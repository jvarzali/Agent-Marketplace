import type { ItemClassification } from "../classifier/types";
import type { RuleCheck } from "./engine";
import { ALWAYS_DENIED_CATEGORIES, ALWAYS_DENIED_MCCS } from "./schema";

/**
 * The deny checks a human override can't lift: a frozen agent, a cart whose math or currency
 * is wrong, and anything cash-like (always-denied categories and MCCs). Those are how a
 * hijacked agent would cash out, so no single approval undoes them. Everything else (limits,
 * stores, schedule, categories the user chose to block) is the user's call.
 */
export function hardDenies(checks: RuleCheck[], classifications: ItemClassification[], mcc: string | null): RuleCheck[] {
  return checks.filter((c) => {
    if (c.outcome !== "deny") return false;
    if (c.rule === "agent.frozen" || c.rule === "currency" || c.rule.startsWith("cart.")) return true;
    if (c.rule === "merchants.mcc") return !!mcc && (ALWAYS_DENIED_MCCS as readonly string[]).includes(mcc);
    const item = /^categories\.item\[(\d+)\]$/.exec(c.rule);
    if (item) {
      const cls = classifications.find((x) => x.index === Number(item[1]));
      return !!cls && (ALWAYS_DENIED_CATEGORIES as readonly string[]).includes(cls.category);
    }
    return false;
  });
}
