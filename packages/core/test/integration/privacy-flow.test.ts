import { describe, expect, it } from "vitest";
import { PrivacyCardIssuer, PRIVACY_SIGNATURE_HEADER, signPrivacyWebhook } from "../../src/issuer/privacy";
import { silentLogger } from "../../src/logger";
import { ConsoleEmailSender, ConsolePushSender } from "../../src/notify/senders";
import { parsePolicy } from "../../src/policy/schema";
import { MemoryRateLimiter } from "../../src/security";
import { createWallet, type AuthedAgent } from "../../src/wallet/index";
import { fakePrivacyApi, privacyTxn } from "../privacy-fake";
import { db, events, groceries, openPolicy } from "./harness";

let counter = 0;
async function setupPrivacy() {
  const clock = { now: new Date("2026-10-14T19:00:00Z") };
  const api = fakePrivacyApi();
  const issuer = new PrivacyCardIssuer({ apiKey: "test_privacy_key", fetch: api.fetch, cardholderName: "Pat Doe", billingAddress: null });
  const wallet = createWallet({ db, issuer, email: new ConsoleEmailSender(silentLogger), push: new ConsolePushSender(silentLogger), logger: silentLogger, now: () => clock.now, agentRateLimiter: new MemoryRateLimiter(1000, 60_000) });
  const user = await wallet.owner.ensureUser(`privacy${Date.now()}_${counter++}@test.dev`);
  const created = await wallet.owner.createAgent(user.id, { name: "Shopper", rules: parsePolicy(openPolicy) });
  const agent = (await wallet.owner.authenticateAgent(created.apiKey)) as AuthedAgent;
  const webhook = (t: unknown) => wallet.issuerEvents.handleWebhook(JSON.stringify(t), new Headers({ [PRIVACY_SIGNATURE_HEADER]: signPrivacyWebhook(t, "test_privacy_key") }));
  return { wallet, api, user, agent, webhook, clock };
}

async function issued(t: Awaited<ReturnType<typeof setupPrivacy>>, total = 12) {
  const r = await t.wallet.purchases.requestPurchase(t.agent, groceries({ total }));
  const s = await t.wallet.purchases.getPurchaseStatus(t.agent, r.id);
  expect(s.status).toBe("credential_issued");
  const cred = await db.issuedCredential.findFirstOrThrow({ where: { purchaseRequestId: r.id } });
  return { id: r.id, s, cred };
}

describe("Privacy.com issuer, end to end", () => {
  it("issues a real-shaped single-use card and completes on a matching charge", async () => {
    const t = await setupPrivacy();
    const { id, s, cred } = await issued(t);
    expect(s.credential).toMatchObject({ cvc: "776", exp_month: 6, exp_year: 2030, cardholder_name: "Pat Doe" });
    expect(t.api.cards.get(cred.providerCardId)).toMatchObject({ type: "SINGLE_USE", spend_limit: 1200 });

    expect((await t.webhook(privacyTxn({ token: "tx1", card: cred.providerCardId, type: "AUTHORIZATION", amount: 1200, descriptor: "AMZN Mktp US" }))).status).toBe(200);
    expect((await events(t.user.id, "authorization.approved")).length).toBe(1);
    await t.webhook(privacyTxn({ token: "tx1", card: cred.providerCardId, type: "CLEARING", amount: 1200, descriptor: "AMZN Mktp US" }));
    expect((await db.purchaseRequest.findUniqueOrThrow({ where: { id } })).status).toBe("completed");
    expect(t.api.cards.get(cred.providerCardId)!.state).toBe("CLOSED");
  });

  it("closes the card and alerts when a charge doesn't match the approved store", async () => {
    const t = await setupPrivacy();
    const { cred } = await issued(t);
    await t.webhook(privacyTxn({ token: "tx2", card: cred.providerCardId, type: "AUTHORIZATION", amount: 1200, descriptor: "QUICKCASH ELECTRONICS", mcc: "5732" }));
    expect(t.api.cards.get(cred.providerCardId)!.state).toBe("CLOSED");
    expect((await db.issuedCredential.findUniqueOrThrow({ where: { id: cred.id } })).status).toBe("cancelled");
    const sec = await events(t.user.id, "security.authorization_mismatch");
    expect(sec).toHaveLength(1);
    expect((sec[0]!.payload as { message: string }).message).toMatch(/Consider disputing/);
  });

  it("flags a charge over the exact approved amount even though Privacy's cap rounds up to the dollar", async () => {
    const t = await setupPrivacy();
    const { cred } = await issued(t, 11.4);
    expect(t.api.cards.get(cred.providerCardId)!.spend_limit).toBe(1200);
    await t.webhook(privacyTxn({ token: "tx3", card: cred.providerCardId, type: "AUTHORIZATION", amount: 1199, descriptor: "AMZN Mktp US" }));
    expect((await events(t.user.id, "security.authorization_mismatch")).length).toBe(1);
  });

  it("closes the Privacy card on freeze and ignores replayed webhooks", async () => {
    const t = await setupPrivacy();
    const { cred } = await issued(t);
    const txn = privacyTxn({ token: "tx4", card: cred.providerCardId, type: "AUTHORIZATION", amount: 1200, descriptor: "AMZN Mktp US" });
    await t.webhook(txn);
    await t.webhook(txn);
    expect((await events(t.user.id, "authorization.approved")).length).toBe(1);
    await t.wallet.owner.freezeAgent(t.user.id, t.agent.id);
    expect(t.api.cards.get(cred.providerCardId)!.state).toBe("CLOSED");
  });

  it("rejects webhooks signed with the wrong key", async () => {
    const t = await setupPrivacy();
    const r = await t.wallet.issuerEvents.handleWebhook(JSON.stringify({ token: "x" }), new Headers({ [PRIVACY_SIGNATURE_HEADER]: signPrivacyWebhook({ token: "x" }, "nope") }));
    expect(r.status).toBe(400);
  });
});
