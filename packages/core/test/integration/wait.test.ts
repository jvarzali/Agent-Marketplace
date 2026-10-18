import { describe, expect, it } from "vitest";
import { MockCardIssuer } from "../../src/issuer/mock";
import { groceries, setup } from "./harness";

describe("wait_for_decision", () => {
  it("returns as soon as the owner approves", async () => {
    const t = await setup();
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries({ total: 45 }));
    expect(v.status).toBe("pending_approval");
    expect(v.next_step).toMatch(/wait_for_decision/);
    const started = Date.now();
    const waiting = t.wallet.purchases.waitForDecision(t.agent, v.id, 30, 50);
    setTimeout(() => void t.wallet.owner.decideApproval(t.user.id, v.id, "approved", v.cart_hash), 200);
    const r = await waiting;
    expect(r.status).toBe("credential_issued");
    expect(r.credential?.number).toMatch(/^\d{16}$/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("returns a denial, and says to keep waiting when time runs out", async () => {
    const t = await setup();
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries({ total: 45 }));
    const still = await t.wallet.purchases.waitForDecision(t.agent, v.id, 1, 50);
    expect(still.status).toBe("pending_approval");
    expect(still.next_step).toMatch(/Call wait_for_decision again/);
    await t.wallet.owner.decideApproval(t.user.id, v.id, "denied", v.cart_hash);
    expect((await t.wallet.purchases.waitForDecision(t.agent, v.id, 30, 50)).status).toBe("denied");
  });

  it("only waits on the agent's own requests", async () => {
    const t = await setup();
    await expect(t.wallet.purchases.waitForDecision(t.agent, "nope", 1, 50)).rejects.toThrow(/No purchase request/);
  });
});

describe("card holder", () => {
  it("cards carry the owner's name and billing address when set", async () => {
    const holder = { name: "Pat Doe", address: { line1: "1 Main St", line2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US" } };
    const issuer = new MockCardIssuer("s", () => new Date(), holder);
    const card = await issuer.createCard({ purchaseRequestId: "r", userId: "u", amountLimitCents: 100, currency: "USD", merchantDomain: "a.com", merchantName: "A", allowedMccs: [], blockedMccs: [], expiresAt: new Date(Date.now() + 60_000) });
    expect(await issuer.getCardSecrets(card.providerCardId)).toMatchObject({ cardholderName: "Pat Doe", billingAddress: { postalCode: "78701" } });
  });
});
