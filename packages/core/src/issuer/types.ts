/**
 * Card issuing provider abstraction. The issued card is the final enforcement layer:
 * whatever our policy engine decides, the card itself must refuse anything outside the
 * approved merchant, amount and lifetime.
 */

export interface CreateCardParams {
  purchaseRequestId: string;
  userId: string;
  /** Hard cap for the single authorization (approved total + configured buffer). */
  amountLimitCents: number;
  currency: string;
  merchantDomain: string;
  merchantName: string;
  /** If known, the only MCCs the card may be used at. Empty = not restricted by MCC allowlist. */
  allowedMccs: string[];
  /** MCCs the card must always decline. */
  blockedMccs: string[];
  expiresAt: Date;
}

export interface IssuedCard {
  provider: string;
  providerCardId: string;
  last4: string;
}

/** Full card details. Never persisted or logged; returned to the agent exactly once. */
export interface CardSecrets {
  number: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  last4: string;
  cardholderName: string;
  billingAddress: {
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  } | null;
}

export interface IssuerMerchant {
  name: string;
  mcc: string | null;
  /** Some providers report the merchant URL/domain; often null. */
  domain: string | null;
  country: string | null;
}

export interface TransactionEventFields {
  eventId: string;
  transactionId: string;
  authorizationId: string | null;
  providerCardId: string;
  /** Always positive. */
  amountCents: number;
  currency: string;
  merchant: IssuerMerchant;
  raw: unknown;
}

export type IssuerEvent =
  | {
      /** Real-time authorization request: we must answer approve/decline synchronously. */
      type: "authorization.request";
      eventId: string;
      authorizationId: string;
      providerCardId: string;
      amountCents: number;
      currency: string;
      merchant: IssuerMerchant;
      raw: unknown;
    }
  | {
      /** An authorization was approved or declined (by the issuer's controls or by us). */
      type: "authorization.created";
      eventId: string;
      authorizationId: string;
      providerCardId: string;
      approved: boolean;
      amountCents: number;
      currency: string;
      merchant: IssuerMerchant;
      declineReason: string | null;
      raw: unknown;
    }
  | ({ type: "transaction.capture" } & TransactionEventFields)
  | ({ type: "transaction.refund" } & TransactionEventFields)
  | { type: "ignored"; eventId: string; providerType: string; raw: unknown };

export interface AuthorizationDecision {
  approved: boolean;
  reason: string;
}

export interface WebhookResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface CardIssuer {
  readonly provider: string;
  createCard(params: CreateCardParams): Promise<IssuedCard>;
  /** Fetch full card details from the provider for one-time delivery to the agent. */
  getCardSecrets(providerCardId: string): Promise<CardSecrets>;
  /** Permanently cancel. Must be idempotent. */
  cancelCard(providerCardId: string): Promise<void>;
  /** Verify the webhook signature and normalize the payload. Throws WebhookSignatureError. */
  parseWebhook(rawBody: string, headers: Headers): Promise<IssuerEvent>;
  /** Build the HTTP response for a webhook, including real-time authorization answers. */
  webhookResponse(event: IssuerEvent, decision: AuthorizationDecision | null): WebhookResponse;
}

export class WebhookSignatureError extends Error {}
