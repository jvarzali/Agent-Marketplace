/** True if `domain` equals `base` or is a subdomain of it. */
export function domainMatches(domain: string, base: string): boolean {
  return domain === base || domain.endsWith(`.${base}`);
}
