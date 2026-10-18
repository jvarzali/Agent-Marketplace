import { describe, expect, it } from "vitest";
import { db, setup } from "../../core/test/integration/harness";
import { createDemoStoreHandler, parseExpiry, priceOrder } from "../src/demo-store";

const officePolicy = {
  merchants: { mode: "allowlist" as const, allow_domains: ["shop.localhost"] },
  categories: { allow: ["office"] },
  limits: { per_order_total: 75, per_day: 150, per_week: 200, per_month: 500, max_quantity_per_item: 5, max_orders_per_day: 10 },
  approval: { always: false, require_if_total_over: 50, require_for_new_merchant: false },
  schedule: { timezone: "America/Los_Angeles", allowed_hours: null },
  currency: "USD" as const,
};

async function shop() {
  const t = await setup(officePolicy);
  const store = createDemoStoreHandler(() => t.wallet);
  const call = (method: string, path: string, form?: Record<string, string>) =>
    store(new Request(`http://shop.localhost:3000${path}`, { method, headers: { host: "shop.localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: form ? new URLSearchParams(form).toString() : undefined }));
  /** The agent's side: ask for 2 packs of paper at the price the checkout page shows, get the card. */
  const getCard = async () => {
    const o = priceOrder((s) => (s === "paper" ? "2" : null));
    const v = await t.wallet.purchases.requestPurchase(t.agent, {
      merchant_domain: "shop.localhost",
      merchant_name: "Bayside Office Supply",
      items: o.lines.map((l) => ({ name: l.name, unit_price: l.unitPriceCents / 100, quantity: l.quantity })),
      subtotal: o.subtotalCents / 100,
      tax: o.taxCents / 100,
      shipping: o.shippingCents / 100,
      total: o.totalCents / 100,
      currency: "USD",
      reasoning: "Printer paper the user asked for",
    });
    expect(v.status).toBe("approved");
    const s = (await t.wallet.purchases.getPurchaseStatus(t.agent, v.id)) as { credential: { number: string; cvc: string; exp_month: number; exp_year: number } };
    const c = s.credential;
    return { id: v.id, form: { paper: "2", name: "Jordan Avery", number: c.number, exp: `${String(c.exp_month).padStart(2, "0")}/${String(c.exp_year).slice(-2)}`, cvc: c.cvc, zip: "94115" } };
  };
  return { t, call, getCard };
}

describe("demo store", () => {
  it("prices orders on the server", () => {
    expect(priceOrder((s) => ({ paper: "2", pens: "1" })[s] ?? null)).toMatchObject({ subtotalCents: 2347, taxCents: 194, shippingCents: 499, totalCents: 3040 });
    expect(priceOrder((s) => (s === "stapler" ? "2" : null)).shippingCents).toBe(0);
    expect(priceOrder(() => "-3").lines).toHaveLength(0);
    expect(parseExpiry("06/30")).toEqual({ month: 6, year: 2030 });
    expect(parseExpiry("13/30")).toBeNull();
  });

  it("shows products and checkout totals", async () => {
    const { call } = await shop();
    const home = await (await call("GET", "/shop")).text();
    expect(home).toContain("Printer paper, 500 sheets");
    expect(home).not.toMatch(/\b(test|demo|fake)\b/i);
    const checkout = await (await call("GET", "/shop/checkout?paper=2")).text();
    expect(checkout).toContain("Order total");
    expect(checkout).toContain("$24.45");
  });

  it("an approved card pays once, completes the purchase, and can't be reused", async () => {
    const { call, getCard } = await shop();
    const { id, form } = await getCard();
    const ok = await call("POST", "/shop/pay", form);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Order confirmed");
    expect((await db.purchaseRequest.findUniqueOrThrow({ where: { id } })).status).toBe("completed");
    const again = await call("POST", "/shop/pay", form);
    expect(again.status).toBe(402);
  });

  it("declines a store that charges more than the approved total", async () => {
    const { call, getCard, t } = await shop();
    const { id, form } = await getCard();
    const res = await call("POST", "/shop/pay", { ...form, mode: "overcharge" });
    expect(res.status).toBe(402);
    expect((await db.purchaseRequest.findUniqueOrThrow({ where: { id } })).status).toBe("credential_issued");
    expect(await db.auditEvent.count({ where: { userId: t.user.id, severity: "security" } })).toBeGreaterThan(0);
  });

  it("declines a charge from a different merchant through the wallet's real-time check", async () => {
    const { call, getCard, t } = await shop();
    const { form } = await getCard();
    const res = await call("POST", "/shop/pay", { ...form, mode: "wrong-merchant" });
    expect(res.status).toBe(402);
    expect(await res.text()).toContain("match what was approved");
    expect(await db.auditEvent.count({ where: { userId: t.user.id, type: "security.authorization_declined" } })).toBe(1);
  });

  it("rejects a wrong card number", async () => {
    const { call, getCard } = await shop();
    const { form } = await getCard();
    const res = await call("POST", "/shop/pay", { ...form, number: "4000000000000002" });
    expect(await res.text()).toContain("card number, expiry or CVC is wrong");
  });
});
