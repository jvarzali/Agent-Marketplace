import { describe, expect, it } from "vitest";
import { MOCK_SIGNATURE_HEADER } from "@paysafe/core";
import { amazon, db, groceries, setup } from "../../core/test/integration/harness";
import { createApiHandler } from "../src/handler";

async function client() {
  const t = await setup();
  const handle = createApiHandler(() => t.wallet, { cronSecret: "cron_test" });
  const call = async (method: string, path: string, body?: unknown, key: string | null = t.apiKey) => {
    const res = await handle(
      new Request(`http://test${path}`, {
        method,
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
  return { t, handle, call };
}

describe("REST API", () => {
  it("requires a valid agent key", async () => {
    const { call } = await client();
    expect((await call("GET", "/api/v1/agent/policy", undefined, null)).status).toBe(401);
    expect((await call("GET", "/api/v1/agent/policy", undefined, "aw_notarealkeynotarealkey")).status).toBe(401);
  });

  it("full flow: policy, budget, request, status with credential once, result", async () => {
    const { call, t } = await client();
    const policy = await call("GET", "/api/v1/agent/policy");
    expect(policy.status).toBe(200);
    expect(policy.json.summary).toContain("amazon.com");

    expect((await call("GET", "/api/v1/agent/budget")).json.windows).toHaveLength(3);

    const created = await call("POST", "/api/v1/purchases", groceries());
    expect(created.status).toBe(201);
    expect(created.json.status).toBe("approved");

    const s1 = await call("GET", `/api/v1/purchases/${created.json.id}`);
    expect(s1.headers.get("cache-control")).toBe("no-store");
    expect(s1.json.credential.number).toMatch(/^\d{16}$/);
    const s2 = await call("GET", `/api/v1/purchases/${created.json.id}`);
    expect(s2.json.credential).toBeUndefined();

    const cred = await db.issuedCredential.findFirstOrThrow({ where: { purchaseRequestId: created.json.id } });
    await t.issuer.simulateCharge({ providerCardId: cred.providerCardId, amountCents: 1200, merchant: amazon, deliver: t.deliver });
    const r = await call("POST", `/api/v1/purchases/${created.json.id}/result`, { success: true, order_reference: "A-1" });
    expect(r.json.status).toBe("completed");
    expect((await call("GET", "/api/v1/purchases")).json.purchases).toHaveLength(1);
  });

  it("returns denials with reasons and helpful validation errors", async () => {
    const { call } = await client();
    const denied = await call("POST", "/api/v1/purchases", groceries({ merchant: "target.com", extraItems: [{ name: "Visa gift card", unit_price: 25, quantity: 1 }] }));
    expect(denied.status).toBe(200);
    expect(denied.json.status).toBe("denied");
    expect(denied.json.next_step).toMatch(/do not split/i);
    const bad = await call("POST", "/api/v1/purchases", { merchant_domain: "amazon.com" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("validation");
  });

  it("cart confirmation via POST /status cancels on mismatch", async () => {
    const { call, t } = await client();
    const created = await call("POST", "/api/v1/purchases", groceries({ total: 45 }));
    await t.wallet.owner.decideApproval(t.user.id, created.json.id, "approved", created.json.cart_hash);
    const s = await call("POST", `/api/v1/purchases/${created.json.id}/status`, { current_cart: groceries({ total: 46 }) });
    expect(s.json.status).toBe("cancelled");
  });

  it("rate-limits per agent", async () => {
    const { t, call } = await client();
    t.wallet.deps.agentRateLimiter = { take: async () => false };
    const r = await call("GET", "/api/v1/agent/budget");
    expect(r.status).toBe(429);
  });

  it("webhooks verify signatures; cron requires its secret", async () => {
    const { handle, t } = await client();
    const bad = await handle(new Request("http://test/api/webhooks/issuer", { method: "POST", body: "{}", headers: { [MOCK_SIGNATURE_HEADER]: "00" } }));
    expect(bad.status).toBe(400);
    const body = JSON.stringify({ type: "ignored", eventId: "e1", providerType: "x", raw: null });
    const good = await handle(new Request("http://test/api/webhooks/issuer", { method: "POST", body, headers: { [MOCK_SIGNATURE_HEADER]: t.issuer.sign(body) } }));
    expect(good.status).toBe(200);
    expect((await handle(new Request("http://test/api/cron/expire"))).status).toBe(401);
    expect((await handle(new Request("http://test/api/cron/expire", { headers: { authorization: "Bearer cron_test" } }))).status).toBe(200);
  });
});

describe("MCP over HTTP", () => {
  const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id, method, params });

  it("rejects unauthenticated clients", async () => {
    const { call } = await client();
    expect((await call("POST", "/api/mcp", rpc(1, "tools/list"), null)).status).toBe(401);
  });

  it("lists the tools with safety rules in their descriptions", async () => {
    const { call } = await client();
    const init = await call("POST", "/api/mcp", rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(init.status).toBe(200);
    expect(init.json.result.instructions).toMatch(/NEVER ask the user for their real card/);
    const list = await call("POST", "/api/mcp", rpc(2, "tools/list"));
    const names = list.json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_my_policy", "get_budget", "request_purchase", "get_purchase_status", "cancel_purchase", "report_purchase_result"]));
    const req = list.json.result.tools.find((t: { name: string }) => t.name === "request_purchase");
    expect(req.description).toMatch(/NEVER save/);
    expect(req.description).toMatch(/NEVER retry a denied purchase by splitting/);
  });

  it("runs a purchase through tools", async () => {
    const { call } = await client();
    const tool = async (name: string, args: unknown) => (await call("POST", "/api/mcp", rpc(3, "tools/call", { name, arguments: args }))).json.result;
    const policy = await tool("get_my_policy", {});
    expect(policy.content[0].text).toContain("Only these stores");
    const r = await tool("request_purchase", groceries());
    const id = /"id": "([^"]+)"/.exec(r.content[0].text)![1];
    expect(r.content[0].text).toMatch(/Status: approved/);
    const s = await tool("get_purchase_status", { purchase_id: id });
    expect(s.content[0].text).toMatch(/SINGLE-USE CARD/);
    const s2 = await tool("get_purchase_status", { purchase_id: id });
    expect(s2.content[0].text).not.toMatch(/"number"/);
    const err = await tool("cancel_purchase", { purchase_id: "nope" });
    expect(err.isError).toBe(true);
    expect(err.content[0].text).toMatch(/No purchase request/);
  });
});
