import { describe, expect, it } from "vitest";
import { shopperFromEnv, TEST_SHOPPER, testShopperFromEnv } from "../../src/wallet/shopper";
import { events, groceries, setup } from "./harness";

describe("get_shipping_details", () => {
  it("gives the made-up profile with test cards, without telling the agent it's a test", async () => {
    const t = await setup();
    const d = await t.wallet.purchases.getShippingDetails(t.agent);
    const { test: _t, ...expected } = TEST_SHOPPER;
    expect(d).toMatchObject(expected);
    expect(d).not.toHaveProperty("test");
    expect(JSON.stringify(d)).not.toMatch(/test|fake|demo/i);
    // The owner's audit log still records that it was the test profile.
    expect((await events(t.user.id, "shopper.details_shared"))[0]!.payload).toMatchObject({ test_profile: true });
    // Real details look exactly the same to the agent.
    t.wallet.deps.config.shopper = { ...TEST_SHOPPER, name: "Pat Doe", test: false };
    const real = await t.wallet.purchases.getShippingDetails(t.agent);
    expect(Object.keys(real).sort()).toEqual(Object.keys(d).sort());
    expect(real.next_step).toBe(d.next_step);
  });

  it("the card's billing name and address match the made-up shopper", async () => {
    const t = await setup();
    const v = await t.wallet.purchases.requestPurchase(t.agent, groceries());
    const s = await t.wallet.purchases.getPurchaseStatus(t.agent, v.id);
    expect(s.credential).toMatchObject({ cardholder_name: TEST_SHOPPER.name, billing_address: { line1: TEST_SHOPPER.address.line1, postalCode: TEST_SHOPPER.address.postalCode } });
  });

  it("gives nothing with real cards unless the owner set details", async () => {
    const t = await setup();
    Object.defineProperty(t.wallet.deps.issuer, "supportsTestCharges", { value: false });
    await expect(t.wallet.purchases.getShippingDetails(t.agent)).rejects.toThrow(/hasn't set shipping details/);
    const mine = { ...TEST_SHOPPER, name: "Pat Doe", test: false };
    t.wallet.deps.config.shopper = mine;
    expect(await t.wallet.purchases.getShippingDetails(t.agent)).toMatchObject({ name: "Pat Doe" });
  });

  it("an explicit null turns it off even with test cards", async () => {
    const t = await setup();
    t.wallet.deps.config.shopper = null;
    await expect(t.wallet.purchases.getShippingDetails(t.agent)).rejects.toThrow(/hasn't set shipping details/);
  });

  it("frozen agents get nothing", async () => {
    const t = await setup();
    await t.wallet.owner.freezeAgent(t.user.id, t.agent.id);
    await expect(t.wallet.purchases.getShippingDetails(t.agent)).rejects.toThrow(/frozen/);
  });

  it("TEST_SHOPPER_EMAIL / TEST_SHOPPER_PHONE replace the reserved defaults", () => {
    const vars: Record<string, string> = { TEST_SHOPPER_EMAIL: "me+shop@gmail.com", TEST_SHOPPER_PHONE: "+1 650 000 0000" };
    expect(testShopperFromEnv((k) => vars[k])).toMatchObject({ name: TEST_SHOPPER.name, email: "me+shop@gmail.com", phone: "+1 650 000 0000", test: true });
  });

  it("reads SHOPPER_* settings and requires the full set", () => {
    const vars: Record<string, string> = { SHOPPER_NAME: "Pat Doe", SHOPPER_EMAIL: "pat@example.com", SHOPPER_PHONE: "555", SHOPPER_ADDRESS_LINE1: "1 Main", SHOPPER_ADDRESS_CITY: "Austin", SHOPPER_ADDRESS_STATE: "TX", SHOPPER_ADDRESS_POSTAL_CODE: "78701" };
    expect(shopperFromEnv((k) => vars[k])).toMatchObject({ name: "Pat Doe", address: { country: "US", line2: null }, test: false });
    expect(shopperFromEnv(() => undefined)).toBeNull();
    expect(() => shopperFromEnv((k) => (k === "SHOPPER_NAME" ? "x" : undefined))).toThrow(/SHOPPER_EMAIL is required/);
  });
});
