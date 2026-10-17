import { categoryLabel, money } from "./format";
import type { Category, Policy } from "./types";

// Denied for every agent regardless of what the user picks (prompt.md §6).
// The backend enforces this; the UI only shows it as locked.
export const ALWAYS_BLOCKED: Category[] = ["gift_cards", "stored_value", "subscriptions"];

export const SELECTABLE_CATEGORIES: Category[] = [
  "groceries",
  "household",
  "pet_supplies",
  "personal_care",
  "electronics",
  "office",
  "alcohol",
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

export type TemplateId = "approve_all" | "groceries_50" | "custom";

export const TEMPLATES: { id: TemplateId; name: string; blurb: string }[] = [
  {
    id: "approve_all",
    name: "Approve everything",
    blurb: "You approve every purchase. Best for a new agent you haven't seen shop yet.",
  },
  {
    id: "groceries_50",
    name: "Groceries under $50",
    blurb: "Groceries, household and pet supplies at stores you pick. You approve anything over $30.",
  },
  {
    id: "custom",
    name: "Custom",
    blurb: "Start from “Approve everything” and set your own rules next.",
  },
];

export function templatePolicy(id: TemplateId): Policy {
  const base: Policy = {
    version: 1,
    merchants: { mode: "any", allow_domains: [], deny_mccs: ["7995", "6051", "4829"] },
    categories: { allow: [], deny: [...ALWAYS_BLOCKED, "alcohol", "firearms"] },
    limits: {
      per_order_total: 50,
      per_day: 75,
      per_week: 150,
      per_month: 300,
      max_quantity_per_item: 5,
      max_orders_per_day: 3,
    },
    approval: {
      always: true,
      require_if_total_over: null,
      require_for_new_merchant: true,
      require_if_category_uncertain: true,
    },
    schedule: { timezone: "America/Los_Angeles", allowed_hours: "08:00-22:00" },
    currency: "USD",
  };
  if (id === "groceries_50") {
    return {
      ...base,
      merchants: { ...base.merchants, mode: "allowlist", allow_domains: ["amazon.com", "target.com", "instacart.com"] },
      categories: { allow: ["groceries", "household", "pet_supplies"], deny: base.categories.deny },
      approval: { ...base.approval, always: false, require_if_total_over: 30 },
    };
  }
  return base;
}

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
        : "Any store, except gambling, money transfer and crypto merchants.",
  });

  const allowed = p.categories.allow.map((c) => categoryLabel[c].toLowerCase());
  out.push({ label: "Buys", text: allowed.length ? `${cap(list(allowed))}.` : "Anything that isn't blocked." });

  const blocked = Array.from(new Set([...ALWAYS_BLOCKED, ...p.categories.deny])).map((c) =>
    categoryLabel[c].toLowerCase(),
  );
  out.push({ label: "Never buys", text: `${cap(list(blocked))}.` });

  const l = p.limits;
  out.push({
    label: "Spending",
    text: `${money(l.per_order_total)} an order with tax and shipping. ${money(l.per_day)} a day, ${money(
      l.per_week,
    )} a week, ${money(l.per_month)} a month.`,
  });
  out.push({
    label: "Orders",
    text: `Up to ${l.max_orders_per_day} a day, ${l.max_quantity_per_item} of any one item.`,
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
  if (l.per_order_total > l.per_day) w.push("The per-order limit is higher than the daily limit, so the daily limit wins.");
  if (l.per_day > l.per_week) w.push("The daily limit is higher than the weekly limit.");
  if (l.per_week > l.per_month) w.push("The weekly limit is higher than the monthly limit.");
  const nums = [l.per_order_total, l.per_day, l.per_week, l.per_month, l.max_quantity_per_item, l.max_orders_per_day];
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) w.push("Limits must be zero or more.");
  return w;
}
