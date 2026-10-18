/**
 * The card filler against a real Chrome (headless), like the agent's shopping browser. Skipped
 * when Chrome isn't installed. Every hostname resolves to this machine, so pages can pretend to
 * be a store (shop.test) and a payment provider's iframe (js.payments.test; real provider hosts
 * like js.stripe.com are HTTPS-only in Chrome, so the test registers its own).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CardFillError, CdpCardFiller, textShowsTotal } from "../../src/checkout/browser-fill";

const CHROME = process.env["CHROME_PATH"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const secrets = { number: "4000009990004242", cvc: "123", expMonth: 6, expYear: 2030, last4: "4242", cardholderName: "Pat Doe", billingAddress: { line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } };

const plainForm = `<h1>Checkout</h1><p>Order total $24.45</p>
<input name="name" autocomplete="cc-name"><input name="number" autocomplete="cc-number"><input name="exp" autocomplete="cc-exp"><input name="cvc" autocomplete="cc-csc">`;
// Stripe-Elements-like: card fields in an iframe on the provider's domain, with masking.
const stripeFrame = `<input name="cardnumber" autocomplete="cc-number" oninput="this.value=this.value.replace(/\\D/g,'').replace(/(\\d{4})(?=\\d)/g,'$1 ')">
<input name="exp-date" autocomplete="cc-exp" oninput="let d=this.value.replace(/\\D/g,'');this.value=d.length>2?d.slice(0,2)+' / '+d.slice(2,4):d">
<input name="cvc" autocomplete="cc-csc"><input name="postal" autocomplete="postal-code">`;
const PAGES: Record<string, (port: number) => string> = {
  "shop.test/plain": () => plainForm,
  "shop.test/selects": () => `<p>Total: USD 1,204.50</p><input autocomplete="cc-number"><select autocomplete="cc-exp-month">${[...Array(12)].map((_, i) => `<option value="${String(i + 1).padStart(2, "0")}">${i + 1}</option>`).join("")}</select><select autocomplete="cc-exp-year"><option>2029</option><option>2030</option></select><input autocomplete="cc-csc">`,
  "shop.test/stripe": (port) => `<p>Total $24.45</p><iframe src="http://js.payments.test:${port}/frame" width=600 height=200></iframe>`,
  "js.payments.test/frame": () => stripeFrame,
  "shop.test/evil-frame": (port) => `<p>Total $24.45</p><iframe src="http://evil.example:${port}/frame" width=600 height=200></iframe>`,
  "evil.example/frame": () => stripeFrame,
  "shop.test/wrong-total": () => plainForm.replace("$24.45", "$124.45"),
  // Best Buy-like: no autocomplete hints, and expiry/security code appear only after a full number.
  "shop.test/reveal": () => `<p>Order Total $24.45</p>
<label for="number">Card Number</label><input id="number" type="tel" oninput="document.getElementById('more').style.display=this.value.replace(/\\D/g,'').length>=15?'block':'none'">
<div id="more" style="display:none">
  <label for="m">Expiration Month</label><select id="m" name="expiration-month"><option value="">Month</option>${[...Array(12)].map((_, i) => `<option value="${i + 1}">${String(i + 1).padStart(2, "0")}</option>`).join("")}</select>
  <select name="expiration-year" aria-label="Expiration Year"><option value="">Year</option><option>2029</option><option>2030</option></select>
  <label>Security Code <input name="cvv-code" type="tel"></label>
</div>`,
  // Only labels and placeholders to go on.
  "shop.test/labels": () => `<p>Total: $24.45</p><label>Gift card <input id="g1"></label>
<label for="f1">Credit card number</label><input id="f1"><input id="f2" placeholder="MM / YY"><input id="f3" aria-label="CVC"><label for="f4">Name on card</label><input id="f4">`,
};

let server: Server;
let port = 0;
let chrome: ChildProcess;
let profile: string;
let cdpUrl = "";
let agent: Browser;

describe.skipIf(!existsSync(CHROME))("CdpCardFiller in a real Chrome", () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const key = `${(req.headers.host ?? "").replace(/:\d+$/, "")}${req.url}`;
      const page = PAGES[key];
      res.writeHead(page ? 200 : 404, { "content-type": "text/html" }).end(page ? `<!doctype html><body>${page(port)}</body>` : "nope");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    profile = mkdtempSync(path.join(tmpdir(), "aw-chrome-"));
    chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP * 127.0.0.1`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    cdpUrl = await new Promise<string>((resolve, reject) => {
      let buf = "";
      chrome.stderr!.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
        if (m) resolve(`http://127.0.0.1:${new URL(m[1]!).port}`);
      });
      setTimeout(() => reject(new Error(`Chrome didn't start: ${buf}`)), 15_000);
    });
    agent = await chromium.connectOverCDP(cdpUrl); // stands in for the agent's Playwright MCP
  }, 30_000);

  afterAll(async () => {
    await agent?.close().catch(() => undefined);
    if (chrome && chrome.exitCode === null) await new Promise((r) => chrome.once("exit", r).kill());
    server?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  const open = async (p: string) => {
    const page = await agent.contexts()[0]!.newPage();
    await page.goto(`http://${p.replace("/", `:${port}/`)}`);
    return page;
  };
  const fill = (totalCents = 2445) => new CdpCardFiller({ cdpUrl, extraPaymentHosts: ["payments.test"] }).fill({ merchantDomain: "shop.test", totalCents, currency: "USD", secrets });

  it("fills a plain card form and leaves the browser open", async () => {
    const page = await open("shop.test/plain");
    const r = await fill();
    expect(r.filled).toEqual(["card number", "expiry", "security code", "name on card"]);
    expect(await page.inputValue('[name="number"]')).toBe(secrets.number);
    expect(await page.inputValue('[name="exp"]')).toBe("06/30");
    expect(await page.inputValue('[name="cvc"]')).toBe("123");
    expect(page.isClosed()).toBe(false);
    await page.close();
  });

  it("fills month/year selects", async () => {
    const page = await open("shop.test/selects");
    const r = await fill(120450);
    expect(r.filled).toContain("expiry month");
    expect(await page.inputValue('[autocomplete="cc-exp-month"]')).toBe("06");
    expect(await page.inputValue('[autocomplete="cc-exp-year"]')).toBe("2030");
    await page.close();
  });

  it("fills masked fields inside a payment provider's iframe", async () => {
    const page = await open("shop.test/stripe");
    const r = await fill();
    expect(r.filled).toEqual(["card number", "expiry", "security code", "billing ZIP"]);
    const frame = page.frames().find((f) => f.url().includes("js.payments.test"))!;
    expect(await frame.inputValue('[name="cardnumber"]')).toBe("4000 0099 9000 4242");
    expect(await frame.inputValue('[name="exp-date"]')).toBe("06 / 30");
    expect(await frame.inputValue('[name="postal"]')).toBe("78701");
    await page.close();
  });

  it("waits for fields that appear after the number, and reads labels (Best Buy-like)", async () => {
    const page = await open("shop.test/reveal");
    const r = await fill();
    expect(r.filled).toEqual(["card number", "expiry month", "expiry year", "security code"]);
    expect(await page.inputValue("#m")).toBe("6");
    expect(await page.inputValue('[name="expiration-year"]')).toBe("2030");
    expect(await page.inputValue('[name="cvv-code"]')).toBe("123");
    await page.close();
  });

  it("finds fields by label and placeholder alone, skipping look-alikes", async () => {
    const page = await open("shop.test/labels");
    const r = await fill();
    expect(r.filled).toEqual(["card number", "expiry", "security code", "name on card"]);
    expect(await page.inputValue("#f1")).toBe(secrets.number);
    expect(await page.inputValue("#f2")).toBe("06/30");
    expect(await page.inputValue("#f3")).toBe("123");
    expect(await page.inputValue("#g1")).toBe("");
    await page.close();
  });

  it("won't type into an iframe from an unknown host", async () => {
    const page = await open("shop.test/evil-frame");
    await expect(fill()).rejects.toThrow(/Couldn't find a card number field/);
    expect(await page.frames().find((f) => f.url().includes("evil.example"))!.inputValue('[name="cardnumber"]')).toBe("");
    await page.close();
  });

  it("refuses when the page doesn't show the approved total", async () => {
    const page = await open("shop.test/wrong-total");
    await expect(fill()).rejects.toThrow(/doesn't show the approved total of \$24\.45/);
    expect(await page.inputValue('[name="number"]')).toBe("");
    await page.close();
  });

  it("refuses when no tab is on the approved store", async () => {
    await expect(new CdpCardFiller({ cdpUrl }).fill({ merchantDomain: "other-store.com", totalCents: 2445, currency: "USD", secrets })).rejects.toThrow(/No tab is open on other-store.com/);
  });

  it("explains how to start the browser when it isn't running", async () => {
    await expect(new CdpCardFiller({ cdpUrl: "http://127.0.0.1:1" }).fill({ merchantDomain: "shop.test", totalCents: 1, currency: "USD", secrets })).rejects.toBeInstanceOf(CardFillError);
  });
});

describe("textShowsTotal", () => {
  it("matches the total as shown on checkout pages, not a different number containing it", () => {
    expect(textShowsTotal("Total $24.45", 2445, "USD")).toBe(true);
    expect(textShowsTotal("USD 1,204.50 due", 120450, "USD")).toBe(true);
    expect(textShowsTotal("Total $1204.50", 120450, "USD")).toBe(true);
    expect(textShowsTotal("Total $124.45", 2445, "USD")).toBe(false);
    expect(textShowsTotal("Total $24.459", 2445, "USD")).toBe(false);
  });
});
