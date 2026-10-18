/**
 * Standalone dev server for the agent API, MCP endpoint, webhooks and cron, until the
 * Next.js app mounts the same handler. `npm run dev:api` → http://localhost:4000
 */
import { config as loadEnv } from "dotenv";
import { createServer } from "node:http";
import { getWallet, MockCardIssuer } from "@paysafe/core";
import { createApiHandler } from "./handler";

// The monorepo keeps one .env at its root; a package-local .env (if any) wins.
loadEnv({ path: [".env", new URL("../../../.env", import.meta.url).pathname], quiet: true });

const port = Number(process.env["API_PORT"] ?? 4000);
const handle = createApiHandler();

/** Dev-only: let you play the card network against the mock issuer. Disabled unless CARD_ISSUER=mock. */
async function devSimulate(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/dev/simulate-charge" || req.method !== "POST") return null;
  const wallet = getWallet();
  if (!(wallet.deps.issuer instanceof MockCardIssuer)) return new Response("mock issuer only", { status: 404 });
  const b = (await req.json()) as { purchase_id: string; amount: number; merchant_name: string; mcc?: string; refund?: boolean };
  const cred = await wallet.deps.db.issuedCredential.findFirst({ where: { purchaseRequestId: b.purchase_id }, orderBy: { createdAt: "desc" } });
  if (!cred) return new Response("no credential for that purchase", { status: 404 });
  const deliver = async (body: string, headers: Headers) => {
    const r = await wallet.issuerEvents.handleWebhook(body, headers);
    return { status: r.status, body: r.body };
  };
  const merchant = { name: b.merchant_name, mcc: b.mcc ?? null, domain: null, country: "US" };
  const amountCents = Math.round(b.amount * 100);
  if (b.refund) {
    await wallet.deps.issuer.simulateRefund({ providerCardId: cred.providerCardId, amountCents, merchant, deliver });
    return Response.json({ refunded: true });
  }
  return Response.json(await wallet.deps.issuer.simulateCharge({ providerCardId: cred.providerCardId, amountCents, merchant, deliver }));
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(`http://localhost:${port}${req.url ?? "/"}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  try {
    const response = (process.env["NODE_ENV"] !== "production" && (await devSimulate(request))) || (await handle(request));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(e instanceof Error ? e.message : "error");
  }
}).listen(port, () => {
  process.stdout.write(`paysafe API listening on http://localhost:${port}\n`);
});
