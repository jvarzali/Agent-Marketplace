import { toCents } from "../money";
import { ordersInWindow, windowSpend, WINDOWS, type HistoryEntry } from "./engine";
import type { PolicyRules } from "./schema";

export interface BudgetWindow {
  window: "per_day" | "per_week" | "per_month";
  limitCents: number | null;
  /** Spent plus reserved by pending / approved / issued-but-unused requests. */
  committedCents: number;
  remainingCents: number | null;
}

export interface Budget {
  currency: string;
  perOrderLimitCents: number | null;
  windows: BudgetWindow[];
  ordersLast24h: number;
  ordersLeftToday: number | null;
  /** Largest single order that would pass every limit right now (ignores category/merchant rules). */
  maxNextOrderCents: number | null;
}

/** Pure. Remaining budget for each rolling window. */
export function computeBudget(policy: PolicyRules, history: HistoryEntry[], now: Date): Budget {
  const windows = (Object.keys(WINDOWS) as (keyof typeof WINDOWS)[]).map((w): BudgetWindow => {
    const limit = policy.limits[w];
    const committed = windowSpend(history, now, WINDOWS[w]);
    const limitCents = limit === null ? null : toCents(limit);
    return { window: w, limitCents, committedCents: committed, remainingCents: limitCents === null ? null : Math.max(0, limitCents - committed) };
  });
  const orders = ordersInWindow(history, now, WINDOWS.per_day);
  const maxOrders = policy.limits.max_orders_per_day;
  const ordersLeft = maxOrders === null ? null : Math.max(0, maxOrders - orders);
  const perOrder = policy.limits.per_order_total === null ? null : toCents(policy.limits.per_order_total);
  const caps = [perOrder, ...windows.map((w) => w.remainingCents)].filter((x): x is number => x !== null);
  let maxNext = caps.length ? Math.min(...caps) : null;
  if (ordersLeft === 0) maxNext = 0;
  return { currency: policy.currency, perOrderLimitCents: perOrder, windows, ordersLast24h: orders, ordersLeftToday: ordersLeft, maxNextOrderCents: maxNext };
}
