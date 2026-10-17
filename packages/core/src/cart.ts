import { createHash } from "node:crypto";
import { z } from "zod";
import { toCents } from "./money";

/** Money as sent by agents: major units (e.g. 12.99), at most 2 decimals. */
const money = z
  .number()
  .nonnegative()
  .max(1_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "at most 2 decimal places");

const untrustedText = (max: number) => z.string().trim().min(1).max(max);

export const cartItemInputSchema = z.object({
  name: untrustedText(300),
  /** The agent's guess at the category. Untrusted: only used as a weak hint by the classifier. */
  category: z.string().trim().toLowerCase().max(64).optional(),
  unit_price: money,
  quantity: z.number().int().positive().max(10_000),
  url: z.url({ protocol: /^https?$/ }).max(2048).optional(),
});

export const purchaseRequestInputSchema = z.object({
  merchant_domain: z.string().trim().min(3).max(253),
  merchant_name: untrustedText(200),
  mcc: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  items: z.array(cartItemInputSchema).min(1).max(100),
  subtotal: money,
  tax: money.default(0),
  shipping: money.default(0),
  total: money,
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
  reasoning: untrustedText(4000),
});

export type PurchaseRequestInput = z.input<typeof purchaseRequestInputSchema>;

export interface CartItem {
  name: string;
  category_hint: string | null;
  unit_price_cents: number;
  quantity: number;
  url: string | null;
}

export interface NormalizedCart {
  merchantDomain: string;
  merchantName: string;
  mcc: string | null;
  items: CartItem[];
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
  reasoning: string;
}

/**
 * Normalize a merchant domain or URL to a bare lowercase host with no "www." prefix.
 * Returns null if it isn't a plausible domain.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

/** True if `domain` equals `base` or is a subdomain of it. */
export function domainMatches(domain: string, base: string): boolean {
  return domain === base || domain.endsWith(`.${base}`);
}

export function normalizeCart(input: z.output<typeof purchaseRequestInputSchema>): NormalizedCart {
  const merchantDomain = normalizeDomain(input.merchant_domain);
  if (!merchantDomain) throw new CartValidationError(`"${input.merchant_domain}" is not a valid merchant domain`);
  return {
    merchantDomain,
    merchantName: input.merchant_name,
    mcc: input.mcc ?? null,
    items: input.items.map((i) => ({
      name: i.name,
      category_hint: i.category ?? null,
      unit_price_cents: toCents(i.unit_price),
      quantity: i.quantity,
      url: i.url ?? null,
    })),
    subtotalCents: toCents(input.subtotal),
    taxCents: toCents(input.tax),
    shippingCents: toCents(input.shipping),
    totalCents: toCents(input.total),
    currency: input.currency,
    reasoning: input.reasoning,
  };
}

export class CartValidationError extends Error {}

/**
 * Deterministic hash over everything that defines "this exact purchase": merchant, items,
 * quantities, prices, tax, shipping, total and currency. Item order does not matter.
 * Reasoning and display names of the merchant are excluded; item names are included.
 */
export function cartHash(cart: Pick<NormalizedCart, "merchantDomain" | "items" | "subtotalCents" | "taxCents" | "shippingCents" | "totalCents" | "currency">): string {
  const items = cart.items
    .map((i) => [i.name, i.unit_price_cents, i.quantity, i.url ?? ""] as const)
    .map((t) => JSON.stringify(t))
    .sort();
  const canonical = JSON.stringify({
    v: 1,
    merchant: cart.merchantDomain,
    items,
    subtotal: cart.subtotalCents,
    tax: cart.taxCents,
    shipping: cart.shippingCents,
    total: cart.totalCents,
    currency: cart.currency,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
