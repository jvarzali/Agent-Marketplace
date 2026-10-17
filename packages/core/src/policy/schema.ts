import { z } from "zod";

/**
 * Categories that can never be purchased, whatever the policy says. They are
 * cash-equivalents: a gift card or stored-value load turns a scoped, single-use
 * credential back into reusable money.
 */
export const ALWAYS_DENIED_CATEGORIES = ["gift_cards", "stored_value"] as const;

/** Denied unless the user explicitly lists them in `categories.allow`. */
export const DEFAULT_DENIED_CATEGORIES = ["subscriptions"] as const;

/**
 * MCCs that are always blocked: gambling (7995), quasi-cash / money orders (6051),
 * money transfer (4829), stored-value card load (6540), financial institutions - manual
 * and automated cash (6010, 6011), and non-financial institutions / foreign currency (6012).
 */
export const ALWAYS_DENIED_MCCS = ["7995", "6051", "4829", "6540", "6010", "6011", "6012"] as const;

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "must be a bare domain like example.com");

const mcc = z.string().regex(/^\d{4}$/, "MCC must be 4 digits");

const category = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]+$/, "categories are snake_case identifiers");

/** Major currency units (dollars). Null/absent means "no limit". */
const amount = z.number().nonnegative().max(1_000_000);

const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;

export const autoApproveRuleSchema = z.object({
  category,
  max_total: amount,
});

export const policyRulesSchema = z.object({
  merchants: z
    .object({
      /** allowlist: only allow_domains. blocklist: anything except deny_domains. */
      mode: z.enum(["allowlist", "blocklist"]).default("allowlist"),
      allow_domains: z.array(domain).default([]),
      deny_domains: z.array(domain).default([]),
      deny_mccs: z.array(mcc).default([]),
    })
    .prefault({}),
  categories: z
    .object({
      /** Empty means any category not denied. */
      allow: z.array(category).default([]),
      deny: z.array(category).default([]),
    })
    .prefault({}),
  limits: z
    .object({
      per_order_total: amount.nullable().default(null),
      per_day: amount.nullable().default(null),
      per_week: amount.nullable().default(null),
      per_month: amount.nullable().default(null),
      max_quantity_per_item: z.number().int().positive().nullable().default(null),
      max_orders_per_day: z.number().int().positive().nullable().default(null),
      /** Requests to the same merchant within this window are evaluated together for order-splitting. */
      split_window_minutes: z.number().int().positive().max(7 * 24 * 60).default(60),
    })
    .prefault({}),
  approval: z
    .object({
      always: z.boolean().default(true),
      require_if_total_over: amount.nullable().default(null),
      require_for_new_merchant: z.boolean().default(true),
      /**
       * Low-confidence category classification always requires approval; this cannot be
       * turned off (default-deny principle), so the only accepted value is true.
       */
      require_if_category_uncertain: z.literal(true).default(true),
      /**
       * Carts made entirely of one category at or under max_total skip the `always` and
       * `require_if_total_over` triggers. Added by accepting trust suggestions. Never
       * bypasses new-merchant, uncertain-category, or order-splitting approval.
       */
      auto_approve: z.array(autoApproveRuleSchema).default([]),
    })
    .prefault({}),
  schedule: z
    .object({
      timezone: z
        .string()
        .refine(isValidTimeZone, "unknown IANA timezone")
        .default("UTC"),
      /** "HH:MM-HH:MM" in the policy timezone. May wrap midnight ("22:00-06:00"). Null = any time. */
      allowed_hours: z
        .string()
        .refine((v) => {
          const [a, b] = v.split("-");
          return !!a && !!b && hhmm.test(a) && hhmm.test(b) && a !== b;
        }, 'must look like "08:00-22:00"')
        .nullable()
        .default(null),
    })
    .prefault({}),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD")
    .default("USD"),
  /** Extra headroom on the issued card above the approved total, for tax/shipping drift. */
  credential_buffer: amount.max(1000).default(0),
});

export type PolicyRules = z.output<typeof policyRulesSchema>;
export type PolicyRulesInput = z.input<typeof policyRulesSchema>;
export type AutoApproveRule = z.output<typeof autoApproveRuleSchema>;

export function parsePolicy(input: unknown): PolicyRules {
  return policyRulesSchema.parse(input);
}

export function safeParsePolicy(input: unknown) {
  return policyRulesSchema.safeParse(input);
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
