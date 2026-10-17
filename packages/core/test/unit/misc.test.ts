import { describe, expect, it } from "vitest";
import { cartHash, normalizeDomain, purchaseRequestInputSchema } from "../../src/cart";
import { classifyItemByRules, CompositeClassifier } from "../../src/classifier/rules";
import type { ItemClassifier } from "../../src/classifier/types";
import { MockCardIssuer, MOCK_SIGNATURE_HEADER } from "../../src/issuer/mock";
import { WebhookSignatureError } from "../../src/issuer/types";
import { redact } from "../../src/logger";
import { computeBudget } from "../../src/policy/budget";
import { describePolicyText } from "../../src/policy/describe";
import { policyTemplates } from "../../src/policy/templates";
import { escapeHtml, generateApiKey, hashApiKey, MemoryRateLimiter, safeHttpUrl } from "../../src/security";
import { computeTrustLevel, computeTrustSuggestions, type TrustHistoryItem } from "../../src/trust";
import { cart, history, NOON_LA, policy } from "./helpers";

describe("cart hash", () => {
  const base = cart({
    items: [
      { name: "Organic bananas", unit_price: 3.5, quantity: 2 },
      { name: "Paper towels", unit_price: 5, quantity: 1 },
    ],
    tax: 1,
    shipping: 2,
  });

  it("is stable and order-independent", () => {
    const reordered = { ...base, items: [...base.items].reverse() };
    expect(cartHash(base)).toBe(cartHash(reordered));
    expect(cartHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores the agent's reasoning and merchant display name", () => {
    expect(cartHash({ ...base, reasoning: "different" } as typeof base)).toBe(cartHash(base));
    expect(cartHash({ ...base, merchantName: "AMZN" } as typeof base)).toBe(cartHash(base));
  });

  it.each([
    ["merchant", { merchantDomain: "target.com" }],
    ["tax", { taxCents: 101 }],
    ["shipping", { shippingCents: 0 }],
    ["total", { totalCents: 1 }],
    ["currency", { currency: "EUR" }],
  ])("changes when %s changes", (_, change) => {
    expect(cartHash({ ...base, ...change })).not.toBe(cartHash(base));
  });

  it("changes when an item's price, quantity, name or url changes", () => {
    const mod = (f: (i: (typeof base.items)[number]) => void) => {
      const items = structuredClone(base.items);
      f(items[0]!);
      return cartHash({ ...base, items });
    };
    expect(mod((i) => (i.unit_price_cents += 1))).not.toBe(cartHash(base));
    expect(mod((i) => (i.quantity += 1))).not.toBe(cartHash(base));
    expect(mod((i) => (i.name = "Bananas"))).not.toBe(cartHash(base));
    expect(mod((i) => (i.url = "https://amazon.com/x"))).not.toBe(cartHash(base));
  });
});

describe("cart input validation", () => {
  it("rejects more than 2 decimals, negative amounts, and non-http urls", () => {
    const ok = { merchant_domain: "amazon.com", merchant_name: "A", items: [{ name: "x", unit_price: 1, quantity: 1 }], subtotal: 1, total: 1, currency: "USD", reasoning: "r" };
    expect(purchaseRequestInputSchema.safeParse(ok).success).toBe(true);
    expect(purchaseRequestInputSchema.safeParse({ ...ok, total: 1.001 }).success).toBe(false);
    expect(purchaseRequestInputSchema.safeParse({ ...ok, tax: -1 }).success).toBe(false);
    expect(purchaseRequestInputSchema.safeParse({ ...ok, items: [{ name: "x", unit_price: 1, quantity: 1, url: "javascript:alert(1)" }] }).success).toBe(false);
  });

  it("normalizes domains", () => {
    expect(normalizeDomain("https://WWW.Amazon.com/dp/123")).toBe("amazon.com");
    expect(normalizeDomain("target.com")).toBe("target.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
  });
});

describe("rule-based classifier", () => {
  const c = (name: string, category?: string, url?: string) =>
    classifyItemByRules({ name, category_hint: category ?? null, unit_price_cents: 100, quantity: 1, url: url ?? null }, 0);

  it("restricted keywords win over everything", () => {
    expect(c("Snack gift card bundle", "groceries")).toMatchObject({ category: "gift_cards", confidence: 0.9 });
  });

  it("detects restricted items from the URL path", () => {
    expect(c("Birthday card", undefined, "https://amazon.com/Amazon-eGift-Card/dp/B0")).toMatchObject({ category: "gift_cards" });
  });

  it("trusts the agent's restricted label", () => {
    expect(c("Mystery item", "stored_value").category).toBe("stored_value");
  });

  it("classifies common groceries confidently", () => {
    expect(c("Organic bananas")).toMatchObject({ category: "groceries" });
    expect(c("Organic bananas").confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("gives low confidence to an agent-only label", () => {
    expect(c("Widget", "groceries").confidence).toBeLessThan(0.7);
  });

  it("gives low confidence when rules and agent disagree", () => {
    expect(c("USB cable", "groceries").confidence).toBeLessThan(0.7);
  });

  it("composite classifier uses the fallback only for unsure items and never overrides restricted hits", async () => {
    const fallback: ItemClassifier = { classify: async (items) => items.map((_, i) => ({ index: i, category: "household", confidence: 0.95, source: "llm" as const })) };
    const comp = new CompositeClassifier(fallback);
    const items = [
      { name: "Gift card", category_hint: null, unit_price_cents: 1, quantity: 1, url: null },
      { name: "Widget", category_hint: null, unit_price_cents: 1, quantity: 1, url: null },
    ];
    const out = await comp.classify(items, { merchantDomain: "a.com", mcc: null });
    expect(out[0]).toMatchObject({ index: 0, category: "gift_cards" });
    expect(out[1]).toMatchObject({ index: 1, category: "household", source: "llm" });
  });

  it("composite classifier keeps low confidence if the fallback throws", async () => {
    const comp = new CompositeClassifier({ classify: async () => Promise.reject(new Error("down")) });
    const out = await comp.classify([{ name: "Widget", category_hint: null, unit_price_cents: 1, quantity: 1, url: null }], { merchantDomain: "a.com", mcc: null });
    expect(out[0]!.confidence).toBe(0);
  });
});

describe("budget", () => {
  it("reports remaining per window including pending amounts", () => {
    const b = computeBudget(policy(), history([{ status: "pending_approval", totalCents: 4000, createdAt: new Date(NOON_LA.getTime() - 3_600_000) }]), NOON_LA);
    expect(b.windows.find((w) => w.window === "per_day")).toMatchObject({ limitCents: 10000, committedCents: 4000, remainingCents: 6000 });
    expect(b.ordersLeftToday).toBe(2);
    expect(b.maxNextOrderCents).toBe(6000);
  });

  it("max next order is 0 when out of orders", () => {
    const h = history([1, 2, 3].map((i) => ({ totalCents: 100, createdAt: new Date(NOON_LA.getTime() - i * 3_600_000) })));
    expect(computeBudget(policy(), h, NOON_LA).maxNextOrderCents).toBe(0);
  });
});

describe("policy description", () => {
  it("describes the brief's example policy in plain English", () => {
    const text = describePolicyText(policy());
    expect(text).toContain("Only these stores: amazon.com, target.com");
    expect(text).toContain("At most $75.00 per order, including tax and shipping.");
    expect(text).toContain("Only between 08:00 and 22:00 (America/Los_Angeles).");
    expect(text).toContain("gift cards");
    expect(text).toContain("A human approves any order over $30.00.");
  });

  it("templates are valid and require approval for everything", () => {
    for (const t of policyTemplates("America/Chicago")) expect(t.rules.approval.always).toBe(true);
  });
});

describe("trust suggestions", () => {
  const item = (i: number, o: Partial<TrustHistoryItem> = {}): TrustHistoryItem => ({
    id: `t${i}`,
    status: "completed",
    categories: ["groceries"],
    totalCents: 3000 + i * 50,
    createdAt: new Date(NOON_LA.getTime() - i * 86_400_000),
    hadIncident: false,
    ...o,
  });
  const always = policy((p) => (p.approval!.always = true));

  it("suggests auto-approving a category after a clean streak", () => {
    const s = computeTrustSuggestions(always, Array.from({ length: 15 }, (_, i) => item(i)), { now: NOON_LA, minStreak: 10 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ category: "groceries", streakCount: 15, maxTotalCents: 4000 });
    expect(s[0]!.message).toMatch(/^15 groceries purchases up to \$40\.00 with no issues\. Auto-approve groceries up to \$40\.00\?$/);
  });

  it("an incident breaks the streak", () => {
    const h = Array.from({ length: 15 }, (_, i) => item(i, i === 3 ? { hadIncident: true } : {}));
    expect(computeTrustSuggestions(always, h, { now: NOON_LA, minStreak: 10 })).toHaveLength(0);
  });

  it("does not suggest when approval isn't required anyway, or already auto-approved", () => {
    const h = Array.from({ length: 15 }, (_, i) => item(i));
    const lax = policy((p) => (p.approval = { always: false, require_if_total_over: 100 }));
    expect(computeTrustSuggestions(lax, h, { now: NOON_LA })).toHaveLength(0);
    const auto = policy((p) => (p.approval = { always: true, auto_approve: [{ category: "groceries", max_total: 50 }] }));
    expect(computeTrustSuggestions(auto, h, { now: NOON_LA })).toHaveLength(0);
  });

  it("never suggests restricted categories and never above the per-order limit", () => {
    const gifts = Array.from({ length: 15 }, (_, i) => item(i, { categories: ["gift_cards"] }));
    expect(computeTrustSuggestions(always, gifts, { now: NOON_LA })).toHaveLength(0);
    const big = Array.from({ length: 15 }, (_, i) => item(i, { totalCents: 9000 }));
    const s = computeTrustSuggestions(always, big, { now: NOON_LA });
    expect(s[0]!.maxTotalCents).toBe(7500);
  });

  it("trust level grows with clean history and drops after an incident", () => {
    expect(computeTrustLevel([], NOON_LA)).toBe(0);
    const clean = Array.from({ length: 30 }, (_, i) => item(i));
    expect(computeTrustLevel(clean, NOON_LA)).toBe(3);
    expect(computeTrustLevel([...clean, item(1, { hadIncident: true })], NOON_LA)).toBe(1);
  });
});

describe("security helpers", () => {
  it("API keys: random, prefixed, hashed", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.key.startsWith("aw_")).toBe(true);
    expect(a.hash).toBe(hashApiKey(a.key));
    expect(a.hash).not.toContain(a.key);
  });

  it("escapes HTML and only allows http(s) links", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">`)).toBe("&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("https://amazon.com/x")).toBe("https://amazon.com/x");
  });

  it("redacts card data from logs", () => {
    const out = redact({ number: "4000001234567899", nested: { cvc: "123", note: "card 4000 0012 3456 7899 used" }, last4: "7899" }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("4000001234567899");
    expect(JSON.stringify(out)).not.toContain("4000 0012 3456 7899");
    expect(JSON.stringify(out)).not.toContain('"123"');
    expect(out.last4).toBe("7899");
  });

  it("rate limiter blocks after the limit within a window", async () => {
    let t = 0;
    const rl = new MemoryRateLimiter(2, 1000, () => t);
    expect(await rl.take("k")).toBe(true);
    expect(await rl.take("k")).toBe(true);
    expect(await rl.take("k")).toBe(false);
    t = 1000;
    expect(await rl.take("k")).toBe(true);
  });
});

describe("mock card issuer", () => {
  it("rejects webhooks with a bad signature", async () => {
    const m = new MockCardIssuer("s");
    await expect(m.parseWebhook("{}", new Headers({ [MOCK_SIGNATURE_HEADER]: "00" }))).rejects.toBeInstanceOf(WebhookSignatureError);
    const body = JSON.stringify({ type: "ignored", eventId: "e", providerType: "x", raw: null });
    await expect(m.parseWebhook(body, new Headers({ [MOCK_SIGNATURE_HEADER]: m.sign(body) }))).resolves.toMatchObject({ type: "ignored" });
  });

  it("enforces amount, MCC, expiry and single use at the network level", async () => {
    let now = new Date("2026-10-14T19:00:00Z");
    const m = new MockCardIssuer("s", () => now);
    const card = await m.createCard({
      purchaseRequestId: "p",
      userId: "u",
      amountLimitCents: 1000,
      currency: "USD",
      merchantDomain: "amazon.com",
      merchantName: "Amazon",
      allowedMccs: [],
      blockedMccs: ["7995"],
      expiresAt: new Date(now.getTime() + 30 * 60_000),
    });
    const approve = async () => ({ status: 200, body: JSON.stringify({ approved: true }) });
    const merchant = { name: "Amazon", mcc: "5411", domain: null, country: "US" };
    expect((await m.simulateCharge({ providerCardId: card.providerCardId, amountCents: 1001, merchant, deliver: approve })).reason).toBe("spending_controls");
    expect((await m.simulateCharge({ providerCardId: card.providerCardId, amountCents: 500, merchant: { ...merchant, mcc: "7995" }, deliver: approve })).reason).toBe("spending_controls");
    now = new Date(now.getTime() + 31 * 60_000);
    expect((await m.simulateCharge({ providerCardId: card.providerCardId, amountCents: 500, merchant, deliver: approve })).reason).toBe("card_expired");
    now = new Date("2026-10-14T19:00:00Z");
    expect((await m.simulateCharge({ providerCardId: card.providerCardId, amountCents: 500, merchant, deliver: approve })).approved).toBe(true);
    expect((await m.simulateCharge({ providerCardId: card.providerCardId, amountCents: 1, merchant, deliver: approve })).reason).toBe("card_canceled");
  });

  it("generates Luhn-valid test numbers and never the same twice", async () => {
    const m = new MockCardIssuer();
    const p = { purchaseRequestId: "p", userId: "u", amountLimitCents: 1, currency: "USD", merchantDomain: "a.com", merchantName: "A", allowedMccs: [], blockedMccs: [], expiresAt: new Date() };
    const a = await m.getCardSecrets((await m.createCard(p)).providerCardId);
    const b = await m.getCardSecrets((await m.createCard(p)).providerCardId);
    const luhn = (n: string) => [...n].reverse().reduce((s, d, i) => s + (i % 2 ? ((Number(d) * 2) % 10) + Math.floor((Number(d) * 2) / 10) : Number(d)), 0) % 10 === 0;
    expect(luhn(a.number)).toBe(true);
    expect(a.number).not.toBe(b.number);
  });
});
