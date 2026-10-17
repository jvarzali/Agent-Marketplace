import type { AuditType, Category, RequestStatus, Tone } from "./types";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function money(n: number): string {
  return usd.format(n);
}

export function relTime(ts: number, now: number): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 0) {
    const ahead = -s;
    if (ahead < 60) return "in under a minute";
    if (ahead < 3600) return `in ${Math.round(ahead / 60)} min`;
    return `in ${Math.round(ahead / 3600)} h`;
  }
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function countdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const today = new Date(now);
  const yest = new Date(now - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Agent-supplied URLs are untrusted. Only http(s) links are ever rendered as links;
 * anything else is shown as inert text.
 */
export function safeLink(url: string): { href: string | null; domain: string } {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return { href: null, domain: "unsupported link" };
    return { href: u.toString(), domain: u.hostname.replace(/^www\./, "") };
  } catch {
    return { href: null, domain: "invalid link" };
  }
}

export const categoryLabel: Record<Category, string> = {
  groceries: "Groceries",
  household: "Household",
  pet_supplies: "Pet supplies",
  personal_care: "Personal care",
  electronics: "Electronics",
  office: "Office supplies",
  gift_cards: "Gift cards",
  stored_value: "Stored value",
  subscriptions: "Subscriptions",
  alcohol: "Alcohol",
  firearms: "Firearms",
  unknown: "Unclassified",
};

export const statusLabel: Record<RequestStatus, string> = {
  denied: "Denied",
  pending_approval: "Waiting on you",
  approved: "Approved",
  credential_issued: "Card issued",
  completed: "Completed",
  expired: "Expired",
  cancelled: "Cancelled",
};

export const statusTone: Record<RequestStatus, Tone> = {
  denied: "stop",
  pending_approval: "hold",
  approved: "good",
  credential_issued: "good",
  completed: "good",
  expired: "info",
  cancelled: "info",
};

export const auditTone: Record<AuditType, Tone> = {
  request_denied: "stop",
  request_pending: "hold",
  request_auto_approved: "good",
  approved: "good",
  denied: "stop",
  credential_issued: "info",
  credential_cancelled: "info",
  transaction: "good",
  security: "stop",
  refund: "info",
  policy_changed: "info",
  frozen: "stop",
  unfrozen: "info",
  agent_created: "info",
};

export const auditLabel: Record<AuditType, string> = {
  request_denied: "Blocked",
  request_pending: "Asked you",
  request_auto_approved: "Auto-approved",
  approved: "You approved",
  denied: "You denied",
  credential_issued: "Card issued",
  credential_cancelled: "Card cancelled",
  transaction: "Charged",
  security: "Security",
  refund: "Refund",
  policy_changed: "Rules changed",
  frozen: "Frozen",
  unfrozen: "Unfrozen",
  agent_created: "Agent added",
};
