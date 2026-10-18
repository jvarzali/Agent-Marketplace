import type { Browser, Frame, Locator, Page } from "playwright-core";
import { domainMatches } from "../domain";
import type { CardSecrets } from "../issuer/types";
import { formatMoney } from "../money";

/**
 * Types an issued card into the agent's checkout page, so the agent never handles the number.
 * The wallet connects to the same Chrome the agent drives (over the Chrome DevTools Protocol),
 * finds the tab on the approved store, checks the page shows the approved total, and fills the
 * card fields, including the ones payment providers put in their own iframes.
 */
export interface CardFiller {
  fill(p: FillParams): Promise<FillResult>;
}

export interface FillParams {
  merchantDomain: string;
  totalCents: number;
  currency: string;
  secrets: CardSecrets;
}

export interface FillResult {
  pageUrl: string;
  /** Fields typed into, in plain words ("card number", "expiry", ...). */
  filled: string[];
}

/** A fill that didn't happen, with a message written for the agent. */
export class CardFillError extends Error {
  override readonly name = "CardFillError";
}

/**
 * Payment providers whose iframes may hold card fields. Card fields in any other third-party
 * frame are left alone, so a stray iframe on the page can't collect the card.
 */
export const PAYMENT_FRAME_HOSTS = [
  "shopifyinc.com", // Shopify checkout card fields (checkout.pci.shopifyinc.com)
  "shopifycs.com",
  "stripe.com", // js.stripe.com, Stripe Elements
  "stripecdn.com",
  "braintreegateway.com",
  "braintree-api.com",
  "adyen.com",
  "adyenpayments.com",
  "checkout.com",
  "squareup.com",
  "squarecdn.com",
  "paypal.com",
  "recurly.com",
  "chargebee.com",
  "spreedly.com",
  "authorize.net",
  "cybersource.com",
  "bluesnap.com",
  "worldpay.com",
  "bolt.com",
];

type Field = "number" | "expiry" | "expMonth" | "expYear" | "cvc" | "name" | "postal";

/** Selectors per field, most specific first. Checked in every allowed frame. */
const SELECTORS: Record<Field, string[]> = {
  number: [
    'input[autocomplete="cc-number"]',
    'input[name="cardnumber"]',
    'input[name="cardNumber"]',
    'input[name="card_number"]',
    'input[name="card-number"]',
    'input[data-elements-stable-field-name="cardNumber"]',
    'input[id="card-number"]',
    'input[name="number"]',
  ],
  expiry: [
    'input[autocomplete="cc-exp"]',
    'input[name="exp-date"]',
    'input[name="expiry"]',
    'input[name="cardExpiry"]',
    'input[data-elements-stable-field-name="cardExpiry"]',
    'input[name="exp"]',
  ],
  expMonth: ['select[autocomplete="cc-exp-month"]', 'input[autocomplete="cc-exp-month"]', 'select[name*="exp_month" i]', 'select[name*="expmonth" i]', 'input[name*="exp_month" i]'],
  expYear: ['select[autocomplete="cc-exp-year"]', 'input[autocomplete="cc-exp-year"]', 'select[name*="exp_year" i]', 'select[name*="expyear" i]', 'input[name*="exp_year" i]'],
  cvc: [
    'input[autocomplete="cc-csc"]',
    'input[name="cvc"]',
    'input[name="cvv"]',
    'input[name="cardCvc"]',
    'input[name="verification_value"]',
    'input[name="securityCode"]',
    'input[name="card_cvc"]',
    'input[data-elements-stable-field-name="cardCvc"]',
  ],
  name: ['input[autocomplete="cc-name"]', 'input[name="ccname"]', 'input[name="cardholder-name"]', 'input[name="cardholderName"]'],
  postal: ['input[autocomplete="postal-code"][name="postal"]', 'input[name="postal"]'],
};

const LABEL: Record<Field, string> = {
  number: "card number",
  expiry: "expiry",
  expMonth: "expiry month",
  expYear: "expiry year",
  cvc: "security code",
  name: "name on card",
  postal: "billing ZIP",
};

export interface CdpCardFillerOptions {
  /** Chrome's remote debugging address, e.g. http://127.0.0.1:9222. */
  cdpUrl: string;
  /** Extra hosts whose iframes may hold card fields. */
  extraPaymentHosts?: string[];
  /** For tests. */
  connect?: (cdpUrl: string) => Promise<Browser>;
}

export class CdpCardFiller implements CardFiller {
  private readonly paymentHosts: string[];

  constructor(private readonly opts: CdpCardFillerOptions) {
    this.paymentHosts = [...PAYMENT_FRAME_HOSTS, ...(opts.extraPaymentHosts ?? [])];
  }

  async fill(p: FillParams): Promise<FillResult> {
    const browser = await this.connect();
    try {
      const page = await this.findCheckoutPage(browser, p.merchantDomain);
      if (!(await pageShowsTotal(page, p.totalCents, p.currency))) {
        throw new CardFillError(
          `The checkout page (${page.url()}) doesn't show the approved total of ${formatMoney(p.totalCents, p.currency)}, so the card was not entered. Go to the payment step where that total is shown and try again. If the total changed, call cancel_purchase and request again with the new cart.`,
        );
      }
      const found = await this.fieldsOn(page, p.merchantDomain);
      if (!found.number) {
        throw new CardFillError(
          `Couldn't find a card number field on ${page.url()}. Make sure the payment step is showing and that "credit/debit card" is selected (not a saved card, PayPal or Shop Pay), then try again.`,
        );
      }
      const s = p.secrets;
      const mm = String(s.expMonth).padStart(2, "0");
      const yy = String(s.expYear).slice(-2);
      const filled: Field[] = [];
      await typeInto(found.number, s.number, true);
      filled.push("number");
      // Many stores (Best Buy, for one) only show expiry and security code once the number is in.
      Object.assign(found, await this.restAfterNumber(page, p.merchantDomain));
      if (found.expiry) {
        await typeInto(found.expiry, `${mm}/${yy}`, false);
        filled.push("expiry");
      } else {
        if (found.expMonth && (await setPart(found.expMonth, [mm, String(s.expMonth), MONTHS[s.expMonth - 1]!, MONTHS[s.expMonth - 1]!.slice(0, 3)]))) filled.push("expMonth");
        if (found.expYear && (await setPart(found.expYear, [String(s.expYear), yy]))) filled.push("expYear");
      }
      if (found.cvc) {
        await typeInto(found.cvc, s.cvc, true);
        filled.push("cvc");
      }
      if (found.name && s.cardholderName) {
        await typeInto(found.name, s.cardholderName, false);
        filled.push("name");
      }
      if (found.postal && s.billingAddress?.postalCode) {
        await typeInto(found.postal, s.billingAddress.postalCode, false);
        filled.push("postal");
      }
      const missing = (["cvc"] as Field[]).filter((f) => !filled.includes(f));
      const hasExpiry = filled.includes("expiry") || (filled.includes("expMonth") && filled.includes("expYear"));
      if (!hasExpiry) missing.unshift("expiry");
      if (missing.length) {
        throw new CardFillError(`Entered the card number on ${page.url()} but couldn't find the ${missing.map((m) => LABEL[m]).join(" and ")} field. Don't type card details yourself; tell the user the store's card form wasn't recognized.`);
      }
      return { pageUrl: page.url(), filled: filled.map((f) => LABEL[f]) };
    } finally {
      // Disconnects only: the agent's browser and its tabs stay open.
      await browser.close().catch(() => undefined);
    }
  }

  private async connect(): Promise<Browser> {
    try {
      if (this.opts.connect) return await this.opts.connect(this.opts.cdpUrl);
      const { chromium } = await import("playwright-core");
      return await chromium.connectOverCDP(this.opts.cdpUrl, { timeout: 5_000 });
    } catch {
      throw new CardFillError(
        `The wallet can't reach the shopping browser at ${this.opts.cdpUrl}. The user needs to start it with agents/browser/start-chrome.sh (and point the browser tools at it). Tell the user; don't enter card details yourself.`,
      );
    }
  }

  private async findCheckoutPage(browser: Browser, merchantDomain: string): Promise<Page> {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const onStore = pages.filter((pg) => {
      const h = hostOf(pg.url());
      return h !== null && domainMatches(h, merchantDomain);
    });
    if (!onStore.length) {
      const open = [...new Set(pages.map((pg) => hostOf(pg.url())).filter(Boolean))].join(", ") || "none";
      throw new CardFillError(
        `No tab is open on ${merchantDomain} in the shopping browser (its open tabs: ${open}). The wallet can only enter the card in the browser your playwright tools control. If you shopped in a different browser (such as Claude in Chrome or the built-in browser), redo the checkout with the playwright browser tools, then call fill_payment_details again.`,
      );
    }
    if (onStore.length === 1) return onStore[0]!;
    // Prefer the most recently opened tab that has a card field.
    for (const pg of [...onStore].reverse()) {
      if ((await this.fieldsOn(pg, merchantDomain, 1)).number) return pg;
    }
    return onStore[onStore.length - 1]!;
  }

  /**
   * Card fields on the page. Payment iframes from other origins attach to a fresh connection
   * a moment after it's made, so look a few times before giving up.
   */
  private async fieldsOn(page: Page, merchantDomain: string, attempts = 6): Promise<Partial<Record<Field, Locator>>> {
    let found: Partial<Record<Field, Locator>> = {};
    for (let i = 0; i < attempts; i++) {
      if (i) await page.waitForTimeout(400);
      found = await findFields(page.frames().filter((f) => this.frameAllowed(f, merchantDomain)));
      if (found.number && (found.cvc || i >= 2)) return found;
    }
    return found;
  }

  /** Expiry, security code etc., looked up again after the number is typed (up to ~3 s). */
  private async restAfterNumber(page: Page, merchantDomain: string): Promise<Partial<Record<Field, Locator>>> {
    let found: Partial<Record<Field, Locator>> = {};
    for (let i = 0; i < 8; i++) {
      if (i) await page.waitForTimeout(400);
      found = await findFields(page.frames().filter((f) => this.frameAllowed(f, merchantDomain)), ["number"]);
      const expiry = found.expiry || (found.expMonth && found.expYear);
      if (expiry && found.cvc) break;
    }
    delete found.number;
    return found;
  }

  private frameAllowed(f: Frame, merchantDomain: string): boolean {
    const url = f.url();
    // about:blank / srcdoc frames inherit the parent page's origin.
    if (url === "about:blank" || url === "about:srcdoc" || url === "") return f.parentFrame() ? this.frameAllowed(f.parentFrame()!, merchantDomain) : false;
    const h = hostOf(url);
    if (!h) return false;
    return domainMatches(h, merchantDomain) || this.paymentHosts.some((ph) => domainMatches(h, ph));
  }
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Does the page's visible text include the total (e.g. "$1,234.50", "1234.50", "USD 24.45")? */
export async function pageShowsTotal(page: Page, totalCents: number, currency: string): Promise<boolean> {
  const text = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");
  return textShowsTotal(text, totalCents, currency);
}

export function textShowsTotal(text: string, totalCents: number, _currency: string): boolean {
  const major = Math.floor(totalCents / 100);
  const minor = String(totalCents % 100).padStart(2, "0");
  const forms = new Set([`${major}.${minor}`, `${major.toLocaleString("en-US")}.${minor}`]);
  return [...forms].some((f) => new RegExp(`(^|[^\\d.,])${f.replace(/[.,]/g, (c) => `\\${c}`)}(?![\\d])`).test(text));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Card fields across the allowed frames: first by the standard attributes (SELECTORS), then, for
 * any still missing, by what the field says about itself (label, placeholder, aria-label, name).
 */
async function findFields(frames: Frame[], skip: Field[] = []): Promise<Partial<Record<Field, Locator>>> {
  const out: Partial<Record<Field, Locator>> = {};
  const usable = async (loc: Locator) => (await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false)) && (await loc.isEnabled().catch(() => false));
  for (const field of Object.keys(SELECTORS) as Field[]) {
    if (skip.includes(field)) continue;
    for (const frame of frames) {
      if (out[field]) break;
      for (const sel of SELECTORS[field]) {
        const loc = frame.locator(sel).first();
        if ((await usable(loc)) && (await loc.isEditable().catch(() => true))) {
          out[field] = loc;
          break;
        }
      }
    }
  }
  const missing = (["number", "expiry", "expMonth", "expYear", "cvc", "name"] as Field[]).filter((f) => !out[f] && !skip.includes(f));
  if (!missing.length || (out.expiry && missing.every((f) => f === "expMonth" || f === "expYear" || f === "name"))) return out;
  for (const frame of frames) {
    const marked = await frame.evaluate(labelFields, missing).catch(() => [] as string[]);
    for (const f of marked as Field[]) {
      if (out[f]) continue;
      const loc = frame.locator(`[data-aw-field="${f}"]`).first();
      if (await usable(loc)) out[f] = loc;
    }
  }
  // A single expiry box and month/year boxes are alternatives; prefer the one that's complete.
  if (out.expiry && out.expMonth && out.expYear) delete out.expiry;
  return out;
}

/**
 * Runs in the page: tags visible inputs/selects with data-aw-field by what they're labelled.
 * Must be self-contained (it's serialized into the page).
 */
function labelFields(wanted: string[]): string[] {
  for (const el of Array.from(document.querySelectorAll("[data-aw-field]"))) el.removeAttribute("data-aw-field");
  const describe = (el: HTMLInputElement | HTMLSelectElement) => {
    const parts = [el.name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("autocomplete"), el.getAttribute("title"), el.getAttribute("data-testid")];
    for (const l of Array.from(el.labels ?? [])) parts.push(l.textContent);
    for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) parts.push(document.getElementById(id)?.textContent ?? "");
    if (el instanceof HTMLSelectElement) parts.push(el.options[0]?.textContent ?? "");
    return parts.filter(Boolean).join(" ").toLowerCase().replace(/[_-]+/g, " ");
  };
  const els = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")).filter((el) => {
    if (el.disabled || (el instanceof HTMLInputElement && (el.readOnly || ["hidden", "checkbox", "radio", "submit", "button", "image", "file"].includes(el.type)))) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  });
  const notCard = /birth|dob|gift|promo|coupon|zip|postal|phone|email|search|quantity|qty/;
  const rules: Record<string, (d: string, el: Element) => boolean> = {
    number: (d) => /card ?(number|num|no\b)|cc ?num|\bpan\b|credit card$/.test(d) && !/name|holder/.test(d),
    expMonth: (d) => /month|\bmm\b(?! ?\/)/.test(d) && !/year/.test(d),
    expYear: (d) => /year|\byy(yy)?\b/.test(d) && !/month|mm ?\/|\/ ?yy/.test(d),
    expiry: (d, el) => el instanceof HTMLInputElement && (/mm ?\/ ?yy|expir|\bexp\b|valid (thru|through|until)|exp date/.test(d)) && !/month|year\b/.test(d),
    cvc: (d) => /cvv|cvc|csc|\bcid\b|security ?code|card ?code|verification/.test(d),
    name: (d) => /name on card|card ?holder|cardholder|card name|name on the card/.test(d),
  };
  const taken = new Set<Element>();
  const found: string[] = [];
  for (const field of ["number", "expiry", "expMonth", "expYear", "cvc", "name"]) {
    if (!wanted.includes(field)) continue;
    const el = els.find((e) => !taken.has(e) && !notCard.test(describe(e)) && rules[field]!(describe(e), e));
    if (!el) continue;
    taken.add(el);
    el.setAttribute("data-aw-field", field);
    found.push(field);
  }
  return found;
}

/** Type like a person (masked card inputs ignore programmatic value changes), then verify. */
async function typeInto(loc: Locator, value: string, digitsOnly: boolean): Promise<void> {
  await loc.click({ timeout: 5_000 });
  await loc.fill("");
  await loc.pressSequentially(value, { delay: 25 });
  const got = await loc.inputValue().catch(() => "");
  const norm = (s: string) => (digitsOnly ? s.replace(/\D/g, "") : s.trim());
  // Expiry masks may reformat "06/30" as "06 / 30"; compare digits for those.
  const ok = digitsOnly ? norm(got) === norm(value) : got.trim() === value || got.replace(/\D/g, "") === value.replace(/\D/g, "");
  if (!ok) throw new CardFillError("The store's card form didn't accept the typed value. Tell the user the card form wasn't recognized; don't enter card details yourself.");
}

/** Set an expiry month/year select or input, trying each accepted format ("06", "6", "June", "Jun"). */
async function setPart(loc: Locator, values: string[]): Promise<boolean> {
  const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "input");
  if (tag === "select") {
    // Match an option by value or by its text ("06", "06 - June", "June", "2030").
    const value = await loc.evaluate((el, cands) => {
      const opts = Array.from((el as HTMLSelectElement).options);
      const norm = (s: string) => s.trim().toLowerCase();
      for (const c of cands.map(norm)) {
        const o = opts.find((o) => norm(o.value) === c || norm(o.text) === c || new RegExp(`^${c}\\b`).test(norm(o.text)));
        if (o) return o.value;
      }
      return null;
    }, values);
    if (value === null) return false;
    await loc.selectOption({ value });
    return (await loc.inputValue()) === value;
  }
  await typeInto(loc, values[0]!, true);
  return true;
}
