export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const SENSITIVE_KEY = /^(number|pan|card_?number|cvc|cvv|cvc2|exp(_month|_year|month|year)?|api_?key|authorization|password|secret|token|p256dh|auth)$/i;
// 13-19 digit runs (optionally spaced/dashed) look like card numbers.
const PAN_LIKE = /\b(?:\d[ -]?){13,19}\b/g;

/** Deep-redact card data and secrets. Used on everything that is logged. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") return value.replace(PAN_LIKE, (m) => `[redacted …${m.replace(/\D/g, "").slice(-4)}]`);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function consoleLogger(): Logger {
  const line = (level: string, msg: string, data?: Record<string, unknown>) =>
    JSON.stringify({ level, msg, ...(data ? { data: redact(data) } : {}), at: new Date().toISOString() });
  return {
    info: (m, d) => console.log(line("info", m, d)),
    warn: (m, d) => console.warn(line("warn", m, d)),
    error: (m, d) => console.error(line("error", m, d)),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
