import type { PurchaseRequest } from "@agent-wallet/db";
import { z } from "zod";
import { CardFillError } from "../checkout/browser-fill";
import { cartHash, CartValidationError, normalizeCart, purchaseRequestInputSchema, type CartItem } from "../cart";
import type { CardSecrets } from "../issuer/types";
import { formatMoney, toCents } from "../money";
import { computeBudget, type Budget } from "../policy/budget";
import { describePolicy, describePolicyText, type PolicySummarySection } from "../policy/describe";
import { evaluatePurchase, type RuleCheck } from "../policy/engine";
import { hardDenies } from "../policy/override";
import { ALWAYS_DENIED_MCCS, type PolicyRules } from "../policy/schema";
import { audit, json, lockAgent, minutes, WalletError, type AuthedAgent, type Tx, type WalletDeps } from "./context";
import { cartFromRow, classificationsFromRow, loadActivePolicy, loadHistory, loadKnownMerchants } from "./history";
import { Notifications } from "./notifications";
import { TEST_SHOPPER, type ShopperProfile } from "./shopper";

export type AgentPurchaseStatus =
  | "denied"
  | "pending_approval"
  | "approved"
  | "credential_issued"
  | "completed"
  | "expired"
  | "cancelled";

/** What an agent sees about one of its purchase requests. */
export interface AgentPurchaseView {
  id: string;
  status: AgentPurchaseStatus;
  merchant_domain: string;
  merchant_name: string;
  total: string;
  total_cents: number;
  currency: string;
  cart_hash: string;
  reasons: string[];
  /** Plain-language next step for the agent. */
  next_step: string;
  created_at: string;
  /** Present exactly once: on the first status call after the card is issued. */
  credential?: AgentCredential;
}

export interface AgentCredential {
  number: string;
  cvc: string;
  exp_month: number;
  exp_year: number;
  cardholder_name: string;
  billing_address: CardSecrets["billingAddress"];
  amount_limit: string;
  amount_limit_cents: number;
  merchant_domain: string;
  expires_at: string;
  single_use: true;
  instructions: string;
}

/** What fill_payment_details returns: never the card number, only what to do next. */
export interface FillPaymentView extends AgentPurchaseView {
  filled_fields: string[];
  page_url: string;
  card_last4: string;
  /** Billing details for any address fields the store asks for (not secret). */
  cardholder_name: string;
  billing_address: CardSecrets["billingAddress"];
}

/** Fills allowed per card, so a confused agent can't keep re-entering it. */
const MAX_FILLS_PER_CARD = 5;

export const reportResultSchema = z.object({
  success: z.boolean(),
  order_reference: z.string().trim().max(200).optional(),
  amount_charged: z.number().nonnegative().max(1_000_000).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export type ReportResultInput = z.input<typeof reportResultSchema>;

const ACTIVE: AgentPurchaseStatus[] = ["pending_approval", "approved", "credential_issued"];

export class PurchaseService {
  private readonly notify: Notifications;

  constructor(private readonly deps: WalletDeps) {
    this.notify = new Notifications(deps);
  }

  // ───────────── agent: policy & budget ─────────────

  async getMyPolicy(agent: AuthedAgent): Promise<{ status: string; summary: string; sections: PolicySummarySection[]; rules: PolicyRules; version: number }> {
    const p = await loadActivePolicy(this.deps.db, agent.id);
    const current = await this.deps.db.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { status: true } });
    const frozen = current.status === "frozen" ? "This agent is FROZEN by its owner: every purchase will be denied until they unfreeze it.\n\n" : "";
    return { status: current.status, summary: frozen + describePolicyText(p.rules), sections: describePolicy(p.rules), rules: p.rules, version: p.version };
  }

  async getBudget(agent: AuthedAgent): Promise<Budget & { frozen: boolean; summary: string }> {
    const now = this.deps.now();
    const [p, history, current] = await Promise.all([
      loadActivePolicy(this.deps.db, agent.id),
      loadHistory(this.deps.db, agent.id, now),
      this.deps.db.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { status: true } }),
    ]);
    const b = computeBudget(p.rules, history, now);
    const m = (c: number | null) => (c === null ? "no limit" : formatMoney(c, b.currency));
    const lines = b.windows.map((w) => `${{ per_day: "Last 24h", per_week: "Last 7 days", per_month: "Last 30 days" }[w.window]}: ${m(w.remainingCents)} left of ${m(w.limitCents)}`);
    lines.push(`Orders left in the next 24h: ${b.ordersLeftToday ?? "no limit"}`);
    lines.push(`Largest order that fits right now: ${m(b.maxNextOrderCents)} (including tax and shipping)`);
    if (current.status === "frozen") lines.unshift("Agent is FROZEN: no purchases possible.");
    return { ...b, frozen: current.status === "frozen", summary: lines.join("\n") };
  }

  // ───────────── agent: request ─────────────

  async requestPurchase(agent: AuthedAgent, raw: unknown): Promise<AgentPurchaseView> {
    const parsed = purchaseRequestInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new WalletError("validation", `Invalid purchase request: ${z.prettifyError(parsed.error)}`, parsed.error.issues);
    }
    let cart;
    try {
      cart = normalizeCart(parsed.data);
    } catch (e) {
      if (e instanceof CartValidationError) throw new WalletError("validation", e.message);
      throw e;
    }
    const hash = cartHash(cart);
    const classifications = await this.deps.classifier.classify(cart.items, { merchantDomain: cart.merchantDomain, mcc: cart.mcc });

    const { row, notifyReasons } = await this.deps.db.$transaction(async (tx) => {
      const now = this.deps.now();
      await lockAgent(tx, agent.id);
      const a = await tx.agent.findUniqueOrThrow({ where: { id: agent.id } });
      const policy = await loadActivePolicy(tx, agent.id);
      const [history, knownMerchants] = await Promise.all([loadHistory(tx, agent.id, now), loadKnownMerchants(tx, agent.id)]);
      const result = evaluatePurchase({ cart, classifications, policy: policy.rules, agent: { status: a.status }, history, knownMerchants, now });

      const status = result.decision === "deny" ? "denied" : result.decision === "needs_approval" ? "pending_approval" : "approved";
      const row = await tx.purchaseRequest.create({
        data: {
          agentId: agent.id,
          policyId: policy.id,
          merchantDomain: cart.merchantDomain,
          merchantName: cart.merchantName,
          mcc: cart.mcc,
          items: json(cart.items),
          classifications: json(classifications),
          subtotalCents: cart.subtotalCents,
          taxCents: cart.taxCents,
          shippingCents: cart.shippingCents,
          totalCents: cart.totalCents,
          currency: cart.currency,
          agentReasoning: cart.reasoning,
          cartHash: hash,
          status,
          decision: result.decision,
          decisionReasons: json(result.checks),
          pendingExpiresAt: status === "pending_approval" ? new Date(now.getTime() + minutes(this.deps.config.pendingTtlMinutes)) : null,
          createdAt: now,
        },
      });
      if (status === "approved") {
        // Policy auto-approval. Bound to the cart hash and short-lived like a human approval.
        await tx.approval.create({
          data: { purchaseRequestId: row.id, decision: "approved", cartHash: hash, decidedAt: now, expiresAt: new Date(now.getTime() + minutes(this.deps.config.approvalTtlMinutes)) },
        });
      }
      await audit(
        tx,
        {
          userId: agent.userId,
          agentId: agent.id,
          purchaseRequestId: row.id,
          type: `purchase.${result.decision === "allow" ? "auto_approved" : result.decision === "deny" ? "denied" : "pending_approval"}`,
          severity: result.decision === "deny" ? "warning" : "info",
          payload: {
            merchant: cart.merchantDomain,
            total_cents: cart.totalCents,
            currency: cart.currency,
            cart_hash: hash,
            policy_version: policy.version,
            reasons: result.reasons,
            checks: result.checks,
          },
        },
        now,
      );
      return { row, notifyReasons: result.reasons };
    });

    if (row.status === "pending_approval") {
      await this.notify.approvalNeeded({
        userId: agent.userId,
        requestId: row.id,
        agentName: agent.name,
        merchantName: row.merchantName,
        merchantDomain: row.merchantDomain,
        items: row.items as unknown as CartItem[],
        totalCents: row.totalCents,
        currency: row.currency,
        reasons: notifyReasons,
      });
    }
    return this.view(row);
  }

  // ───────────── agent: checkout details ─────────────

  /** Name, email, phone and shipping address to enter at checkout. Never card details. */
  async getShippingDetails(agent: AuthedAgent): Promise<Omit<ShopperProfile, "test"> & { next_step: string }> {
    const a = await this.deps.db.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { status: true } });
    if (a.status === "frozen") throw new WalletError("forbidden", "This agent is frozen by its owner. Stop and tell the user.");
    const configured = this.deps.config.shopper;
    const profile = configured ?? (configured === undefined && this.deps.issuer.supportsTestCharges ? (this.deps.config.testShopper ?? TEST_SHOPPER) : null);
    if (!profile) {
      throw new WalletError("not_found", "The owner hasn't set shipping details for this wallet. Ask the user for the name, email, phone and address to use; don't make them up.");
    }
    await audit(this.deps.db, { userId: agent.userId, agentId: agent.id, type: "shopper.details_shared", payload: { test_profile: profile.test } }, this.deps.now());
    // Same answer either way: the agent isn't told whether these are test details.
    const { test: _test, ...details } = profile;
    return { ...details, next_step: "Use these exactly for the contact and shipping fields at checkout. Don't change them or use other saved addresses." };
  }

  // ───────────── agent: status & credential delivery ─────────────

  async getPurchaseStatus(agent: AuthedAgent, id: string, opts: { cart?: unknown } = {}): Promise<AgentPurchaseView> {
    let row = await this.ownRequest(agent, id);
    const now = this.deps.now();

    if (row.status === "pending_approval" && row.pendingExpiresAt && row.pendingExpiresAt <= now) {
      row = await this.transition(row, "expired", "approval_window_lapsed", "purchase.expired", { reason: "No human decision before the request lapsed." });
    }

    if (opts.cart !== undefined && ACTIVE.includes(row.status)) {
      const parsed = purchaseRequestInputSchema.safeParse(opts.cart);
      if (!parsed.success) throw new WalletError("validation", `Invalid cart: ${z.prettifyError(parsed.error)}`);
      let current: string;
      try {
        current = cartHash(normalizeCart(parsed.data));
      } catch (e) {
        if (e instanceof CartValidationError) throw new WalletError("validation", e.message);
        throw e;
      }
      if (current !== row.cartHash) {
        await this.cancelInternal(row, "cart_changed", "warning");
        row = await this.deps.db.purchaseRequest.findUniqueOrThrow({ where: { id } });
        return { ...this.view(row), next_step: "Your cart changed after this request was made, so it was cancelled. Submit a new request_purchase with the exact current cart." };
      }
    }

    const reveal = this.deps.config.cardDelivery === "agent";
    if (row.status === "approved" || (reveal && row.status === "credential_issued" && !(await this.delivered(row.id)))) {
      return this.issueAndDeliver(agent, row.id, reveal);
    }
    return this.view(row);
  }

  /**
   * Wait (up to `seconds`, max 120) for the owner to decide a pending request, then return its
   * status like get_purchase_status. Lets agents wait for approval without asking the user.
   */
  async waitForDecision(agent: AuthedAgent, id: string, seconds = 60, pollMs = 1_000): Promise<AgentPurchaseView> {
    const deadline = Date.now() + Math.min(120, Math.max(1, seconds)) * 1_000;
    await this.ownRequest(agent, id);
    for (;;) {
      const row = await this.deps.db.purchaseRequest.findUniqueOrThrow({ where: { id }, select: { status: true, pendingExpiresAt: true } });
      const lapsed = row.pendingExpiresAt !== null && row.pendingExpiresAt <= this.deps.now();
      if (row.status !== "pending_approval" || lapsed || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const v = await this.getPurchaseStatus(agent, id);
    if (v.status === "pending_approval") {
      return { ...v, next_step: "Still waiting for the owner. Call wait_for_decision again right away; don't ask the user anything or end your turn, and don't submit the purchase again." };
    }
    return v;
  }

  /**
   * Type the issued card into the agent's checkout page (browser delivery). The wallet checks
   * the tab is on the approved store and shows the approved total; the agent never sees the
   * number. Issues the card first if the request was just approved.
   */
  async fillPaymentDetails(agent: AuthedAgent, id: string): Promise<FillPaymentView> {
    let row = await this.ownRequest(agent, id);
    if (row.status === "approved") {
      await this.issueAndDeliver(agent, id, false);
      row = await this.ownRequest(agent, id);
    }
    if (row.status !== "credential_issued") {
      throw new WalletError("invalid_state", `This request is ${row.status}, so there's no card to enter. ${nextStep(row, this.deps.config.cardDelivery)}`);
    }
    const filler = this.deps.cardFiller;
    if (!filler) throw new WalletError("invalid_state", "This wallet isn't set up to enter cards in the browser. Tell the user; don't enter card details yourself.");
    const now = this.deps.now();
    const [a, cred] = await Promise.all([
      this.deps.db.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { status: true } }),
      this.deps.db.issuedCredential.findFirst({ where: { purchaseRequestId: id, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    if (a.status === "frozen") throw new WalletError("forbidden", "This agent is frozen by its owner. Stop and tell the user.");
    if (!cred || cred.expiresAt <= now) throw new WalletError("invalid_state", "The card for this request has expired or was closed. Submit a new request if the user still wants this.");
    const fills = await this.deps.db.auditEvent.count({ where: { purchaseRequestId: id, type: "credential.filled" } });
    if (fills >= MAX_FILLS_PER_CARD) throw new WalletError("rate_limited", `The card was already entered ${fills} times. Stop and tell the user; cancel_purchase if checkout can't be completed.`);

    const secrets = await this.deps.issuer.getCardSecrets(cred.providerCardId);
    let result;
    try {
      result = await filler.fill({ merchantDomain: cred.merchantDomain, totalCents: row.totalCents, currency: row.currency, secrets });
    } catch (e) {
      const message = e instanceof CardFillError ? e.message : "Couldn't enter the card in the browser. Tell the user; don't enter card details yourself.";
      await audit(this.deps.db, { userId: agent.userId, agentId: agent.id, purchaseRequestId: id, type: "credential.fill_failed", severity: "warning", payload: { last4: cred.last4, reason: message } }, now);
      if (!(e instanceof CardFillError)) this.deps.logger.error("card fill failed", { requestId: id, error: e instanceof Error ? e.message : String(e) });
      throw new WalletError("invalid_state", message);
    }
    await this.deps.db.$transaction(async (tx) => {
      if (!cred.deliveredAt) await tx.issuedCredential.update({ where: { id: cred.id }, data: { deliveredAt: now } });
      await audit(tx, { userId: agent.userId, agentId: agent.id, purchaseRequestId: id, type: "credential.filled", payload: { last4: cred.last4, page: result.pageUrl.split("?")[0], fields: result.filled } }, now);
    });
    return {
      ...this.view(row),
      filled_fields: result.filled,
      page_url: result.pageUrl,
      card_last4: cred.last4,
      cardholder_name: secrets.cardholderName,
      billing_address: secrets.billingAddress,
      next_step: `The card ending ${cred.last4} is entered (${result.filled.join(", ")}). If the page still asks for a billing name or address, use the details here. Then place the order and call report_purchase_result with the order number. Do not change the cart.`,
    };
  }

  /**
   * Issue the single-use card for an approved request and return its details once.
   * Runs under the agent lock so concurrent polls can't receive the card twice. All
   * policy deny-rules are re-checked at issuance (freeze, tightened limits, etc.).
   */
  private async issueAndDeliver(agent: AuthedAgent, id: string, reveal: boolean): Promise<AgentPurchaseView> {
    let createdCardId = null as string | null;
    try {
      const out = await this.deps.db.$transaction(
        async (tx) => {
          const now = this.deps.now();
          await lockAgent(tx, agent.id);
          const row = await tx.purchaseRequest.findUniqueOrThrow({ where: { id } });
          const a = await tx.agent.findUniqueOrThrow({ where: { id: agent.id } });

          // Crash recovery: card was created but never delivered.
          if (row.status === "credential_issued") {
            const cred = await tx.issuedCredential.findFirst({ where: { purchaseRequestId: id, status: "active", deliveredAt: null } });
            if (!cred || !reveal) return { row, secrets: null, cred: null };
            if (a.status === "frozen" || cred.expiresAt <= now) return { row, secrets: null, cred: null };
            const secrets = await this.deps.issuer.getCardSecrets(cred.providerCardId);
            await tx.issuedCredential.update({ where: { id: cred.id }, data: { deliveredAt: now } });
            await audit(tx, { userId: agent.userId, agentId: agent.id, purchaseRequestId: id, type: "credential.delivered", payload: { last4: cred.last4 } }, now);
            return { row, secrets, cred };
          }
          if (row.status !== "approved") return { row, secrets: null, cred: null };

          // The request's status says it's approved; take the approval that did it (a human
          // denial overridden in the same millisecond must not shadow it).
          const approval = await tx.approval.findFirst({ where: { purchaseRequestId: id, decision: "approved" }, orderBy: { decidedAt: "desc" } });
          if (!approval || approval.decision !== "approved") {
            return { row: await this.setStatus(tx, row, "cancelled", "no_valid_approval", now), secrets: null, cred: null };
          }
          if (approval.expiresAt <= now) {
            await audit(tx, { userId: agent.userId, agentId: agent.id, purchaseRequestId: id, type: "approval.expired", payload: { expired_at: approval.expiresAt.toISOString() } }, now);
            return { row: await this.setStatus(tx, row, "expired", "approval_expired", now), secrets: null, cred: null };
          }
          if (approval.cartHash !== row.cartHash) {
            await audit(tx, { userId: agent.userId, agentId: agent.id, purchaseRequestId: id, type: "security.cart_hash_mismatch", severity: "security", payload: { approved_hash: approval.cartHash, request_hash: row.cartHash } }, now);
            return { row: await this.setStatus(tx, row, "cancelled", "cart_hash_mismatch", now), secrets: null, cred: null };
          }

          // Re-check every deny rule now: the agent may have been frozen or limits tightened since approval.
          // A human override already accepted the policy denials, so only the hard rules apply to it.
          const policy = await loadActivePolicy(tx, agent.id);
          const [history, knownMerchants] = await Promise.all([loadHistory(tx, agent.id, now, id), loadKnownMerchants(tx, agent.id)]);
          const classifications = classificationsFromRow(row);
          const recheck = evaluatePurchase({ cart: cartFromRow(row), classifications, policy: policy.rules, agent: { status: a.status }, history, knownMerchants, now });
          const denies = approval.override ? hardDenies(recheck.checks, classifications, row.mcc) : recheck.checks.filter((c) => c.outcome === "deny");
          if (denies.length) {
            await audit(tx, { userId: agent.userId, agentId: agent.id, purchaseRequestId: id, type: "purchase.blocked_at_issuance", severity: "warning", payload: { reasons: denies.map((d) => d.message) } }, now);
            const updated = await tx.purchaseRequest.update({
              where: { id },
              data: { status: "cancelled", cancelReason: a.status === "frozen" ? "agent_frozen" : "policy_recheck_failed", decisionReasons: json([...(row.decisionReasons as unknown as RuleCheck[]), ...denies.map((d) => ({ ...d, rule: `issuance.${d.rule}` }))]) },
            });
            return { row: updated, secrets: null, cred: null };
          }

          const expiresAt = new Date(now.getTime() + minutes(this.deps.config.credentialTtlMinutes));
          const amountLimitCents = row.totalCents + toCents(policy.rules.credential_buffer);
          const blockedMccs = [...new Set([...ALWAYS_DENIED_MCCS, ...policy.rules.merchants.deny_mccs])];
          const card = await this.deps.issuer.createCard({
            purchaseRequestId: id,
            userId: agent.userId,
            amountLimitCents,
            currency: row.currency,
            merchantDomain: row.merchantDomain,
            merchantName: row.merchantName,
            allowedMccs: row.mcc ? [row.mcc] : [],
            blockedMccs,
            expiresAt,
          });
          createdCardId = card.providerCardId;
          const secrets = reveal ? await this.deps.issuer.getCardSecrets(card.providerCardId) : null;
          const cred = await tx.issuedCredential.create({
            data: {
              purchaseRequestId: id,
              provider: card.provider,
              providerCardId: card.providerCardId,
              last4: card.last4,
              amountLimitCents,
              currency: row.currency,
              allowedMccs: row.mcc ? [row.mcc] : [],
              merchantDomain: row.merchantDomain,
              expiresAt,
              deliveredAt: reveal ? now : null,
              createdAt: now,
            },
          });
          const updated = await tx.purchaseRequest.update({ where: { id }, data: { status: "credential_issued" } });
          await audit(
            tx,
            {
              userId: agent.userId,
              agentId: agent.id,
              purchaseRequestId: id,
              type: "credential.issued",
              payload: { provider: card.provider, provider_card_id: card.providerCardId, last4: card.last4, amount_limit_cents: amountLimitCents, merchant: row.merchantDomain, expires_at: expiresAt.toISOString() },
            },
            now,
          );
          return { row: updated, secrets, cred };
        },
        { timeout: 20_000 },
      );
      createdCardId = null;
      const v = this.view(out.row);
      if (out.secrets && out.cred) {
        v.credential = {
          number: out.secrets.number,
          cvc: out.secrets.cvc,
          exp_month: out.secrets.expMonth,
          exp_year: out.secrets.expYear,
          cardholder_name: out.secrets.cardholderName,
          billing_address: out.secrets.billingAddress,
          amount_limit: formatMoney(out.cred.amountLimitCents, out.cred.currency),
          amount_limit_cents: out.cred.amountLimitCents,
          merchant_domain: out.cred.merchantDomain,
          expires_at: out.cred.expiresAt.toISOString(),
          single_use: true,
          instructions:
            `Use this card once, only at ${out.cred.merchantDomain}, for at most ${formatMoney(out.cred.amountLimitCents, out.cred.currency)}, before ${out.cred.expiresAt.toISOString()}. ` +
            "Do not save, log, or repeat these details anywhere else. They will not be shown again. After checkout, call report_purchase_result.",
        };
        v.next_step = "Complete checkout now: enter this as a NEW card (not a saved one) with the billing details shown, place the order, then call report_purchase_result with the order number.";
      }
      return v;
    } catch (e) {
      if (createdCardId) {
        // The transaction failed after a card was created: make sure it can never be used.
        await this.deps.issuer.cancelCard(createdCardId).catch(() => undefined);
      }
      if (WalletError.is(e)) throw e;
      this.deps.logger.error("credential issuance failed", { requestId: id, error: e instanceof Error ? e.message : String(e) });
      throw new WalletError("issuer_error", "Could not issue a card right now. Try get_purchase_status again in a minute; do not resubmit the purchase.");
    }
  }

  // ───────────── agent: cancel & report ─────────────

  async cancelPurchase(agent: AuthedAgent, id: string, reason?: string): Promise<AgentPurchaseView> {
    const row = await this.ownRequest(agent, id);
    if (!ACTIVE.includes(row.status)) {
      throw new WalletError("invalid_state", `This request is already ${row.status}; nothing to cancel.`);
    }
    await this.cancelInternal(row, reason ? `agent: ${reason.slice(0, 200)}` : "agent_cancelled", "info");
    return this.view(await this.deps.db.purchaseRequest.findUniqueOrThrow({ where: { id } }));
  }

  async reportPurchaseResult(agent: AuthedAgent, id: string, raw: unknown): Promise<AgentPurchaseView> {
    const parsed = reportResultSchema.safeParse(raw);
    if (!parsed.success) throw new WalletError("validation", `Invalid result: ${z.prettifyError(parsed.error)}`);
    const row = await this.ownRequest(agent, id);
    if (!["credential_issued", "completed"].includes(row.status)) {
      throw new WalletError("invalid_state", `Request is ${row.status}; results can only be reported after a card was issued.`);
    }
    const now = this.deps.now();
    const r = parsed.data;
    const updated = await this.deps.db.$transaction(async (tx) => {
      const u = await tx.purchaseRequest.update({
        where: { id },
        data: { orderReference: r.order_reference ?? row.orderReference, orderResult: json({ ...r, reported_at: now.toISOString() }) },
      });
      await audit(
        tx,
        { userId: agent.userId, agentId: agent.id, purchaseRequestId: id, type: r.success ? "purchase.result_reported" : "purchase.failure_reported", payload: { ...r } },
        now,
      );
      return u;
    });
    if (!r.success && row.status === "credential_issued") {
      // The agent says checkout failed: kill the card so it can't be used later.
      await this.cancelInternal(updated, "agent_reported_failure", "info");
      return this.view(await this.deps.db.purchaseRequest.findUniqueOrThrow({ where: { id } }));
    }
    return this.view(updated);
  }

  async listMyPurchases(agent: AuthedAgent, limit = 20): Promise<AgentPurchaseView[]> {
    const rows = await this.deps.db.purchaseRequest.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: "desc" }, take: Math.min(limit, 100) });
    return rows.map((r) => this.view(r));
  }

  // ───────────── internals ─────────────

  /** Cancel a request and every active card for it. Used by agents, freeze, cart changes. */
  async cancelInternal(row: PurchaseRequest, reason: string, severity: "info" | "warning" | "security"): Promise<void> {
    const agent = await this.deps.db.agent.findUniqueOrThrow({ where: { id: row.agentId } });
    await this.deps.db.$transaction(async (tx) => {
      const now = this.deps.now();
      await lockAgent(tx, row.agentId);
      const current = await tx.purchaseRequest.findUniqueOrThrow({ where: { id: row.id } });
      if (!ACTIVE.includes(current.status)) return;
      await cancelCredentials(this.deps, tx, row.id, now);
      await tx.purchaseRequest.update({ where: { id: row.id }, data: { status: "cancelled", cancelReason: reason } });
      await audit(tx, { userId: agent.userId, agentId: agent.id, purchaseRequestId: row.id, type: "purchase.cancelled", severity, payload: { reason } }, now);
    });
  }

  private async transition(row: PurchaseRequest, status: AgentPurchaseStatus, reason: string, type: string, payload: Record<string, unknown>): Promise<PurchaseRequest> {
    const agent = await this.deps.db.agent.findUniqueOrThrow({ where: { id: row.agentId } });
    return this.deps.db.$transaction(async (tx) => {
      const now = this.deps.now();
      const u = await this.setStatus(tx, row, status, reason, now);
      await audit(tx, { userId: agent.userId, agentId: agent.id, purchaseRequestId: row.id, type, payload }, now);
      return u;
    });
  }

  private async setStatus(tx: Tx, row: PurchaseRequest, status: AgentPurchaseStatus, reason: string, _now: Date): Promise<PurchaseRequest> {
    return tx.purchaseRequest.update({ where: { id: row.id }, data: { status, cancelReason: reason } });
  }

  private async delivered(requestId: string): Promise<boolean> {
    const pending = await this.deps.db.issuedCredential.count({ where: { purchaseRequestId: requestId, status: "active", deliveredAt: null } });
    return pending === 0;
  }

  private async ownRequest(agent: AuthedAgent, id: string): Promise<PurchaseRequest> {
    const row = await this.deps.db.purchaseRequest.findUnique({ where: { id } });
    if (!row || row.agentId !== agent.id) throw new WalletError("not_found", `No purchase request ${id} for this agent.`);
    return row;
  }

  view(row: PurchaseRequest): AgentPurchaseView {
    const checks = row.decisionReasons as unknown as RuleCheck[];
    const reasons = checks.filter((c) => c.outcome === "deny" || c.outcome === "needs_approval").map((c) => c.message);
    return {
      id: row.id,
      status: row.status,
      merchant_domain: row.merchantDomain,
      merchant_name: row.merchantName,
      total: formatMoney(row.totalCents, row.currency),
      total_cents: row.totalCents,
      currency: row.currency,
      cart_hash: row.cartHash,
      reasons,
      next_step: nextStep(row, this.deps.config.cardDelivery),
      created_at: row.createdAt.toISOString(),
    };
  }
}

export async function cancelCredentials(deps: WalletDeps, tx: Tx, requestId: string, now: Date): Promise<number> {
  const creds = await tx.issuedCredential.findMany({ where: { purchaseRequestId: requestId, status: "active" } });
  for (const c of creds) {
    await deps.issuer.cancelCard(c.providerCardId);
    await tx.issuedCredential.update({ where: { id: c.id }, data: { status: "cancelled" } });
    const req = await tx.purchaseRequest.findUniqueOrThrow({ where: { id: requestId }, include: { agent: true } });
    await audit(tx, { userId: req.agent.userId, agentId: req.agentId, purchaseRequestId: requestId, type: "credential.cancelled", payload: { last4: c.last4 } }, now);
  }
  return creds.length;
}

function nextStep(row: PurchaseRequest, delivery: "agent" | "browser"): string {
  switch (row.status) {
    case "denied":
      return "Denied by the owner's rules (see reasons). Do not retry the same purchase, and do not split it into smaller orders. If a different choice fits the rules (a cheaper item, an allowed store; check get_my_policy and get_budget), pick the best one yourself and request that. Only if nothing fits, tell the user why it can't be bought.";
    case "pending_approval":
      return "Waiting for the owner to approve. Call wait_for_decision now and keep calling it until the status changes; don't ask the user anything meanwhile. Stay on the checkout page; do not submit the same purchase again or pay any other way.";
    case "approved":
      return delivery === "browser"
        ? `Approved. Stay on the checkout page at ${row.merchantDomain} and call fill_payment_details: the wallet enters the single-use card into the page for you.`
        : "Approved. Call get_purchase_status to receive the single-use card.";
    case "credential_issued":
      if (delivery === "browser") {
        return `Approved, and a single-use card is ready. With the payment step showing on ${row.merchantDomain}, call fill_payment_details: the wallet types the card into the page (you never see the number). Then place the order and call report_purchase_result.`;
      }
      return "A single-use card was already issued and delivered for this request. It is not shown again. If you lost it, call cancel_purchase and submit a new request.";
    case "completed":
      return "Payment completed. Call report_purchase_result with the order confirmation if you haven't.";
    case "expired":
      return "This request expired (approval or card window passed). Submit a new request if the user still wants it.";
    case "cancelled":
      return `Cancelled (${row.cancelReason ?? "no reason"}). Submit a new request if appropriate.`;
  }
}
