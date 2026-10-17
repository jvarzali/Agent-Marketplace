import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  WebhookSignatureError,
  type AuthorizationDecision,
  type CardIssuer,
  type CardSecrets,
  type CreateCardParams,
  type IssuedCard,
  type IssuerEvent,
  type IssuerMerchant,
  type WebhookResponse,
} from "./types";

interface MockCard {
  id: string;
  params: CreateCardParams;
  number: string;
  cvc: string;
  status: "active" | "canceled";
  /** Single-use: becomes true after the first approved authorization. */
  used: boolean;
}

export interface SimulatedCharge {
  providerCardId: string;
  amountCents: number;
  currency?: string;
  merchant: IssuerMerchant;
  /** Also emit a capture after an approved authorization (default true). */
  capture?: boolean;
  /** Delivers a signed webhook to our service; returns its HTTP response. */
  deliver: (rawBody: string, headers: Headers) => Promise<{ status: number; body: string }>;
}

export interface SimulatedChargeResult {
  approved: boolean;
  declinedBy: "issuer" | "wallet" | null;
  reason: string | null;
  authorizationId: string;
}

export const MOCK_SIGNATURE_HEADER = "x-mock-issuer-signature";

/**
 * In-memory card issuer for development and tests. Emulates what a real issuer + card
 * network enforce on their own (amount cap, MCC blocks, expiry, single use, cancellation)
 * and calls our real-time authorization webhook like Stripe does.
 */
export class MockCardIssuer implements CardIssuer {
  readonly provider = "mock";
  private readonly cards = new Map<string, MockCard>();

  constructor(private readonly webhookSecret: string = "mock_webhook_secret", private readonly now: () => Date = () => new Date()) {}

  async createCard(params: CreateCardParams): Promise<IssuedCard> {
    const id = `mock_card_${randomUUID()}`;
    const number = fakePan(id);
    this.cards.set(id, { id, params, number, cvc: number.slice(-3), status: "active", used: false });
    return { provider: this.provider, providerCardId: id, last4: number.slice(-4) };
  }

  async getCardSecrets(providerCardId: string): Promise<CardSecrets> {
    const card = this.mustGet(providerCardId);
    const exp = card.params.expiresAt;
    return {
      number: card.number,
      cvc: card.cvc,
      expMonth: exp.getUTCMonth() + 1,
      expYear: exp.getUTCFullYear() + 1, // network expiry is coarse; real lifetime is enforced by cancellation
      last4: card.number.slice(-4),
      cardholderName: "Agent Wallet Test",
      billingAddress: { line1: "123 Test Street", city: "San Francisco", state: "CA", postalCode: "94111", country: "US" },
    };
  }

  async cancelCard(providerCardId: string): Promise<void> {
    const card = this.cards.get(providerCardId);
    if (card) card.status = "canceled";
  }

  /** Test helper. */
  getCard(providerCardId: string): Readonly<MockCard> | undefined {
    return this.cards.get(providerCardId);
  }

  sign(rawBody: string): string {
    return createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
  }

  async parseWebhook(rawBody: string, headers: Headers): Promise<IssuerEvent> {
    const sig = headers.get(MOCK_SIGNATURE_HEADER) ?? "";
    const expected = this.sign(rawBody);
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookSignatureError("invalid mock issuer signature");
    return JSON.parse(rawBody) as IssuerEvent;
  }

  webhookResponse(event: IssuerEvent, decision: AuthorizationDecision | null): WebhookResponse {
    if (event.type === "authorization.request") {
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: decision?.approved ?? false }) };
    }
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ received: true }) };
  }

  /** Simulate a merchant charging a card, end to end through our webhook endpoint. */
  async simulateCharge(c: SimulatedCharge): Promise<SimulatedChargeResult> {
    const card = this.mustGet(c.providerCardId);
    const currency = c.currency ?? card.params.currency;
    const authorizationId = `mock_auth_${randomUUID()}`;
    const base = { authorizationId, providerCardId: card.id, amountCents: c.amountCents, currency, merchant: c.merchant };

    const send = async (event: IssuerEvent) => {
      const body = JSON.stringify(event);
      return c.deliver(body, new Headers({ [MOCK_SIGNATURE_HEADER]: this.sign(body), "content-type": "application/json" }));
    };

    const issuerDecline = this.networkControls(card, c.amountCents, currency, c.merchant);
    if (issuerDecline) {
      await send({ type: "authorization.created", eventId: `evt_${randomUUID()}`, ...base, approved: false, declineReason: issuerDecline, raw: null });
      return { approved: false, declinedBy: "issuer", reason: issuerDecline, authorizationId };
    }

    const res = await send({ type: "authorization.request", eventId: `evt_${randomUUID()}`, ...base, raw: null });
    let approved = false;
    try {
      approved = res.status === 200 && (JSON.parse(res.body) as { approved?: boolean }).approved === true;
    } catch {
      approved = false;
    }
    const reason = approved ? null : "webhook_declined";
    await send({ type: "authorization.created", eventId: `evt_${randomUUID()}`, ...base, approved, declineReason: reason, raw: null });
    if (!approved) return { approved: false, declinedBy: "wallet", reason, authorizationId };

    card.used = true;
    card.status = "canceled"; // single-use lifecycle control
    if (c.capture !== false) {
      await send({
        type: "transaction.capture",
        eventId: `evt_${randomUUID()}`,
        transactionId: `mock_txn_${randomUUID()}`,
        authorizationId,
        providerCardId: card.id,
        amountCents: c.amountCents,
        currency,
        merchant: c.merchant,
        raw: null,
      });
    }
    return { approved: true, declinedBy: null, reason: null, authorizationId };
  }

  /** Simulate a merchant refund on a previously used card. */
  async simulateRefund(c: Omit<SimulatedCharge, "capture">): Promise<void> {
    const card = this.mustGet(c.providerCardId);
    const body = JSON.stringify({
      type: "transaction.refund",
      eventId: `evt_${randomUUID()}`,
      transactionId: `mock_txn_${randomUUID()}`,
      authorizationId: null,
      providerCardId: card.id,
      amountCents: c.amountCents,
      currency: c.currency ?? card.params.currency,
      merchant: c.merchant,
      raw: null,
    } satisfies IssuerEvent);
    await c.deliver(body, new Headers({ [MOCK_SIGNATURE_HEADER]: this.sign(body) }));
  }

  /** What the issuer/network enforce regardless of what our service says. */
  private networkControls(card: MockCard, amount: number, currency: string, merchant: IssuerMerchant): string | null {
    const p = card.params;
    if (card.status !== "active") return "card_canceled";
    if (card.used) return "card_used";
    if (this.now() > p.expiresAt) return "card_expired";
    if (currency !== p.currency) return "currency_mismatch";
    if (amount > p.amountLimitCents) return "spending_controls";
    if (merchant.mcc && p.blockedMccs.includes(merchant.mcc)) return "spending_controls";
    if (merchant.mcc && p.allowedMccs.length && !p.allowedMccs.includes(merchant.mcc)) return "spending_controls";
    return null;
  }

  private mustGet(id: string): MockCard {
    const card = this.cards.get(id);
    if (!card) throw new Error(`mock card ${id} not found`);
    return card;
  }
}

/** Deterministic, Luhn-valid test card number in the 4000 00xx test range. */
function fakePan(seed: string): string {
  const digits = createHash("sha256").update(seed).digest().subarray(0, 10);
  let body = "400000" + Array.from(digits, (d) => String(d % 10)).join("").slice(0, 9);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  body += String((10 - (sum % 10)) % 10);
  return body;
}
