#!/usr/bin/env node
/**
 * Local MCP server over stdio, for clients like Claude Desktop / Claude Code that launch a process.
 * Env: AGENT_WALLET_API_KEY (the agent's key), DATABASE_URL, plus the same provider env as the web app.
 * Logs go to stderr; stdout is reserved for the MCP protocol.
 */
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWalletFromEnv, type Logger } from "@agent-wallet/core";
import { createMcpServer } from "./server";

const stderrLogger: Logger = {
  info: (m, d) => process.stderr.write(`${JSON.stringify({ level: "info", m, d })}\n`),
  warn: (m, d) => process.stderr.write(`${JSON.stringify({ level: "warn", m, d })}\n`),
  error: (m, d) => process.stderr.write(`${JSON.stringify({ level: "error", m, d })}\n`),
};

async function main() {
  const wallet = createWalletFromEnv({ logger: stderrLogger });
  const agent = await wallet.owner.authenticateAgent(process.env["AGENT_WALLET_API_KEY"]);
  if (!agent) {
    process.stderr.write("AGENT_WALLET_API_KEY is missing, invalid or revoked.\n");
    process.exit(1);
  }
  const server = createMcpServer(wallet, agent);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`agent-wallet MCP failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
