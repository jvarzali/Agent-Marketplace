import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { isStripeTestKey, StripeIssuingCardIssuer } from "../../src/issuer/stripe";
import { WebhookSignatureError } from "../../src/issuer/types";

const WHSEC = "whsec_test_secret";

/** A real Stripe client (for webhook signing) with the API calls replaced by fakes. */
function fakeStripe() {
  const stripe = new Stripe("sk_test_fake");
  const cards = [
    { id: "ic_other", last4: "4242", number: "4000009990000000", cvc: "111" },
    { id: "ic_1", last4: "4242", number: "4000009990004242", cvc: "123" },
  ];
  const fns = {
    create: vi.fn(async (p: Stripe.Issuing.CardCreateParams) => ({ id: "ic_new", last4: "0005", ...p })),
    list: vi.fn(async () => ({ data: cards.map(({ id, last4 }) => ({ id, last4 })) })),
    retrieve: vi.fn(async (id: string) => cards.find((c) => c.id === id)!),
    authCreate: vi.fn(async (p: { card: string; amount: number }) => ({ id: "iauth_1", approved: p.amount <= 2500, request_history: [{ reason: p.amount <= 2500 ? "webhook_approved" : "webhook_declined" }] })),
    capture: vi.fn(async () => ({})),
  };
  Object.assign(stripe.issuing.cards, { create: fns.create, list: fns.list, retrieve: fns.retrieve });
  Object.assign(stripe.testHelpers.issuing.authorizations, { create: fns.authCreate, capture: fns.capture });
  return { stripe, fns };
}

const issuerWith = (key = "sk_test_fake") => {
  const f = fakeStripe();
  return { ...f, issuer: new StripeIssuingCardIssuer({ secretKey: key, webhookSecret: WHSEC, resolveCardholder: async () => "ich_1", client: f.stripe }) };
};

const signed = (stripe: Stripe, event: object) => {
  const payload = JSON.stringify(event);
  return { payload, headers: new Headers({ "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) }) };
};

describe("StripeIssuingCardIssuer", () => {
  it("creates a single-use virtual card capped at the approved amount", async () => {
    const { issuer, fns } = issuerWith();
    const card = await issuer.createCard({ purchaseRequestId: "req_1", userId: "u1", amountLimitCents: 2537, currency: "USD", merchantDomain: "shop.localhost", merchantName: "Demo", allowedMccs: [], blockedMccs: ["7995"], expiresAt: new Date("2026-10-14T19:30:00Z") });
    expect(card).toEqual({ provider: "stripe", providerCardId: "ic_new", last4: "0005" });
    const [params, opts] = fns.create.mock.calls[0] as unknown as [Stripe.Issuing.CardCreateParams, { idempotencyKey: string }];
    expect(params).toMatchObject({
      cardholder: "ich_1",
      currency: "usd",
      type: "virtual",
      status: "active",
      lifecycle_controls: { cancel_after: { payment_count: 1 } },
      spending_controls: { spending_limits: [{ amount: 2537, interval: "per_authorization" }, { amount: 2537, interval: "all_time" }], blocked_categories: ["betting_casino_gambling"] },
    });
    expect(opts.idempotencyKey).toBe("card_req_1");
  });

  it("finds the financial account when Stripe asks for one, then reuses it", async () => {
    const { issuer, fns, stripe } = issuerWith();
    const needFa = Object.assign(new Error("You need a financial account to create a card."), { param: "financial_account_v2" });
    fns.create.mockImplementation(async (p: Stripe.Issuing.CardCreateParams) => {
      if (!(p as { financial_account_v2?: string }).financial_account_v2) throw needFa;
      return { id: "ic_fa", last4: "0013", ...p } as never;
    });
    const raw = vi.fn(async () => ({ data: [{ id: "fa_closed", status: "closed" }, { id: "fa_test_1", status: "open" }] }));
    Object.assign(stripe, { rawRequest: raw });
    const params = { purchaseRequestId: "req_fa", userId: "u1", amountLimitCents: 100, currency: "USD", merchantDomain: "a.com", merchantName: "A", allowedMccs: [], blockedMccs: [], expiresAt: new Date() };
    expect((await issuer.createCard(params)).providerCardId).toBe("ic_fa");
    expect(fns.create.mock.calls[1]![0]).toMatchObject({ financial_account_v2: "fa_test_1" });
    await issuer.createCard({ ...params, purchaseRequestId: "req_fa2" });
    expect(fns.create.mock.calls[2]![0]).toMatchObject({ financial_account_v2: "fa_test_1" });
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("verifies signatures and parses the real-time authorization request", async () => {
    const { issuer, stripe } = issuerWith();
    const { payload, headers } = signed(stripe, {
      id: "evt_1",
      object: "event",
      type: "issuing_authorization.request",
      data: { object: { id: "iauth_1", amount: 0, currency: "usd", pending_request: { amount: 2446, currency: "usd" }, card: { id: "ic_1" }, merchant_data: { name: "DEMO OFFICE SUPPLY", category_code: "5943", url: "https://www.shop.localhost", country: "US" } } },
    });
    expect(await issuer.parseWebhook(payload, headers)).toMatchObject({ type: "authorization.request", authorizationId: "iauth_1", providerCardId: "ic_1", amountCents: 2446, currency: "USD", merchant: { domain: "shop.localhost", mcc: "5943" } });
    await expect(issuer.parseWebhook(payload, new Headers({ "stripe-signature": "t=1,v1=bad" }))).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(issuer.parseWebhook(payload, new Headers())).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("answers authorization requests with Stripe-Version and the decision", () => {
    const { issuer } = issuerWith();
    const ev = { type: "authorization.request" as const, eventId: "e", authorizationId: "a", providerCardId: "c", amountCents: 1, currency: "USD", merchant: { name: "", mcc: null, domain: null, country: null }, raw: null };
    const r = issuer.webhookResponse(ev, { approved: false, reason: "amount over approval" });
    expect(r.headers["stripe-version"]).toBe(Stripe.API_VERSION);
    expect(JSON.parse(r.body)).toEqual({ approved: false, metadata: { agent_wallet_reason: "amount over approval" } });
  });

  it("parses captures and refunds with positive amounts", async () => {
    const { issuer, stripe } = issuerWith();
    const txn = (type: string, amount: number) =>
      signed(stripe, { id: `evt_${type}`, object: "event", type: "issuing_transaction.created", data: { object: { id: "ipi_1", type, amount, currency: "usd", authorization: "iauth_1", card: "ic_1", merchant_data: { name: "DEMO" } } } });
    const cap = txn("capture", -2446);
    expect(await issuer.parseWebhook(cap.payload, cap.headers)).toMatchObject({ type: "transaction.capture", amountCents: 2446, authorizationId: "iauth_1" });
    const ref = txn("refund", 500);
    expect(await issuer.parseWebhook(ref.payload, ref.headers)).toMatchObject({ type: "transaction.refund", amountCents: 500 });
  });

  it("test charges find the card by number and capture approved charges", async () => {
    const { issuer, fns } = issuerWith();
    const base = { currency: "USD", merchant: { name: "DEMO OFFICE SUPPLY", domain: "shop.localhost", mcc: "5943", country: "US" }, deliver: async () => ({ status: 200, body: "" }) };
    const card = { number: "4000 0099 9000 4242", expMonth: 6, expYear: 2030, cvc: "123" };
    expect(await issuer.testCharge({ ...base, card, amountCents: 2446 })).toEqual({ approved: true, reason: null, authorizationId: "iauth_1" });
    expect(fns.authCreate.mock.calls[0]![0]).toMatchObject({ card: "ic_1", amount: 2446, currency: "usd", merchant_data: { name: "DEMO OFFICE SUPPLY", url: "shop.localhost", category: "stationery_stores_office_and_school_supply_stores" } });
    expect(fns.capture).toHaveBeenCalledWith("iauth_1");

    expect(await issuer.testCharge({ ...base, card, amountCents: 9000 })).toMatchObject({ approved: false, reason: "webhook_declined" });
    expect(fns.capture).toHaveBeenCalledTimes(1);
    expect(await issuer.testCharge({ ...base, card: { ...card, cvc: "999" }, amountCents: 100 })).toMatchObject({ approved: false, reason: "card_not_found" });
  });

  it("only allows test charges with a test-mode key", async () => {
    expect(isStripeTestKey("sk_test_123")).toBe(true);
    expect(isStripeTestKey("rk_test_123")).toBe(true);
    expect(isStripeTestKey("sk_live_123")).toBe(false);
    const { issuer } = issuerWith("sk_live_fake");
    expect(issuer.supportsTestCharges).toBe(false);
    await expect(issuer.testCharge({ card: { number: "1", expMonth: 1, expYear: 2030, cvc: "1" }, amountCents: 1, currency: "USD", merchant: { name: "x", mcc: null, domain: null, country: null }, deliver: async () => ({ status: 200, body: "" }) })).rejects.toThrow(/test-mode key/);
  });
});
