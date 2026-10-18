import Stripe from "stripe";
import { STRIPE_MCC_CATEGORIES } from "./stripe-mcc";
import {
  WebhookSignatureError,
  type AuthorizationDecision,
  type CardIssuer,
  type CardSecrets,
  type CreateCardParams,
  type IssuedCard,
  type IssuerEvent,
  type IssuerMerchant,
  type TestChargeParams,
  type TestChargeResult,
  type WebhookResponse,
} from "./types";

export interface StripeIssuerOptions {
  secretKey: string;
  /** Signing secret of the webhook endpoint that receives issuing_* events (incl. issuing_authorization.request). */
  webhookSecret: string;
  /** Issuing cardholder to attach cards to for a given user. Cardholders require KYC, so they are created out of band. */
  resolveCardholder: (userId: string) => Promise<string>;
  /**
   * Financial account the cards spend from (fa_...). Accounts on Stripe's newer money
   * management require one; when unset it's looked up the first time Stripe asks for it.
   */
  financialAccount?: string;
  client?: Stripe;
}

type CardCreate = Stripe.Issuing.CardCreateParams;
type Category = NonNullable<NonNullable<CardCreate["spending_controls"]>["blocked_categories"]>[number];
type TestMerchantCategory = NonNullable<NonNullable<Parameters<Stripe["testHelpers"]["issuing"]["authorizations"]["create"]>[0]["merchant_data"]>["category"]>;

/** Test-mode secret or restricted key. */
export const isStripeTestKey = (key: string) => /^(sk|rk)_test_/.test(key);

/**
 * Stripe Issuing implementation (checked against Stripe docs, API version 2026-09-30).
 *
 * Enforcement on Stripe's side:
 *  - lifecycle_controls.cancel_after.payment_count = 1 → single-use card
 *  - spending_limits per_authorization + all_time = approved amount
 *  - blocked_categories for restricted MCCs; allowed_categories when the merchant MCC is known
 * Stripe cannot lock a card to a merchant domain or expire it in 30 minutes, so the
 * real-time authorization webhook (issuing_authorization.request) checks merchant and
 * expiry, and the expiry sweeper cancels unused cards.
 */
export class StripeIssuingCardIssuer implements CardIssuer {
  readonly provider = "stripe";
  readonly supportsTestCharges: boolean;
  private readonly stripe: Stripe;
  private financialAccount: string | undefined;

  constructor(private readonly opts: StripeIssuerOptions) {
    this.stripe = opts.client ?? new Stripe(opts.secretKey);
    this.supportsTestCharges = isStripeTestKey(opts.secretKey);
    this.financialAccount = opts.financialAccount;
  }

  async createCard(p: CreateCardParams): Promise<IssuedCard> {
    const cardholder = await this.opts.resolveCardholder(p.userId);
    const blocked = mapCategories(p.blockedMccs);
    const allowed = mapCategories(p.allowedMccs);
    const spending_controls: NonNullable<CardCreate["spending_controls"]> = {
      spending_limits: [
        { amount: p.amountLimitCents, interval: "per_authorization" },
        { amount: p.amountLimitCents, interval: "all_time" },
      ],
    };
    // Stripe accepts either allowed_categories or blocked_categories, not both.
    if (allowed.length) spending_controls.allowed_categories = allowed;
    else if (blocked.length) spending_controls.blocked_categories = blocked;

    const params: CardCreate = {
      cardholder,
      currency: p.currency.toLowerCase(),
      type: "virtual",
      status: "active",
      lifecycle_controls: { cancel_after: { payment_count: 1 } },
      spending_controls,
      metadata: { purchase_request_id: p.purchaseRequestId, merchant_domain: p.merchantDomain, expires_at: p.expiresAt.toISOString() },
    };
    const create = (fa: string | undefined) =>
      // financial_account_v2 isn't in the SDK's types yet.
      this.stripe.issuing.cards.create({ ...params, ...(fa ? { financial_account_v2: fa } : {}) } as CardCreate, { idempotencyKey: `card_${p.purchaseRequestId}${fa ? "_fa" : ""}` });
    let card: Stripe.Issuing.Card;
    try {
      card = await create(this.financialAccount);
    } catch (e) {
      if (this.financialAccount || (e as { param?: string }).param !== "financial_account_v2") throw e;
      this.financialAccount = await findFinancialAccount(this.stripe);
      if (!this.financialAccount) throw new Error("Stripe needs a financial account for Issuing cards and none is open on this account. In the dashboard, open Issuing and add funds (test mode), or set STRIPE_FINANCIAL_ACCOUNT.");
      card = await create(this.financialAccount);
    }
    return { provider: this.provider, providerCardId: card.id, last4: card.last4 };
  }

  async getCardSecrets(providerCardId: string): Promise<CardSecrets> {
    const card = await this.stripe.issuing.cards.retrieve(providerCardId, { expand: ["number", "cvc", "cardholder"] });
    if (!card.number || !card.cvc) throw new Error("Stripe did not return card details (account may not be enabled for PAN retrieval)");
    const holder = typeof card.cardholder === "object" ? card.cardholder : null;
    const addr = holder?.billing?.address;
    return {
      number: card.number,
      cvc: card.cvc,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      last4: card.last4,
      cardholderName: holder?.name ?? "",
      billingAddress: addr
        ? { line1: addr.line1 ?? "", line2: addr.line2, city: addr.city ?? "", state: addr.state ?? "", postalCode: addr.postal_code ?? "", country: addr.country ?? "" }
        : null,
    };
  }

  async cancelCard(providerCardId: string): Promise<void> {
    try {
      await this.stripe.issuing.cards.update(providerCardId, { status: "canceled" });
    } catch (e) {
      // Already canceled (e.g. by the single-use lifecycle control) is fine.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/cancel/i.test(msg)) throw e;
    }
  }

  /**
   * Test mode: charge a card with Stripe's test helpers, as if a store ran it. Stripe sends the
   * real-time authorization webhook to us during the call, so our rules decide it. Approved
   * charges are captured, which completes the purchase.
   */
  async testCharge(p: TestChargeParams): Promise<TestChargeResult> {
    if (!this.supportsTestCharges) throw new Error("Test charges need a Stripe test-mode key (sk_test_...)");
    const number = p.card.number.replace(/\D/g, "");
    const candidates = await this.stripe.issuing.cards.list({ status: "active", exp_month: p.card.expMonth, exp_year: p.card.expYear, limit: 100 });
    let cardId: string | null = null;
    for (const c of candidates.data.filter((c) => c.last4 === number.slice(-4))) {
      const full = await this.stripe.issuing.cards.retrieve(c.id, { expand: ["number", "cvc"] });
      if (full.number === number && full.cvc === p.card.cvc.trim()) {
        cardId = c.id;
        break;
      }
    }
    if (!cardId) return { approved: false, reason: "card_not_found", authorizationId: null };

    const category = p.merchant.mcc ? STRIPE_MCC_CATEGORIES[p.merchant.mcc] : undefined;
    const auth = await this.stripe.testHelpers.issuing.authorizations.create({
      card: cardId,
      amount: p.amountCents,
      currency: p.currency.toLowerCase(),
      merchant_data: {
        name: p.merchant.name,
        ...(p.merchant.domain ? { url: p.merchant.domain } : {}),
        ...(category ? { category: category as TestMerchantCategory } : {}),
        ...(p.merchant.city ? { city: p.merchant.city } : {}),
        ...(p.merchant.state ? { state: p.merchant.state } : {}),
        ...(p.merchant.postalCode ? { postal_code: p.merchant.postalCode } : {}),
        ...(p.merchant.country ? { country: p.merchant.country } : {}),
      },
    });
    if (!auth.approved) {
      const last = auth.request_history[auth.request_history.length - 1];
      return { approved: false, reason: last?.reason ?? "declined", authorizationId: auth.id };
    }
    await this.stripe.testHelpers.issuing.authorizations.capture(auth.id);
    return { approved: true, reason: null, authorizationId: auth.id };
  }

  async parseWebhook(rawBody: string, headers: Headers): Promise<IssuerEvent> {
    const sig = headers.get("stripe-signature");
    if (!sig) throw new WebhookSignatureError("missing Stripe-Signature header");
    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(rawBody, sig, this.opts.webhookSecret);
    } catch (e) {
      throw new WebhookSignatureError(e instanceof Error ? e.message : "invalid signature");
    }

    switch (event.type) {
      case "issuing_authorization.request": {
        const a = event.data.object;
        return {
          type: "authorization.request",
          eventId: event.id,
          authorizationId: a.id,
          providerCardId: a.card.id,
          amountCents: a.pending_request?.amount ?? a.amount,
          currency: (a.pending_request?.currency ?? a.currency).toUpperCase(),
          merchant: merchantOf(a.merchant_data),
          raw: event,
        };
      }
      case "issuing_authorization.created": {
        const a = event.data.object;
        const last = a.request_history[a.request_history.length - 1];
        return {
          type: "authorization.created",
          eventId: event.id,
          authorizationId: a.id,
          providerCardId: a.card.id,
          approved: a.approved,
          amountCents: a.amount || last?.amount || 0,
          currency: a.currency.toUpperCase(),
          merchant: merchantOf(a.merchant_data),
          declineReason: a.approved ? null : (last?.reason ?? "declined"),
          raw: event,
        };
      }
      case "issuing_transaction.created": {
        const t = event.data.object;
        const isRefund = t.type === "refund";
        return {
          type: isRefund ? ("transaction.refund" as const) : ("transaction.capture" as const),
          eventId: event.id,
          transactionId: t.id,
          authorizationId: typeof t.authorization === "string" ? t.authorization : (t.authorization?.id ?? null),
          providerCardId: typeof t.card === "string" ? t.card : t.card.id,
          // Captures are negative (money leaving the balance), refunds positive.
          amountCents: Math.abs(t.amount),
          currency: t.currency.toUpperCase(),
          merchant: merchantOf(t.merchant_data),
          raw: event,
        };
      }
      default:
        return { type: "ignored", eventId: event.id, providerType: event.type, raw: event };
    }
  }

  webhookResponse(event: IssuerEvent, decision: AuthorizationDecision | null): WebhookResponse {
    if (event.type === "authorization.request") {
      return {
        status: 200,
        // Stripe requires the Stripe-Version header on synchronous authorization responses.
        headers: { "content-type": "application/json", "stripe-version": Stripe.API_VERSION },
        body: JSON.stringify({ approved: decision?.approved ?? false, metadata: { paysafe_reason: (decision?.reason ?? "").slice(0, 400) } }),
      };
    }
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ received: true }) };
  }
}

/** The account's open financial account (Stripe money management, a v2 preview API). */
export async function findFinancialAccount(stripe: Stripe): Promise<string | undefined> {
  const r = (await stripe.rawRequest("GET", "/v2/money_management/financial_accounts", {}, { apiVersion: `${Stripe.API_VERSION.split(".")[0]}.preview` })) as unknown as {
    data?: { id: string; status?: string }[];
  };
  return r.data?.find((f) => f.status === "open")?.id;
}

function mapCategories(mccs: string[]): Category[] {
  return [...new Set(mccs.map((m) => STRIPE_MCC_CATEGORIES[m]).filter((c): c is string => !!c))] as Category[];
}

function merchantOf(m: { name?: string | null; category_code?: string | null; url?: string | null; country?: string | null }): IssuerMerchant {
  let domain: string | null = null;
  if (m.url) {
    try {
      domain = new URL(/^https?:\/\//.test(m.url) ? m.url : `https://${m.url}`).hostname.replace(/^www\./, "");
    } catch {
      domain = null;
    }
  }
  return { name: m.name ?? "", mcc: m.category_code ?? null, domain, country: m.country ?? null };
}
