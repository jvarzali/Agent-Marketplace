import type { IssuedCredential, PurchaseRequest } from "@agent-wallet/db";
import { domainMatches } from "../cart";
import { formatMoney } from "../money";
import { ALWAYS_DENIED_MCCS } from "../policy/schema";
import { WebhookSignatureError, type AuthorizationDecision, type IssuerEvent, type IssuerMerchant, type WebhookResponse } from "../issuer/types";
import { audit, json, type WalletDeps } from "./context";
import { Notifications } from "./notifications";
import type { TrustService } from "./trust";

type CredWithRequest = IssuedCredential & { purchaseRequest: PurchaseRequest & { agent: { id: string; userId: string; name: string; status: "active" | "frozen" } } };

/** Card-processor descriptors that don't contain the store's domain label. */
const MERCHANT_ALIASES: Record<string, string[]> = {
  "amazon.com": ["amazon", "amzn"],
  "walmart.com": ["walmart", "wal-mart", "wm supercenter"],
  "wholefoodsmarket.com": ["whole foods", "wholefds"],
  "target.com": ["target"],
  "costco.com": ["costco"],
  "instacart.com": ["instacart"],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Does the merchant on the authorization correspond to the store the card was issued for? */
export function merchantMatches(cred: { merchantDomain: string }, requestMerchantName: string, m: IssuerMerchant): boolean {
  if (m.domain) return domainMatches(m.domain.toLowerCase(), cred.merchantDomain) || domainMatches(cred.merchantDomain, m.domain.toLowerCase());
  const name = norm(m.name);
  if (!name) return false;
  const base = Object.keys(MERCHANT_ALIASES).find((d) => domainMatches(cred.merchantDomain, d));
  const label = cred.merchantDomain.split(".").slice(-2, -1)[0] ?? cred.merchantDomain;
  const candidates = [label, requestMerchantName, ...(base ? MERCHANT_ALIASES[base]! : [])].map(norm).filter((c) => c.length >= 3);
  return candidates.some((c) => name.includes(c) || c.includes(name));
}

/**
 * Processes card-issuer webhooks: answers real-time authorization requests, reconciles
 * captures and refunds, and logs every mismatch as a security event.
 */
export class IssuerEventService {
  private readonly notify: Notifications;

  constructor(
    private readonly deps: WalletDeps,
    private readonly trust: TrustService,
  ) {
    this.notify = new Notifications(deps);
  }

  async handleWebhook(rawBody: string, headers: Headers): Promise<WebhookResponse> {
    let event: IssuerEvent;
    try {
      event = await this.deps.issuer.parseWebhook(rawBody, headers);
    } catch (e) {
      if (e instanceof WebhookSignatureError) {
        this.deps.logger.warn("rejected issuer webhook with bad signature", { error: e.message });
        return { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "invalid signature" }) };
      }
      throw e;
    }
    const decision = await this.handleEvent(event);
    return this.deps.issuer.webhookResponse(event, decision);
  }

  async handleEvent(event: IssuerEvent): Promise<AuthorizationDecision | null> {
    switch (event.type) {
      case "authorization.request":
        return this.authorize(event);
      case "authorization.created":
        await this.authorizationCreated(event);
        return null;
      case "transaction.capture":
        await this.capture(event);
        return null;
      case "transaction.refund":
        await this.refund(event);
        return null;
      case "ignored":
        return null;
    }
  }

  /** Why a charge doesn't match the card it was made on, or null if it does. */
  private violation(cred: CredWithRequest, e: { amountCents: number; currency: string; merchant: IssuerMerchant }, now: Date): string | null {
    const r = cred.purchaseRequest;
    if (cred.status !== "active") return `card is ${cred.status}`;
    if (cred.expiresAt <= now) return "card expired";
    if (r.agent.status === "frozen") return "agent is frozen";
    if (r.status !== "credential_issued") return `purchase is ${r.status}`;
    if (e.currency.toUpperCase() !== cred.currency) return `currency ${e.currency} does not match ${cred.currency}`;
    if (e.amountCents > cred.amountLimitCents) return `amount ${formatMoney(e.amountCents, e.currency)} is over the approved ${formatMoney(cred.amountLimitCents, cred.currency)}`;
    if (e.merchant.mcc && (ALWAYS_DENIED_MCCS as readonly string[]).includes(e.merchant.mcc)) return `merchant category ${e.merchant.mcc} is blocked`;
    if (cred.allowedMccs.length && e.merchant.mcc && !cred.allowedMccs.includes(e.merchant.mcc)) return `merchant category ${e.merchant.mcc} is not the approved one`;
    if (!merchantMatches(cred, r.merchantName, e.merchant)) return `merchant "${e.merchant.name}" is not ${cred.merchantDomain}`;
    return null;
  }

  /** Real-time decision. Default deny: anything that doesn't match the issued card exactly is declined. */
  private async authorize(e: Extract<IssuerEvent, { type: "authorization.request" }>): Promise<AuthorizationDecision> {
    const now = this.deps.now();
    const cred = await this.findCred(e.providerCardId);
    const decline = async (reason: string): Promise<AuthorizationDecision> => {
      if (cred) await this.securityEvent(cred, "security.authorization_declined", `Declined a ${formatMoney(e.amountCents, e.currency)} charge from "${e.merchant.name}": ${reason}`, { ...summary(e), reason });
      else this.deps.logger.warn("authorization for unknown card", { card: e.providerCardId });
      return { approved: false, reason };
    };
    if (!cred) return decline("unknown card");
    const bad = this.violation(cred, e, now);
    if (bad) return decline(bad);
    const r = cred.purchaseRequest;
    await audit(this.deps.db, { userId: r.agent.userId, agentId: r.agentId, purchaseRequestId: r.id, type: "authorization.approved", payload: summary(e) }, now);
    return { approved: true, reason: "matches approved purchase" };
  }

  /**
   * For issuers without real-time authorization: the charge already went through, so check it
   * now. A mismatch closes the card immediately (no second charge) and alerts the user.
   */
  private async checkAfterTheFact(cred: CredWithRequest, e: Extract<IssuerEvent, { type: "authorization.created" }>) {
    const now = this.deps.now();
    const r = cred.purchaseRequest;
    const bad = this.violation(cred, e, now);
    if (!bad) {
      await audit(this.deps.db, { userId: r.agent.userId, agentId: r.agentId, purchaseRequestId: r.id, type: "authorization.approved", payload: summary(e) }, now);
      return;
    }
    await this.deps.issuer.cancelCard(cred.providerCardId).catch((err) => this.deps.logger.error("closing card after mismatched charge failed", { error: String(err) }));
    await this.deps.db.issuedCredential.update({ where: { id: cred.id }, data: { status: "cancelled" } });
    await this.securityEvent(
      cred,
      "security.authorization_mismatch",
      `A ${formatMoney(e.amountCents, e.currency)} charge from "${e.merchant.name}" went through but doesn't match what you approved: ${bad}. The card is now closed. Consider disputing the charge.`,
      { ...summary(e), reason: bad },
    );
  }

  private async authorizationCreated(e: Extract<IssuerEvent, { type: "authorization.created" }>) {
    const cred = await this.findCred(e.providerCardId);
    const inserted = await this.recordTxn(e.eventId, cred, {
      kind: "authorization",
      status: e.approved ? "approved" : "declined",
      amountCents: e.amountCents,
      currency: e.currency,
      merchant: e.merchant,
      declineReason: e.declineReason,
      raw: e.raw ?? e,
    });
    if (!inserted || !cred) return;
    if (e.approved && this.deps.issuer.realtimeAuthorization === false) return this.checkAfterTheFact(cred, e);
    // Declines by our own real-time webhook were already logged as security events in authorize().
    if (!e.approved && e.declineReason !== "webhook_declined") {
      // Declined by the issuer's own spending controls: the card network enforced the limit.
      await this.securityEvent(cred, "security.charge_declined", `The card network declined a ${formatMoney(e.amountCents, e.currency)} charge from "${e.merchant.name}" (${e.declineReason ?? "declined"}).`, {
        ...summary(e),
        reason: e.declineReason,
      });
    }
  }

  private async capture(e: Extract<IssuerEvent, { type: "transaction.capture" }>) {
    const now = this.deps.now();
    const cred = await this.findCred(e.providerCardId);
    const inserted = await this.recordTxn(e.eventId, cred, { kind: "capture", status: "settled", amountCents: e.amountCents, currency: e.currency, merchant: e.merchant, declineReason: null, raw: e.raw ?? e });
    if (!inserted) return;
    if (!cred) {
      this.deps.logger.warn("capture for unknown card", { card: e.providerCardId });
      return;
    }
    const r = cred.purchaseRequest;
    await this.deps.db.$transaction(async (tx) => {
      await tx.issuedCredential.update({ where: { id: cred.id }, data: { status: "used" } });
      await tx.purchaseRequest.update({ where: { id: r.id }, data: { status: "completed", settledCents: (r.settledCents ?? 0) + e.amountCents } });
      await audit(tx, { userId: r.agent.userId, agentId: r.agentId, purchaseRequestId: r.id, type: "purchase.completed", payload: { ...summary(e), approved_total_cents: r.totalCents } }, now);
    });
    // Single-use: make sure the card is dead even if the provider's lifecycle control didn't fire.
    await this.deps.issuer.cancelCard(cred.providerCardId).catch((err) => this.deps.logger.error("cancel after capture failed", { error: String(err) }));
    if (e.amountCents > cred.amountLimitCents) {
      await this.securityEvent(cred, "security.over_capture", `Merchant captured ${formatMoney(e.amountCents, e.currency)}, more than the approved ${formatMoney(cred.amountLimitCents, cred.currency)}. Consider disputing.`, summary(e));
    }
    if (!merchantMatches(cred, r.merchantName, e.merchant)) {
      await this.securityEvent(cred, "security.capture_merchant_mismatch", `Captured by "${e.merchant.name}", not ${cred.merchantDomain}. Consider disputing.`, summary(e));
    }
    await this.trust.refresh(r.agentId).catch((err) => this.deps.logger.error("trust refresh failed", { error: String(err) }));
  }

  private async refund(e: Extract<IssuerEvent, { type: "transaction.refund" }>) {
    const now = this.deps.now();
    const cred = await this.findCred(e.providerCardId);
    const inserted = await this.recordTxn(e.eventId, cred, { kind: "refund", status: "refunded", amountCents: e.amountCents, currency: e.currency, merchant: e.merchant, declineReason: null, raw: e.raw ?? e });
    if (!inserted || !cred) return;
    const r = cred.purchaseRequest;
    await this.deps.db.$transaction(async (tx) => {
      await tx.purchaseRequest.update({ where: { id: r.id }, data: { refundedCents: { increment: e.amountCents } } });
      await audit(tx, { userId: r.agent.userId, agentId: r.agentId, purchaseRequestId: r.id, type: "refund.received", payload: { ...summary(e), note: "Budget restored by the refunded amount." } }, now);
    });
  }

  // ───────────── helpers ─────────────

  private findCred(providerCardId: string): Promise<CredWithRequest | null> {
    return this.deps.db.issuedCredential.findUnique({
      where: { providerCardId },
      include: { purchaseRequest: { include: { agent: { select: { id: true, userId: true, name: true, status: true } } } } },
    });
  }

  /** Insert a Transaction row; false if this provider event was already processed (idempotency). */
  private async recordTxn(
    eventId: string,
    cred: CredWithRequest | null,
    t: { kind: "authorization" | "capture" | "refund"; status: "approved" | "declined" | "settled" | "refunded"; amountCents: number; currency: string; merchant: IssuerMerchant; declineReason: string | null; raw: unknown },
  ): Promise<boolean> {
    const existing = await this.deps.db.transaction.findUnique({ where: { providerEventId: eventId } });
    if (existing) return false;
    try {
      await this.deps.db.transaction.create({
        data: {
          providerEventId: eventId,
          issuedCredentialId: cred?.id ?? null,
          purchaseRequestId: cred?.purchaseRequestId ?? null,
          kind: t.kind,
          status: t.status,
          amountCents: t.amountCents,
          currency: t.currency,
          merchant: t.merchant.name,
          merchantMcc: t.merchant.mcc,
          declineReason: t.declineReason,
          rawEvent: json(stripSecrets(t.raw)),
          createdAt: this.deps.now(),
        },
      });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return false; // concurrent duplicate delivery
      throw e;
    }
  }

  private async securityEvent(cred: CredWithRequest, type: string, message: string, payload: Record<string, unknown>) {
    const r = cred.purchaseRequest;
    await audit(this.deps.db, { userId: r.agent.userId, agentId: r.agentId, purchaseRequestId: r.id, type, severity: "security", payload: { message, ...payload } }, this.deps.now());
    await this.notify.securityAlert({
      userId: r.agent.userId,
      agentName: r.agent.name,
      title: message,
      detail: `Card ending ${cred.last4}, issued for ${cred.merchantDomain} (${formatMoney(cred.amountLimitCents, cred.currency)} limit).`,
      link: `${this.deps.config.appUrl.replace(/\/$/, "")}/activity?purchase=${encodeURIComponent(r.id)}`,
    });
  }
}

function summary(e: { amountCents: number; currency: string; merchant: IssuerMerchant }) {
  return { amount_cents: e.amountCents, currency: e.currency, merchant_name: e.merchant.name, merchant_mcc: e.merchant.mcc, merchant_domain: e.merchant.domain };
}

/** Provider payloads should never contain PAN/CVC, but strip any such keys defensively. */
function stripSecrets(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(stripSecrets);
  if (raw && typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (!/^(number|cvc|pan|card_number)$/i.test(k)) out[k] = stripSecrets(v);
    return out;
  }
  return raw ?? null;
}
