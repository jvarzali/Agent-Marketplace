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
  type WebhookResponse,
} from "./types";

export interface StripeIssuerOptions {
  secretKey: string;
  /** Signing secret of the webhook endpoint that receives issuing_* events (incl. issuing_authorization.request). */
  webhookSecret: string;
  /** Issuing cardholder to attach cards to for a given user. Cardholders require KYC, so they are created out of band. */
  resolveCardholder: (userId: string) => Promise<string>;
  client?: Stripe;
}

type CardCreate = Stripe.Issuing.CardCreateParams;
type Category = NonNullable<NonNullable<CardCreate["spending_controls"]>["blocked_categories"]>[number];

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
  private readonly stripe: Stripe;

  constructor(private readonly opts: StripeIssuerOptions) {
    this.stripe = opts.client ?? new Stripe(opts.secretKey);
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

    const card = await this.stripe.issuing.cards.create(
      {
        cardholder,
        currency: p.currency.toLowerCase(),
        type: "virtual",
        status: "active",
        lifecycle_controls: { cancel_after: { payment_count: 1 } },
        spending_controls,
        metadata: { purchase_request_id: p.purchaseRequestId, merchant_domain: p.merchantDomain, expires_at: p.expiresAt.toISOString() },
      },
      { idempotencyKey: `card_${p.purchaseRequestId}` },
    );
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
        body: JSON.stringify({ approved: decision?.approved ?? false, metadata: { agent_wallet_reason: (decision?.reason ?? "").slice(0, 400) } }),
      };
    }
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ received: true }) };
  }
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
