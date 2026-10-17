import type { ItemClassification } from "../classifier/types";
import { CATEGORY_CONFIDENCE_THRESHOLD } from "../policy/engine";
import { computeTrustLevel, computeTrustSuggestions, type TrustHistoryItem } from "../trust";
import { audit, WalletError, type WalletDeps } from "./context";
import { loadActivePolicy } from "./history";
import type { OwnerService } from "./owner";

/** Trust building: suggestions only. Nothing here loosens a policy without the user accepting. */
export class TrustService {
  constructor(
    private readonly deps: WalletDeps,
    private readonly owner: () => OwnerService,
  ) {}

  private async history(agentId: string): Promise<TrustHistoryItem[]> {
    const since = new Date(this.deps.now().getTime() - 180 * 86_400_000);
    const rows = await this.deps.db.purchaseRequest.findMany({
      where: { agentId, createdAt: { gt: since }, status: { in: ["completed", "credential_issued", "cancelled"] } },
      select: { id: true, status: true, totalCents: true, createdAt: true, classifications: true, refundedCents: true },
    });
    const incidents = await this.deps.db.auditEvent.findMany({
      where: { agentId, severity: "security", createdAt: { gt: since }, purchaseRequestId: { not: null } },
      select: { purchaseRequestId: true },
    });
    const bad = new Set(incidents.map((i) => i.purchaseRequestId));
    return rows.map((r) => {
      const cls = r.classifications as unknown as ItemClassification[];
      const confident = cls.every((c) => c.confidence >= CATEGORY_CONFIDENCE_THRESHOLD);
      return {
        id: r.id,
        status: r.status,
        categories: confident ? [...new Set(cls.map((c) => c.category))] : [],
        totalCents: r.totalCents,
        createdAt: r.createdAt,
        hadIncident: bad.has(r.id) || r.refundedCents > 0,
      };
    });
  }

  /** Recompute trust level and open suggestions for an agent. Called after each completed purchase. */
  async refresh(agentId: string): Promise<void> {
    const now = this.deps.now();
    const [history, policy] = await Promise.all([this.history(agentId), loadActivePolicy(this.deps.db, agentId)]);
    await this.deps.db.agent.update({ where: { id: agentId }, data: { trustLevel: computeTrustLevel(history, now) } });
    const drafts = computeTrustSuggestions(policy.rules, history, { now, minStreak: this.deps.config.trustMinStreak });
    for (const d of drafts) {
      // Unique on (agent, category, amount): a dismissed suggestion is not re-offered.
      await this.deps.db.trustSuggestion.upsert({
        where: { agentId_category_maxTotalCents: { agentId, category: d.category, maxTotalCents: d.maxTotalCents } },
        update: { streakCount: d.streakCount, message: d.message },
        create: { agentId, category: d.category, maxTotalCents: d.maxTotalCents, streakCount: d.streakCount, message: d.message, createdAt: now },
      });
    }
  }

  async list(userId: string, agentId?: string) {
    return this.deps.db.trustSuggestion.findMany({
      where: { status: "open", agent: { userId }, ...(agentId ? { agentId } : {}) },
      include: { agent: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  /** The user accepts: adds an auto-approve rule in a new policy version. */
  async accept(userId: string, suggestionId: string) {
    const s = await this.own(userId, suggestionId);
    const policy = await loadActivePolicy(this.deps.db, s.agentId);
    const rules = structuredClone(policy.rules);
    rules.approval.auto_approve = [...rules.approval.auto_approve.filter((r) => r.category !== s.category), { category: s.category, max_total: s.maxTotalCents / 100 }];
    const updated = await this.owner().updatePolicy(userId, s.agentId, rules, { source: `trust_suggestion:${s.id}` });
    const now = this.deps.now();
    await this.deps.db.trustSuggestion.update({ where: { id: s.id }, data: { status: "accepted", decidedAt: now } });
    await audit(this.deps.db, { userId, agentId: s.agentId, type: "trust.suggestion_accepted", payload: { category: s.category, max_total_cents: s.maxTotalCents, policy_version: updated.version } }, now);
    return updated;
  }

  async dismiss(userId: string, suggestionId: string) {
    const s = await this.own(userId, suggestionId);
    const now = this.deps.now();
    await this.deps.db.trustSuggestion.update({ where: { id: s.id }, data: { status: "dismissed", decidedAt: now } });
    await audit(this.deps.db, { userId, agentId: s.agentId, type: "trust.suggestion_dismissed", payload: { category: s.category, max_total_cents: s.maxTotalCents } }, now);
  }

  private async own(userId: string, id: string) {
    const s = await this.deps.db.trustSuggestion.findUnique({ where: { id }, include: { agent: { select: { userId: true } } } });
    if (!s || s.agent.userId !== userId) throw new WalletError("not_found", "Suggestion not found.");
    if (s.status !== "open") throw new WalletError("invalid_state", `Suggestion already ${s.status}.`);
    return s;
  }
}
