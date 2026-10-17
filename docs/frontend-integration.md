# Frontend integration guide

For whoever works on `apps/web` (the Next.js dashboard). The web app is a **thin layer**:
authenticate the human, call `@agent-wallet/core`, render. No business rules in components or
route handlers.

> **Status: wired.** Everything below is implemented in `apps/web`. Where to find it:
>
> | Piece | File |
> |---|---|
> | Auth.js (email magic link, Prisma adapter, database sessions) | `apps/web/auth.ts`, `app/api/auth/[...nextauth]/route.ts` |
> | Agent REST / MCP / webhooks / cron | `app/api/[...path]/route.ts` |
> | Sign-in gate | `middleware.ts` (cookie check) + `app/(dashboard)/layout.tsx` (real session check) |
> | First render | `app/(dashboard)/layout.tsx` → `wallet.owner.getDashboardSnapshot(userId)` |
> | Core → view-model mapping (cents → dollars, rule labels, event sentences) | `lib/server/snapshot.ts` |
> | Every mutation (Server Actions, POST only, user id from the session) | `lib/actions.ts` |
> | Client store used by every view; polls every 15 s | `lib/store.tsx` |
> | Web push opt-in + service worker | `components/PushToggle.tsx`, `public/sw.js` |
> | Root `.env` loading for the Next server | `instrumentation.ts` |
>
> Check `WalletError` with `WalletError.is(e)`, not `instanceof`: Next bundles the package into
> several layers, and the process-wide wallet may come from a different copy of the class.

## 1. Add the workspace packages

`apps/web/package.json`:

```json
"dependencies": {
  "@agent-wallet/core": "*",
  "@agent-wallet/db": "*",
  "@agent-wallet/api": "*",
  "@agent-wallet/mcp": "*"
}
```

`apps/web/next.config.ts`: the packages ship TypeScript source, so transpile them, and keep
the database driver on the server:

```ts
const nextConfig = {
  transpilePackages: ["@agent-wallet/core", "@agent-wallet/db", "@agent-wallet/api", "@agent-wallet/mcp"],
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
};
export default nextConfig;
```

Use `@agent-wallet/core/pure` in **client components** (policy schema, plain-English policy
summary, templates, money formatting). It doesn't import the database. Everything else must
be server-only (Server Components / Server Actions / route handlers).

## 2. Mount the agent API, MCP endpoint, webhooks and cron

One catch-all route serves all agent-facing endpoints:

```ts
// apps/web/app/api/[...path]/route.ts
import { createApiHandler } from "@agent-wallet/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = createApiHandler();
export { handle as GET, handle as POST, handle as DELETE };
```

This gives you `/api/v1/*` (REST), `/api/mcp` (remote MCP), `/api/webhooks/issuer` (card issuer
webhooks) and `/api/cron/expire` (expiry sweep). If you add your own `/api/*` routes (e.g.
Auth.js at `/api/auth/[...nextauth]`), the more specific route wins over the catch-all.

The expiry sweep should run **every minute** (it cancels unused cards after 30 minutes). Call
`GET /api/cron/expire` with `Authorization: Bearer $CRON_SECRET` from your scheduler.

## 3. Auth (humans)

Use Auth.js with `@auth/prisma-adapter` and an email provider (magic link). The Prisma schema
already has the `User`, `Account`, `Session` and `VerificationToken` models (table names are
snake_case via `@@map`; the adapter works with model names).

```ts
import { PrismaAdapter } from "@auth/prisma-adapter";
import { getDb } from "@agent-wallet/db";
// NextAuth({ adapter: PrismaAdapter(getDb()), providers: [Resend({ ... })], ... })
```

Every `wallet.owner.*` / `wallet.trust.*` method takes the **signed-in user's id** as its first
argument and checks ownership itself. Always pass the id from the server-side session, never
from the request body or URL.

## 4. Calling the backend

```ts
import { getWallet, WalletError } from "@agent-wallet/core";
const wallet = getWallet(); // process singleton built from env
```

`WalletError` has `.code` (`not_found`, `validation`, `invalid_state`, `conflict`, …), `.status`
(HTTP) and a `.message` that is safe to show to the user. `validation` errors on policies carry
Zod issues in `.details` for per-field form errors.

### Onboarding

| Screen | Call |
|---|---|
| Sign up / sign in | Auth.js |
| Pick a starter template | `policyTemplates(timezone)` from `@agent-wallet/core/pure` → `{ id, name, description, rules }` |
| Create first agent | `wallet.owner.createAgent(userId, { name, client, template })` (`client`: `claude` \| `chatgpt` \| `custom`) → `{ agent, apiKey }`. **Show `apiKey` once**, with a copy button. It can't be retrieved again. |
| Connection instructions | Show the MCP config snippets from the README (§ Connecting an agent) with the key and your `APP_URL` filled in. |

### Agents list

| Feature | Call |
|---|---|
| List with status, spend this week, trust level, pending count | `wallet.owner.listAgents(userId)` → `AgentSummary[]` (amounts in cents) |
| **Freeze** button | `wallet.owner.freezeAgent(userId, agentId)` → `{ cancelledRequests, cancelledCards }` |
| **Freeze all agents** | `wallet.owner.freezeAll(userId)` |
| Unfreeze | `wallet.owner.unfreezeAgent(userId, agentId)` |
| Rename | `wallet.owner.renameAgent(userId, agentId, name)` |
| Rotate key (shows new key once) | `wallet.owner.rotateApiKey(userId, agentId)` → `{ apiKey, prefix }` |
| Revoke key | `wallet.owner.revokeApiKey(userId, agentId)` |
| Home summary | `wallet.owner.getDashboardSummary(userId)` → agents, pending count, weekly spend, recent security events |
| Everything at once | `wallet.owner.getDashboardSnapshot(userId)` → user, agents (+ rules, budget), recent purchases (+ checks, latest card), activity, open suggestions |

### Policy editor (form UI, not raw JSON)

| Feature | Call |
|---|---|
| Load | `wallet.owner.getPolicy(userId, agentId)` → `{ version, rules, summary }` |
| Live plain-English preview while editing | `describePolicy(rules)` from `@agent-wallet/core/pure` (client-side), or `wallet.owner.previewPolicy(rules)` |
| Validate on the client | `safeParsePolicy(rules)` from `@agent-wallet/core/pure` |
| Save (creates a new version) | `wallet.owner.updatePolicy(userId, agentId, rules)` |
| History | `wallet.owner.listPolicyVersions(userId, agentId)` |

The rules shape is `PolicyRules` (see `packages/core/src/policy/schema.ts`). Policy amounts are
in **dollars** (major units); everything returned from services is in **cents**.
`approval.require_if_category_uncertain` is always `true` and can't be turned off, so show it as
a fixed rule rather than a toggle.

### Approvals inbox (mobile-first)

| Feature | Call |
|---|---|
| Inbox list | `wallet.owner.listPendingApprovals(userId)` |
| Detail / confirmation page at **`/approvals/[id]`** (the email and push links point here, optionally with `?intent=approve` or `?intent=deny` to preselect) | `wallet.owner.getApprovalContext(userId, id)` → merchant, each item with link and line total, totals, agent reasoning, `triggeredRules`, the agent's recent history, `confirmToken`, `canDecide` |
| Approve / Deny (after the confirm step) | Server Action **POST**: `wallet.owner.decideApproval(userId, id, "approved" \| "denied", confirmToken)` |
| Override a denial (after the confirm step) | `wallet.owner.overrideDenial(userId, id, confirmToken)`. Refused for cash-like carts (gift cards, stored value, blocked MCCs), broken cart math, frozen agents and requests older than `PENDING_TTL_MINUTES`; the snapshot's `overrideBlock` says why. At issuance only those hard rules are re-checked. |
| Automated purchases badge | snapshot `purchases[].autoApproved` + `user.autoPurchasesSeenAt`; `wallet.owner.markAutoPurchasesSeen(userId)` when the user opens the list |

Rules that must hold:
- Opening `/approvals/[id]` (a GET) must **never** approve or deny anything. Approve/Deny happens
  only through a POST from an authenticated session after a confirm step. `?intent=` only
  preselects a button.
- Pass back the `confirmToken` you rendered. If the cart changed, `decideApproval` throws
  `conflict`. Reload and show the new cart.
- Item names, reasoning, merchant names and URLs come from the agent and are **untrusted**. Render
  them as text (React's default escaping; no `dangerouslySetInnerHTML`). Item `url`s are already
  filtered to http(s) or null. Link them with `rel="noopener noreferrer nofollow"` and
  `target="_blank"`.

### Activity log

| Feature | Call |
|---|---|
| Event feed, filterable by agent / severity / type, paginated | `wallet.owner.listActivity(userId, { agentId?, severity?, types?, before?, limit? })` → `{ events, nextCursor }` |
| Purchases table | `wallet.owner.listPurchases(userId, { agentId?, status?, before?, limit? })` |
| Purchase detail (request, every rule check, approvals, cards, transactions, audit trail) | `wallet.owner.getPurchase(userId, id)` |

Show `severity: "security"` events prominently (red banner on the home screen). Examples:
`security.authorization_declined` (a card was tried at the wrong store or for too much),
`security.charge_declined`, `security.over_capture`. Their `payload.message` is a human sentence.

### Trust suggestions

| Feature | Call |
|---|---|
| List open suggestions | `wallet.trust.list(userId, agentId?)` → `{ id, message, category, maxTotalCents, streakCount, agent }` |
| Accept (adds an auto-approve rule as a new policy version) | `wallet.trust.accept(userId, id)` |
| Dismiss (won't be offered again) | `wallet.trust.dismiss(userId, id)` |

Suggestions only. Nothing loosens a policy unless the user accepts.

### Web push

1. Expose `VAPID_PUBLIC_KEY` to the client and subscribe with the Push API.
2. Save with `wallet.owner.savePushSubscription(userId, subscription.toJSON())`, and remove with
   `wallet.owner.deletePushSubscription(userId, endpoint)`.
3. Serve the service worker from [`push-service-worker.js`](./push-service-worker.js) as
   `/sw.js`. Notification buttons open the confirmation page; they never approve directly.

## 5. Seed data

`npm run db:seed` creates `demo@agentwallet.dev` with two agents, three weeks of history,
a trust suggestion, a security event, a refund and two live pending approvals. Sign in as that
email (with the console email sender, the magic link prints in the server log).
