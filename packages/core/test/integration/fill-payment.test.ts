import { describe, expect, it } from "vitest";
import { CardFillError, type CardFiller, type FillParams, type FillResult } from "../../src/checkout/browser-fill";
import { WalletError } from "../../src/wallet/context";
import { amazon, db, events, groceries, setup } from "./harness";

/** Browser delivery with a filler that records what it was asked to type. */
async function browserWallet(behave: (p: FillParams) => void = () => undefined, order: FillResult["order"] = { outcome: "confirmed", reference: "A1B2C3", message: "Thank you for your order" }) {
  const t = await setup();
  const calls: FillParams[] = [];
  const filler: CardFiller = {
    fill: async (p) => {
      calls.push(p);
      behave(p);
      return { pageUrl: "https://www.amazon.com/checkout/pay?session=1", filled: ["card number", "expiry", "security code"], ...(order ? { order } : {}) };
    },
  };
  t.wallet.deps.config.cardDelivery = "browser";
  t.wallet.deps.cardFiller = filler;
  return { t, calls };
}

describe("fill_payment_details (browser card delivery)", () => {
  it("never hands the agent the card; the wallet enters it on the page", async () => {
    const { t, calls } = await browserWallet();
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries());
    expect(v.status).toBe("approved");
    expect(v.next_step).toMatch(/fill_payment_details/);

    const s = await t.wallet.purchases.getPurchaseStatus(t.agent, v.id);
    expect(s.status).toBe("credential_issued");
    expect(s.credential).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/\d{16}/);

    const f = await t.wallet.purchases.fillPaymentDetails(t.agent, v.id);
    expect(JSON.stringify(f)).not.toMatch(/\d{16}/);
    expect(f).toMatchObject({ card_last4: expect.stringMatching(/^\d{4}$/), filled_fields: ["card number", "expiry", "security code"], billing_address: { postalCode: "94115" } });
    expect(calls[0]).toMatchObject({ merchantDomain: "amazon.com", totalCents: 1200, currency: "USD", secrets: { number: expect.stringMatching(/^\d{16}$/) } });
    const cred = await db.issuedCredential.findFirstOrThrow({ where: { purchaseRequestId: v.id } });
    expect(cred.deliveredAt).not.toBeNull();
    const filled = await events(t.user.id, "credential.filled");
    expect(filled[0]!.payload).toMatchObject({ page: "https://www.amazon.com/checkout/pay" });
    expect(JSON.stringify(filled)).not.toMatch(/\d{16}/);

    // The card still works for the store's charge.
    const charge = await t.issuer.simulateCharge({ providerCardId: cred.providerCardId, amountCents: 1200, merchant: amazon, deliver: t.deliver });
    expect(charge.approved).toBe(true);
  });

  it("the wallet places the order and records a confirmed one", async () => {
    const { t, calls } = await browserWallet();
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries());
    const f = await t.wallet.purchases.fillPaymentDetails(t.agent, v.id);
    expect(calls[0]!.placeOrder).toEqual({});
    expect(f).toMatchObject({ order_outcome: "confirmed", order_reference: "A1B2C3", next_step: expect.stringMatching(/placed the order \(order A1B2C3\)/) });
    expect(await events(t.user.id, "purchase.result_reported")).toHaveLength(1);
  });

  it("passes the agent's button_text to the browser", async () => {
    const { t, calls } = await browserWallet(undefined, { outcome: "unknown", reference: null, message: "" });
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries());
    const f = await t.wallet.purchases.fillPaymentDetails(t.agent, v.id, { buttonText: "Finish" });
    expect(calls[0]!.placeOrder).toEqual({ buttonText: "Finish" });
    expect(f.next_step).toMatch(/Don't place the order a second time/);
  });

  it("a declined payment isn't recorded as a purchase, and the agent is told what to do", async () => {
    const { t } = await browserWallet(undefined, { outcome: "declined", reference: null, message: "Your card was declined" });
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries());
    const f = await t.wallet.purchases.fillPaymentDetails(t.agent, v.id);
    expect(f).toMatchObject({ order_outcome: "declined", status: "credential_issued", next_step: expect.stringMatching(/declined the payment.*removed from the form/) });
    expect(await events(t.user.id, "purchase.result_reported")).toHaveLength(0);
  });

  it("issues the card on first fill straight after approval", async () => {
    const { t, calls } = await browserWallet();
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries());
    await t.wallet.purchases.fillPaymentDetails(t.agent, v.id);
    expect(calls).toHaveLength(1);
    expect((await db.purchaseRequest.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("credential_issued");
  });

  it("won't fill before approval", async () => {
    const { t, calls } = await browserWallet();
    const pending = await t.wallet.purchases.requestPurchase(t.agent, groceries({ total: 45 }));
    expect(pending.status).toBe("pending_approval");
    await expect(t.wallet.purchases.fillPaymentDetails(t.agent, pending.id)).rejects.toThrow(/pending_approval/);
    expect(calls).toHaveLength(0);
  });

  it("stops after five fills of the same card", async () => {
    const { t } = await browserWallet();
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries());
    for (let i = 0; i < 5; i++) await t.wallet.purchases.fillPaymentDetails(t.agent, v.id);
    await expect(t.wallet.purchases.fillPaymentDetails(t.agent, v.id)).rejects.toThrow(/already entered 5 times/);
  });

  it("won't fill once the agent is frozen", async () => {
    const { t, calls } = await browserWallet();
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries());
    await t.wallet.purchases.getPurchaseStatus(t.agent, v.id);
    await t.wallet.owner.freezeAgent(t.user.id, t.agent.id);
    await expect(t.wallet.purchases.fillPaymentDetails(t.agent, v.id)).rejects.toSatisfy((e: unknown) => WalletError.is(e));
    expect(calls).toHaveLength(0);
  });

  it("passes the filler's explanation to the agent and logs the failure", async () => {
    const { t } = await browserWallet(() => {
      throw new CardFillError("The checkout page doesn't show the approved total of $12.00");
    });
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries());
    await expect(t.wallet.purchases.fillPaymentDetails(t.agent, v.id)).rejects.toThrow(/doesn't show the approved total/);
    expect(await events(t.user.id, "credential.fill_failed")).toHaveLength(1);
  });

  it("agent delivery still shows the card once, and fill works there too", async () => {
    const t = await setup();
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries());
    expect((await t.wallet.purchases.getPurchaseStatus(t.agent, v.id)).credential?.number).toMatch(/^\d{16}$/);
    await expect(t.wallet.purchases.fillPaymentDetails(t.agent, v.id)).rejects.toThrow(/isn't set up to enter cards/);
  });
});
