# AgentMart dashboard (`apps/web`)

The human-facing dashboard from `prompt.md` §9: approvals inbox, agents and freeze controls, the policy editor, the activity log, onboarding, and trust suggestions. It is frontend only for now and runs on demo data.

## Run it

```sh
npm install          # from the repo root
npm run dev          # http://localhost:3000
```

## How it's wired

- Every `app/**/page.tsx` is a server component that sets the tab title and renders a client view from `components/views/`. When the backend lands, pages can fetch on the server and pass data down without the views changing much.
- `lib/store.tsx` is a client-side stand-in for the backend. Pages only use `useStore()`, so swapping its methods for REST calls later doesn't touch the UI. State persists in `localStorage`; use **Reset demo data** in the sidebar to start over.
- `lib/mock-data.ts` holds the seed: three agents (one frozen), three pending approvals, and a history that includes a blocked gift card and a declined charge.
- `lib/types.ts` mirrors the data model in §5. Replace it with types from `/packages/core` once that exists.
- `lib/policy.ts` holds starter templates and turns a policy into plain-English sentences. It doesn't evaluate rules: the rule checks on each request come from the (mock) policy engine output.

## Decisions

- **Freezing is one tap; unfreezing asks first.** Stopping spending should never be slowed down. Giving spending power back should take a deliberate second step.
- **Approve and deny both have a confirm step**, as §9 requires. Email links will open `/approvals/[id]`, which never acts on page load.
- **Agent-written text is untrusted.** Item names and reasoning render only as React text. Item links are restricted to http(s) and opened with `rel="noopener noreferrer nofollow"`. Reasoning is labeled as written by the agent.
- **Safety rules the UI shows as locked:** gift cards, stored value and subscriptions are always blocked, and "ask when unsure what an item is" is always on. The backend must enforce both; the UI only reflects them.
- **`/login`** is a placeholder for Auth.js email sign-in. It sends nothing.
- The API key and MCP config shown during onboarding are generated in the browser for the demo. The real key comes from the backend, which stores only a hash.

## Design notes

Ledger / Swiss: full-width pages with a top bar, ruled sections (a heavy rule over each heading) and real tables instead of floating cards, like a bank statement. Green, amber and red appear only to mean allowed, waiting on you, and stopped, shown as colored text with an icon, not tinted badges. Each purchase request is drawn as a thermal receipt (the only place the monospace face appears). Approve and Deny sit on a tear-off stub below a perforation on the same slip, and the decision lands on the receipt as a stamp. Icons are Lucide SVGs, always paired with a text label. Status labels also carry a distinct icon shape, so they never rely on color alone. Supports light and dark mode, mobile down to 360px, and reduced motion.
