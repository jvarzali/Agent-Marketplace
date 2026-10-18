import { ALWAYS_DENIED_CATEGORIES, DEFAULT_DENIED_CATEGORIES, type PolicyTemplateId } from "@paysafe/core/pure";
import { categoryName, money } from "./format";
import type { Category, Policy } from "./types";

// Denied for every agent regardless of what the user picks. The backend enforces this;
// the UI only shows it as locked.
export const ALWAYS_BLOCKED: Category[] = [...ALWAYS_DENIED_CATEGORIES];
// Blocked unless the user explicitly allows them.
export const BLOCKED_BY_DEFAULT: Category[] = [...DEFAULT_DENIED_CATEGORIES];

export const SELECTABLE_CATEGORIES: Category[] = [
  "groceries",
  "household",
  "pet_supplies",
  "personal_care",
  "baby",
  "pharmacy",
  "apparel",
  "electronics",
  "office",
  "subscriptions",
  "alcohol",
  "tobacco",
  "firearms",
];

export const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "UTC",
];

export type TemplateId = PolicyTemplateId;

export const TEMPLATES: { id: TemplateId; name: string; blurb: string }[] = [
  {
    id: "approve_everything",
    name: "Approve everything",
    blurb: "Any store, but you approve every purchase. Best for a new agent you haven't seen shop yet.",
  },
  {
    id: "groceries_under_50",
    name: "Groceries under $50",
    blurb: "Groceries, household, personal care and pet supplies at major grocers, up to $50 an order. You approve each one.",
  },
  {
    id: "custom",
    name: "Custom",
    blurb: "Start from \u201cApprove everything\u201d and set your own rules next.",
  },
];

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function hours(range: string): string {
  const fmt = (hm: string) => {
    const [h, m] = hm.split(":").map(Number);
    const d = new Date(2000, 0, 1, h, m);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: m ? "2-digit" : undefined });
  };
  const [a, b] = range.split("-");
  return `${fmt(a)} to ${fmt(b)}`;
}

export interface PolicyLine {
  label: string;
  text: string;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Plain-English description of a policy, one labeled line per rule group. */
export function describePolicy(p: Policy): PolicyLine[] {
  const out: PolicyLine[] = [];

  out.push({
    label: "Stores",
    text:
      p.merchants.mode === "allowlist"
        ? p.merchants.allow_domains.length
          ? `Only ${list(p.merchants.allow_domains)}.`
          : "None yet. Add at least one store."
        : p.merchants.deny_domains.length
          ? `Any store except ${list(p.merchants.deny_domains)}, and never gambling, money transfer or cash-like merchants.`
          : "Any store, except gambling, money transfer and cash-like merchants.",
  });

  const allowed = p.categories.allow.map((c) => categoryName(c).toLowerCase());
  out.push({ label: "Buys", text: allowed.length ? `${cap(list(allowed))}.` : "Anything that isn't blocked." });

  const defaults = BLOCKED_BY_DEFAULT.filter((c) => !p.categories.allow.includes(c));
  const blocked = Array.from(new Set([...ALWAYS_BLOCKED, ...defaults, ...p.categories.deny])).map((c) =>
    categoryName(c).toLowerCase(),
  );
  out.push({ label: "Never buys", text: `${cap(list(blocked))}.` });

  const l = p.limits;
  const windows = [
    l.per_day !== null && `${money(l.per_day)} a day`,
    l.per_week !== null && `${money(l.per_week)} a week`,
    l.per_month !== null && `${money(l.per_month)} a month`,
  ].filter((x): x is string => !!x);
  out.push({
    label: "Spending",
    text: [
      l.per_order_total !== null ? `${money(l.per_order_total)} an order with tax and shipping.` : "No per-order limit.",
      windows.length ? `${cap(list(windows))}.` : "No daily, weekly or monthly budget.",
      p.credential_buffer > 0 ? `Each card allows ${money(p.credential_buffer)} over the approved total.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  });
  out.push({
    label: "Orders",
    text:
      l.max_orders_per_day === null && l.max_quantity_per_item === null
        ? "No limit on order count or quantity."
        : `${l.max_orders_per_day === null ? "Any number" : `Up to ${l.max_orders_per_day}`} a day, ${
            l.max_quantity_per_item === null ? "any quantity" : `${l.max_quantity_per_item}`
          } of any one item.`,
  });

  let asks: string;
  if (p.approval.always) {
    asks = "Before every purchase.";
  } else {
    const when: string[] = [];
    if (p.approval.require_if_total_over !== null) when.push(`an order is over ${money(p.approval.require_if_total_over)}`);
    if (p.approval.require_for_new_merchant) when.push("it's a new store");
    if (p.approval.require_if_category_uncertain) when.push("it isn't sure what an item is");
    asks = when.length ? `When ${list(when)}.` : "Never, when every rule passes.";
  }
  out.push({ label: "Asks you", text: asks });

  if (p.approval.auto_approve.length) {
    out.push({
      label: "Skips asking",
      text: `${cap(
        list(p.approval.auto_approve.map((r) => `${categoryName(r.category).toLowerCase()} orders up to ${money(r.max_total)}`)),
      )}, unless it's a new store or an unclear item.`,
    });
  }

  const tzCity = p.schedule.timezone.split("/").pop()?.replace(/_/g, " ") ?? p.schedule.timezone;
  out.push({
    label: "Hours",
    text: p.schedule.allowed_hours ? `${cap(hours(p.schedule.allowed_hours))}, ${tzCity} time.` : "Any time.",
  });

  return out;
}

/** Form-level sanity checks. The backend schema is the real validator. */
export function policyWarnings(p: Policy): string[] {
  const w: string[] = [];
  const l = p.limits;
  if (p.merchants.mode === "allowlist" && p.merchants.allow_domains.length === 0)
    w.push("Add at least one store, or every request will be blocked.");
  const over = (a: number | null, b: number | null) => a !== null && b !== null && a > b;
  if (over(l.per_order_total, l.per_day)) w.push("The per-order limit is higher than the daily limit, so the daily limit wins.");
  if (over(l.per_day, l.per_week)) w.push("The daily limit is higher than the weekly limit.");
  if (over(l.per_week, l.per_month)) w.push("The weekly limit is higher than the monthly limit.");
  const nums = [l.per_order_total, l.per_day, l.per_week, l.per_month, l.max_quantity_per_item, l.max_orders_per_day];
  if (nums.some((n) => n !== null && (!Number.isFinite(n) || n < 0))) w.push("Limits must be zero or more.");
  if (p.credential_buffer > 50) w.push("The card allowance is over $50. Keep it small: it's money the agent can spend beyond what you approved.");
  if ([l.max_quantity_per_item, l.max_orders_per_day].some((n) => n !== null && (n < 1 || !Number.isInteger(n))))
    w.push("Order and quantity limits must be whole numbers of 1 or more. Leave them empty for no limit.");
  return w;
}
