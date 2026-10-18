import { createHmac, timingSafeEqual } from "node:crypto";
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

/**
 * Privacy.com (https://developers.privacy.com). Cards are funded from the user's linked bank
 * account, so this works for personal use. Requires a paid Privacy plan for API access.
 *
 * What Privacy enforces on the network: a single-use card (closes after its first charge) with
 * a hard spend limit. What it can't do: ask us before approving a charge. Privacy webhooks are
 * advice-only, so merchant/amount checks run right after the charge (see IssuerEventService)
 * and a mismatch closes the card immediately and raises a security alert.
 */
export interface PrivacyIssuerOptions {
  apiKey: string;
  /** Default https://api.privacy.com/v1. */
  baseUrl?: string;
  /** SINGLE_USE (default) closes after one charge; MERCHANT_LOCKED locks to the first merchant. */
  cardType?: "SINGLE_USE" | "MERCHANT_LOCKED";
  /** Funding source to charge; the account default when unset. */
  fundingToken?: string;
  /** Name and billing address on the Privacy account; stores check them at checkout. */
  cardholderName: string;
  billingAddress: CardSecrets["billingAddress"];
  fetch?: typeof fetch;
}

export const PRIVACY_SIGNATURE_HEADER = "x-privacy-hmac";

interface PrivacyCard {
  token: string;
  last_four: string;
  state: string;
  pan?: string;
  cvv?: string;
  exp_month?: string;
  exp_year?: string;
}

interface PrivacyEvent {
  token?: string;
  type?: string;
  result?: string;
  amount?: number;
  created?: string;
}

interface PrivacyTransaction {
  token: string;
  card_token?: string;
  card?: { token?: string };
  amount?: number;
  authorization_amount?: number;
  settled_amount?: number;
  result?: string;
  status?: string;
  merchant?: { descriptor?: string; mcc?: string; country?: string };
  events?: PrivacyEvent[];
}

/** Secrets returned by card creation, held only until the agent picks them up. */
const SECRET_TTL_MS = 10 * 60_000;

export class PrivacyCardIssuer implements CardIssuer {
  readonly provider = "privacy";
  /** Privacy can't ask us before approving a charge; checks run on the advice webhook instead. */
  readonly realtimeAuthorization = false;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly fresh = new Map<string, { secrets: CardSecrets; at: number }>();

  constructor(private readonly opts: PrivacyIssuerOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.privacy.com/v1").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async createCard(p: CreateCardParams): Promise<IssuedCard> {
    if (p.currency.toUpperCase() !== "USD") throw new Error("Privacy.com cards are USD only");
    // Privacy spend limits must be whole dollars: round up, so the approved total always fits.
    // Anything over the exact approved amount is still flagged when the charge comes in.
    const spendLimit = Math.ceil(p.amountLimitCents / 100) * 100;
    const card = await this.request<PrivacyCard>("POST", "/cards", {
      type: this.opts.cardType ?? "SINGLE_USE",
      memo: `Agent Wallet ${p.merchantDomain} ${p.purchaseRequestId}`.slice(0, 100),
      spend_limit: spendLimit,
      spend_limit_duration: "FOREVER",
      state: "OPEN",
      ...(this.opts.fundingToken ? { funding_token: this.opts.fundingToken } : {}),
    });
    if (card.pan && card.cvv && card.exp_month && card.exp_year) {
      this.fresh.set(card.token, { secrets: this.secretsOf(card), at: Date.now() });
    }
    return { provider: this.provider, providerCardId: card.token, last4: card.last_four };
  }

  async getCardSecrets(providerCardId: string): Promise<CardSecrets> {
    const cached = this.fresh.get(providerCardId);
    this.fresh.delete(providerCardId);
    if (cached && Date.now() - cached.at < SECRET_TTL_MS) return cached.secrets;
    const card = await this.request<PrivacyCard>("GET", `/cards/${encodeURIComponent(providerCardId)}`);
    if (!card.pan || !card.cvv || !card.exp_month || !card.exp_year) throw new Error("Privacy did not return card details for this card");
    return this.secretsOf(card);
  }

  async cancelCard(providerCardId: string): Promise<void> {
    this.fresh.delete(providerCardId);
    try {
      await this.request("PATCH", `/cards/${encodeURIComponent(providerCardId)}`, { state: "CLOSED" });
    } catch (e) {
      // Closing is final on Privacy's side; a card that's already closed is fine.
      const card = await this.request<PrivacyCard>("GET", `/cards/${encodeURIComponent(providerCardId)}`).catch(() => null);
      if (card?.state !== "CLOSED") throw e;
    }
  }

  async parseWebhook(rawBody: string, headers: Headers): Promise<IssuerEvent> {
    const sig = headers.get(PRIVACY_SIGNATURE_HEADER);
    if (!sig) throw new WebhookSignatureError("missing X-Privacy-HMAC header");
    let t: PrivacyTransaction;
    try {
      t = JSON.parse(rawBody) as PrivacyTransaction;
    } catch {
      throw new WebhookSignatureError("body is not JSON");
    }
    if (!privacySignatureCandidates(t, this.opts.apiKey).some((c) => safeEqual(c, sig))) throw new WebhookSignatureError("invalid X-Privacy-HMAC");
    return toIssuerEvent(t);
  }

  webhookResponse(_event: IssuerEvent, _decision: AuthorizationDecision | null): WebhookResponse {
    // Advice messages only need a 200.
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ received: true }) };
  }

  private secretsOf(card: PrivacyCard): CardSecrets {
    return {
      number: card.pan!,
      cvc: card.cvv!,
      expMonth: Number(card.exp_month),
      expYear: Number(card.exp_year),
      last4: card.last_four,
      cardholderName: this.opts.cardholderName,
      billingAddress: this.opts.billingAddress,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `api-key ${this.opts.apiKey}`, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      // Never echo the response body: on card endpoints it can contain the PAN.
      let message = "";
      try {
        message = String((JSON.parse(text) as { message?: unknown }).message ?? "");
      } catch {
        message = "";
      }
      throw new Error(`Privacy API ${method} ${path.replace(/\/cards\/[^/]+/, "/cards/:token")} failed: ${res.status}${message ? ` ${message.slice(0, 200)}` : ""}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** Normalize a Privacy transaction webhook. Uses the latest event when present, else the status. */
export function toIssuerEvent(t: PrivacyTransaction): IssuerEvent {
  const providerCardId = t.card_token ?? t.card?.token ?? "";
  const merchant: IssuerMerchant = {
    name: t.merchant?.descriptor ?? "",
    mcc: t.merchant?.mcc ?? null,
    domain: null,
    country: t.merchant?.country ?? null,
  };
  const base = { transactionId: t.token, authorizationId: t.token, providerCardId, currency: "USD", merchant, raw: t };
  const events = [...(t.events ?? [])].sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
  const last = events[events.length - 1];
  const amount = (n: number | undefined) => Math.abs(n ?? 0);

  const kind =
    last?.type ??
    (t.status === "DECLINED" || t.status === "PENDING"
      ? "AUTHORIZATION"
      : t.status === "VOIDED"
        ? "VOID"
        : (t.amount ?? 0) < 0
          ? "RETURN"
          : t.status === "SETTLING" || t.status === "SETTLED"
            ? "CLEARING"
            : "UNKNOWN");
  const eventId = `privacy:${t.token}:${last?.token ?? kind}`;

  switch (kind) {
    case "AUTHORIZATION":
    case "AUTHORIZATION_ADVICE": {
      const result = last?.result ?? t.result ?? (t.status === "DECLINED" ? "DECLINED" : "APPROVED");
      return {
        type: "authorization.created",
        eventId,
        authorizationId: t.token,
        providerCardId,
        approved: result === "APPROVED",
        amountCents: amount(last?.amount ?? t.authorization_amount ?? t.amount),
        currency: "USD",
        merchant,
        declineReason: result === "APPROVED" ? null : result.toLowerCase(),
        raw: t,
      };
    }
    case "CLEARING":
      return { type: "transaction.capture", eventId, amountCents: amount(last?.amount ?? t.settled_amount ?? t.amount), ...base };
    case "RETURN":
      return { type: "transaction.refund", eventId, amountCents: amount(last?.amount ?? t.amount), ...base };
    default:
      return { type: "ignored", eventId, providerType: `privacy.${kind.toLowerCase()}`, raw: t };
  }
}

/** JSON with keys sorted at every level and no whitespace, as Privacy signs it. */
function canonicalJson(v: unknown, asciiOnly: boolean): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x, asciiOnly)).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${str(k, asciiOnly)}:${canonicalJson(o[k], asciiOnly)}`)
      .join(",")}}`;
  }
  return typeof v === "string" ? str(v, asciiOnly) : JSON.stringify(v);
}

// Python's json.dumps (Privacy's reference) escapes non-ASCII; JavaScript doesn't. Accept either.
const str = (s: string, asciiOnly: boolean) => {
  const j = JSON.stringify(s);
  return asciiOnly ? j.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) : j;
};

const hmac = (key: string, msg: string) => createHmac("sha256", key).update(msg).digest("base64");

/** Every signature Privacy's documented signing methods could produce for this payload. */
export function privacySignatureCandidates(payload: unknown, apiKey: string): string[] {
  const forms = new Set([canonicalJson(payload, false), canonicalJson(payload, true)]);
  // Privacy's JavaScript sample passes the sorted top-level keys as a replacer, which also
  // filters nested objects to those key names. Accept that form too.
  if (payload && typeof payload === "object" && !Array.isArray(payload)) forms.add(JSON.stringify(payload, Object.keys(payload).sort()));
  return [...forms].map((f) => hmac(apiKey, f));
}

/** Sign a payload the way Privacy does (for tests and local simulation). */
export function signPrivacyWebhook(payload: unknown, apiKey: string): string {
  return hmac(apiKey, canonicalJson(payload, false));
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
