import type { AuditEvent, Prisma, PurchaseRequest } from "@agent-wallet/db";
import type { CartItem } from "../cart";
import type { ItemClassification } from "../classifier/types";
import { windowSpend, WINDOWS, type RuleCheck } from "../policy/engine";
import { describePolicy, type PolicySummarySection } from "../policy/describe";
import { safeParsePolicy, type PolicyRules } from "../policy/schema";
import { templateRules, type PolicyTemplateId } from "../policy/templates";
import { generateApiKey, hashApiKey, looksLikeApiKey, safeHttpUrl } from "../security";
import { audit, json, lockAgent, minutes, WalletError, type AuthedAgent, type WalletDeps } from "./context";
import { loadActivePolicy, loadHistory } from "./history";
import { cancelCredentials } from "./purchases";

export interface AgentSummary {
  id: string;
  name: string;
  status: "active" | "frozen";
  trustLevel: number;
  apiKeyPrefix: string;
  apiKeyRevoked: boolean;
  createdAt: Date;
  frozenAt: Date | null;
  spentThisWeekCents: number;
  currency: string;
  pendingApprovals: number;
  policyVersion: number;
}

export interface ApprovalContext {
  request: {
    id: string;
    status: PurchaseRequest["status"];
    merchantDomain: string;
    merchantName: string;
    mcc: string | null;
    /** Untrusted agent-supplied text: render escaped, never as HTML. `url` is null unless http(s). */
    items: (CartItem & { url: string | null; lineTotalCents: number; classification: ItemClassification | null })[];
    subtotalCents: number;
    taxCents: number;
    shippingCents: number;
    totalCents: number;
    currency: string;
    /** Untrusted agent-supplied text. */
    agentReasoning: string;
    cartHash: string;
    createdAt: Date;
    pendingExpiresAt: Date | null;
  };
  /** The rules that sent this to approval (and any that would deny it). */
  triggeredRules: RuleCheck[];
  allChecks: RuleCheck[];
  agent: { id: string; name: string; status: "active" | "frozen"; trustLevel: number };
  recentHistory: { id: string; merchantDomain: string; totalCents: number; currency: string; status: PurchaseRequest["status"]; createdAt: Date }[];
  /** Pass back unchanged to decideApproval: binds the decision to exactly what was displayed. */
  confirmToken: string;
  canDecide: boolean;
}

export interface ActivityQuery {
  agentId?: string;
  severity?: "info" | "warning" | "security";
  types?: string[];
  purchaseRequestId?: string;
  /** Cursor: return events created before this event id. */
  before?: string;
  limit?: number;
}

/**
 * Everything the human-facing dashboard does. Every method takes the signed-in user's id
 * and verifies ownership; the web layer must pass the id from the authenticated session.
 */
export class OwnerService {
  constructor(private readonly deps: WalletDeps) {}

  // ───────────── agent auth (used by REST/MCP layers) ─────────────

  async authenticateAgent(apiKey: string | null | undefined): Promise<AuthedAgent | null> {
    if (!apiKey || !looksLikeApiKey(apiKey)) return null;
    const a = await this.deps.db.agent.findUnique({ where: { apiKeyHash: hashApiKey(apiKey) } });
    if (!a || a.apiKeyRevokedAt) return null;
    return { id: a.id, userId: a.userId, name: a.name, status: a.status };
  }

  // ───────────── users ─────────────

  /** For seeding/tests and the Auth.js `createUser` event; normal sign-up goes through Auth.js. */
  async ensureUser(email: string, opts: { name?: string; timezone?: string } = {}) {
    const normalized = email.trim().toLowerCase();
    return this.deps.db.user.upsert({
      where: { email: normalized },
      update: {},
      create: { email: normalized, name: opts.name ?? null, timezone: opts.timezone ?? "America/Los_Angeles", createdAt: this.deps.now() },
    });
  }

  // ───────────── agents ─────────────

  async createAgent(userId: string, input: { name: string; template?: PolicyTemplateId; rules?: unknown }): Promise<{ agent: AgentSummary; apiKey: string }> {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new WalletError("validation", "Agent name must be 1-80 characters.");
    const user = await this.deps.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new WalletError("not_found", "User not found.");
    let rules: PolicyRules;
    if (input.rules !== undefined) {
      const p = safeParsePolicy(input.rules);
      if (!p.success) throw new WalletError("validation", "Invalid policy.", p.error.issues);
      rules = p.data;
    } else {
      rules = templateRules(input.template ?? "approve_everything", user.timezone);
    }
    const key = generateApiKey();
    const now = this.deps.now();
    const agent = await this.deps.db.$transaction(async (tx) => {
      const a = await tx.agent.create({ data: { userId, name, apiKeyHash: key.hash, apiKeyPrefix: key.prefix, createdAt: now } });
      await tx.policy.create({ data: { agentId: a.id, version: 1, rules: json(rules), createdByUserId: userId, createdAt: now } });
      await audit(tx, { userId, agentId: a.id, type: "agent.created", payload: { name, template: input.template ?? (input.rules ? "custom" : "approve_everything") } }, now);
      await audit(tx, { userId, agentId: a.id, type: "policy.updated", payload: { version: 1, rules } }, now);
      return a;
    });
    return { agent: (await this.summaries(userId, [agent.id]))[0]!, apiKey: key.key };
  }

  async listAgents(userId: string): Promise<AgentSummary[]> {
    return this.summaries(userId);
  }

  async getAgent(userId: string, agentId: string): Promise<AgentSummary> {
    await this.ownAgent(userId, agentId);
    return (await this.summaries(userId, [agentId]))[0]!;
  }

  async renameAgent(userId: string, agentId: string, name: string): Promise<AgentSummary> {
    await this.ownAgent(userId, agentId);
    const n = name.trim();
    if (!n || n.length > 80) throw new WalletError("validation", "Agent name must be 1-80 characters.");
    await this.deps.db.$transaction(async (tx) => {
      await tx.agent.update({ where: { id: agentId }, data: { name: n } });
      await audit(tx, { userId, agentId, type: "agent.renamed", payload: { name: n } }, this.deps.now());
    });
    return this.getAgent(userId, agentId);
  }

  /** Issue a new key (old one stops working immediately). Returns the raw key once. */
  async rotateApiKey(userId: string, agentId: string): Promise<{ apiKey: string; prefix: string }> {
    await this.ownAgent(userId, agentId);
    const key = generateApiKey();
    await this.deps.db.$transaction(async (tx) => {
      await tx.agent.update({ where: { id: agentId }, data: { apiKeyHash: key.hash, apiKeyPrefix: key.prefix, apiKeyRevokedAt: null } });
      await audit(tx, { userId, agentId, type: "agent.api_key_rotated", payload: { prefix: key.prefix } }, this.deps.now());
    });
    return { apiKey: key.key, prefix: key.prefix };
  }

  async revokeApiKey(userId: string, agentId: string): Promise<void> {
    await this.ownAgent(userId, agentId);
    const now = this.deps.now();
    await this.deps.db.$transaction(async (tx) => {
      await tx.agent.update({ where: { id: agentId }, data: { apiKeyRevokedAt: now } });
      await audit(tx, { userId, agentId, type: "agent.api_key_revoked", severity: "warning" }, now);
    });
  }

  // ───────────── freeze ─────────────

  /**
   * Immediately: deny all new requests, cancel every active card, and cancel pending /
   * approved requests. Runs under the agent lock so no issuance can slip in between.
   */
  async freezeAgent(userId: string, agentId: string, reason = "frozen by owner"): Promise<{ cancelledRequests: number; cancelledCards: number }> {
    await this.ownAgent(userId, agentId);
    return this.deps.db.$transaction(
      async (tx) => {
        const now = this.deps.now();
        await lockAgent(tx, agentId);
        await tx.agent.update({ where: { id: agentId }, data: { status: "frozen", frozenAt: now } });
        const open = await tx.purchaseRequest.findMany({ where: { agentId, status: { in: ["pending_approval", "approved", "credential_issued"] } } });
        let cards = 0;
        for (const r of open) {
          cards += await cancelCredentials(this.deps, tx, r.id, now);
          await tx.purchaseRequest.update({ where: { id: r.id }, data: { status: "cancelled", cancelReason: "agent_frozen" } });
        }
        await audit(tx, { userId, agentId, type: "agent.frozen", severity: "warning", payload: { reason, cancelled_requests: open.length, cancelled_cards: cards } }, now);
        return { cancelledRequests: open.length, cancelledCards: cards };
      },
      { timeout: 30_000 },
    );
  }

  async freezeAll(userId: string, reason = "freeze all"): Promise<{ agents: number; cancelledRequests: number; cancelledCards: number }> {
    const agents = await this.deps.db.agent.findMany({ where: { userId }, select: { id: true } });
    let requests = 0;
    let cards = 0;
    for (const a of agents) {
      const r = await this.freezeAgent(userId, a.id, reason);
      requests += r.cancelledRequests;
      cards += r.cancelledCards;
    }
    return { agents: agents.length, cancelledRequests: requests, cancelledCards: cards };
  }

  async unfreezeAgent(userId: string, agentId: string): Promise<AgentSummary> {
    await this.ownAgent(userId, agentId);
    await this.deps.db.$transaction(async (tx) => {
      await tx.agent.update({ where: { id: agentId }, data: { status: "active", frozenAt: null } });
      await audit(tx, { userId, agentId, type: "agent.unfrozen" }, this.deps.now());
    });
    return this.getAgent(userId, agentId);
  }

  // ───────────── policies ─────────────

  async getPolicy(userId: string, agentId: string): Promise<{ version: number; rules: PolicyRules; summary: PolicySummarySection[] }> {
    await this.ownAgent(userId, agentId);
    const p = await loadActivePolicy(this.deps.db, agentId);
    return { version: p.version, rules: p.rules, summary: describePolicy(p.rules) };
  }

  async listPolicyVersions(userId: string, agentId: string) {
    await this.ownAgent(userId, agentId);
    return this.deps.db.policy.findMany({ where: { agentId }, orderBy: { version: "desc" }, select: { id: true, version: true, rules: true, createdAt: true, createdByUserId: true } });
  }

  /** Validate without saving: for the policy editor's live preview. */
  previewPolicy(rules: unknown): { ok: true; rules: PolicyRules; summary: PolicySummarySection[] } | { ok: false; issues: unknown } {
    const p = safeParsePolicy(rules);
    return p.success ? { ok: true, rules: p.data, summary: describePolicy(p.data) } : { ok: false, issues: p.error.issues };
  }

  async updatePolicy(userId: string, agentId: string, rules: unknown, meta: { source?: string } = {}): Promise<{ version: number; rules: PolicyRules; summary: PolicySummarySection[] }> {
    await this.ownAgent(userId, agentId);
    const p = safeParsePolicy(rules);
    if (!p.success) throw new WalletError("validation", "Invalid policy.", p.error.issues);
    return this.deps.db.$transaction(async (tx) => {
      const now = this.deps.now();
      await lockAgent(tx, agentId);
      const prev = await loadActivePolicy(tx, agentId);
      const version = prev.version + 1;
      await tx.policy.create({ data: { agentId, version, rules: json(p.data), createdByUserId: userId, createdAt: now } });
      await audit(tx, { userId, agentId, type: "policy.updated", payload: { version, previous_version: prev.version, rules: p.data, previous_rules: prev.rules, source: meta.source ?? "editor" } }, now);
      return { version, rules: p.data, summary: describePolicy(p.data) };
    });
  }

  // ───────────── approvals ─────────────

  async listPendingApprovals(userId: string) {
    const now = this.deps.now();
    const rows = await this.deps.db.purchaseRequest.findMany({
      where: { agent: { userId }, status: "pending_approval", OR: [{ pendingExpiresAt: null }, { pendingExpiresAt: { gt: now } }] },
      include: { agent: { select: { id: true, name: true, status: true } } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      merchantDomain: r.merchantDomain,
      merchantName: r.merchantName,
      totalCents: r.totalCents,
      currency: r.currency,
      itemCount: (r.items as unknown as CartItem[]).length,
      reasons: (r.decisionReasons as unknown as RuleCheck[]).filter((c) => c.outcome === "needs_approval" && !c.rule.startsWith("categories.item")).map((c) => c.message),
      createdAt: r.createdAt,
      pendingExpiresAt: r.pendingExpiresAt,
    }));
  }

  async getApprovalContext(userId: string, requestId: string): Promise<ApprovalContext> {
    const r = await this.ownRequest(userId, requestId);
    const agent = await this.deps.db.agent.findUniqueOrThrow({ where: { id: r.agentId } });
    const checks = r.decisionReasons as unknown as RuleCheck[];
    const classifications = r.classifications as unknown as ItemClassification[];
    const recent = await this.deps.db.purchaseRequest.findMany({
      where: { agentId: r.agentId, id: { not: r.id } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, merchantDomain: true, totalCents: true, currency: true, status: true, createdAt: true },
    });
    const now = this.deps.now();
    return {
      request: {
        id: r.id,
        status: r.status,
        merchantDomain: r.merchantDomain,
        merchantName: r.merchantName,
        mcc: r.mcc,
        items: (r.items as unknown as CartItem[]).map((i, idx) => ({
          ...i,
          url: safeHttpUrl(i.url),
          lineTotalCents: i.unit_price_cents * i.quantity,
          classification: classifications.find((c) => c.index === idx) ?? null,
        })),
        subtotalCents: r.subtotalCents,
        taxCents: r.taxCents,
        shippingCents: r.shippingCents,
        totalCents: r.totalCents,
        currency: r.currency,
        agentReasoning: r.agentReasoning,
        cartHash: r.cartHash,
        createdAt: r.createdAt,
        pendingExpiresAt: r.pendingExpiresAt,
      },
      triggeredRules: checks.filter((c) => c.outcome === "needs_approval" || c.outcome === "deny"),
      allChecks: checks,
      agent: { id: agent.id, name: agent.name, status: agent.status, trustLevel: agent.trustLevel },
      recentHistory: recent,
      confirmToken: r.cartHash,
      canDecide: r.status === "pending_approval" && (!r.pendingExpiresAt || r.pendingExpiresAt > now),
    };
  }

  /**
   * Record a human decision. Must be called from an authenticated POST (never a GET link).
   * `confirmToken` is the cart hash the user was shown; if the cart differs, nothing is approved.
   */
  async decideApproval(userId: string, requestId: string, decision: "approved" | "denied", confirmToken: string): Promise<{ status: "approved" | "denied" | "expired"; expiresAt?: Date }> {
    await this.ownRequest(userId, requestId);
    const result = await this.deps.db.$transaction(async (tx) => {
      const now = this.deps.now();
      const r0 = await tx.purchaseRequest.findUniqueOrThrow({ where: { id: requestId } });
      await lockAgent(tx, r0.agentId);
      const r = await tx.purchaseRequest.findUniqueOrThrow({ where: { id: requestId }, include: { agent: true } });
      if (r.status !== "pending_approval") throw new WalletError("invalid_state", `This purchase is already ${r.status.replace(/_/g, " ")}.`);
      if (r.pendingExpiresAt && r.pendingExpiresAt <= now) {
        await tx.purchaseRequest.update({ where: { id: r.id }, data: { status: "expired", cancelReason: "approval_window_lapsed" } });
        await audit(tx, { userId, agentId: r.agentId, purchaseRequestId: r.id, type: "purchase.expired", payload: { reason: "approval window lapsed" } }, now);
        return { status: "expired" as const };
      }
      if (confirmToken !== r.cartHash) {
        return { status: "hash_mismatch" as const, agentId: r.agentId, actual: r.cartHash };
      }
      if (decision === "approved" && r.agent.status === "frozen") {
        throw new WalletError("invalid_state", "This agent is frozen. Unfreeze it before approving purchases.");
      }
      const expiresAt = new Date(now.getTime() + minutes(this.deps.config.approvalTtlMinutes));
      await tx.approval.create({ data: { purchaseRequestId: r.id, decidedByUserId: userId, decision, cartHash: r.cartHash, decidedAt: now, expiresAt } });
      await tx.purchaseRequest.update({ where: { id: r.id }, data: { status: decision === "approved" ? "approved" : "denied" } });
      await audit(
        tx,
        { userId, agentId: r.agentId, purchaseRequestId: r.id, type: decision === "approved" ? "approval.approved" : "approval.denied", payload: { cart_hash: r.cartHash, total_cents: r.totalCents, expires_at: expiresAt.toISOString() } },
        now,
      );
      return { status: decision === "approved" ? ("approved" as const) : ("denied" as const), expiresAt };
    });
    if (result.status === "hash_mismatch") {
      // Logged outside the transaction so the security event survives.
      await audit(this.deps.db, { userId, agentId: result.agentId, purchaseRequestId: requestId, type: "security.approval_hash_mismatch", severity: "security", payload: { shown: confirmToken, actual: result.actual } }, this.deps.now());
      throw new WalletError("conflict", "The cart changed since you opened it. Reload the page and review it again.");
    }
    return result;
  }

  // ───────────── history & activity ─────────────

  async listPurchases(userId: string, q: { agentId?: string; status?: PurchaseRequest["status"]; before?: string; limit?: number } = {}) {
    const limit = Math.min(q.limit ?? 50, 200);
    const rows = await this.deps.db.purchaseRequest.findMany({
      where: { agent: { userId }, ...(q.agentId ? { agentId: q.agentId } : {}), ...(q.status ? { status: q.status } : {}) },
      include: { agent: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      ...(q.before ? { cursor: { id: q.before }, skip: 1 } : {}),
    });
    return rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      merchantDomain: r.merchantDomain,
      merchantName: r.merchantName,
      totalCents: r.totalCents,
      settledCents: r.settledCents,
      refundedCents: r.refundedCents,
      currency: r.currency,
      status: r.status,
      decision: r.decision,
      createdAt: r.createdAt,
    }));
  }

  /** Full detail of one purchase: request, checks, approvals, cards (no secrets), transactions, audit trail. */
  async getPurchase(userId: string, requestId: string) {
    await this.ownRequest(userId, requestId);
    const r = await this.deps.db.purchaseRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: {
        agent: { select: { id: true, name: true, status: true } },
        approvals: { orderBy: { decidedAt: "asc" } },
        credentials: { select: { id: true, provider: true, last4: true, amountLimitCents: true, currency: true, merchantDomain: true, expiresAt: true, deliveredAt: true, status: true, createdAt: true } },
        transactions: { select: { id: true, kind: true, status: true, amountCents: true, currency: true, merchant: true, merchantMcc: true, declineReason: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      },
    });
    const events = await this.deps.db.auditEvent.findMany({ where: { purchaseRequestId: requestId }, orderBy: { createdAt: "asc" } });
    return {
      ...r,
      items: (r.items as unknown as CartItem[]).map((i) => ({ ...i, url: safeHttpUrl(i.url) })),
      decisionReasons: r.decisionReasons as unknown as RuleCheck[],
      events,
    };
  }

  async listActivity(userId: string, q: ActivityQuery = {}): Promise<{ events: (AuditEvent & { agentName: string | null })[]; nextCursor: string | null }> {
    const limit = Math.min(q.limit ?? 50, 200);
    const where: Prisma.AuditEventWhereInput = {
      userId,
      ...(q.agentId ? { agentId: q.agentId } : {}),
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.types?.length ? { type: { in: q.types } } : {}),
      ...(q.purchaseRequestId ? { purchaseRequestId: q.purchaseRequestId } : {}),
    };
    const rows = await this.deps.db.auditEvent.findMany({
      where,
      include: { agent: { select: { name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(q.before ? { cursor: { id: q.before }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      events: page.map(({ agent, ...e }) => ({ ...e, agentName: agent?.name ?? null })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async getDashboardSummary(userId: string) {
    const now = this.deps.now();
    const agents = await this.summaries(userId);
    const securityEvents = await this.deps.db.auditEvent.findMany({
      where: { userId, severity: "security", createdAt: { gt: new Date(now.getTime() - 7 * 86_400_000) } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return {
      agents,
      pendingApprovals: agents.reduce((s, a) => s + a.pendingApprovals, 0),
      spentThisWeekCents: agents.reduce((s, a) => s + a.spentThisWeekCents, 0),
      recentSecurityEvents: securityEvents,
    };
  }

  // ───────────── push subscriptions ─────────────

  async savePushSubscription(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    if (!safeHttpUrl(sub.endpoint)?.startsWith("https://")) throw new WalletError("validation", "Push endpoint must be https.");
    await this.deps.db.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
  }

  async deletePushSubscription(userId: string, endpoint: string) {
    await this.deps.db.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  // ───────────── internals ─────────────

  private async summaries(userId: string, ids?: string[]): Promise<AgentSummary[]> {
    const now = this.deps.now();
    const agents = await this.deps.db.agent.findMany({ where: { userId, ...(ids ? { id: { in: ids } } : {}) }, orderBy: { createdAt: "asc" } });
    return Promise.all(
      agents.map(async (a) => {
        const [history, policy, pending] = await Promise.all([
          loadHistory(this.deps.db, a.id, now),
          loadActivePolicy(this.deps.db, a.id),
          this.deps.db.purchaseRequest.count({ where: { agentId: a.id, status: "pending_approval" } }),
        ]);
        return {
          id: a.id,
          name: a.name,
          status: a.status,
          trustLevel: a.trustLevel,
          apiKeyPrefix: a.apiKeyPrefix,
          apiKeyRevoked: !!a.apiKeyRevokedAt,
          createdAt: a.createdAt,
          frozenAt: a.frozenAt,
          spentThisWeekCents: windowSpend(history, now, WINDOWS.per_week),
          currency: policy.rules.currency,
          pendingApprovals: pending,
          policyVersion: policy.version,
        };
      }),
    );
  }

  private async ownAgent(userId: string, agentId: string) {
    const a = await this.deps.db.agent.findUnique({ where: { id: agentId } });
    if (!a || a.userId !== userId) throw new WalletError("not_found", "Agent not found.");
    return a;
  }

  private async ownRequest(userId: string, requestId: string) {
    const r = await this.deps.db.purchaseRequest.findUnique({ where: { id: requestId }, include: { agent: { select: { userId: true } } } });
    if (!r || r.agent.userId !== userId) throw new WalletError("not_found", "Purchase not found.");
    return r;
  }
}

