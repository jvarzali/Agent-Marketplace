import { describe, expect, it } from "vitest";
import { evaluatePurchase } from "../../src/policy/engine";
import { defaultPolicy } from "../../src/policy/templates";
import { safeParsePolicy } from "../../src/policy/schema";
import { cart, evaluate, history, NOON_LA, outcome, policy } from "./helpers";

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOON_LA.getTime() - n * DAY);
const minutesAgo = (n: number) => new Date(NOON_LA.getTime() - n * 60_000);

describe("policy engine: baseline", () => {
  it("allows a small grocery order at a known, allowed store", () => {
    const r = evaluate();
    expect(r.decision).toBe("allow");
    expect(r.reasons).toEqual([]);
  });

  it("records every rule check, not just the deciding one", () => {
    const r = evaluate({ agent: { status: "frozen" } });
    const rules = r.checks.map((c) => c.rule);
    for (const rule of [
      "agent.frozen",
      "cart.subtotal",
      "cart.total",
      "currency",
      "merchants.mcc",
      "categories.item[0]",
      "limits.per_order_total",
      "limits.per_day",
      "limits.per_week",
      "limits.per_month",
      "limits.max_quantity_per_item",
      "limits.max_orders_per_day",
      "limits.order_splitting",
      "schedule",
      "approval.always",
      "approval.total_over",
      "approval.new_merchant",
      "approval.category_uncertain",
    ]) {
      expect(rules).toContain(rule);
    }
  });

  it("is deterministic (pure)", () => {
    expect(evaluate()).toEqual(evaluate());
  });
});

describe("agent status", () => {
  it("denies everything when the agent is frozen", () => {
    const r = evaluate({ agent: { status: "frozen" } });
    expect(r.decision).toBe("deny");
    expect(r.reasons[0]).toMatch(/frozen/);
  });
});

describe("limits apply to the full total (edge case: tax/shipping)", () => {
  it("denies when items are under the per-order limit but tax + shipping push it over", () => {
    const c = cart({ items: [{ name: "Paper towels", unit_price: 35, quantity: 2 }], tax: 4, shipping: 5 });
    expect(c.subtotalCents).toBe(7000);
    expect(c.totalCents).toBe(7900);
    const r = evaluate({ cart: c, policy: policy((p) => (p.approval!.require_if_total_over = null)) });
    expect(r.decision).toBe("deny");
    expect(outcome(r, "limits.per_order_total")).toBe("deny");
    expect(r.reasons.join(" ")).toMatch(/including tax and shipping/);
  });

  it("allows exactly at the per-order limit", () => {
    const c = cart({ items: [{ name: "Paper towels", unit_price: 70, quantity: 1 }], tax: 5 });
    const r = evaluate({ cart: c, policy: policy((p) => (p.approval!.require_if_total_over = null)) });
    expect(outcome(r, "limits.per_order_total")).toBe("pass");
  });
});

describe("rolling windows count in-flight requests (edge case: stacking)", () => {
  const p = policy((x) => {
    x.limits!.per_order_total = 100;
    x.approval!.require_if_total_over = null;
  });
  const sixty = cart({ items: [{ name: "Laundry detergent", unit_price: 60, quantity: 1 }] });

  it("denies a second request that would exceed the weekly budget while the first is still pending", () => {
    const r = evaluate({ cart: sixty, policy: p, history: history([{ status: "pending_approval", totalCents: 15000, createdAt: daysAgo(3) }]) });
    expect(r.decision).toBe("deny");
    expect(outcome(r, "limits.per_week")).toBe("deny");
  });

  it("counts approved and issued-but-unused requests too", () => {
    for (const status of ["approved", "credential_issued"] as const) {
      const r = evaluate({ cart: sixty, policy: p, history: history([{ status, totalCents: 15000, createdAt: daysAgo(3) }]) });
      expect(outcome(r, "limits.per_week")).toBe("deny");
    }
  });

  it("each request alone passes", () => {
    expect(evaluate({ cart: sixty, policy: p }).decision).toBe("allow");
  });

  it("does not count denied, expired or cancelled requests", () => {
    for (const status of ["denied", "expired", "cancelled"] as const) {
      const r = evaluate({ cart: sixty, policy: p, history: history([{ status, totalCents: 15000, createdAt: daysAgo(3) }]) });
      expect(outcome(r, "limits.per_week")).toBe("pass");
    }
  });

  it("uses rolling windows: spend 8 days ago doesn't count against the week but does against the month", () => {
    const r = evaluate({ cart: sixty, policy: p, history: history([{ totalCents: 45000, createdAt: daysAgo(8) }]) });
    expect(outcome(r, "limits.per_week")).toBe("pass");
    expect(outcome(r, "limits.per_month")).toBe("deny");
  });

  it("daily limit uses the last 24 hours", () => {
    const r = evaluate({ cart: sixty, policy: p, history: history([{ totalCents: 5000, createdAt: minutesAgo(60) }]) });
    expect(outcome(r, "limits.per_day")).toBe("deny");
    const r2 = evaluate({ cart: sixty, policy: p, history: history([{ totalCents: 5000, createdAt: new Date(NOON_LA.getTime() - DAY - 1000) }]) });
    expect(outcome(r2, "limits.per_day")).toBe("pass");
  });
});

describe("order splitting", () => {
  const p = policy();
  const small = cart({ items: [{ name: "Dog food", unit_price: 28, quantity: 1 }] });

  it("flags several small orders at the same store that together exceed the per-order limit", () => {
    const h = history([
      { status: "credential_issued", totalCents: 2500, createdAt: minutesAgo(20) },
      { status: "pending_approval", totalCents: 2500, createdAt: minutesAgo(10) },
    ]);
    const r = evaluate({ cart: small, policy: p, history: h });
    expect(outcome(r, "limits.order_splitting")).toBe("needs_approval");
    expect(r.decision).not.toBe("allow");
    expect(r.reasons.join(" ")).toMatch(/split/i);
  });

  it("flags splits that dodge the approval threshold", () => {
    const p2 = policy((x) => (x.limits!.per_order_total = null));
    const tiny = cart({ items: [{ name: "Dog food", unit_price: 20, quantity: 1 }] });
    const r = evaluate({ cart: tiny, policy: p2, history: history([{ status: "completed", totalCents: 2000, createdAt: minutesAgo(5) }]) });
    expect(outcome(r, "approval.total_over")).toBe("pass");
    expect(outcome(r, "limits.order_splitting")).toBe("needs_approval");
    expect(r.decision).toBe("needs_approval");
  });

  it("treats subdomains as the same store", () => {
    const r = evaluate({ cart: small, policy: p, history: history([{ merchantDomain: "smile.amazon.com", totalCents: 5000, createdAt: minutesAgo(5) }]) });
    expect(outcome(r, "limits.order_splitting")).toBe("needs_approval");
  });

  it("ignores orders at other stores and outside the window", () => {
    const h = history([
      { merchantDomain: "target.com", totalCents: 5000, createdAt: minutesAgo(5) },
      { totalCents: 5000, createdAt: minutesAgo(90) },
    ]);
    expect(outcome(evaluate({ cart: small, policy: p, history: h }), "limits.order_splitting")).toBe("pass");
  });
});

describe("restricted categories", () => {
  it("denies a gift card hidden in an otherwise allowed cart", () => {
    const c = cart({
      items: [
        { name: "Organic bananas", unit_price: 3.5, quantity: 2 },
        { name: "Amazon.com eGift Card - Birthday", category: "groceries", unit_price: 10, quantity: 1 },
        { name: "Paper towels", unit_price: 5, quantity: 1 },
      ],
    });
    const r = evaluate({ cart: c });
    expect(r.decision).toBe("deny");
    expect(outcome(r, "categories.item[1]")).toBe("deny");
    expect(outcome(r, "categories.item[0]")).toBe("pass");
  });

  it("denies gift cards and stored value even if the user forgot to list them", () => {
    const p = policy((x) => {
      x.categories = { allow: [], deny: [] };
    });
    for (const name of ["Visa Gift Card $25", "Prepaid debit card reload", "Steam Wallet code"]) {
      const r = evaluate({ cart: cart({ items: [{ name, unit_price: 25, quantity: 1 }] }), policy: p });
      expect(r.decision, name).toBe("deny");
    }
  });

  it("gift cards can't be re-allowed by listing them in allow", () => {
    const p = policy((x) => {
      x.categories = { allow: ["gift_cards", "groceries"], deny: [] };
    });
    const r = evaluate({ cart: cart({ items: [{ name: "Target GiftCard", unit_price: 20, quantity: 1 }] }), policy: p });
    expect(r.decision).toBe("deny");
  });

  it("denies subscriptions by default, allows them only when explicitly allowed", () => {
    const sub = cart({ items: [{ name: "Coffee subscription - monthly plan", unit_price: 20, quantity: 1 }] });
    const open = policy((x) => (x.categories = { allow: [], deny: [] }));
    expect(evaluate({ cart: sub, policy: open }).decision).toBe("deny");
    const allowed = policy((x) => (x.categories = { allow: ["subscriptions"], deny: [] }));
    expect(outcome(evaluate({ cart: sub, policy: allowed }), "categories.item[0]")).toBe("pass");
  });

  it("denies a confidently classified category not on the allow list", () => {
    const r = evaluate({ cart: cart({ items: [{ name: "USB-C charger cable", unit_price: 12, quantity: 1 }] }) });
    expect(outcome(r, "categories.item[0]")).toBe("deny");
  });

  it("denies policy-listed categories like alcohol", () => {
    const r = evaluate({ cart: cart({ items: [{ name: "Red wine 750ml", unit_price: 15, quantity: 1 }] }) });
    expect(r.decision).toBe("deny");
  });
});

describe("category confidence (edge case: low confidence never allows)", () => {
  const permissive = policy((x) => {
    x.categories = { allow: [], deny: [] };
    x.approval = { always: false, require_if_total_over: null, require_for_new_merchant: false };
  });

  it("an unrecognized item with only the agent's label needs approval", () => {
    const r = evaluate({ cart: cart({ items: [{ name: "Widget XJ-9", category: "household", unit_price: 9, quantity: 1 }] }), policy: permissive });
    expect(r.decision).toBe("needs_approval");
    expect(outcome(r, "approval.category_uncertain")).toBe("needs_approval");
  });

  it("an item with no hint at all needs approval", () => {
    const r = evaluate({ cart: cart({ items: [{ name: "Thing", unit_price: 9, quantity: 1 }] }), policy: permissive });
    expect(r.decision).toBe("needs_approval");
  });

  it("a missing classification needs approval", () => {
    const r = evaluate({ policy: permissive, classifications: [] });
    expect(r.decision).toBe("needs_approval");
  });

  it("low confidence is never allowed whatever the classifier says the category is", () => {
    const r = evaluate({ policy: permissive, classifications: [{ index: 0, category: "groceries", confidence: 0.69, source: "llm" }] });
    expect(r.decision).toBe("needs_approval");
  });

  it("require_if_category_uncertain cannot be turned off", () => {
    expect(safeParsePolicy({ approval: { require_if_category_uncertain: false } }).success).toBe(false);
  });
});

describe("merchants", () => {
  it("requires approval at an allowed but never-used store (require_for_new_merchant)", () => {
    const c = cart({ merchant_domain: "target.com", merchant_name: "Target" });
    const r = evaluate({ cart: c, knownMerchants: ["amazon.com"] });
    expect(r.decision).toBe("needs_approval");
    expect(outcome(r, "approval.new_merchant")).toBe("needs_approval");
  });

  it("denies stores outside the allowlist", () => {
    const r = evaluate({ cart: cart({ merchant_domain: "evilamazon.com" }) });
    expect(outcome(r, "merchants.allowlist")).toBe("deny");
  });

  it("allows subdomains of allowed stores", () => {
    const r = evaluate({ cart: cart({ merchant_domain: "https://www.smile.amazon.com/cart" }) });
    expect(outcome(r, "merchants.domain")).toBe("pass");
  });

  it("denies blocked domains in blocklist mode", () => {
    const p = policy((x) => (x.merchants = { mode: "blocklist", deny_domains: ["amazon.com"] }));
    expect(evaluate({ policy: p }).decision).toBe("deny");
  });

  it("denies blocked MCCs, including always-blocked ones the user didn't list", () => {
    expect(outcome(evaluate({ cart: cart({ mcc: "7995" }) }), "merchants.mcc")).toBe("deny");
    expect(outcome(evaluate({ cart: cart({ mcc: "6540" }) }), "merchants.mcc")).toBe("deny");
    expect(outcome(evaluate({ cart: cart({ mcc: "5411" }) }), "merchants.mcc")).toBe("pass");
  });
});

describe("quantity and frequency", () => {
  it("denies quantities above the per-item maximum", () => {
    const r = evaluate({ cart: cart({ items: [{ name: "Organic bananas", unit_price: 1, quantity: 6 }] }) });
    expect(outcome(r, "limits.max_quantity_per_item")).toBe("deny");
  });

  it("denies when the daily order count is reached", () => {
    const h = history([0, 1, 2].map((i) => ({ merchantDomain: "target.com", totalCents: 100, createdAt: minutesAgo(200 + i * 60) })));
    expect(outcome(evaluate({ history: h }), "limits.max_orders_per_day")).toBe("deny");
  });
});

describe("schedule respects the policy timezone", () => {
  it("denies outside allowed hours in the policy's timezone", () => {
    // 05:30 UTC = 22:30 in Los Angeles: outside 08:00-22:00 there, though mid-morning-ish in UTC terms.
    const r = evaluate({ now: new Date("2026-10-15T05:30:00Z") });
    expect(outcome(r, "schedule")).toBe("deny");
    expect(r.reasons.join(" ")).toMatch(/22:30/);
  });

  it("allows inside allowed hours even when it's outside them in UTC", () => {
    // 16:00 UTC = 09:00 LA; 03:00 UTC = 20:00 LA (previous day)
    expect(outcome(evaluate({ now: new Date("2026-10-14T16:00:00Z") }), "schedule")).toBe("pass");
    expect(outcome(evaluate({ now: new Date("2026-10-15T03:00:00Z") }), "schedule")).toBe("pass");
  });

  it("handles windows that wrap midnight", () => {
    const p = policy((x) => (x.schedule = { timezone: "America/New_York", allowed_hours: "22:00-06:00" }));
    expect(outcome(evaluate({ policy: p, now: new Date("2026-10-15T03:00:00Z") }), "schedule")).toBe("pass"); // 23:00 NY
    expect(outcome(evaluate({ policy: p, now: new Date("2026-10-14T16:00:00Z") }), "schedule")).toBe("deny"); // 12:00 NY
  });

  it("start is inclusive, end is exclusive", () => {
    expect(outcome(evaluate({ now: new Date("2026-10-14T15:00:00Z") }), "schedule")).toBe("pass"); // 08:00 LA
    expect(outcome(evaluate({ now: new Date("2026-10-15T05:00:00Z") }), "schedule")).toBe("deny"); // 22:00 LA
  });
});

describe("currency and integrity", () => {
  it("denies a currency mismatch", () => {
    const r = evaluate({ cart: cart({ currency: "EUR" }) });
    expect(outcome(r, "currency")).toBe("deny");
    expect(r.decision).toBe("deny");
  });

  it("denies when the subtotal doesn't match the items", () => {
    const r = evaluate({ cart: cart({ subtotal: 1, total: 1 }) });
    expect(outcome(r, "cart.subtotal")).toBe("deny");
  });

  it("denies when the total isn't subtotal + tax + shipping", () => {
    const r = evaluate({ cart: cart({ tax: 1, total: 7 }) });
    expect(outcome(r, "cart.total")).toBe("deny");
  });
});

describe("refunds restore budget", () => {
  it("counts completed purchases net of refunds", () => {
    const p = policy((x) => {
      x.limits!.per_order_total = 100;
      x.approval!.require_if_total_over = null;
    });
    const c = cart({ items: [{ name: "Laundry detergent", unit_price: 60, quantity: 1 }] });
    const before = evaluate({ cart: c, policy: p, history: history([{ totalCents: 19000, settledCents: 19000, createdAt: daysAgo(3) }]) });
    expect(outcome(before, "limits.per_week")).toBe("deny");
    const after = evaluate({ cart: c, policy: p, history: history([{ totalCents: 19000, settledCents: 19000, refundedCents: 10000, createdAt: daysAgo(3) }]) });
    expect(outcome(after, "limits.per_week")).toBe("pass");
  });
});

describe("approval triggers", () => {
  it("requires approval over the threshold", () => {
    const r = evaluate({ cart: cart({ items: [{ name: "Dog food", unit_price: 40, quantity: 1 }] }) });
    expect(r.decision).toBe("needs_approval");
    expect(outcome(r, "approval.total_over")).toBe("needs_approval");
  });

  it("new agents' default policy requires approval for everything", () => {
    const p = defaultPolicy("America/Los_Angeles");
    expect(p.approval.always).toBe(true);
    const r = evaluatePurchase({ cart: cart(), classifications: [{ index: 0, category: "groceries", confidence: 1, source: "rules" }], policy: p, agent: { status: "active" }, history: [], knownMerchants: ["amazon.com"], now: NOON_LA });
    expect(r.decision).toBe("needs_approval");
  });

  it("auto_approve exempts matching carts from `always`, but not from new-merchant approval", () => {
    const p = policy((x) => {
      x.approval = { always: true, require_for_new_merchant: true, auto_approve: [{ category: "groceries", max_total: 40 }] };
    });
    expect(evaluate({ policy: p }).decision).toBe("allow");
    expect(evaluate({ policy: p, knownMerchants: [] }).decision).toBe("needs_approval");
    const big = cart({ items: [{ name: "Organic bananas", unit_price: 4.5, quantity: 5 }, { name: "Olive oil", unit_price: 20, quantity: 1 }] });
    expect(evaluate({ policy: p, cart: big }).decision).toBe("needs_approval");
    const mixed = cart({ items: [{ name: "Organic bananas", unit_price: 3, quantity: 1 }, { name: "Paper towels", unit_price: 5, quantity: 1 }] });
    expect(evaluate({ policy: p, cart: mixed }).decision).toBe("needs_approval");
  });

  it("deny beats needs_approval", () => {
    const r = evaluate({ cart: cart({ merchant_domain: "target.com", currency: "EUR" }), knownMerchants: [] });
    expect(r.decision).toBe("deny");
    expect(r.reasons[0]).toMatch(/EUR/);
  });
});
