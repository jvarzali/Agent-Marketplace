import { formatMoney, toCents } from "../money";
import { ALWAYS_DENIED_CATEGORIES, ALWAYS_DENIED_MCCS, DEFAULT_DENIED_CATEGORIES, type PolicyRules } from "./schema";

export interface PolicySummarySection {
  title: string;
  lines: string[];
}

/** Plain-English description of a policy, for the dashboard and for agents (`get_my_policy`). */
export function describePolicy(rules: PolicyRules): PolicySummarySection[] {
  const m = (v: number) => formatMoney(toCents(v), rules.currency);
  const human = (c: string) => c.replace(/_/g, " ");
  const sections: PolicySummarySection[] = [];

  const merchants: string[] = [];
  if (rules.merchants.mode === "allowlist") {
    merchants.push(
      rules.merchants.allow_domains.length
        ? `Only these stores: ${rules.merchants.allow_domains.join(", ")} (and their subdomains).`
        : "No stores are allowed yet. Every purchase will be denied until stores are added.",
    );
  } else {
    merchants.push("Any store, except the blocked ones below.");
  }
  if (rules.merchants.deny_domains.length) merchants.push(`Blocked stores: ${rules.merchants.deny_domains.join(", ")}.`);
  const mccs = [...new Set([...ALWAYS_DENIED_MCCS, ...rules.merchants.deny_mccs])];
  merchants.push(`Blocked merchant types (MCC): ${mccs.join(", ")} (gambling, cash-like and money-transfer merchants are always blocked).`);
  sections.push({ title: "Where", lines: merchants });

  const cats: string[] = [];
  cats.push(rules.categories.allow.length ? `Allowed categories: ${rules.categories.allow.map(human).join(", ")}.` : "Any category that is not blocked.");
  const subscriptionsAllowed = rules.categories.allow.includes("subscriptions");
  const denied = [
    ...new Set([
      ...ALWAYS_DENIED_CATEGORIES,
      ...(subscriptionsAllowed ? [] : DEFAULT_DENIED_CATEGORIES),
      ...rules.categories.deny,
    ]),
  ];
  cats.push(`Never: ${denied.map(human).join(", ")}.`);
  sections.push({ title: "What", lines: cats });

  const l = rules.limits;
  const limits: string[] = [];
  if (l.per_order_total !== null) limits.push(`At most ${m(l.per_order_total)} per order, including tax and shipping.`);
  if (l.per_day !== null) limits.push(`At most ${m(l.per_day)} in any 24 hours.`);
  if (l.per_week !== null) limits.push(`At most ${m(l.per_week)} in any 7 days.`);
  if (l.per_month !== null) limits.push(`At most ${m(l.per_month)} in any 30 days.`);
  if (l.max_quantity_per_item !== null) limits.push(`At most ${l.max_quantity_per_item} of any single item.`);
  if (l.max_orders_per_day !== null) limits.push(`At most ${l.max_orders_per_day} orders in any 24 hours.`);
  limits.push("Pending and approved-but-unused purchases count toward these limits.");
  limits.push(
    `Several orders at the same store within ${l.split_window_minutes} minutes are treated as one order; splitting an order will not get around a limit.`,
  );
  sections.push({ title: "How much", lines: limits });

  const s = rules.schedule;
  sections.push({
    title: "When",
    lines: [s.allowed_hours ? `Only between ${s.allowed_hours.replace("-", " and ")} (${s.timezone}).` : "Any time."],
  });

  const a = rules.approval;
  const approval: string[] = [];
  if (a.always) approval.push("A human approves every purchase.");
  else if (a.require_if_total_over !== null) approval.push(`A human approves any order over ${m(a.require_if_total_over)}.`);
  else approval.push("Purchases that pass every rule go through without approval.");
  for (const r of a.auto_approve) approval.push(`Exception: ${human(r.category)} orders up to ${m(r.max_total)} are approved automatically.`);
  if (a.require_for_new_merchant) approval.push("The first purchase at a new store needs approval.");
  approval.push("If an item's category is unclear, a human approves it.");
  sections.push({ title: "Approval", lines: approval });

  sections.push({ title: "Currency", lines: [`All purchases must be in ${rules.currency}.`] });
  return sections;
}

export function describePolicyText(rules: PolicyRules): string {
  return describePolicy(rules)
    .map((s) => `${s.title}:\n${s.lines.map((l) => `- ${l}`).join("\n")}`)
    .join("\n\n");
}
