# Shopping agent: Claude Code + a real browser

Uses your Claude subscription (no API key, no extra cost). Claude drives a real Chrome and can
only pay through PaySafe. It never types a card number: after you approve, it calls
`fill_payment_details` and the wallet enters the single-use card into the checkout page itself.

`.claude/settings.json` turns off Claude Code's file and shell tools for this folder, so the agent
can't read your `.env` (card issuer keys) or run commands; it only has the wallet and the browser.

## Setup (once)

1. In the repo's `.env`, set `CARD_DELIVERY="browser"` and restart `npm run dev`.
2. Copy this folder outside the repo, so it's nowhere near your `.env`, and connect the tools:

   ```bash
   cp -R agents/claude ~/agent-shopper
   cd ~/agent-shopper
   claude mcp add --transport http paysafe http://localhost:3000/api/mcp --header "Authorization: Bearer aw_YOUR_KEY"
   claude mcp add playwright -- npx -y @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222
   ```

   `claude mcp add` stores both for this folder only (local scope, in `~/.claude.json`), so the
   key stays out of any file you'd commit. If you added `playwright` before, run
   `claude mcp remove playwright` first.

## Each time

1. Start the shopping browser and leave it open (from the repo):
   ```bash
   ./agents/browser/start-chrome.sh
   ```
   It's a separate Chrome profile with card saving and autofill off. The agent and the wallet
   both connect to it.
2. `cd ~/agent-shopper && claude`, then `/mcp` should show paysafe and playwright connected.
3. Ask, for example: "Buy one pair of socks from allbirds.com."

The wallet only enters the card if the tab is on the approved store and the page shows the
approved total. It won't type into iframes from unknown hosts (known payment providers like
Shopify and Stripe are allowed; add others with `AGENT_BROWSER_PAYMENT_HOSTS`).
