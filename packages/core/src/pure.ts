// Browser-safe subset (no database, no Node-only providers). Safe to import from client components.
export * from "./money";
export * from "./policy/schema";
export * from "./policy/describe";
export * from "./policy/templates";
export * from "./policy/override";
export { computeBudget, type Budget, type BudgetWindow } from "./policy/budget";
export type { RuleCheck, Decision, CheckOutcome } from "./policy/engine";
