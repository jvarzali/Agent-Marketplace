import type { Db, Prisma } from "@agent-wallet/db";
import type { ItemClassifier } from "../classifier/types";
import type { CardIssuer } from "../issuer/types";
import { redact, type Logger } from "../logger";
import type { EmailSender, PushSender } from "../notify/types";
import type { RateLimiter } from "../security";

export type Tx = Prisma.TransactionClient;

export interface WalletConfig {
  /** Base URL of the dashboard, used in notification links. */
  appUrl: string;
  /** How long a human approval stays valid before the agent must use it. */
  approvalTtlMinutes: number;
  /** Lifetime of an issued single-use card. */
  credentialTtlMinutes: number;
  /** How long a request may wait for a human before it lapses. */
  pendingTtlMinutes: number;
  /** Clean purchases in a row before a trust suggestion is offered. */
  trustMinStreak: number;
}

export const defaultConfig: WalletConfig = {
  appUrl: "http://localhost:3000",
  approvalTtlMinutes: 15,
  credentialTtlMinutes: 30,
  pendingTtlMinutes: 24 * 60,
  trustMinStreak: 10,
};

export interface WalletDeps {
  db: Db;
  issuer: CardIssuer;
  classifier: ItemClassifier;
  email: EmailSender;
  push: PushSender;
  agentRateLimiter: RateLimiter;
  logger: Logger;
  now: () => Date;
  config: WalletConfig;
}

export type WalletErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "invalid_state"
  | "conflict"
  | "rate_limited"
  | "issuer_error";

const STATUS: Record<WalletErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation: 400,
  invalid_state: 409,
  conflict: 409,
  rate_limited: 429,
  issuer_error: 502,
};

const WALLET_ERROR: unique symbol = Symbol.for("agent-wallet.WalletError");

/** Errors with messages written for whoever called (agent or human): what happened and what to do next. */
export class WalletError extends Error {
  readonly status: number;
  readonly [WALLET_ERROR] = true;
  constructor(
    readonly code: WalletErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WalletError";
    this.status = STATUS[code];
  }

  /**
   * Use instead of `instanceof`: bundlers (e.g. Next.js layers) can load this module more than
   * once, and an error thrown by one copy isn't an instance of the other copy's class.
   */
  static is(e: unknown): e is WalletError {
    return typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[WALLET_ERROR] === true;
  }
}

export interface AuthedAgent {
  id: string;
  userId: string;
  name: string;
  status: "active" | "frozen";
}

export type AuditSeverity = "info" | "warning" | "security";

export interface AuditInput {
  userId: string;
  agentId?: string | null;
  purchaseRequestId?: string | null;
  type: string;
  severity?: AuditSeverity;
  payload?: Record<string, unknown>;
}

/** Append an audit event. Payloads are redacted as a last line of defence against card data leaking in. */
export async function audit(db: Tx | Db, e: AuditInput, now: Date): Promise<void> {
  await db.auditEvent.create({
    data: {
      userId: e.userId,
      agentId: e.agentId ?? null,
      purchaseRequestId: e.purchaseRequestId ?? null,
      type: e.type,
      severity: e.severity ?? "info",
      payload: (redact(e.payload ?? {}) ?? {}) as Prisma.InputJsonValue,
      createdAt: now,
    },
  });
}

/** Serialize all money-moving work for one agent (prevents budget races between concurrent requests). */
export async function lockAgent(tx: Tx, agentId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM agents WHERE id = ${agentId} FOR UPDATE`;
}

export function json(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

export const minutes = (n: number) => n * 60_000;
