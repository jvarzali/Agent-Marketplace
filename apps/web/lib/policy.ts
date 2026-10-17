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

/** Plain-English description of a policy, one sentence per rule group. */
export function describePolicy(p: Policy): string[] {
  const out: string[] = [];

  out.push(
    p.merchants.mode === "allowlist"
      ? p.merchants.allow_domains.length
        ? `Shops only at ${list(p.merchants.allow_domains)}.`
        : "Can't shop anywhere yet. Add at least one store."
      : "Can shop at any store, except gambling, money transfer and crypto merchants.",
  );

  const allowed = p.categories.allow.map((c) => categoryLabel[c].toLowerCase());
  out.push(allowed.length ? `Buys ${list(allowed)}.` : "Can buy any kind of item that isn't blocked.");

  const blocked = Array.from(new Set([...ALWAYS_BLOCKED, ...p.categories.deny])).map((c) =>
    categoryLabel[c].toLowerCase(),
  );
  out.push(`Never buys ${list(blocked)}.`);

  const l = p.limits;
  out.push(
    `Spends up to ${money(l.per_order_total)} an order including tax and shipping, ${money(l.per_day)} a day, ${money(
      l.per_week,
    )} a week and ${money(l.per_month)} a month.`,
  );
  out.push(
    `At most ${l.max_orders_per_day} ${l.max_orders_per_day === 1 ? "order" : "orders"} a day and ${l.max_quantity_per_item} of any one item.`,
  );

  if (p.approval.always) {
    out.push("Asks you before every purchase.");
  } else {
    const asks: string[] = [];
    if (p.approval.require_if_total_over !== null) asks.push(`an order is over ${money(p.approval.require_if_total_over)}`);
    if (p.approval.require_for_new_merchant) asks.push("it's a store it hasn't used before");
    if (p.approval.require_if_category_uncertain) asks.push("it isn't sure what an item is");
    out.push(asks.length ? `Asks you when ${list(asks)}.` : "Buys without asking when every rule passes.");
  }

  const tzCity = p.schedule.timezone.split("/").pop()?.replace(/_/g, " ") ?? p.schedule.timezone;
  out.push(
    p.schedule.allowed_hours ? `Only shops ${hours(p.schedule.allowed_hours)}, ${tzCity} time.` : "Can shop at any hour.",
  );

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
