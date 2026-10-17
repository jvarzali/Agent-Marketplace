import { parsePolicy, type PolicyRules } from "./schema";

export type PolicyTemplateId = "approve_everything" | "groceries_under_50" | "custom";

export interface PolicyTemplate {
  id: PolicyTemplateId;
  name: string;
  description: string;
  rules: PolicyRules;
}

/**
 * Policy for a brand-new agent: every purchase needs human approval, any merchant except
 * the always-blocked categories/MCCs, modest limits.
 */
export function defaultPolicy(timezone = "UTC"): PolicyRules {
  return parsePolicy({
    merchants: { mode: "blocklist" },
    limits: { per_order_total: 100, per_day: 200, per_week: 400, per_month: 1000, max_quantity_per_item: 10, max_orders_per_day: 5 },
    approval: { always: true, require_for_new_merchant: true },
    schedule: { timezone },
  });
}

export function policyTemplates(timezone = "UTC"): PolicyTemplate[] {
  return [
    {
      id: "approve_everything",
      name: "Approve everything",
      description: "Your agent can shop anywhere, but you approve every purchase before it happens.",
      rules: defaultPolicy(timezone),
    },
    {
      id: "groceries_under_50",
      name: "Groceries under $50",
      description:
        "Groceries and household basics at major grocers, up to $50 per order. You approve each purchase until you choose to loosen it.",
      rules: parsePolicy({
        merchants: {
          mode: "allowlist",
          allow_domains: ["amazon.com", "target.com", "walmart.com", "instacart.com", "costco.com", "wholefoodsmarket.com"],
        },
        categories: { allow: ["groceries", "household", "personal_care", "pet_supplies"], deny: ["alcohol", "tobacco"] },
        limits: { per_order_total: 50, per_day: 75, per_week: 150, per_month: 400, max_quantity_per_item: 6, max_orders_per_day: 2 },
        approval: { always: true, require_for_new_merchant: true },
        schedule: { timezone, allowed_hours: "07:00-22:00" },
      }),
    },
    {
      id: "custom",
      name: "Custom",
      description: "Start from the safe default and edit every rule yourself.",
      rules: defaultPolicy(timezone),
    },
  ];
}

export function templateRules(id: PolicyTemplateId, timezone = "UTC"): PolicyRules {
  const t = policyTemplates(timezone).find((x) => x.id === id);
  if (!t) throw new Error(`unknown policy template ${id}`);
  return t.rules;
}
