import { audit, type WalletDeps } from "./context";

/**
 * Periodic sweep (run every minute via cron): expires lapsed approvals and pending requests,
 * and cancels any issued card past its lifetime. Issuers like Stripe can't expire a card in
 * 30 minutes, so this plus the real-time authorization check enforce the short lifetime.
 */
export async function expireStale(deps: WalletDeps): Promise<{ pending: number; approvals: number; cards: number }> {
  const now = deps.now();
  let pending = 0;
  let approvals = 0;
  let cards = 0;

  const lapsed = await deps.db.purchaseRequest.findMany({
    where: { status: "pending_approval", pendingExpiresAt: { lte: now } },
    include: { agent: { select: { userId: true } } },
  });
  for (const r of lapsed) {
    const n = await deps.db.purchaseRequest.updateMany({ where: { id: r.id, status: "pending_approval" }, data: { status: "expired", cancelReason: "approval_window_lapsed" } });
    if (n.count) {
      pending++;
      await audit(deps.db, { userId: r.agent.userId, agentId: r.agentId, purchaseRequestId: r.id, type: "purchase.expired", payload: { reason: "no human decision in time" } }, now);
    }
  }

  const approved = await deps.db.purchaseRequest.findMany({
    where: { status: "approved" },
    include: { agent: { select: { userId: true } }, approvals: { orderBy: { decidedAt: "desc" }, take: 1 } },
  });
  for (const r of approved) {
    const a = r.approvals[0];
    if (a && a.expiresAt > now) continue;
    const n = await deps.db.purchaseRequest.updateMany({ where: { id: r.id, status: "approved" }, data: { status: "expired", cancelReason: "approval_expired" } });
    if (n.count) {
      approvals++;
      await audit(deps.db, { userId: r.agent.userId, agentId: r.agentId, purchaseRequestId: r.id, type: "approval.expired", payload: { expired_at: a?.expiresAt.toISOString() ?? null } }, now);
    }
  }

  const stale = await deps.db.issuedCredential.findMany({
    where: { status: "active", expiresAt: { lte: now } },
    include: { purchaseRequest: { include: { agent: { select: { userId: true } } } } },
  });
  for (const c of stale) {
    try {
      await deps.issuer.cancelCard(c.providerCardId);
    } catch (e) {
      deps.logger.error("failed to cancel expired card", { credential: c.id, error: String(e) });
      continue;
    }
    await deps.db.issuedCredential.update({ where: { id: c.id }, data: { status: "expired" } });
    await deps.db.purchaseRequest.updateMany({ where: { id: c.purchaseRequestId, status: "credential_issued" }, data: { status: "expired", cancelReason: "credential_expired" } });
    cards++;
    const r = c.purchaseRequest;
    await audit(deps.db, { userId: r.agent.userId, agentId: r.agentId, purchaseRequestId: r.id, type: "credential.expired", payload: { last4: c.last4 } }, now);
  }
  return { pending, approvals, cards };
}
