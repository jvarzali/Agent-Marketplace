/**
 * Prepares a Stripe test-mode account for PaySafe:
 *  1. checks STRIPE_SECRET_KEY is a test key and that Issuing is turned on,
 *  2. creates the cardholder every card is issued to (or checks the existing one),
 *  3. writes STRIPE_ISSUING_CARDHOLDER_ID (and CARD_ISSUER="stripe") into the root .env,
 *  4. checks the Issuing balance has test money, and prints the webhook command.
 *
 *   npm run stripe:setup
 *
 * The cardholder is you (SHOPPER_* in .env) if set, else the made-up test shopper, so the card's
 * name and billing address match the checkout details. Re-run after changing SHOPPER_*.
 * Optional overrides: STRIPE_CARDHOLDER_NAME and STRIPE_BILLING_LINE1/CITY/STATE/POSTAL_CODE.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import Stripe from "stripe";
import { findFinancialAccount, isStripeTestKey } from "../src/issuer/stripe";
import { shopperFromEnv, TEST_SHOPPER } from "../src/wallet/shopper";

const ROOT_ENV = new URL("../../../.env", import.meta.url).pathname;
loadEnv({ path: [".env", ROOT_ENV], quiet: true });

const env = (k: string) => process.env[k]?.trim() || undefined;

/** E.164 for Stripe: "206-771-9911" → "+12067719911" (US numbers without a country code). */
function e164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (phone.trim().startsWith("+")) return `+${digits}`;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/** Set KEY="value" in the root .env, replacing an existing line or appending one. */
function saveEnv(key: string, value: string) {
  const text = existsSync(ROOT_ENV) ? readFileSync(ROOT_ENV, "utf8") : "";
  const line = `${key}="${value}"`;
  const re = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(ROOT_ENV, re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, "\n")}${line}\n`);
}

async function main() {
  const key = env("STRIPE_SECRET_KEY");
  if (!key) fail(`Put your test secret key in ${ROOT_ENV} as STRIPE_SECRET_KEY="sk_test_..." (Stripe dashboard → Developers → API keys, in test mode).`);
  if (!isStripeTestKey(key)) fail("STRIPE_SECRET_KEY is not a test-mode key. This setup only runs in test mode (sk_test_...).");
  const stripe = new Stripe(key);

  // 1. Issuing turned on?
  try {
    await stripe.issuing.cardholders.list({ limit: 1 });
  } catch (e) {
    fail(
      `Stripe Issuing isn't available on this account yet (${e instanceof Error ? e.message : e}).\n  In the Stripe dashboard, switch to test mode, open Issuing (search "Issuing"), and click Get started.\n  If Issuing doesn't appear, your account's country may not support it.`,
    );
  }
  console.log("✓ Test key works and Issuing is on");

  // 2. Cardholder: the person on every card. Your SHOPPER_* details if set (so the card's name
  // and billing address match the checkout), else the made-up test shopper.
  const shopper = shopperFromEnv(env);
  const base = shopper ?? { ...TEST_SHOPPER, name: env("TEST_SHOPPER_NAME") ?? TEST_SHOPPER.name };
  const name = env("STRIPE_CARDHOLDER_NAME") ?? base.name;
  // Stripe requires a phone number on the cardholder before it issues cards (3-D Secure).
  const phone_number = e164(env("STRIPE_CARDHOLDER_PHONE") ?? base.phone);
  const address = env("STRIPE_BILLING_LINE1")
    ? { line1: env("STRIPE_BILLING_LINE1")!, city: env("STRIPE_BILLING_CITY") ?? "", state: env("STRIPE_BILLING_STATE") ?? "", postal_code: env("STRIPE_BILLING_POSTAL_CODE") ?? "", country: "US" }
    : { line1: base.address.line1, ...(base.address.line2 ? { line2: base.address.line2 } : {}), city: base.address.city, state: base.address.state, postal_code: base.address.postalCode, country: base.address.country };

  let cardholderId = env("STRIPE_ISSUING_CARDHOLDER_ID");
  if (cardholderId) {
    const ch = await stripe.issuing.cardholders.retrieve(cardholderId).catch(() => null);
    if (!ch) fail(`STRIPE_ISSUING_CARDHOLDER_ID ${cardholderId} doesn't exist in this account. Clear it in .env and run this again.`);
    if (ch.status !== "active") fail(`Cardholder ${cardholderId} is ${ch.status}. Clear STRIPE_ISSUING_CARDHOLDER_ID in .env and run this again.`);
    if (ch.name === name) {
      // Keep the billing address in step with .env (Stripe doesn't allow renaming a cardholder).
      await stripe.issuing.cardholders.update(ch.id, { billing: { address }, phone_number, ...(shopper ? { email: shopper.email } : {}) });
      console.log(`✓ Using cardholder ${ch.id} (${ch.name})`);
    } else {
      console.log(`  Cardholder ${ch.id} is "${ch.name}", not "${name}"; creating a new one.`);
      cardholderId = undefined;
    }
  }
  if (!cardholderId) {
    const [first, ...rest] = name.split(/\s+/);
    const ch = await stripe.issuing.cardholders.create({
      type: "individual",
      name,
      status: "active",
      ...(shopper ? { email: shopper.email } : {}),
      phone_number,
      billing: { address },
      individual: {
        first_name: first!,
        last_name: rest.join(" ") || first!,
        dob: { day: 1, month: 1, year: 1990 },
        card_issuing: { user_terms_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" } },
      },
      metadata: { created_by: "paysafe stripe:setup" },
    });
    cardholderId = ch.id;
    saveEnv("STRIPE_ISSUING_CARDHOLDER_ID", ch.id);
    console.log(`✓ Created cardholder ${ch.id} (${ch.name}) and saved it to .env`);
  }
  if (env("CARD_ISSUER") !== "stripe") {
    saveEnv("CARD_ISSUER", "stripe");
    console.log('✓ Set CARD_ISSUER="stripe" in .env');
  }

  // 3. Where cards spend from. Newer accounts use a financial account (money management);
  // older ones the Issuing balance. Test charges are declined without test money in it.
  const fa = env("STRIPE_FINANCIAL_ACCOUNT") ?? (await findFinancialAccount(stripe).catch(() => undefined));
  let usd = 0;
  if (fa) {
    if (!env("STRIPE_FINANCIAL_ACCOUNT")) saveEnv("STRIPE_FINANCIAL_ACCOUNT", fa);
    const r = (await stripe.rawRequest("GET", `/v2/money_management/financial_accounts/${fa}`, {}, { apiVersion: `${Stripe.API_VERSION.split(".")[0]}.preview` })) as unknown as {
      balance?: { available?: Record<string, { value: number }> };
    };
    usd = r.balance?.available?.["usd"]?.value ?? 0;
    console.log(`✓ Cards spend from financial account ${fa} (saved as STRIPE_FINANCIAL_ACCOUNT)`);
  } else {
    const balance = await stripe.balance.retrieve();
    usd = balance.issuing?.available.find((b) => b.currency === "usd")?.amount ?? 0;
  }
  if (usd < 10_000) {
    console.log(
      `! Balance is $${(usd / 100).toFixed(2)}. Add test money in the dashboard (test mode): Issuing → add funds / Balances → Add to balance (e.g. $1,000). Charges are declined without it.`,
    );
  } else {
    console.log(`✓ Balance: $${(usd / 100).toFixed(2)} (test money)`);
  }

  // 4. Webhooks.
  const secret = env("STRIPE_WEBHOOK_SECRET");
  console.log(`
Next:
  1. In a separate terminal, forward Stripe's webhooks to the app (keep it running):

       stripe listen --events issuing_authorization.request,issuing_authorization.created,issuing_transaction.created --forward-to localhost:3000/api/webhooks/issuer

  2. ${secret ? "If the whsec_... it prints differs from STRIPE_WEBHOOK_SECRET in .env, update it." : 'Copy the whsec_... it prints into .env as STRIPE_WEBHOOK_SECRET="whsec_...".'}
  3. Restart npm run dev, then open http://shop.localhost:3000/shop
`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
