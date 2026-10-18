import { getDb, type Db } from "@agent-wallet/db";
import { CdpCardFiller, type CardFiller } from "../checkout/browser-fill";
import { RuleBasedClassifier } from "../classifier/rules";
import type { ItemClassifier } from "../classifier/types";
import { MockCardIssuer } from "../issuer/mock";
import { PrivacyCardIssuer } from "../issuer/privacy";
import { StripeIssuingCardIssuer } from "../issuer/stripe";
import type { CardIssuer } from "../issuer/types";
import { consoleLogger, type Logger } from "../logger";
import { ConsoleEmailSender, ConsolePushSender, ResendEmailSender, WebPushSender } from "../notify/senders";
import type { EmailSender, PushSender } from "../notify/types";
import { MemoryRateLimiter, type RateLimiter } from "../security";
import { defaultConfig, type WalletConfig, type WalletDeps } from "./context";
import { IssuerEventService } from "./issuer-events";
import { expireStale } from "./maintenance";
import { OwnerService } from "./owner";
import { PurchaseService } from "./purchases";
import { shopperFromEnv, testShopperFromEnv } from "./shopper";
import { TrustService } from "./trust";

export interface Wallet {
  deps: WalletDeps;
  /** Agent-facing operations (REST + MCP). */
  purchases: PurchaseService;
  /** Human-facing operations (dashboard). */
  owner: OwnerService;
  trust: TrustService;
  issuerEvents: IssuerEventService;
  expireStale: () => ReturnType<typeof expireStale>;
}

export interface WalletOverrides {
  db?: Db;
  issuer?: CardIssuer;
  classifier?: ItemClassifier;
  email?: EmailSender;
  push?: PushSender;
  agentRateLimiter?: RateLimiter;
  logger?: Logger;
  now?: () => Date;
  config?: Partial<WalletConfig>;
  cardFiller?: CardFiller;
}

export function createWallet(o: WalletOverrides = {}): Wallet {
  const logger = o.logger ?? consoleLogger();
  const deps: WalletDeps = {
    db: o.db ?? getDb(),
    issuer: o.issuer ?? new MockCardIssuer(),
    classifier: o.classifier ?? new RuleBasedClassifier(),
    email: o.email ?? new ConsoleEmailSender(logger),
    push: o.push ?? new ConsolePushSender(logger),
    agentRateLimiter: o.agentRateLimiter ?? new MemoryRateLimiter(60, 60_000),
    logger,
    now: o.now ?? (() => new Date()),
    config: { ...defaultConfig, ...o.config },
    ...(o.cardFiller ? { cardFiller: o.cardFiller } : {}),
  };
  let owner: OwnerService;
  const trust = new TrustService(deps, () => owner);
  owner = new OwnerService(deps);
  return {
    deps,
    purchases: new PurchaseService(deps),
    owner,
    trust,
    issuerEvents: new IssuerEventService(deps, trust),
    expireStale: () => expireStale(deps),
  };
}

const env = (k: string) => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

/** Build a wallet from environment variables (see .env.example). */
export function createWalletFromEnv(o: WalletOverrides = {}): Wallet {
  const logger = o.logger ?? consoleLogger();

  // The owner's real checkout details (SHOPPER_*), also used as the name and billing address on cards.
  const shopper = o.config?.shopper === undefined ? shopperFromEnv(env) : o.config.shopper;

  let issuer = o.issuer;
  if (!issuer) {
    const provider = env("CARD_ISSUER") ?? "mock";
    if (provider === "stripe") {
      const secretKey = env("STRIPE_SECRET_KEY");
      const webhookSecret = env("STRIPE_WEBHOOK_SECRET");
      const cardholder = env("STRIPE_ISSUING_CARDHOLDER_ID");
      if (!secretKey || !webhookSecret || !cardholder) throw new Error("CARD_ISSUER=stripe requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_ISSUING_CARDHOLDER_ID");
      issuer = new StripeIssuingCardIssuer({
        secretKey,
        webhookSecret,
        resolveCardholder: async () => cardholder,
        ...(env("STRIPE_FINANCIAL_ACCOUNT") ? { financialAccount: env("STRIPE_FINANCIAL_ACCOUNT")! } : {}),
      });
    } else if (provider === "privacy") {
      const apiKey = env("PRIVACY_API_KEY");
      const cardholderName = env("PRIVACY_CARDHOLDER_NAME") ?? shopper?.name;
      if (!apiKey || !cardholderName) throw new Error("CARD_ISSUER=privacy requires PRIVACY_API_KEY and PRIVACY_CARDHOLDER_NAME (or SHOPPER_NAME)");
      const line1 = env("PRIVACY_BILLING_LINE1");
      const cardType = env("PRIVACY_CARD_TYPE");
      if (cardType && cardType !== "SINGLE_USE" && cardType !== "MERCHANT_LOCKED") throw new Error("PRIVACY_CARD_TYPE must be SINGLE_USE or MERCHANT_LOCKED");
      issuer = new PrivacyCardIssuer({
        apiKey,
        ...(env("PRIVACY_API_BASE") ? { baseUrl: env("PRIVACY_API_BASE")! } : {}),
        ...(cardType ? { cardType: cardType as "SINGLE_USE" | "MERCHANT_LOCKED" } : {}),
        ...(env("PRIVACY_FUNDING_TOKEN") ? { fundingToken: env("PRIVACY_FUNDING_TOKEN")! } : {}),
        cardholderName,
        billingAddress: line1
          ? {
              line1,
              line2: env("PRIVACY_BILLING_LINE2") ?? null,
              city: env("PRIVACY_BILLING_CITY") ?? "",
              state: env("PRIVACY_BILLING_STATE") ?? "",
              postalCode: env("PRIVACY_BILLING_POSTAL_CODE") ?? "",
              country: env("PRIVACY_BILLING_COUNTRY") ?? "US",
            }
          : (shopper?.address ?? null),
      });
    } else if (provider === "mock") {
      issuer = new MockCardIssuer(env("MOCK_ISSUER_WEBHOOK_SECRET") ?? "mock_webhook_secret", undefined, shopper ?? undefined);
    } else {
      throw new Error(`Unknown CARD_ISSUER "${provider}"`);
    }
  }

  let email = o.email;
  if (!email) {
    const key = env("RESEND_API_KEY");
    email = key ? new ResendEmailSender(key, env("EMAIL_FROM") ?? "Agent Wallet <wallet@example.com>") : new ConsoleEmailSender(logger);
  }

  let push = o.push;
  if (!push) {
    const pub = env("VAPID_PUBLIC_KEY");
    const priv = env("VAPID_PRIVATE_KEY");
    push = pub && priv ? new WebPushSender({ subject: env("VAPID_SUBJECT") ?? "mailto:admin@example.com", publicKey: pub, privateKey: priv }) : new ConsolePushSender(logger);
  }

  const num = (k: string) => (env(k) ? Number(env(k)) : undefined);
  const config: Partial<WalletConfig> = {
    ...(env("APP_URL") ? { appUrl: env("APP_URL")! } : {}),
    ...(num("APPROVAL_TTL_MINUTES") ? { approvalTtlMinutes: num("APPROVAL_TTL_MINUTES")! } : {}),
    ...(num("CREDENTIAL_TTL_MINUTES") ? { credentialTtlMinutes: num("CREDENTIAL_TTL_MINUTES")! } : {}),
    ...(num("PENDING_TTL_MINUTES") ? { pendingTtlMinutes: num("PENDING_TTL_MINUTES")! } : {}),
    ...(num("TRUST_MIN_STREAK") ? { trustMinStreak: num("TRUST_MIN_STREAK")! } : {}),
    ...o.config,
  };
  const delivery = env("CARD_DELIVERY") as WalletConfig["cardDelivery"] | undefined;
  if (delivery && delivery !== "agent" && delivery !== "browser") throw new Error('CARD_DELIVERY must be "agent" or "browser"');
  if (delivery && !o.config?.cardDelivery) config.cardDelivery = delivery;
  if (o.config?.shopper === undefined && shopper) config.shopper = shopper;
  if (!o.config?.testShopper) config.testShopper = testShopperFromEnv(env);
  // The browser the agent shops in, started with remote debugging (agents/browser/start-chrome.sh).
  const cardFiller =
    o.cardFiller ??
    new CdpCardFiller({
      cdpUrl: env("AGENT_BROWSER_CDP_URL") ?? "http://127.0.0.1:9222",
      extraPaymentHosts: (env("AGENT_BROWSER_PAYMENT_HOSTS") ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    });
  const limit = num("AGENT_RATE_LIMIT_PER_MINUTE") ?? 60;
  return createWallet({ ...o, logger, issuer, email, push, cardFiller, agentRateLimiter: o.agentRateLimiter ?? new MemoryRateLimiter(limit, 60_000), config });
}

const globalForWallet = globalThis as unknown as { __agentWallet?: Wallet };

/** Process-wide wallet built from env. Use this from the web app, REST API and MCP server. */
export function getWallet(): Wallet {
  globalForWallet.__agentWallet ??= createWalletFromEnv();
  return globalForWallet.__agentWallet;
}

export { WalletError, type AuthedAgent, type WalletConfig, type WalletDeps } from "./context";
export type { AgentPurchaseView, AgentCredential, ReportResultInput } from "./purchases";
export type { AgentSummary, ApprovalContext, ActivityQuery, AgentClient, DashboardSnapshot } from "./owner";
export { AGENT_CLIENTS } from "./owner";
export { PurchaseService } from "./purchases";
export { OwnerService } from "./owner";
export { TrustService } from "./trust";
export { IssuerEventService, merchantMatches } from "./issuer-events";
