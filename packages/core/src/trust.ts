import { formatMoney, toCents } from "./money";
import { ALWAYS_DENIED_CATEGORIES, DEFAULT_DENIED_CATEGORIES, type PolicyRules } from "./policy/schema";

export interface TrustHistoryItem {
  id: string;
  /** Only completed purchases matter for trust. */
  status: string;
  /** Confidently classified categories of the cart's items (deduplicated). */
  categories: string[];
  totalCents: number;
  createdAt: Date;
  /** Security event, declined authorization, refund or dispute tied to this purchase. */
  hadIncident: boolean;
}

export interface TrustSuggestionDraft {
  category: string;
  maxTotalCents: number;
  streakCount: number;
  message: string;
  /** The policy change accepting this suggestion would make (user must confirm). */
  autoApprove: { category: string; max_total: number };
}

export interface TrustOptions {
  minStreak?: number;
  lookbackDays?: number;
  now: Date;
}

/**
 * Pure. Looks for streaks of clean, completed single-category purchases and suggests an
 * auto-approve rule for that category up to the streak's typical size. Suggestions only:
 * nothing here changes a policy.
 */
export function computeTrustSuggestions(policy: PolicyRules, history: TrustHistoryItem[], opts: TrustOptions): TrustSuggestionDraft[] {
  const minStreak = opts.minStreak ?? 10;
  const since = opts.now.getTime() - (opts.lookbackDays ?? 90) * 86_400_000;
  const recent = history.filter((h) => h.createdAt.getTime() >= since).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const denied = new Set<string>([...ALWAYS_DENIED_CATEGORIES, ...DEFAULT_DENIED_CATEGORIES, ...policy.categories.deny]);
  const categories = new Set(recent.flatMap((h) => (h.categories.length === 1 ? h.categories : [])));
  const out: TrustSuggestionDraft[] = [];

  for (const category of categories) {
    if (denied.has(category)) continue;
    if (policy.categories.allow.length && !policy.categories.allow.includes(category)) continue;

    // Walk back from the most recent purchase touching this category until an incident.
    let streak = 0;
    let maxTotal = 0;
    for (const h of recent) {
      if (!h.categories.includes(category)) continue;
      if (h.hadIncident) break;
      if (h.status !== "completed" || h.categories.length !== 1) continue;
      streak++;
      maxTotal = Math.max(maxTotal, h.totalCents);
    }
    if (streak < minStreak) continue;

    // Round up to the next $5, never above the per-order limit.
    let threshold = Math.ceil(maxTotal / 500) * 500;
    if (policy.limits.per_order_total !== null) threshold = Math.min(threshold, toCents(policy.limits.per_order_total));
    if (threshold <= 0) continue;

    const a = policy.approval;
    const alreadyAuto = a.auto_approve.some((r) => r.category === category && toCents(r.max_total) >= threshold);
    const wouldNeedApproval = a.always || (a.require_if_total_over !== null && toCents(a.require_if_total_over) < threshold);
    if (alreadyAuto || !wouldNeedApproval) continue;

    const name = category.replace(/_/g, " ");
    const amt = formatMoney(threshold, policy.currency);
    out.push({
      category,
      maxTotalCents: threshold,
      streakCount: streak,
      message: `${streak} ${name} purchases up to ${amt} with no issues. Auto-approve ${name} up to ${amt}?`,
      autoApprove: { category, max_total: threshold / 100 },
    });
  }
  return out.sort((x, y) => y.streakCount - x.streakCount);
}

/** 0 (new) … 5 (long clean record). A recent incident caps trust at 1. */
export function computeTrustLevel(history: TrustHistoryItem[], now: Date): number {
  const clean = history.filter((h) => h.status === "completed" && !h.hadIncident).length;
  const recentIncident = history.some((h) => h.hadIncident && now.getTime() - h.createdAt.getTime() < 30 * 86_400_000);
  const level = clean >= 100 ? 5 : clean >= 50 ? 4 : clean >= 25 ? 3 : clean >= 10 ? 2 : clean >= 3 ? 1 : 0;
  return recentIncident ? Math.min(level, 1) : level;
}
