import { getDb, type Db } from "@agent-wallet/db";
import { RuleBasedClassifier } from "../classifier/rules";
import type { ItemClassifier } from "../classifier/types";
import { MockCardIssuer } from "../issuer/mock";
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

  let issuer = o.issuer;
  if (!issuer) {
    const provider = env("CARD_ISSUER") ?? "mock";
    if (provider === "stripe") {
      const secretKey = env("STRIPE_SECRET_KEY");
      const webhookSecret = env("STRIPE_WEBHOOK_SECRET");
      const cardholder = env("STRIPE_ISSUING_CARDHOLDER_ID");
      if (!secretKey || !webhookSecret || !cardholder) throw new Error("CARD_ISSUER=stripe requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_ISSUING_CARDHOLDER_ID");
      issuer = new StripeIssuingCardIssuer({ secretKey, webhookSecret, resolveCardholder: async () => cardholder });
    } else if (provider === "mock") {
      issuer = new MockCardIssuer(env("MOCK_ISSUER_WEBHOOK_SECRET") ?? "mock_webhook_secret");
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
  const limit = num("AGENT_RATE_LIMIT_PER_MINUTE") ?? 60;
  return createWallet({ ...o, logger, issuer, email, push, agentRateLimiter: o.agentRateLimiter ?? new MemoryRateLimiter(limit, 60_000), config });
}

const globalForWallet = globalThis as unknown as { __agentWallet?: Wallet };

/** Process-wide wallet built from env. Use this from the web app, REST API and MCP server. */
export function getWallet(): Wallet {
  globalForWallet.__agentWallet ??= createWalletFromEnv();
  return globalForWallet.__agentWallet;
}

export { WalletError, type AuthedAgent, type WalletConfig, type WalletDeps } from "./context";
export type { AgentPurchaseView, AgentCredential, ReportResultInput } from "./purchases";
export type { AgentSummary, ApprovalContext, ActivityQuery } from "./owner";
export { PurchaseService } from "./purchases";
export { OwnerService } from "./owner";
export { TrustService } from "./trust";
export { IssuerEventService, merchantMatches } from "./issuer-events";
