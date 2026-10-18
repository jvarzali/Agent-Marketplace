import { getWallet, normalizeDomain, formatMoney, type TestChargeResult, type Wallet } from "@paysafe/core";

/**
 * A tiny test store for trying the whole flow with test cards (CARD_ISSUER=mock, or Stripe in
 * test mode). An agent shops here in a browser, asks the wallet for approval, then pays with
 * the card it gets. The store charges that card through the issuer, so the charge is checked
 * by your rules in real time, exactly like a real store's charge would be.
 *
 *   GET  /shop            products
 *   GET  /shop/checkout   order summary and card form (?paper=2&pens=1...)
 *   POST /shop/pay        charges the card
 *
 * Open it at http://shop.localhost:3000/shop: a merchant needs a domain with a dot, and
 * browsers send *.localhost to your own machine. Nothing on its pages says it's a test store,
 * so agents shop it as they would a real one.
 *
 * ?mode=overcharge charges $15 more than the page shows, and ?mode=wrong-merchant charges as a
 * different business. Both show the wallet declining a charge that doesn't match the approval.
 */

/** Shown to the agent like any store; nothing on the page says it's a test store. */
const STORE_NAME = "Bayside Office Supply";

const PRODUCTS = [
  { sku: "paper", name: "Printer paper, 500 sheets", priceCents: 899 },
  { sku: "pens", name: "Ballpoint pens, 12 pack", priceCents: 549 },
  { sku: "notebook", name: "Spiral notebook", priceCents: 399 },
  { sku: "stapler", name: "Desk stapler", priceCents: 1299 },
] as const;

const TAX_RATE = 0.0825;
const FREE_SHIPPING_CENTS = 2500;
const SHIPPING_CENTS = 499;
const MODES = ["honest", "overcharge", "wrong-merchant"] as const;
type Mode = (typeof MODES)[number];

export interface DemoOrder {
  lines: { sku: string; name: string; quantity: number; unitPriceCents: number; totalCents: number }[];
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
}

/** Prices the order from quantities. The server's numbers are the only ones that count. */
export function priceOrder(qty: (sku: string) => string | null): DemoOrder {
  const lines = PRODUCTS.flatMap((p) => {
    const n = Math.min(20, Math.max(0, Math.floor(Number(qty(p.sku) ?? 0)) || 0));
    return n ? [{ sku: p.sku, name: p.name, quantity: n, unitPriceCents: p.priceCents, totalCents: n * p.priceCents }] : [];
  });
  const subtotalCents = lines.reduce((s, l) => s + l.totalCents, 0);
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const shippingCents = subtotalCents === 0 || subtotalCents >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;
  return { lines, subtotalCents, taxCents, shippingCents, totalCents: subtotalCents + taxCents + shippingCents };
}

/** "06/30", "6/2030", "06 / 30" → { month, year }. */
export function parseExpiry(s: string): { month: number; year: number } | null {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/.exec(s);
  if (!m) return null;
  const month = Number(m[1]);
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return month >= 1 && month <= 12 ? { month, year } : null;
}

export function createDemoStoreHandler(getW: () => Wallet = getWallet, basePath = "/shop") {
  const view = (status: number, title: string, body: string) => page(status, title, body, basePath);
  return async function handle(req: Request): Promise<Response> {
    const wallet = getW();
    const issuer = wallet.deps.issuer;
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "").slice(basePath.length) || "/";
    const host = (req.headers.get("host") ?? url.host).replace(/:\d+$/, "");
    const domain = normalizeDomain(host);
    const mode: Mode = (MODES as readonly string[]).includes(url.searchParams.get("mode") ?? "") ? (url.searchParams.get("mode") as Mode) : "honest";

    if (!issuer.supportsTestCharges || !issuer.testCharge) {
      return view(404, "Demo store unavailable", `<p>The demo store only runs with test cards: set <code>CARD_ISSUER="mock"</code>, or <code>CARD_ISSUER="stripe"</code> with a test-mode key (<code>sk_test_...</code>).</p>`);
    }
    const hostNote = domain
      ? ""
      : `<p class="warn">Open this store at <a href="http://shop.localhost${url.port ? `:${url.port}` : ""}${basePath}">http://shop.localhost${url.port ? `:${url.port}` : ""}${basePath}</a>. Agents need a store domain with a dot in it.</p>`;
    const keepMode = mode === "honest" ? "" : `<input type="hidden" name="mode" value="${mode}">`;

    if (path === "/" && req.method === "GET") {
      const rows = PRODUCTS.map(
        (p) =>
          `<tr><td>${esc(p.name)}</td><td class="num">${formatMoney(p.priceCents, "USD")}</td><td class="num"><input type="number" name="${p.sku}" min="0" max="20" value="0" aria-label="Quantity of ${esc(p.name)}"></td></tr>`,
      ).join("");
      return view(
        200,
        STORE_NAME,
        `${hostNote}<p>Office basics, shipped from San Francisco.</p>
        <form method="get" action="${basePath}/checkout">${keepMode}
          <table><thead><tr><th>Item</th><th class="num">Price</th><th class="num">Qty</th></tr></thead><tbody>${rows}</tbody></table>
          <p class="muted">Tax ${(TAX_RATE * 100).toFixed(2)}%. Shipping ${formatMoney(SHIPPING_CENTS, "USD")}, free from ${formatMoney(FREE_SHIPPING_CENTS, "USD")}.</p>
          <button type="submit">Go to checkout</button>
        </form>`,
      );
    }

    if (path === "/checkout" && req.method === "GET") {
      const order = priceOrder((sku) => url.searchParams.get(sku));
      if (!order.lines.length) return redirect(`${basePath}${mode === "honest" ? "" : `?mode=${mode}`}`);
      const hidden = order.lines.map((l) => `<input type="hidden" name="${l.sku}" value="${l.quantity}">`).join("");
      return view(
        200,
        "Checkout",
        `${hostNote}${summary(order)}
        <form method="post" action="${basePath}/pay">${hidden}${keepMode}
          <label>Name on card <input name="name" autocomplete="cc-name" required></label>
          <label>Card number <input name="number" inputmode="numeric" autocomplete="cc-number" required></label>
          <div class="row">
            <label>Expiry (MM/YY) <input name="exp" placeholder="MM/YY" autocomplete="cc-exp" required></label>
            <label>CVC <input name="cvc" inputmode="numeric" autocomplete="cc-csc" required></label>
            <label>ZIP <input name="zip" autocomplete="postal-code"></label>
          </div>
          <button type="submit">Place order: ${formatMoney(order.totalCents, "USD")}</button>
        </form>`,
      );
    }

    if (path === "/pay" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const formMode: Mode = (MODES as readonly string[]).includes(form.get("mode") ?? "") ? (form.get("mode") as Mode) : "honest";
      const order = priceOrder((sku) => form.get(sku));
      const exp = parseExpiry(form.get("exp") ?? "");
      if (!order.lines.length) return redirect(basePath);
      if (!exp) return view(400, "Payment failed", `<p>Expiry must look like MM/YY.</p>${back(basePath)}`);

      const chargeCents = order.totalCents + (formMode === "overcharge" ? 1500 : 0);
      const merchant =
        formMode === "wrong-merchant"
          ? { name: "QUICKCASH GIFTS LLC", domain: "quickcash-gifts.example", mcc: "5947", country: "US", city: "Las Vegas", state: "NV", postalCode: "89101" }
          : { name: STORE_NAME.toUpperCase(), domain: domain ?? host, mcc: "5943", country: "US", city: "San Francisco", state: "CA", postalCode: "94107" };
      let result: TestChargeResult;
      try {
        result = await issuer.testCharge({
          card: { number: form.get("number") ?? "", expMonth: exp.month, expYear: exp.year, cvc: form.get("cvc") ?? "" },
          amountCents: chargeCents,
          currency: "USD",
          merchant,
          deliver: async (raw, headers) => {
            const r = await wallet.issuerEvents.handleWebhook(raw, headers);
            return { status: r.status, body: r.body };
          },
        });
      } catch (e) {
        wallet.deps.logger.error("demo store charge failed", { error: e instanceof Error ? e.message : String(e) });
        return view(502, "Payment failed", `<p>The payment didn't go through: ${esc(e instanceof Error ? e.message : "error")}.</p>${back(basePath)}`);
      }
      if (!result.approved) {
        const why =
          result.reason === "card_not_found"
            ? "The card number, expiry or CVC is wrong, or the card is closed."
            : result.reason === "webhook_declined"
              ? "The card's owner declined this charge (PaySafe: it doesn't match what was approved)."
              : result.reason === "spending_controls"
                ? "The charge is over this card's limit or outside what it may be used for."
                : result.reason === "card_canceled" || result.reason === "card_used"
                  ? "This card has already been used or closed."
              : `The card was declined (${esc(result.reason ?? "declined")}).`;
        return view(402, "Payment declined", `<p>${why}</p><p class="muted">Charged amount: ${formatMoney(chargeCents, "USD")} as ${esc(merchant.name)}.</p>${back(basePath)}`);
      }
      const orderNo = `DS-${(result.authorizationId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase()}`;
      return view(200, "Order confirmed", `<p class="ok">Thanks! Order <strong>${orderNo}</strong> is confirmed.</p>${summary(order)}<p>Charged ${formatMoney(chargeCents, "USD")}.</p>`);
    }

    return view(404, "Not found", back(basePath));
  };
}

function summary(o: DemoOrder): string {
  const rows = o.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${l.quantity} × ${formatMoney(l.unitPriceCents, "USD")}</td><td class="num">${formatMoney(l.totalCents, "USD")}</td></tr>`).join("");
  const line = (label: string, c: number, strong = false) => `<tr${strong ? ' class="total"' : ""}><td colspan="2">${label}</td><td class="num">${formatMoney(c, "USD")}</td></tr>`;
  return `<table><tbody>${rows}</tbody><tfoot>${line("Subtotal", o.subtotalCents)}${line("Tax", o.taxCents)}${line("Shipping", o.shippingCents)}${line("Order total", o.totalCents, true)}</tfoot></table>`;
}

const back = (basePath: string) => `<p><a href="${basePath}">Back to the store</a></p>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function redirect(to: string): Response {
  return new Response(null, { status: 303, headers: { location: to } });
}

function page(status: number, title: string, body: string, home = "/shop"): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title === STORE_NAME ? STORE_NAME : `${esc(title)} · ${STORE_NAME}`}</title>
<style>
:root{color-scheme:light dark;--fg:#111;--bg:#fff;--muted:#666;--line:#ddd;--accent:#1a56db}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#111;--muted:#999;--line:#333;--accent:#6b9bff}}
body{font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:640px;margin:0 auto;padding:24px 16px}
h1{font-size:1.5rem}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px 4px;border-bottom:1px solid var(--line);text-align:left}
.num{text-align:right}.total td{font-weight:700}input{font:inherit;padding:6px 8px;width:100%;box-sizing:border-box}td input{width:4.5em}
label{display:block;margin:12px 0}.row{display:flex;gap:12px}.row label{flex:1}button{font:inherit;padding:10px 16px;background:var(--accent);color:#fff;border:0;border-radius:6px;cursor:pointer}
.muted{color:var(--muted)}.warn{padding:12px;border:1px solid #c80;border-radius:6px}.ok{font-size:1.1rem}a{color:var(--accent)}
</style></head><body><header><a href="${home}">${STORE_NAME}</a></header><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
