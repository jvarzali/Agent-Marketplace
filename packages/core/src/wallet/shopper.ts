/**
 * Contact and shipping details the agent fills in at checkout (get_shipping_details). With test
 * cards there's a built-in made-up profile; with real cards only details the owner set are shared.
 * Agents are never told which one they got, so they behave as they would with real details.
 */
export interface ShopperProfile {
  name: string;
  email: string;
  phone: string;
  address: { line1: string; line2: string | null; city: string; state: string; postalCode: string; country: string };
  /** True for the built-in made-up profile (test cards only). Owner-facing; never sent to agents. */
  test: boolean;
}

/**
 * Made-up but ordinary-looking identity for test cards. The defaults for email and phone are
 * reserved values (example.com, 555-01xx) so stores' emails and texts can't reach a stranger;
 * set TEST_SHOPPER_EMAIL / TEST_SHOPPER_PHONE to ones you own to make those look real too.
 */
export const TEST_SHOPPER: ShopperProfile = {
  name: "Jordan Avery",
  email: "jordan.avery@example.com",
  phone: "+1 415-555-0123",
  address: { line1: "2150 Pine Street", line2: "Apt 4", city: "San Francisco", state: "CA", postalCode: "94115", country: "US" },
  test: true,
};

/** The made-up profile, with any TEST_SHOPPER_* overrides. */
export function testShopperFromEnv(env: (k: string) => string | undefined): ShopperProfile {
  return {
    ...TEST_SHOPPER,
    name: env("TEST_SHOPPER_NAME") ?? TEST_SHOPPER.name,
    email: env("TEST_SHOPPER_EMAIL") ?? TEST_SHOPPER.email,
    phone: env("TEST_SHOPPER_PHONE") ?? TEST_SHOPPER.phone,
  };
}

/** SHOPPER_* environment variables, or null if SHOPPER_NAME isn't set. */
export function shopperFromEnv(env: (k: string) => string | undefined): ShopperProfile | null {
  const name = env("SHOPPER_NAME");
  if (!name) return null;
  const need = (k: string) => {
    const v = env(k);
    if (!v) throw new Error(`SHOPPER_NAME is set, so ${k} is required too`);
    return v;
  };
  return {
    name,
    email: need("SHOPPER_EMAIL"),
    phone: need("SHOPPER_PHONE"),
    address: {
      line1: need("SHOPPER_ADDRESS_LINE1"),
      line2: env("SHOPPER_ADDRESS_LINE2") ?? null,
      city: need("SHOPPER_ADDRESS_CITY"),
      state: need("SHOPPER_ADDRESS_STATE"),
      postalCode: need("SHOPPER_ADDRESS_POSTAL_CODE"),
      country: env("SHOPPER_ADDRESS_COUNTRY") ?? "US",
    },
    test: false,
  };
}
