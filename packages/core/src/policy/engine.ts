import { domainMatches, type NormalizedCart } from "../cart";
import type { ItemClassification } from "../classifier/types";
import { formatMoney, toCents } from "../money";
import { ALWAYS_DENIED_CATEGORIES, ALWAYS_DENIED_MCCS, DEFAULT_DENIED_CATEGORIES, type PolicyRules } from "./schema";

export type Decision = "allow" | "deny" | "needs_approval";
export type CheckOutcome = "pass" | "deny" | "needs_approval" | "not_applicable";

export interface RuleCheck {
  /** Stable identifier, e.g. "limits.per_order_total". */
  rule: string;
  outcome: CheckOutcome;
  /** Human-readable explanation, safe to show to the user and the agent. */
  message: string;
}

export type HistoryStatus =
  | "denied"
  | "pending_approval"
  | "approved"
  | "credential_issued"
  | "completed"
  | "expired"
  | "cancelled";

/** A previous purchase request by the same agent. */
export interface HistoryEntry {
  id: string;
  merchantDomain: string;
  status: HistoryStatus;
  totalCents: number;
  settledCents: number | null;
  refundedCents: number;
  createdAt: Date;
}

export interface EngineInput {
  cart: NormalizedCart;
  classifications: ItemClassification[];
  policy: PolicyRules;
  agent: { status: "active" | "frozen" };
  /** At least the last 30 days of this agent's requests. */
  history: HistoryEntry[];
  /** Merchant domains where this agent has a completed purchase (or the user approved one). */
  knownMerchants: string[];
  now: Date;
}

export interface EngineResult {
  decision: Decision;
  /** Every rule that was evaluated, in evaluation order. */
  checks: RuleCheck[];
  /** Messages from the checks that did not pass, deny reasons first. */
  reasons: string[];
}

/** Classifications below this confidence are "uncertain" and need a human. */
export const CATEGORY_CONFIDENCE_THRESHOLD = 0.7;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Statuses whose money is committed: reserved (pending/approved/issued) or spent (completed). */
const COMMITTED: ReadonlySet<HistoryStatus> = new Set(["pending_approval", "approved", "credential_issued", "completed"]);

/**
 * How much of an earlier request counts against budgets. In-flight requests reserve their full
 * total so an agent can't stack requests while one is pending; completed ones count what
 * actually settled, minus refunds.
 */
export function committedCents(e: HistoryEntry): number {
  if (!COMMITTED.has(e.status)) return 0;
  if (e.status === "completed") return Math.max(0, (e.settledCents ?? e.totalCents) - e.refundedCents);
  return e.totalCents;
}

export function windowSpend(history: HistoryEntry[], now: Date, ms: number): number {
  const since = now.getTime() - ms;
  return history.filter((h) => h.createdAt.getTime() > since).reduce((s, h) => s + committedCents(h), 0);
}

export function ordersInWindow(history: HistoryEntry[], now: Date, ms: number): number {
  const since = now.getTime() - ms;
  return history.filter((h) => h.createdAt.getTime() > since && COMMITTED.has(h.status)).length;
}

export const WINDOWS = {
  per_day: DAY,
  per_week: 7 * DAY,
  per_month: 30 * DAY,
} as const;

/**
 * The policy engine. Pure: no I/O, no clock (uses input.now), deterministic.
 *
 * Evaluation order: agent frozen → integrity/currency → hard denies (merchant, MCC, category)
 * → limits → schedule → approval triggers → allow. Every check runs and is recorded, so the
 * user sees every rule that fired. Any deny wins; otherwise any approval trigger wins.
 */
export function evaluatePurchase(input: EngineInput): EngineResult {
  const { cart, policy, now } = input;
  const checks: RuleCheck[] = [];
  const money = (c: number) => formatMoney(c, policy.currency);
  const add = (rule: string, outcome: CheckOutcome, message: string) => checks.push({ rule, outcome, message });

  // 1. Agent status
  if (input.agent.status === "frozen") add("agent.frozen", "deny", "This agent is frozen by its owner. No purchases are allowed.");
  else add("agent.frozen", "pass", "Agent is active.");

  // 2. Request integrity & currency
  const itemsSum = cart.items.reduce((s, i) => s + i.unit_price_cents * i.quantity, 0);
  if (itemsSum !== cart.subtotalCents) {
    add("cart.subtotal", "deny", `Subtotal ${money(cart.subtotalCents)} does not equal the sum of items ${money(itemsSum)}.`);
  } else add("cart.subtotal", "pass", "Subtotal matches items.");
  const expectedTotal = cart.subtotalCents + cart.taxCents + cart.shippingCents;
  if (expectedTotal !== cart.totalCents) {
    add("cart.total", "deny", `Total ${money(cart.totalCents)} does not equal subtotal + tax + shipping (${money(expectedTotal)}).`);
  } else if (cart.totalCents <= 0) {
    add("cart.total", "deny", "Total must be greater than zero.");
  } else add("cart.total", "pass", "Total equals subtotal + tax + shipping.");

  if (cart.currency !== policy.currency) {
    add("currency", "deny", `Purchase is in ${cart.currency}, but this agent may only spend ${policy.currency}.`);
  } else add("currency", "pass", `Currency is ${policy.currency}.`);

  // 3. Hard denies: merchant
  const domain = cart.merchantDomain;
  const m = policy.merchants;
  const deniedDomain = m.deny_domains.find((d) => domainMatches(domain, d));
  if (deniedDomain) add("merchants.deny_domains", "deny", `${domain} is on the blocked store list.`);
  else if (m.mode === "allowlist" && !m.allow_domains.some((d) => domainMatches(domain, d))) {
    add(
      "merchants.allowlist",
      "deny",
      m.allow_domains.length
        ? `${domain} is not an allowed store. Allowed: ${m.allow_domains.join(", ")}.`
        : "No stores are allowed by this agent's policy yet.",
    );
  } else add("merchants.domain", "pass", `${domain} is an allowed store.`);

  const blockedMccs = new Set<string>([...ALWAYS_DENIED_MCCS, ...m.deny_mccs]);
  if (cart.mcc === null) add("merchants.mcc", "not_applicable", "Merchant category code not provided; the issued card still blocks restricted MCCs.");
  else if (blockedMccs.has(cart.mcc)) add("merchants.mcc", "deny", `Merchant category ${cart.mcc} is blocked.`);
  else add("merchants.mcc", "pass", `Merchant category ${cart.mcc} is allowed.`);

  // 3b. Hard denies: categories (every item)
  const allow = new Set(policy.categories.allow);
  const denied = new Set<string>([
    ...ALWAYS_DENIED_CATEGORIES,
    ...(allow.has("subscriptions") ? [] : DEFAULT_DENIED_CATEGORIES),
    ...policy.categories.deny,
  ]);
  // ALWAYS_DENIED cannot be re-allowed even if listed in allow.
  const byIndex = new Map(input.classifications.map((c) => [c.index, c]));
  const uncertain: string[] = [];
  cart.items.forEach((item, i) => {
    const c = byIndex.get(i);
    const label = `"${item.name}"`;
    if (!c || c.confidence < CATEGORY_CONFIDENCE_THRESHOLD) {
      // Uncertain about a restricted category still deserves a human look; never auto-allow.
      uncertain.push(item.name);
      add(
        `categories.item[${i}]`,
        "needs_approval",
        c ? `Not sure what ${label} is (looks like ${c.category.replace(/_/g, " ")}, confidence ${c.confidence.toFixed(2)}).` : `Could not classify ${label}.`,
      );
      return;
    }
    if (denied.has(c.category)) {
      add(`categories.item[${i}]`, "deny", `${label} is ${c.category.replace(/_/g, " ")}, which is never allowed for this agent.`);
    } else if (allow.size && !allow.has(c.category)) {
      add(`categories.item[${i}]`, "deny", `${label} is ${c.category.replace(/_/g, " ")}, which is not an allowed category.`);
    } else add(`categories.item[${i}]`, "pass", `${label} is ${c.category.replace(/_/g, " ")}.`);
  });

  // 4. Limits (on the full total including tax and shipping)
  const l = policy.limits;
  const total = cart.totalCents;
  if (l.per_order_total === null) add("limits.per_order_total", "not_applicable", "No per-order limit.");
  else if (total > toCents(l.per_order_total)) {
    add("limits.per_order_total", "deny", `Order total ${money(total)} (including tax and shipping) is over the per-order limit of ${money(toCents(l.per_order_total))}.`);
  } else add("limits.per_order_total", "pass", `Order total ${money(total)} is within the per-order limit.`);

  for (const key of ["per_day", "per_week", "per_month"] as const) {
    const limit = l[key];
    const label = { per_day: "24-hour", per_week: "7-day", per_month: "30-day" }[key];
    if (limit === null) {
      add(`limits.${key}`, "not_applicable", `No ${label} limit.`);
      continue;
    }
    const spent = windowSpend(input.history, now, WINDOWS[key]);
    const cap = toCents(limit);
    if (spent + total > cap) {
      add(
        `limits.${key}`,
        "deny",
        `This would bring ${label} spending to ${money(spent + total)}, over the ${money(cap)} limit (${money(Math.max(0, cap - spent))} left, counting pending purchases).`,
      );
    } else add(`limits.${key}`, "pass", `${label} spending would be ${money(spent + total)} of ${money(cap)}.`);
  }

  if (l.max_quantity_per_item === null) add("limits.max_quantity_per_item", "not_applicable", "No per-item quantity limit.");
  else {
    const over = cart.items.filter((i) => i.quantity > l.max_quantity_per_item!);
    if (over.length) {
      add("limits.max_quantity_per_item", "deny", `Quantity over ${l.max_quantity_per_item} for: ${over.map((i) => `"${i.name}" (${i.quantity})`).join(", ")}.`);
    } else add("limits.max_quantity_per_item", "pass", "Item quantities are within limits.");
  }

  if (l.max_orders_per_day === null) add("limits.max_orders_per_day", "not_applicable", "No daily order count limit.");
  else {
    const n = ordersInWindow(input.history, now, DAY);
    if (n + 1 > l.max_orders_per_day) add("limits.max_orders_per_day", "deny", `Already ${n} orders in the last 24 hours (limit ${l.max_orders_per_day}).`);
    else add("limits.max_orders_per_day", "pass", `Order ${n + 1} of ${l.max_orders_per_day} in the last 24 hours.`);
  }

  // Order splitting: recent requests at the same store are judged together.
  const splitSince = now.getTime() - l.split_window_minutes * 60_000;
  const sameStore = input.history.filter(
    (h) => h.createdAt.getTime() > splitSince && COMMITTED.has(h.status) && sameMerchant(h.merchantDomain, domain),
  );
  const combined = sameStore.reduce((s, h) => s + committedCents(h), 0) + total;
  const splitThresholds = [
    l.per_order_total !== null ? { name: "per-order limit", cents: toCents(l.per_order_total) } : null,
    policy.approval.require_if_total_over !== null ? { name: "approval threshold", cents: toCents(policy.approval.require_if_total_over) } : null,
  ].filter((x): x is { name: string; cents: number } => x !== null);
  const splitHit = sameStore.length > 0 ? splitThresholds.find((t) => combined > t.cents && total <= t.cents) : undefined;
  if (splitHit) {
    add(
      "limits.order_splitting",
      "needs_approval",
      `Possible split order: ${sameStore.length + 1} orders at ${domain} in ${l.split_window_minutes} minutes total ${money(combined)}, over the ${splitHit.name} of ${money(splitHit.cents)}.`,
    );
  } else add("limits.order_splitting", "pass", "No sign of order splitting.");

  // 5. Schedule
  const s = policy.schedule;
  if (!s.allowed_hours) add("schedule", "not_applicable", "No time-of-day restriction.");
  else {
    const local = localMinutes(now, s.timezone);
    if (!inWindow(local, s.allowed_hours)) {
      add("schedule", "deny", `Purchases are only allowed ${s.allowed_hours} (${s.timezone}); it is ${fmtMinutes(local)} there now.`);
    } else add("schedule", "pass", `Within allowed hours (${s.allowed_hours} ${s.timezone}).`);
  }

  // 6. Approval triggers
  const a = policy.approval;
  const autoRule = a.auto_approve.find(
    (r) =>
      total <= toCents(r.max_total) &&
      cart.items.every((_, i) => {
        const c = byIndex.get(i);
        return !!c && c.confidence >= CATEGORY_CONFIDENCE_THRESHOLD && c.category === r.category;
      }),
  );
  if (a.always) {
    if (autoRule) add("approval.always", "pass", `Auto-approved: ${autoRule.category.replace(/_/g, " ")} up to ${money(toCents(autoRule.max_total))}.`);
    else add("approval.always", "needs_approval", "This agent's owner approves every purchase.");
  } else add("approval.always", "not_applicable", "Not every purchase needs approval.");

  if (a.require_if_total_over === null) add("approval.total_over", "not_applicable", "No approval threshold.");
  else if (total > toCents(a.require_if_total_over) && !autoRule) {
    add("approval.total_over", "needs_approval", `Orders over ${money(toCents(a.require_if_total_over))} need approval.`);
  } else add("approval.total_over", "pass", `Under the approval threshold of ${money(toCents(a.require_if_total_over))}.`);

  const known = input.knownMerchants.some((k) => sameMerchant(k, domain));
  if (!a.require_for_new_merchant) add("approval.new_merchant", "not_applicable", "New stores don't need approval.");
  else if (!known) add("approval.new_merchant", "needs_approval", `First purchase at ${domain}.`);
  else add("approval.new_merchant", "pass", `${domain} has been used before.`);

  if (uncertain.length) add("approval.category_uncertain", "needs_approval", `Uncertain category for: ${uncertain.map((n) => `"${n}"`).join(", ")}.`);
  else add("approval.category_uncertain", "pass", "All items confidently classified.");

  const decision: Decision = checks.some((c) => c.outcome === "deny")
    ? "deny"
    : checks.some((c) => c.outcome === "needs_approval")
      ? "needs_approval"
      : "allow";
  const reasons = [
    ...checks.filter((c) => c.outcome === "deny"),
    ...checks.filter((c) => c.outcome === "needs_approval" && !c.rule.startsWith("categories.item")),
  ].map((c) => c.message);
  return { decision, checks, reasons };
}

function sameMerchant(a: string, b: string): boolean {
  return domainMatches(a, b) || domainMatches(b, a);
}

/** Minutes since local midnight in the given IANA timezone. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (h % 24) * 60 + m;
}

/** "HH:MM-HH:MM", start inclusive, end exclusive; wraps midnight when end < start. */
export function inWindow(minutes: number, window: string): boolean {
  const [a, b] = window.split("-").map((t) => {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  }) as [number, number];
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

function fmtMinutes(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
