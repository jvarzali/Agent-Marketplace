import type { Db } from "@agent-wallet/db";
import type { CartItem, NormalizedCart } from "../cart";
import type { ItemClassification } from "../classifier/types";
import type { HistoryEntry } from "../policy/engine";
import { defaultPolicy } from "../policy/templates";
import { parsePolicy, type PolicyRules } from "../policy/schema";
import type { Tx } from "./context";

const DAY = 86_400_000;

export async function loadActivePolicy(db: Tx | Db, agentId: string): Promise<{ id: string | null; version: number; rules: PolicyRules }> {
  const p = await db.policy.findFirst({ where: { agentId }, orderBy: { version: "desc" } });
  // No policy at all should not happen; fall back to the safest default rather than allowing anything.
  if (!p) return { id: null, version: 0, rules: defaultPolicy() };
  return { id: p.id, version: p.version, rules: parsePolicy(p.rules) };
}

export async function loadHistory(db: Tx | Db, agentId: string, now: Date, excludeId?: string): Promise<HistoryEntry[]> {
  const rows = await db.purchaseRequest.findMany({
    where: { agentId, createdAt: { gt: new Date(now.getTime() - 31 * DAY) }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, merchantDomain: true, status: true, totalCents: true, settledCents: true, refundedCents: true, createdAt: true },
  });
  return rows;
}

/** Stores this agent has completed a purchase at, or that the user explicitly approved. */
export async function loadKnownMerchants(db: Tx | Db, agentId: string): Promise<string[]> {
  const rows = await db.purchaseRequest.findMany({
    where: {
      agentId,
      OR: [{ status: "completed" }, { approvals: { some: { decision: "approved", decidedByUserId: { not: null } } } }],
    },
    select: { merchantDomain: true },
    distinct: ["merchantDomain"],
  });
  return rows.map((r) => r.merchantDomain);
}

type StoredRequest = {
  merchantDomain: string;
  merchantName: string;
  mcc: string | null;
  items: unknown;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
  agentReasoning: string;
};

export function cartFromRow(r: StoredRequest): NormalizedCart {
  return {
    merchantDomain: r.merchantDomain,
    merchantName: r.merchantName,
    mcc: r.mcc,
    items: r.items as CartItem[],
    subtotalCents: r.subtotalCents,
    taxCents: r.taxCents,
    shippingCents: r.shippingCents,
    totalCents: r.totalCents,
    currency: r.currency,
    reasoning: r.agentReasoning,
  };
}

export function classificationsFromRow(r: { classifications: unknown }): ItemClassification[] {
  return r.classifications as ItemClassification[];
}
