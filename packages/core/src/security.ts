import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "aw_";

/** New agent API key. 32 random bytes, base64url. Shown to the user once; only its hash is stored. */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 10) };
}

/** High-entropy keys don't need a slow KDF; SHA-256 is enough and allows indexed lookup. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function looksLikeApiKey(s: string): boolean {
  return s.startsWith(KEY_PREFIX) && s.length > 20 && s.length < 100;
}

/** Escape untrusted text (item names, agent reasoning, URLs) for HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[c]!);
}

/** Only http(s) URLs may ever be rendered as links. */
export function safeHttpUrl(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface RateLimiter {
  /** Returns true if the call is allowed. */
  take(key: string): Promise<boolean>;
}

/**
 * Fixed-window in-memory limiter. Fine for a single process; on serverless use a shared
 * store (e.g. Redis/Upstash) behind the same interface.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async take(key: string): Promise<boolean> {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || t - cur.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      if (this.hits.size > 50_000) this.gc(t);
      return true;
    }
    cur.count++;
    return cur.count <= this.limit;
  }

  private gc(t: number) {
    for (const [k, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}
