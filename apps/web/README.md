# AgentMart dashboard (`apps/web`)

The human-facing dashboard from `prompt.md` §9: approvals inbox, agents and freeze controls, the policy editor, the activity log, onboarding, and trust suggestions. It runs on the real backend (`@agent-wallet/core`) and also serves the agent-facing API.

## Run it

```sh
# from the repo root, once: npm install, cp .env.example .env (set AUTH_SECRET), npm run db:up, npm run db:migrate, npm run db:seed
npm run dev          # http://localhost:3000
```

Sign in with your email. Without `RESEND_API_KEY` the sign-in link is printed in the terminal running `npm run dev`. The seed user is `demo@agentwallet.dev`.

## How it's wired

- **Sign-in:** Auth.js email magic links (`auth.ts`) with the Prisma adapter and database sessions. The link is sent through the wallet's email sender. `middleware.ts` sends signed-out visitors to `/login?callbackUrl=…`; `app/(dashboard)/layout.tsx` does the real session check.
- **Data:** the dashboard layout loads `wallet.owner.getDashboardSnapshot(userId)` on the server and `lib/server/snapshot.ts` maps it to the view models in `lib/types.ts` (dollars, labeled rule checks, one sentence per audit event).
- **Mutations:** `lib/actions.ts` holds one Server Action per operation (approve/deny with the cart hash, freeze, unfreeze, freeze all, save policy, create agent, rotate key, accept/dismiss suggestions, push subscribe). Each takes the user id from the session and returns a fresh snapshot.
- **`lib/store.tsx`** is what every view uses (`useStore()`). It applies action results, shows toasts for errors, and polls every 15 seconds so new requests from agents appear without a reload.
- **Agent API:** `app/api/[...path]/route.ts` mounts `@agent-wallet/api`: REST at `/api/v1/*`, remote MCP at `/api/mcp`, card-issuer webhooks at `/api/webhooks/issuer`, and the expiry sweep at `/api/cron/expire`.
- **Push:** the header's "Notify me" button registers `public/sw.js` and saves the subscription. It only shows when `VAPID_PUBLIC_KEY` is set.
- `lib/policy.ts` turns a policy into plain-English sentences for the live preview. It doesn't evaluate rules: rule checks come from the backend's engine.

## Decisions

- **Freezing is one tap; unfreezing asks first.** Stopping spending should never be slowed down. Giving spending power back should take a deliberate second step.
- **Denials can be overridden, with a confirm step**, except carts with something no agent may ever buy (gift cards, stored value, cash-like merchants), a frozen agent, or a request more than a day old. The backend enforces this; the button just shows its reason.
- **Automated purchases** (allowed by the rules with no approval) get their own tab in Activity and a tile on the Overview. "Since you last checked" is saved on your account, so it's the same on every device.
- **Approve and deny both have a confirm step**, as §9 requires. Email links will open `/approvals/[id]`, which never acts on page load.
- **Agent-written text is untrusted.** Item names and reasoning render only as React text. Item links are restricted to http(s) and opened with `rel="noopener noreferrer nofollow"`. Reasoning is labeled as written by the agent.
- **Safety rules the UI shows as locked:** gift cards and stored value are always blocked, subscriptions are blocked unless allowed, and "ask when unsure what an item is" is always on. The backend enforces all three; the UI only reflects them.
- The API key shown during onboarding and after rotation comes from the backend, which stores only a hash. It's shown once.

## Design notes

Ledger / Swiss: full-width pages with a top bar, ruled sections (a heavy rule over each heading) and real tables instead of floating cards, like a bank statement. Green, amber and red appear only to mean allowed, waiting on you, and stopped, shown as colored text with an icon, not tinted badges. Each purchase request is drawn as a thermal receipt (the only place the monospace face appears). Approve and Deny sit on a tear-off stub below a perforation on the same slip, and the decision lands on the receipt as a stamp. Icons are Lucide SVGs, always paired with a text label. Status labels also carry a distinct icon shape, so they never rely on color alone. Supports light and dark mode, mobile down to 360px, and reduced motion.
