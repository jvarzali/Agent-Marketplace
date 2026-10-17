import { normalizeCart, purchaseRequestInputSchema, type PurchaseRequestInput } from "../../src/cart";
import { classifyItemByRules } from "../../src/classifier/rules";
import type { ItemClassification } from "../../src/classifier/types";
import { evaluatePurchase, type EngineInput, type HistoryEntry } from "../../src/policy/engine";
import { parsePolicy, type PolicyRulesInput } from "../../src/policy/schema";

// 2026-10-14 12:00 in America/Los_Angeles (PDT, UTC-7)
export const NOON_LA = new Date("2026-10-14T19:00:00Z");

export const basePolicy: PolicyRulesInput = {
  merchants: { mode: "allowlist", allow_domains: ["amazon.com", "target.com"], deny_mccs: ["7995", "6051", "4829"] },
  categories: { allow: ["groceries", "household", "pet_supplies"], deny: ["gift_cards", "stored_value", "subscriptions", "alcohol", "firearms"] },
  limits: { per_order_total: 75, per_day: 100, per_week: 200, per_month: 500, max_quantity_per_item: 5, max_orders_per_day: 3 },
  approval: { always: false, require_if_total_over: 30, require_for_new_merchant: true },
  schedule: { timezone: "America/Los_Angeles", allowed_hours: "08:00-22:00" },
  currency: "USD",
};

export function policy(overrides: (p: PolicyRulesInput) => void = () => {}) {
  const p = structuredClone(basePolicy);
  overrides(p);
  return parsePolicy(p);
}

export function cartInput(o: Partial<PurchaseRequestInput> = {}): PurchaseRequestInput {
  const items = o.items ?? [{ name: "Organic bananas", unit_price: 3.5, quantity: 2, url: "https://www.amazon.com/dp/B000" }];
  const subtotal = o.subtotal ?? Math.round(items.reduce((s, i) => s + i.unit_price * i.quantity, 0) * 100) / 100;
  const tax = o.tax ?? 0;
  const shipping = o.shipping ?? 0;
  return {
    merchant_domain: "amazon.com",
    merchant_name: "Amazon",
    currency: "USD",
    reasoning: "User asked for groceries",
    ...o,
    items,
    subtotal,
    tax,
    shipping,
    total: o.total ?? Math.round((subtotal + tax + shipping) * 100) / 100,
  };
}

export function cart(o: Partial<PurchaseRequestInput> = {}) {
  return normalizeCart(purchaseRequestInputSchema.parse(cartInput(o)));
}

export function history(entries: Partial<HistoryEntry>[]): HistoryEntry[] {
  return entries.map((e, i) => ({
    id: `h${i}`,
    merchantDomain: "amazon.com",
    status: "completed",
    totalCents: 1000,
    settledCents: null,
    refundedCents: 0,
    createdAt: new Date(NOON_LA.getTime() - 3_600_000 * 3),
    ...e,
  }));
}

export function evaluate(o: Partial<Omit<EngineInput, "classifications">> & { classifications?: ItemClassification[] } = {}) {
  const c = o.cart ?? cart();
  return evaluatePurchase({
    cart: c,
    classifications: o.classifications ?? c.items.map((item, i) => classifyItemByRules(item, i)),
    policy: o.policy ?? policy(),
    agent: o.agent ?? { status: "active" },
    history: o.history ?? [],
    knownMerchants: o.knownMerchants ?? ["amazon.com", "target.com"],
    now: o.now ?? NOON_LA,
  });
}

export function outcome(r: ReturnType<typeof evaluate>, rule: string) {
  return r.checks.find((c) => c.rule === rule)?.outcome;
}
