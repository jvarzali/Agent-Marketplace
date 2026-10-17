/** Convert a major-unit amount (e.g. dollars, as written in policies) to integer minor units. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
