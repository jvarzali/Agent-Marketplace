import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "../../core/test/integration/global-setup";
import { groceries, setup } from "../../core/test/integration/harness";

describe("stdio MCP server (as Claude Desktop / Claude Code would launch it)", () => {
  it("connects with an agent key and runs tools", async () => {
    const t = await setup();
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", fileURLToPath(new URL("../src/stdio.ts", import.meta.url))],
      env: { ...(process.env as Record<string, string>), DATABASE_URL: TEST_DATABASE_URL, PAYSAFE_API_KEY: t.apiKey, CARD_ISSUER: "mock" },
      stderr: "pipe",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((x) => x.name)).toContain("request_purchase");
      const policy = await client.callTool({ name: "get_my_policy", arguments: {} });
      expect(JSON.stringify(policy.content)).toContain("Only these stores");
      const r = await client.callTool({ name: "request_purchase", arguments: groceries() });
      expect(JSON.stringify(r.content)).toContain("Status: approved");
    } finally {
      await client.close();
    }
  });

  it("refuses to start without a valid key", async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", fileURLToPath(new URL("../src/stdio.ts", import.meta.url))],
      env: { ...(process.env as Record<string, string>), DATABASE_URL: TEST_DATABASE_URL, PAYSAFE_API_KEY: "aw_invalidinvalidinvalid" },
      stderr: "pipe",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
