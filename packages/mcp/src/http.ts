import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getWallet, type Wallet } from "@agent-wallet/core";
import { createMcpServer } from "./server";

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() ?? null;
}

/**
 * Remote MCP endpoint (Streamable HTTP, stateless). Mount at e.g. /api/mcp in Next.js:
 *   export const POST = (req: Request) => handleMcpRequest(req);
 * The agent authenticates with `Authorization: Bearer <agent API key>`.
 */
export async function handleMcpRequest(req: Request, wallet: Wallet = getWallet()): Promise<Response> {
  const agent = await wallet.owner.authenticateAgent(bearer(req));
  if (!agent) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Invalid or revoked agent API key" }, id: null }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="agent-wallet"' },
    });
  }
  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream or session deletion.
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST" },
    });
  }
  const server = createMcpServer(wallet, agent);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}
