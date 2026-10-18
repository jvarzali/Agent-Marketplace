import { createDb } from "@paysafe/db";
import { MockCardIssuer } from "../../src/issuer/mock";
import { silentLogger } from "../../src/logger";
import { ConsoleEmailSender, ConsolePushSender } from "../../src/notify/senders";
import { parsePolicy, type PolicyRulesInput } from "../../src/policy/schema";
import { MemoryRateLimiter } from "../../src/security";
import { createWallet, type AuthedAgent } from "../../src/wallet/index";
import { TEST_DATABASE_URL } from "./global-setup";

export const db = createDb(TEST_DATABASE_URL);

export const openPolicy: PolicyRulesInput = {
  merchants: { mode: "allowlist", allow_domains: ["amazon.com", "target.com"] },
  categories: { allow: ["groceries", "household", "pet_supplies"] },
  limits: { per_order_total: 75, per_day: 150, per_week: 200, per_month: 500, max_quantity_per_item: 5, max_orders_per_day: 10 },
  approval: { always: false, require_if_total_over: 30, require_for_new_merchant: false },
  schedule: { timezone: "America/Los_Angeles", allowed_hours: null },
  currency: "USD",
};

let counter = 0;

export async function setup(policyInput: PolicyRulesInput = openPolicy) {
  const clock = { now: new Date("2026-10-14T19:00:00Z") };
  const issuer = new MockCardIssuer("test_secret", () => clock.now);
  const email = new ConsoleEmailSender(silentLogger);
  const push = new ConsolePushSender(silentLogger);
  const wallet = createWallet({ db, issuer, email, push, logger: silentLogger, now: () => clock.now, agentRateLimiter: new MemoryRateLimiter(1000, 60_000) });
  const user = await wallet.owner.ensureUser(`user${Date.now()}_${counter++}@test.dev`);
  const created = await wallet.owner.createAgent(user.id, { name: "Shopper", rules: parsePolicy(policyInput) });
  const agent = (await wallet.owner.authenticateAgent(created.apiKey)) as AuthedAgent;
  const deliver = async (body: string, headers: Headers) => {
    const r = await wallet.issuerEvents.handleWebhook(body, headers);
    return { status: r.status, body: r.body };
  };
  const advance = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  return { wallet, issuer, email, push, user, agent, apiKey: created.apiKey, deliver, clock, advance };
}

export function groceries(o: { total?: number; merchant?: string; extraItems?: { name: string; unit_price: number; quantity: number }[] } = {}) {
  const price = o.total ?? 12;
  const items = [{ name: "Organic bananas", unit_price: price, quantity: 1, url: "https://www.amazon.com/dp/B0BANANA" }, ...(o.extraItems ?? [])];
  const subtotal = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  return {
    merchant_domain: o.merchant ?? "amazon.com",
    merchant_name: o.merchant === "target.com" ? "Target" : "Amazon",
    items,
    subtotal,
    tax: 0,
    shipping: 0,
    total: subtotal,
    currency: "USD",
    reasoning: "Weekly groceries the user asked for",
  };
}

export const amazon = { name: "AMZN Mktp US", mcc: "5411", domain: null, country: "US" };

export async function events(userId: string, type?: string) {
  return db.auditEvent.findMany({ where: { userId, ...(type ? { type } : {}) }, orderBy: { createdAt: "asc" } });
}
