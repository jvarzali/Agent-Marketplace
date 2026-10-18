# PaySafe

**Spending guardrails for AI agents.** Users set rules for each of their agents (where it can
shop, what it can buy, how much, and when a human must approve). Agents ask this service for
permission to buy. If the purchase is allowed (and approved, if required), the agent gets a
**single-use virtual card locked to that exact merchant, amount and a 30-minute window**. The
card is the hard stop: limits never depend on the agent behaving.

```
Human ──chat──▶ Agent (Claude, ChatGPT, …)
                  │  request_purchase(merchant, items, total)
                  ▼
        ┌────────────────────────────────────┐        ┌──────────────────┐
        │ policy engine → approval → issuer  │──────▶ │  Card issuer     │
        │   (packages/core)                  │ ◀───── │  (mock / Stripe) │
        └────────────────────────────────────┘ webhooks└──────────────────┘
           ▲ MCP / REST          ▲ dashboard, email, push
         agent                 human
```

**Built with** TypeScript, Next.js 15 + React 19, PostgreSQL + Prisma 7, Auth.js (email magic
links), the Model Context Protocol SDK, Stripe Issuing, Privacy.com, Zod, Web Push, Resend and
Vitest.

> The earlier marketplace concept doc now lives in [`docs/paysafe-vision.md`](docs/paysafe-vision.md).

## Status

| Milestone | State |
|---|---|
| 1. Core + DB: Prisma schema, Zod policy schema, pure policy engine, cart hashing, unit tests | ✅ |
| 2. Purchase flow with `MockCardIssuer`, audit log, integration tests | ✅ |
| 3. REST API for agents (API-key auth, rate limiting) | ✅ |
| 4. MCP server (remote HTTP + local stdio) | ✅ |
| 5. Dashboard (`apps/web`): email sign-in, overview KPIs, approvals with override, agents, freeze, policy editor, activity + automated purchases, settings (light/dark theme), onboarding, trust suggestions | ✅ wired to the backend |
| 6. Notifications: email (Resend or console) and web push (VAPID or console) | ✅ (push toggle in the header and in Settings) |
| 7. Trust suggestions | ✅ |
| 8. Stripe Issuing adapter + webhook handling | ✅ unit-tested with Stripe's real webhook signing; setup script and demo store for test mode; **not yet run against a real Stripe account** |
| 8a. Demo store (`/shop`) for full agent checkouts with test cards (mock or Stripe test mode) | ✅ |
| 8c. Wallet enters the card in the agent's browser (`fill_payment_details`) | ✅ tested in a real headless Chrome and end to end on the demo store; real stores' card forms not yet tried |
| 8b. Privacy.com adapter (real cards, personal use) | ✅ written against Privacy's API docs and tested against a fake; **not yet run against a live Privacy account** |
| 9. Browser extension | later |

## Repository layout

```
packages/db     Prisma schema, migrations (incl. append-only audit trigger), client
packages/core   ALL business logic
  src/policy/     Zod policy schema, pure engine, budget, plain-English describer, templates
  src/cart.ts     cart validation, normalization, cart hash
  src/classifier/ item categorization (rules + pluggable fallback, e.g. an LLM)
  src/issuer/     CardIssuer interface, MockCardIssuer, StripeIssuingCardIssuer
  src/notify/     email + push senders (console, Resend, Web Push)
  src/wallet/     services: purchases (agent), owner (dashboard), issuer webhooks, trust, expiry
  scripts/seed.ts demo data
packages/api    Web-standard Request→Response handler for REST + MCP + webhooks + cron; dev server
packages/mcp    MCP server (tools), Streamable HTTP handler, stdio entrypoint
apps/web        Next.js dashboard; also serves packages/api at /api/* (see docs/frontend-integration.md)
```

The web app, REST API and MCP server are thin layers. Rules live only in `packages/core`.

## Setup

Requirements: Node ≥ 20.19, PostgreSQL 14+ (local binaries or Docker).

```bash
npm install                     # also runs `prisma generate`
cp .env.example .env            # defaults work for local dev
npm run db:up                   # throwaway Postgres in ./.pgdata on :54329 (or: docker compose up -d)
npm run db:migrate              # apply migrations
npm run db:seed                 # demo user + 2 agents + history; prints the agents' API keys
npm run dev                     # dashboard + agent API + MCP on http://localhost:3000
```

Set `AUTH_SECRET` in `.env` (`npx auth secret`). Sign in at http://localhost:3000 as
`demo@paysafe.dev`; without `RESEND_API_KEY` the sign-in link is printed in the `npm run dev`
log. `npm run dev:api` still starts the standalone agent API on :4000, which is the only place
the dev-only charge simulator lives.

`npm run db:reset` drops and recreates the dev database (then run `db:seed` again). Restart
`npm run dev` afterwards. Its old database connections otherwise make sign-in fail with
"Sign-in didn't work".

### Windows

`npm run db:up` uses `scripts/local-db.sh`, which doesn't work on Windows: Postgres can't create
its socket lock file at a Git Bash path. Instead, use Docker (`docker compose up -d`) or the
PostgreSQL binaries zip:

1. Initialize the cluster: `initdb -D .pgdata -U postgres -A trust`.
2. Append these lines to `.pgdata/postgresql.conf`:

   ```
   port = 54329
   unix_socket_directories = ''
   ```

3. Start it from Git Bash, in the repo root, and create the databases:

   ```bash
   pg_ctl -D "$(cygpath -w .pgdata)" -l "$(cygpath -w .pgdata)\server.log" -w start
   psql -h localhost -p 54329 -U postgres -c "CREATE DATABASE paysafe" -c "CREATE DATABASE paysafe_test"
   ```

`npm run db:seed` doesn't load the root `.env`, so pass it explicitly:

```bash
cd packages/db && npx tsx --env-file=../../.env ../core/scripts/seed.ts
```

### Environment variables

All of them are documented in [`.env.example`](.env.example). The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `AUTH_SECRET` | signs dashboard session cookies |
| `APP_URL` | dashboard URL, used in notification links |
| `CARD_ISSUER` | `mock` (default), `privacy` or `stripe` |
| `SHOPPER_NAME`, `SHOPPER_EMAIL`, `SHOPPER_PHONE`, `SHOPPER_ADDRESS_*` | checkout details given to agents; unset = a made-up person with test cards (agents aren't told), none with real cards |
| `TEST_SHOPPER_NAME`, `TEST_SHOPPER_EMAIL`, `TEST_SHOPPER_PHONE` | replace the made-up person's reserved-looking email/phone with ones you own |
| `CARD_DELIVERY` | `agent` (default: agent gets the card once) or `browser` (wallet types it into the checkout page) |
| `AGENT_BROWSER_CDP_URL`, `AGENT_BROWSER_PAYMENT_HOSTS` | shopping browser for `browser` delivery |
| `PRIVACY_API_KEY`, `PRIVACY_CARDHOLDER_NAME`, `PRIVACY_BILLING_*` | Privacy.com cards |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ISSUING_CARDHOLDER_ID` | Stripe Issuing |
| `RESEND_API_KEY`, `EMAIL_FROM` | email; empty = print to console |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web push; empty = log to console |
| `CRON_SECRET` | protects `/api/cron/expire` |

### Card delivery: the wallet enters the card (`CARD_DELIVERY="browser"`)

By default an approved agent receives the single-use card once and types it in. With
`CARD_DELIVERY="browser"`, the agent never gets the number: it opens the payment step and calls
`fill_payment_details` (REST: `POST /api/v1/purchases/:id/fill-payment`), and the wallet types the
card into the page through the same Chrome the agent drives (`agents/browser/start-chrome.sh`,
remote debugging on 127.0.0.1:9222; point Playwright MCP at it with `--cdp-endpoint`). The wallet:

- only uses a tab on the approved store's domain, and only if the page shows the approved total;
- only types into the page itself or iframes of known payment providers (Shopify, Stripe,
  Braintree, Adyen, Square, PayPal...; extend with `AGENT_BROWSER_PAYMENT_HOSTS`);
- clicks the store's place-order button itself (never PayPal, Shop Pay or other payment buttons)
  and waits for the store's answer: a confirmation is recorded with its order number; a decline,
  a validation message or no answer clears the card from the form before the agent gets the
  page back;
- logs each fill (`credential.filled`, with the page, fields and outcome, never the number) and
  stops after 5 fills per card.

So the agent never has control while the card is on the page. This needs the wallet and the browser on the same machine (local use).

### Stripe Issuing in test mode (free, no Issuing application)

Test mode needs only a free Stripe account. Charges are simulated, but they go through Stripe
and your rules exactly like real ones, including the real-time approve/decline.

1. Stripe dashboard → switch to **test mode** → Issuing → **Get started**. Then Balances →
   Issuing balance → **Add to balance** (any amount of test money, e.g. $1,000).
2. Put the test secret key in `.env`: `STRIPE_SECRET_KEY="sk_test_..."`.
3. `npm run stripe:setup` creates the test cardholder and writes `STRIPE_ISSUING_CARDHOLDER_ID`
   and `CARD_ISSUER="stripe"` to `.env`.
4. Install the Stripe CLI (`brew install stripe/stripe-cli/stripe`, then `stripe login`) and keep this
   running:
   ```bash
   stripe listen --events issuing_authorization.request,issuing_authorization.created,issuing_transaction.created \
     --forward-to localhost:3000/api/webhooks/issuer
   ```
   Put the `whsec_...` it prints in `.env` as `STRIPE_WEBHOOK_SECRET`, then restart `npm run dev`.
5. Shop at **http://shop.localhost:3000/shop** (add `shop.localhost` to the agent's stores).
   The agent requests approval with the checkout total, you approve, and it pays with its
   single-use test card. The store charges the card through Stripe; Stripe asks the wallet; the
   wallet approves and the purchase shows as completed in Activity.
6. Guardrail tests: `/shop?mode=overcharge` charges $15 more than the approved total,
   `/shop?mode=wrong-merchant` charges as a different business. Both are declined and
   raise a security alert. Paying twice with the same card is declined too.

The demo store also works with `CARD_ISSUER="mock"`, with no Stripe account at all.

## Dashboard

A sidebar layout in the style of a financial dashboard, with a top bar showing the current
section and a **Freeze all** control.

- **Overview**: four clickable KPI tiles. Each tile's top rule changes color with its state:
  - **Waiting on you**: yellow when approvals are pending.
  - **Automated purchases**: purchases made without approval since you last checked. Yellow
    while any are unchecked.
  - **Spent this week**: yellow above 80% of the budget, red above 100%.
  - **Agents active**: one segment per agent, black when active, red when frozen.

  The overview also shows the receipt strip and per-agent budgets.
- **Approvals**: pending requests with Approve / Deny. Click a row under *Recently decided* to
  expand it into the purchase facts, the receipt and the decision with its reasons. A denied
  purchase can be overridden (**Override and approve**), except for denials no single approval
  should lift: a frozen agent, a cart whose math or currency is wrong, and cash-like items
  (gift cards, stored value, cash-like MCCs).
- **Agents**: budgets, per-agent freeze, policy editor, keys and trust suggestions.
- **Activity**: the audit log with filters. The *Automated purchases* tab
  (`/activity?type=auto`) lists auto-allowed buys. Opening it marks them as seen, and the marker
  is saved on your account.
- **Settings**: theme (match device, light or dark, saved per browser), push notifications and
  sign out.

## Tests

```bash
npm run db:up        # integration tests need Postgres (TEST_DATABASE_URL, default …/paysafe_test)
npm test             # all packages
npm run typecheck
```

- `packages/core/test/unit`: the pure engine, cart hash, classifier, budget, trust and security
  helpers, including the policy edge cases.
- `packages/core/test/integration`: the full flow against a real database and the mock issuer
  (request → decide → approve → issue → charge → reconcile → refund), plus freeze, expiry,
  concurrency, append-only audit, and "card number never stored".
- `packages/api/test`: REST endpoints and MCP over HTTP.
- `packages/mcp/test`: launches the stdio MCP server the way Claude Desktop does.

The integration test database schema is **dropped and recreated on each run**.

## Connecting an agent

**A free agent that shops in a real browser:** see [`agents/goose/README.md`](agents/goose/README.md)
(Goose + Gemini's free tier + Playwright, paying only through this wallet with Privacy.com cards).

Create an agent in the dashboard (or use a key printed by `db:seed`). The key is shown once.

### Claude (remote MCP, recommended)

The MCP endpoint is `POST {APP_URL}/api/mcp` (`http://localhost:3000/api/mcp` with `npm run dev`,
or `:4000` with the standalone `npm run dev:api` server), authenticated with the agent's key as a bearer token.

**Claude Code:**

```bash
claude mcp add --transport http paysafe http://localhost:3000/api/mcp \
  --header "Authorization: Bearer aw_your_agent_key"
```

**Claude Desktop / other clients that take JSON config:**

```json
{
  "mcpServers": {
    "paysafe": {
      "type": "http",
      "url": "https://your-app.example.com/api/mcp",
      "headers": { "Authorization": "Bearer aw_your_agent_key" }
    }
  }
}
```

### Claude Desktop (local stdio)

Runs the server as a local process with direct database access. Useful for development.

```json
{
  "mcpServers": {
    "paysafe": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/paysafe/packages/mcp/src/stdio.ts"],
      "env": {
        "PAYSAFE_API_KEY": "aw_your_agent_key",
        "DATABASE_URL": "postgresql://postgres@localhost:54329/paysafe"
      }
    }
  }
}
```

With `CARD_ISSUER=mock`, mock cards live in the memory of the process that issued them. To
test charges with the dev simulator below, use the remote endpoint so the API server and MCP
share one process.

### Tools

| Tool | What it does |
|---|---|
| `get_my_policy` | The rules, in plain language, so the agent plans carts that pass |
| `get_budget` | Remaining amounts per rolling window, orders left today, largest order that fits |
| `get_shipping_details` | Name, email, phone and shipping address for checkout forms: a made-up person with test cards (the agent isn't told), otherwise the owner's `SHOPPER_*` settings |
| `request_purchase` | Submit the final cart → `denied` (with reasons), `pending_approval`, or `approved` |
| `get_purchase_status` | Status; when approved, the single-use card **exactly once**. Optional `current_cart` re-checks the cart hash |
| `wait_for_decision` | Waits (up to 120 s) for the owner to approve or deny a pending request, so the agent never has to ask the user |
| `fill_payment_details` | The wallet types the approved card into the checkout page open in the agent's browser, clicks the place-order button and reports the store's answer (`CARD_DELIVERY="browser"`) |
| `cancel_purchase` | Abandon; any issued card is cancelled |
| `report_purchase_result` | Order number / failure; a failure cancels the card |
| `list_my_purchases` | Recent requests (never card details) |

Every tool description tells the agent never to ask the user for a real card, never to store
the credential, and never to retry a denial by splitting the order.

### REST (agents without MCP)

Same logic, `Authorization: Bearer <key>`:

```bash
KEY=aw_...
curl -s localhost:3000/api/v1/agent/policy -H "authorization: Bearer $KEY"
curl -s localhost:3000/api/v1/agent/budget -H "authorization: Bearer $KEY"
curl -s localhost:3000/api/v1/purchases -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "merchant_domain": "amazon.com", "merchant_name": "Amazon",
  "items": [{ "name": "Organic bananas", "unit_price": 3.49, "quantity": 2, "url": "https://www.amazon.com/dp/B0" }],
  "subtotal": 6.98, "tax": 0.5, "shipping": 0, "total": 7.48, "currency": "USD",
  "reasoning": "User asked for bananas"
}'
curl -s localhost:3000/api/v1/purchases/<id> -H "authorization: Bearer $KEY"          # card shown once
curl -s -X POST localhost:3000/api/v1/purchases/<id>/result -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"success": true, "order_reference": "112-3"}'
```

Other endpoints: `POST /api/v1/purchases/:id/status` with `{ "current_cart": … }`,
`POST /api/v1/purchases/:id/cancel`, `GET /api/v1/purchases`.

**Dev-only charge simulator** (mock issuer, standalone `npm run dev:api` server only): play the
card network. Mock cards live in the memory of the process that issued them, so the agent must
be connected to `:4000` (not the dashboard on `:3000`) for the purchase you simulate.

```bash
curl -s -X POST localhost:4000/dev/simulate-charge -H 'content-type: application/json' \
  -d '{"purchase_id": "<id>", "amount": 7.48, "merchant_name": "AMZN Mktp US", "mcc": "5411"}'
# try "merchant_name": "SHADY STORE" or a larger amount to see a declined, logged security event
# add "refund": true to simulate a refund
```

## How enforcement works

1. **Policy engine** (`packages/core/src/policy/engine.ts`) is a pure function: request + active
   policy + spending history + known merchants + item classifications + `now` → `allow` / `deny` /
   `needs_approval`, with **every** rule check recorded. Order: frozen → integrity & currency →
   hard denies (store, MCC, category) → limits (on the full total including tax and shipping;
   rolling 24h / 7d / 30d windows that count pending and issued-but-unused amounts; quantity;
   order count; order-splitting) → schedule (policy timezone) → approval triggers → allow.
2. Per-agent row lock (`SELECT … FOR UPDATE`) serializes decisions, so concurrent requests can't
   race past a budget.
3. **Approval** is bound to the cart hash (merchant, items, quantities, prices, tax, shipping,
   total, currency) and expires after 15 minutes. A changed cart needs a new request.
4. **Issuance** re-runs every deny rule (freeze, tightened limits) under the lock, then creates a
   single-use card: limit = approved total + optional `credential_buffer` (default $0), blocked
   cash-like MCCs, the merchant's MCC when known, and a 30-minute lifetime. Card details are
   fetched from the issuer and returned once. They are **never stored or logged**; only the
   provider card id and last 4 are kept.
5. **At the money:** the issuer's own controls (amount, MCC, single-use, cancellation) decline
   anything outside the card's scope. The real-time authorization webhook additionally checks
   merchant, expiry, freeze and amount. Every decline is a `security` audit event plus an
   email or push alert.
6. **Reconciliation:** captures complete the request and kill the card; refunds restore budget;
   duplicate webhooks are processed once. A per-minute sweep cancels unused cards and expires
   stale approvals.

## Decisions

Design choices and their defaults. All of them can be changed.

- **Scope**: US / USD, with card issuers (mock, Privacy.com, Stripe Issuing) behind one
  `CardIssuer` interface and both REST and MCP for agents. Everything is Web-standard
  `Request → Response`, so it runs on Vercel or any Node host (see the hosting notes below).
- **Money** is integer cents in the database and services. Policies are written in dollars
  and converted with rounding to the cent.
- **Rolling windows**: `per_day` = last 24h, `per_week` = last 7 days, `per_month` = last 30 days.
- **Order splitting** → `needs_approval` (not deny): same-store requests within
  `limits.split_window_minutes` (default 60) are summed. If the sum exceeds the per-order limit
  or the approval threshold while each part is under it, a human decides.
- **Schedule violations** and **categories outside the allow list** are denials. They aren't
  ambiguous, so they don't go to approval.
- **Gift cards and stored value can never be allowed**, even if listed in `allow`. They turn a
  scoped card back into cash. **Subscriptions** are denied by default and allowed only if
  explicitly listed in `categories.allow`. Cash-like MCCs (7995, 6051, 4829, 6540, 6010, 6011,
  6012) are always blocked.
- **Low-confidence classification** (< 0.7) always needs approval. `require_if_category_uncertain`
  can only be `true`. The agent's own category label is a weak hint: it counts only when the
  rules agree, except that an agent saying "this is a gift card" is believed.
- **New merchant** = no completed purchase there and no human-approved request there.
- **Templates** ("Approve everything", "Groceries under $50", "Custom") all start with
  `approval.always = true`, per "new agents default to approval.always = true". Trust
  suggestions are how users loosen that over time.
- **Trust suggestions** add an `approval.auto_approve` rule ({category, max_total}) when accepted.
  Auto-approve waives only `always` and `require_if_total_over`, never new-merchant,
  uncertain-category or order-splitting approval. A streak needs N clean, completed,
  single-category purchases (default 10). Any security event or refund breaks it. Thresholds
  round up to $5 and never exceed the per-order limit. Dismissed suggestions are not re-offered.
- **Credential delivery**: issued lazily on the first `get_purchase_status` after approval, so
  "approval expired before use" and "frozen between approval and issuance" are natural states.
  Auto-allowed requests return `approved` and the card comes from the next status call.
  A lost card can't be re-shown: cancel and re-request.
- **A failed checkout** reported via `report_purchase_result` cancels the card.
- **Pending approvals lapse** after 24h (`PENDING_TTL_MINUTES`).
- **API keys** are `aw_` + 32 random bytes. They're stored as SHA-256 (fine for high-entropy
  keys, and indexable). Rotation invalidates the old key immediately.
- **Audit log** is append-only, enforced by a Postgres trigger that rejects UPDATE, DELETE and
  TRUNCATE. Payloads pass through a redactor that strips anything card-like.
- **Stripe Issuing** (checked against docs.stripe.com, API `2026-09-30`):
  `lifecycle_controls.cancel_after.payment_count = 1` for single use; `spending_limits`
  per_authorization + all_time = approved amount; `allowed_categories` (merchant MCC) or
  `blocked_categories`. Stripe can't lock a card to a domain or expire it in 30 minutes, so the
  real-time `issuing_authorization.request` webhook (2-second deadline; responds with
  `Stripe-Version`) and the sweep enforce those. Cards go to one pre-created cardholder
  (`STRIPE_ISSUING_CARDHOLDER_ID`), because cardholders require KYC. Retrieving the full number
  uses `expand: ["number", "cvc"]`, which needs Stripe's approval and PCI scope; the alternative
  is Stripe's Issuing Elements, which won't work for headless agents.
- **Rate limiting** is in-memory per process (60 requests per minute per agent). On serverless,
  swap in a shared store (e.g. Upstash Redis) behind the `RateLimiter` interface.
- **Merchant matching** on authorizations uses the domain if the network gives one. Otherwise it
  matches the descriptor against the domain label, the merchant name and a small alias table
  (`AMZN` → amazon.com). Unmatched → decline. This errs toward false declines, not false approvals.
- **LLM classifier**: `CompositeClassifier` accepts any `ItemClassifier` fallback. No LLM
  implementation ships yet; rules-only is the default.
- **Prisma 7** (`prisma-client` generator, `@prisma/adapter-pg`). The config file is
  `prisma7.config.ts`, the name Prisma 7.10+ uses so it won't collide with Prisma 8.

### Hosting notes

- Any Node host works. On Vercel, deploy `apps/web` (it already serves `packages/api` at `/api/*`).
  Use a managed Postgres (e.g. Neon). Call `/api/cron/expire` every minute. Vercel Cron's
  per-minute schedules need a paid plan; otherwise use any external scheduler.
- Stripe's synchronous authorization webhook must answer within 2 seconds. Keep the webhook
  route warm and the database close to the function region.

## Known limitations

- Privacy.com has no real-time authorization hook for this kind of account: charges are checked
  right after they happen (from its webhook), and a mismatch closes the card. The single-use card
  and its cap are what stop a bad charge up front. Privacy's spend limit is whole dollars, so the
  cap is the approved total rounded up; the exact amount is checked on the webhook.

- The Stripe adapter is tested against a fake client with Stripe's real webhook signing, not yet
  against a real account. In test mode the full card number is available; in live mode,
  retrieving it needs Stripe's sign-off (PCI). `stripe listen` relaying the real-time
  authorization answer is expected from Stripe's docs but unverified here; if test charges are
  declined with `webhook_timeout`, point a dashboard webhook endpoint at a tunnel URL instead.
- Merchant-name matching for authorizations will need tuning with real descriptors.
- The mock issuer is in-memory: fine for dev and tests, not shared across processes.
- No LLM classifier implementation yet. Items the rules don't know go to human approval.
- `npm run db:up` / `db:down` don't work on Windows (see [Windows](#windows)).
