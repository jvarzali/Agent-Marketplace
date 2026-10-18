import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PrivacyCardIssuer, PRIVACY_SIGNATURE_HEADER, privacySignatureCandidates, signPrivacyWebhook, toIssuerEvent } from "../../src/issuer/privacy";
import { WebhookSignatureError } from "../../src/issuer/types";
import { fakePrivacyApi, privacyTxn } from "../privacy-fake";

const KEY = "test_privacy_key";
const issuerWith = (api = fakePrivacyApi()) => ({
  api,
  issuer: new PrivacyCardIssuer({ apiKey: KEY, fetch: api.fetch, cardholderName: "Pat Doe", billingAddress: { line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } }),
});
const params = { purchaseRequestId: "req_1", userId: "u1", amountLimitCents: 2437, currency: "USD", merchantDomain: "staples.com", merchantName: "Staples", allowedMccs: [], blockedMccs: [], expiresAt: new Date() };

describe("PrivacyCardIssuer", () => {
  it("creates a single-use card capped at the approved total, rounded up to whole dollars", async () => {
    const { api, issuer } = issuerWith();
    const card = await issuer.createCard(params);
    expect(card.provider).toBe("privacy");
    expect(api.calls[0]).toMatchObject({ method: "POST", path: "/v1/cards", body: { type: "SINGLE_USE", spend_limit: 2500, spend_limit_duration: "FOREVER", state: "OPEN" } });
  });

  it("refuses non-USD carts", async () => {
    const { issuer } = issuerWith();
    await expect(issuer.createCard({ ...params, currency: "EUR" })).rejects.toThrow(/USD only/);
  });

  it("hands over card details from creation without another API call, then falls back to GET", async () => {
    const { api, issuer } = issuerWith();
    const card = await issuer.createCard(params);
    const s = await issuer.getCardSecrets(card.providerCardId);
    expect(s).toMatchObject({ cvc: "776", expMonth: 6, expYear: 2030, cardholderName: "Pat Doe", billingAddress: { postalCode: "78701" } });
    expect(api.calls).toHaveLength(1);
    await issuer.getCardSecrets(card.providerCardId);
    expect(api.calls[1]).toMatchObject({ method: "GET" });
  });

  it("closes cards idempotently", async () => {
    const { api, issuer } = issuerWith();
    const card = await issuer.createCard(params);
    await issuer.cancelCard(card.providerCardId);
    await issuer.cancelCard(card.providerCardId);
    expect(api.cards.get(card.providerCardId)!.state).toBe("CLOSED");
  });

  it("never puts the API response body (which can hold the PAN) in errors", async () => {
    const api = fakePrivacyApi();
    const issuer = new PrivacyCardIssuer({ apiKey: "wrong", fetch: api.fetch, cardholderName: "x", billingAddress: null });
    await expect(issuer.createCard(params)).rejects.toThrow("Privacy API POST /cards failed: 401 bad key");
  });

  it("verifies X-Privacy-HMAC over key-sorted, whitespace-free JSON", async () => {
    const { issuer } = issuerWith();
    const t = privacyTxn({ token: "t1", card: "card-1", type: "AUTHORIZATION", amount: 2437, descriptor: "STAPLES 0123" });
    const body = JSON.stringify(t, null, 2); // whitespace and key order don't matter
    const ok = await issuer.parseWebhook(body, new Headers({ [PRIVACY_SIGNATURE_HEADER]: signPrivacyWebhook(t, KEY) }));
    expect(ok).toMatchObject({ type: "authorization.created", approved: true, amountCents: 2437, providerCardId: "card-1", merchant: { name: "STAPLES 0123" } });
    await expect(issuer.parseWebhook(body, new Headers({ [PRIVACY_SIGNATURE_HEADER]: signPrivacyWebhook(t, "other") }))).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(issuer.parseWebhook(body, new Headers())).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("accepts Python-style signatures that escape non-ASCII", () => {
    const t = { token: "t", merchant: { descriptor: "CAFÉ" } };
    const python = "{\"merchant\":{\"descriptor\":\"CAF\\u00c9\"},\"token\":\"t\"}";
    const sig = createHmac("sha256", KEY).update(python).digest("base64");
    expect(privacySignatureCandidates(t, KEY)).toContain(sig);
  });

  it("maps transaction lifecycle events", () => {
    expect(toIssuerEvent(privacyTxn({ token: "t", card: "c", type: "CLEARING", amount: 2400, descriptor: "X" }))).toMatchObject({ type: "transaction.capture", amountCents: 2400 });
    expect(toIssuerEvent(privacyTxn({ token: "t", card: "c", type: "RETURN", amount: 500, descriptor: "X" }))).toMatchObject({ type: "transaction.refund", amountCents: 500 });
    expect(toIssuerEvent(privacyTxn({ token: "t", card: "c", type: "VOID", amount: 500, descriptor: "X" }))).toMatchObject({ type: "ignored" });
    expect(toIssuerEvent(privacyTxn({ token: "t", card: "c", type: "AUTHORIZATION", amount: 900, descriptor: "X", result: "USER_TRANSACTION_LIMIT" }))).toMatchObject({ type: "authorization.created", approved: false, declineReason: "user_transaction_limit" });
    // Accounts without the events list: fall back to status.
    expect(toIssuerEvent({ token: "t", card_token: "c", status: "SETTLED", amount: 1200, settled_amount: 1200 })).toMatchObject({ type: "transaction.capture", amountCents: 1200, eventId: "privacy:t:CLEARING" });
  });
});
