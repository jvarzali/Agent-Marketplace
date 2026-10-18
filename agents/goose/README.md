# Shopping agent: Goose + Gemini (free) + a real browser

A free, open-source agent that shops in a real browser and can only pay through Agent Wallet.

- **Goose** (Block, open source) is the agent.
- **Gemini** via a free Google AI Studio key is the model.
- **Playwright MCP** drives a real Chrome (`agents/browser/start-chrome.sh`).
- **Agent Wallet** (`/api/mcp`) is the only way it can pay: your rules and approvals, then a
  single-use card capped at what you approved. With `CARD_DELIVERY="browser"` in `.env`, the
  wallet types the card into the checkout page itself (`fill_payment_details`), so the model
  never sees the number.

Everything runs on your machine, so it talks to `http://localhost:3000` directly.

## 1. Pick the cards

**Free, test money: Stripe test mode + the demo store.** Follow "Stripe Issuing in test mode" in
the main README (`npm run stripe:setup`, `stripe listen`). The agent shops at
`http://shop.localhost:3000/shop`. Run `npm run dev`, sign in, add an agent (**Agents → Add
an agent → My own agent**) with `shop.localhost` as its only store and **Every purchase** on, and
copy its API key for step 3. Skip step 4: the demo store has no accounts or saved cards. Prompt:

> Check my wallet rules, then buy two packs of printer paper from http://shop.localhost:3000/shop.
> Go to checkout, ask the wallet for approval with the exact order total, wait for me, then pay
> with the card it gives you.

Try `http://shop.localhost:3000/shop?mode=overcharge` to watch the wallet decline a store
that charges more than you approved.

**Real cards on real stores: Privacy.com**, below.

### Real cards (Privacy.com)

1. On a **paid** Privacy plan (the API needs one), create an API key at app.privacy.com/api.
   Never give this key to the agent, and don't install Privacy's own MCP server or CLI where the
   agent can use them: with those, it could create cards without your approval.
2. In the repo's `.env`:
   ```
   CARD_ISSUER="privacy"
   PRIVACY_API_KEY="..."
   PRIVACY_CARDHOLDER_NAME="Your Name"          # as on your Privacy account
   PRIVACY_BILLING_LINE1="..."                  # your Privacy account's billing address
   PRIVACY_BILLING_CITY="..."
   PRIVACY_BILLING_STATE="CA"
   PRIVACY_BILLING_POSTAL_CODE="94107"
   ```
3. Optional but recommended: transaction webhooks. In Privacy's account settings, set the
   webhook URL to `https://<public-url>/api/webhooks/issuer` (for local dev, a tunnel such as
   `cloudflared tunnel --url http://localhost:3000`). With webhooks, every charge is checked
   against what you approved, a mismatch closes the card and alerts you, and purchases show as
   completed. Without them the card still enforces its cap and single use, and unused cards are
   closed after 30 minutes.
4. `npm run dev`, sign in, and add an agent (**Agents → Add an agent → My own agent**). Keep
   **Every purchase** on in its rules, and add the stores it may use. Copy its API key.

## 2. Install the pieces

- **Goose:** install the CLI or desktop app from https://block.github.io/goose.
- **Gemini key:** create a free key at https://aistudio.google.com/apikey, then run
  `goose configure` → Configure Providers → Google Gemini, and paste it. Free-tier requests may
  be used by Google to improve its products.
- Node.js 20+ (for `npx @playwright/mcp`).

## 3. Configure Goose

```bash
./agents/goose/print-config.sh aw_your_agent_key            # prints the config
./agents/goose/print-config.sh aw_your_agent_key >> ~/.config/goose/config.yaml
```

If `~/.config/goose/config.yaml` already has `extensions:` or a provider, merge the
`agentwallet` and `playwright` entries by hand instead of appending. `config.example.yaml` shows
the full shape.

## 4. Start the browser

```bash
./agents/browser/start-chrome.sh      # leave it running while the agent shops
```

It's Chrome with its own profile (`~/.agent-wallet/chrome-profile`), separate from your everyday
browser, with card saving and autofill turned off. Log into stores there if you want, but keep
**no saved cards, PayPal, Shop Pay or gift balance** on those store accounts. Otherwise the agent
could pay without the wallet.

## 5. Shop

```bash
cd agents/goose      # .goosehints here gives the agent its shopping rules
goose session
```

> Check my wallet rules, then buy two packs of printer paper from staples.com. Go to the final
> checkout, then ask the wallet for approval and wait for me.

1. The request shows up in the dashboard's Approvals within about 15 seconds (or by email with
   `RESEND_API_KEY`). Approve it.
2. The agent picks up the single-use card, enters it, places the order and reports the order
   number.
3. Watch Activity for the charge. A charge that doesn't match closes the card and raises a red
   alert.

## Limits to expect

- Privacy spend limits are whole dollars, so the card's cap is your approved total rounded up.
  With webhooks on, anything above the exact approved total is flagged and the card closed.
- If the store recalculates tax at the last step, the card can decline. Raise **Card allowance
  over the approved total** in the agent's rules by a dollar or two.
- Captchas and bank verification pop-ups need you. The agent is told to ask.
- Gemini's free tier has rate limits. If Goose stalls, wait a minute.
