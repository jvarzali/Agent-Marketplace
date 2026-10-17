# AgentMart dashboard (`apps/web`)

The human-facing dashboard from `prompt.md` §9: approvals inbox, agents and freeze controls, the policy editor, the activity log, onboarding, and trust suggestions. It is frontend only for now and runs on demo data.

## Run it

```sh
npm install          # from the repo root
npm run dev          # http://localhost:3000
```

## How it's wired

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

Security-paper grounds and banknote-navy ink. Green, amber and red appear only to mean allowed, waiting on you, and stopped. Each purchase request is drawn as a thermal receipt (the only place the monospace face appears), and decisions land on it as a stamp. Supports light and dark mode, mobile down to 360px, and reduced motion.
