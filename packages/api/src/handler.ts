import { getWallet, WalletError, type AuthedAgent, type Wallet } from "@paysafe/core";
import { bearer, handleMcpRequest } from "@paysafe/mcp";

/**
 * Agent-facing REST API + issuer webhooks + cron, as a single Web-standard handler.
 *
 *   GET  /api/v1/agent/policy
 *   GET  /api/v1/agent/budget
 *   GET  /api/v1/agent/shipping            name, email, phone, address for checkout
 *   GET  /api/v1/purchases                 recent requests
 *   POST /api/v1/purchases                 request_purchase
 *   GET  /api/v1/purchases/:id             get_purchase_status (credential once)
 *   POST /api/v1/purchases/:id/status      same, with body { current_cart } to confirm the cart
 *   POST /api/v1/purchases/:id/wait        { seconds? } waits for the owner's decision (max 120s)
 *   POST /api/v1/purchases/:id/cancel      { reason? }
 *   POST /api/v1/purchases/:id/result      { success, order_reference?, amount_charged?, notes? }
 *   POST /api/v1/purchases/:id/fill-payment  { button_text? } wallet enters the card and places the order
 *   POST /api/mcp                          MCP (Streamable HTTP)
 *   POST /api/webhooks/issuer              card issuer webhooks (signature-verified)
 *   GET|POST /api/cron/expire              expiry sweep (Authorization: Bearer $CRON_SECRET)
 *
 * Agents authenticate with `Authorization: Bearer <agent API key>`.
 * Next.js: app/api/[...path]/route.ts → `export const GET = handle, POST = handle` (see README).
 */
export function createApiHandler(getW: () => Wallet = getWallet, opts: { cronSecret?: string } = {}) {
  return async function handle(req: Request): Promise<Response> {
    const wallet = getW();
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    try {
      if (path === "/api/mcp") return await handleMcpRequest(req, wallet);
      if (path === "/api/webhooks/issuer" && req.method === "POST") {
        const r = await wallet.issuerEvents.handleWebhook(await req.text(), req.headers);
        return new Response(r.body, { status: r.status, headers: r.headers });
      }
      if (path === "/api/cron/expire") {
        const secret = opts.cronSecret ?? process.env["CRON_SECRET"];
        if (!secret || bearer(req) !== secret) return error(401, "unauthorized", "Invalid cron secret.");
        return json(200, await wallet.expireStale());
      }
      if (path === "/api/health") return json(200, { ok: true });

      if (!path.startsWith("/api/v1/")) return error(404, "not_found", "No such endpoint.");
      const agent = await wallet.owner.authenticateAgent(bearer(req));
      if (!agent) return error(401, "unauthorized", "Missing, invalid or revoked agent API key. Send Authorization: Bearer <key>.");
      if (!(await wallet.deps.agentRateLimiter.take(`agent:${agent.id}`))) {
        return error(429, "rate_limited", "Too many requests. Wait a minute before calling again.", { "retry-after": "60" });
      }
      return await route(wallet, agent, req, path);
    } catch (e) {
      if (WalletError.is(e)) return error(e.status, e.code, e.message, undefined, e.details);
      wallet.deps.logger.error("api error", { path, error: e instanceof Error ? e.message : String(e) });
      return error(500, "internal", "Internal error.");
    }
  };
}

async function route(wallet: Wallet, agent: AuthedAgent, req: Request, path: string): Promise<Response> {
  const p = wallet.purchases;
  const m = req.method;
  if (path === "/api/v1/agent/policy" && m === "GET") return json(200, await p.getMyPolicy(agent));
  if (path === "/api/v1/agent/budget" && m === "GET") return json(200, await p.getBudget(agent));
  if (path === "/api/v1/agent/shipping" && m === "GET") return json(200, await p.getShippingDetails(agent));
  if (path === "/api/v1/purchases" && m === "GET") return json(200, { purchases: await p.listMyPurchases(agent, Number(new URL(req.url).searchParams.get("limit") ?? 20)) });
  if (path === "/api/v1/purchases" && m === "POST") {
    const v = await p.requestPurchase(agent, await body(req));
    return json(v.status === "denied" ? 200 : 201, v);
  }
  const match = /^\/api\/v1\/purchases\/([A-Za-z0-9_-]{1,64})(?:\/(status|cancel|result|fill-payment|wait))?$/.exec(path);
  if (match) {
    const [, id, action] = match as unknown as [string, string, string | undefined];
    if (!action && m === "GET") return noStore(json(200, await p.getPurchaseStatus(agent, id)));
    if (action === "status" && m === "POST") {
      const b = (await body(req)) as { current_cart?: unknown };
      return noStore(json(200, await p.getPurchaseStatus(agent, id, b?.current_cart !== undefined ? { cart: b.current_cart } : {})));
    }
    if (action === "cancel" && m === "POST") {
      const b = (await body(req)) as { reason?: unknown };
      return json(200, await p.cancelPurchase(agent, id, typeof b?.reason === "string" ? b.reason : undefined));
    }
    if (action === "result" && m === "POST") return json(200, await p.reportPurchaseResult(agent, id, await body(req)));
    if (action === "wait" && m === "POST") {
      const b = (await body(req)) as { seconds?: unknown };
      return noStore(json(200, await p.waitForDecision(agent, id, typeof b?.seconds === "number" ? b.seconds : 60)));
    }
    if (action === "fill-payment" && m === "POST") {
      const b = (await body(req)) as { button_text?: unknown };
      return noStore(json(200, await p.fillPaymentDetails(agent, id, typeof b?.button_text === "string" && b.button_text.trim() ? { buttonText: b.button_text.slice(0, 80) } : {})));
    }
  }
  return error(404, "not_found", "No such endpoint.");
}

async function body(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 256_000) throw new WalletError("validation", "Request body too large.");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new WalletError("validation", "Body must be JSON.");
  }
}

function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Responses that may carry card details must never be cached. */
function noStore(r: Response): Response {
  r.headers.set("cache-control", "no-store");
  return r;
}

function error(status: number, code: string, message: string, headers: Record<string, string> = {}, details?: unknown): Response {
  return json(status, { error: { code, message, ...(details ? { details } : {}) } }, headers);
}
