import "server-only";

import { formatMoney, type DashboardSnapshot, type RuleCheck as CoreRuleCheck } from "@agent-wallet/core";
import type { AuditEvent, AuditType, PurchaseRequest, RuleCheck, Snapshot } from "@/lib/types";

// Turns @agent-wallet/core's dashboard snapshot into the view models the client renders.
// Presentation only: every rule was already evaluated by the backend.

type CoreEvent = DashboardSnapshot["events"][number];
type CorePurchase = DashboardSnapshot["purchases"][number];

const dollars = (cents: number) => cents / 100;

const RULE_LABELS: [prefix: string, label: string][] = [
  ["agent.frozen", "Agent frozen"],
  ["cart.", "Cart math"],
  ["currency", "Currency"],
  ["merchants.deny_domains", "Blocked stores"],
  ["merchants.domain", "Store"],
  ["merchants.mcc", "Merchant type"],
  ["categories.", "Category"],
  ["limits.per_order_total", "Order limit"],
  ["limits.per_day", "Daily budget"],
  ["limits.per_week", "Weekly budget"],
  ["limits.per_month", "Monthly budget"],
  ["limits.max_quantity_per_item", "Quantity"],
  ["limits.max_orders_per_day", "Orders today"],
  ["limits.order_splitting", "Split orders"],
  ["schedule", "Shopping hours"],
  ["approval.always", "Ask every time"],
  ["approval.total_over", "Ask-first amount"],
  ["approval.new_merchant", "New store"],
  ["approval.category_uncertain", "Unclear item"],
];

function ruleLabel(rule: string): string {
  return RULE_LABELS.find(([p]) => rule.startsWith(p))?.[1] ?? rule;
}

function toCheck(c: CoreRuleCheck): RuleCheck | null {
  if (c.outcome === "not_applicable") return null;
  const outcome = c.outcome === "needs_approval" ? "approval" : c.outcome;
  return { rule: ruleLabel(c.rule), outcome, detail: c.message };
}

function toRequest(p: CorePurchase): PurchaseRequest {
  return {
    id: p.id,
    agentId: p.agentId,
    merchantDomain: p.merchantDomain,
    merchantName: p.merchantName,
    items: p.items.map((i) => ({
      name: i.name,
      category: i.classification?.category ?? "unknown",
      categoryConfidence: i.classification?.confidence ?? 0,
      unitPrice: dollars(i.unit_price_cents),
      quantity: i.quantity,
      url: i.url,
    })),
    subtotal: dollars(p.subtotalCents),
    tax: dollars(p.taxCents),
    shipping: dollars(p.shippingCents),
    total: dollars(p.totalCents),
    currency: p.currency,
    reasoning: p.agentReasoning,
    cartHash: p.cartHash,
    status: p.status,
    autoApproved: p.autoApproved,
    overridden: p.overridden,
    overrideBlock: p.overrideBlock,
    checks: p.checks.map(toCheck).filter((c): c is RuleCheck => c !== null),
    createdAt: p.createdAt.getTime(),
    decidedAt: p.decidedAt?.getTime(),
    credential: p.credential
      ? {
          last4: p.credential.last4,
          amountLimit: dollars(p.credential.amountLimitCents),
          expiresAt: p.credential.expiresAt.getTime(),
          status: p.credential.status,
        }
      : undefined,
  };
}

type Payload = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function describeEvent(e: CoreEvent, purchase: CorePurchase | undefined): { type: AuditType; summary: string } {
  const p = (e.payload ?? {}) as Payload;
  const agent = e.agentName ?? "An agent";
  const currency = purchase?.currency ?? str(p["currency"]) ?? "USD";
  const m = (cents: number | undefined) => (cents === undefined ? "" : formatMoney(cents, currency));
  const total = m(purchase?.totalCents ?? num(p["total_cents"]));
  const where = purchase?.merchantName ?? str(p["merchant"]) ?? "a store";
  const what = total ? `${total} at ${where}` : `the purchase at ${where}`;
  const firstReason = (Array.isArray(p["reasons"]) ? (p["reasons"] as unknown[]) : []).find((r) => typeof r === "string") as string | undefined;
  const withReason = (s: string) => (firstReason ? `${s}: ${firstReason}` : `${s}.`);

  if (e.type.startsWith("security.")) {
    return { type: "security", summary: str(p["message"]) ?? SECURITY_FALLBACK[e.type] ?? "A security check failed." };
  }
  switch (e.type) {
    case "agent.created":
      return { type: "agent_created", summary: `You added ${agent}.` };
    case "agent.renamed":
      return { type: "other", summary: `Renamed to ${str(p["name"]) ?? agent}.` };
    case "agent.api_key_rotated":
      return { type: "other", summary: `You replaced ${agent}'s API key. The old key stopped working.` };
    case "agent.api_key_revoked":
      return { type: "frozen", summary: `You revoked ${agent}'s API key.` };
    case "agent.frozen": {
      const cards = num(p["cancelled_cards"]) ?? 0;
      return { type: "frozen", summary: `${agent} was frozen. ${cards} active ${cards === 1 ? "card" : "cards"} cancelled.` };
    }
    case "agent.unfrozen":
      return { type: "unfrozen", summary: `You unfroze ${agent}.` };
    case "policy.updated": {
      const v = num(p["version"]);
      if (v === 1) return { type: "policy_changed", summary: `${agent} started on its first set of rules.` };
      const viaTrust = str(p["source"])?.startsWith("trust_suggestion:");
      return { type: "policy_changed", summary: `You saved version ${v ?? "?"} of ${agent}'s rules${viaTrust ? " by accepting a suggestion" : ""}.` };
    }
    case "trust.suggestion_accepted":
      return { type: "policy_changed", summary: `You accepted a suggestion to loosen ${agent}'s rules.` };
    case "trust.suggestion_dismissed":
      return { type: "other", summary: `You dismissed a suggestion for ${agent}.` };
    case "purchase.pending_approval":
      return { type: "request_pending", summary: withReason(`${agent} asked you about ${what}`) };
    case "purchase.auto_approved":
      return { type: "request_auto_approved", summary: `${what} passed every rule.` };
    case "purchase.denied":
      return { type: "request_denied", summary: withReason(`Blocked ${what}`) };
    case "purchase.blocked_at_issuance":
      return { type: "request_denied", summary: withReason(`Blocked ${what} before a card was issued`) };
    case "approval.approved":
      return { type: "approved", summary: `You approved ${what}.` };
    case "approval.override":
      return { type: "approved", summary: `You overrode the denial and approved ${what}.` };
    case "approval.denied":
      return { type: "denied", summary: `You denied ${what}.` };
    case "approval.expired":
      return { type: "other", summary: `The approval for ${what} lapsed before the agent used it.` };
    case "purchase.expired":
      return { type: "other", summary: `${what} expired with no decision.` };
    case "purchase.cancelled":
      return { type: "other", summary: `${what} was cancelled${str(p["reason"]) ? `: ${str(p["reason"])}` : "."}` };
    case "purchase.result_reported":
      return { type: "other", summary: `${agent} reported the order at ${where}${str(p["order_reference"]) ? ` (${str(p["order_reference"])})` : ""}.` };
    case "purchase.failure_reported":
      return { type: "other", summary: `${agent} reported the order at ${where} failed. Its card was cancelled.` };
    case "purchase.completed":
      return { type: "transaction", summary: `Charged ${m(num(p["amount_cents"]))} at ${str(p["merchant_name"]) ?? where}. The card is now closed.` };
    case "credential.issued":
      return { type: "credential_issued", summary: `Single-use card ending ${str(p["last4"]) ?? "····"} issued for ${m(num(p["amount_limit_cents"]))} at ${where}.` };
    case "credential.delivered":
      return { type: "other", summary: `${agent} picked up the card ending ${str(p["last4"]) ?? "····"}.` };
    case "credential.cancelled":
      return { type: "credential_cancelled", summary: `Card ending ${str(p["last4"]) ?? "····"} cancelled.` };
    case "credential.expired":
      return { type: "credential_cancelled", summary: `Card ending ${str(p["last4"]) ?? "····"} expired unused.` };
    case "authorization.approved":
      return { type: "transaction", summary: `Authorized ${m(num(p["amount_cents"]))} at ${str(p["merchant_name"]) ?? where}.` };
    case "refund.received":
      return { type: "refund", summary: `Refund of ${m(num(p["amount_cents"]))} from ${str(p["merchant_name"]) ?? where}. Budget restored.` };
    default:
      return { type: "other", summary: e.type.replace(/[._]/g, " ") };
  }
}

const SECURITY_FALLBACK: Record<string, string> = {
  "security.approval_hash_mismatch": "An approval was attempted on a cart that had changed. Nothing was approved.",
  "security.cart_hash_mismatch": "The cart changed after it was approved, so no card was issued.",
};

function toEvent(e: CoreEvent, purchases: Map<string, CorePurchase>): AuditEvent {
  const purchase = e.purchaseRequestId ? purchases.get(e.purchaseRequestId) : undefined;
  const { type, summary } = describeEvent(e, purchase);
  return {
    id: e.id,
    agentId: e.agentId,
    type,
    rawType: e.type,
    summary,
    requestId: purchase ? purchase.id : undefined,
    createdAt: e.createdAt.getTime(),
  };
}

export function toSnapshot(s: DashboardSnapshot): Snapshot {
  const purchases = new Map(s.purchases.map((p) => [p.id, p]));
  const committed = (a: DashboardSnapshot["agents"][number], w: "per_day" | "per_week" | "per_month") =>
    dollars(a.budget.windows.find((x) => x.window === w)?.committedCents ?? 0);
  return {
    userEmail: s.user.email,
    autoSeenAt: s.user.autoPurchasesSeenAt.getTime(),
    agents: s.agents.map((a) => ({
      id: a.id,
      name: a.name,
      client: a.client,
      status: a.status,
      trustLevel: a.trustLevel,
      createdAt: a.createdAt.getTime(),
      keyPrefix: a.apiKeyPrefix,
      keyRevoked: a.apiKeyRevoked,
      policy: { ...a.rules, version: a.policyVersion },
      spend: {
        today: committed(a, "per_day"),
        week: committed(a, "per_week"),
        month: committed(a, "per_month"),
        ordersToday: a.budget.ordersLast24h,
      },
    })),
    requests: s.purchases.map(toRequest),
    events: s.events.map((e) => toEvent(e, purchases)),
    suggestions: s.suggestions.map((x) => {
      const name = x.category.replace(/_/g, " ");
      const amt = formatMoney(x.maxTotalCents, s.agents.find((a) => a.id === x.agentId)?.currency ?? "USD");
      return {
        id: x.id,
        agentId: x.agentId,
        proposal: `Skip asking you for ${name} orders up to ${amt}?`,
        evidence: `${x.streakCount} ${name} purchases up to ${amt} went through with no issues. New stores and unclear items would still come to you.`,
      };
    }),
  };
}
