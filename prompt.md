# Project Brief: Agent Spending Guardrails ("the wallet for AI agents")

You are going to help me build a product that lets people safely let AI agents buy things on their behalf. Read this whole document before writing any code. Then, before starting, ask me any questions where a wrong guess would be expensive to undo (see "Questions to ask me first" at the end). After that, work through the milestones in order.

---

## 1. What we're building

AI agents (Claude, ChatGPT, custom agents) are starting to shop online for people. The problem: agents can do almost anything, and users don't trust them with a credit card. This product is the trusted layer between an agent and the user's money.

- The **user** sets rules for each of their agents: where it can shop, what it can buy, how much it can spend, and when a human must approve.
- The **agent** asks our service for permission to buy. If the purchase is allowed (and approved, if required), our service gives the agent a **single-use, locked-down payment credential** good only for that exact purchase.
- The user watches everything from a dashboard, approves purchases from their phone, and can freeze any agent instantly.
- Over time, users **build trust** in their agents by seeing a clean track record and gradually loosening limits.

### The three parties

```
Human ──chat──▶ Agent (Claude, ChatGPT, etc.)        ← NOT our product
                  │
                  │ request_purchase(merchant, items, total)
                  ▼
            OUR SERVICE  ◀──── Human sets rules, approves, reviews
          (policy + wallet)      (web dashboard + notifications)
```

The user does not talk to their agent through our product. They talk to their agent wherever they already do. Our product only gets involved when the agent wants to spend money.

---

## 2. The single most important principle

**The hard stop must be enforced at the money, not at the agent's behavior.**

- The agent must never hold a reusable payment credential, a stored card, or anything that can spend more than what was approved.
- Limits must never depend on the agent following instructions. Assume the agent may be confused, buggy, or prompt-injected by text on a product page.
- Every purchase goes through: **policy check → (optional) human approval → issue a credential scoped to that exact merchant, amount, and short expiry**.
- The card network (via the card issuer's spending controls) is the final enforcement layer. Our policy engine decides; the issued card enforces.
- Default deny. Anything ambiguous goes to human approval, never to auto-allow.

If any design decision you make weakens this principle, stop and flag it to me instead of proceeding.

---

## 3. Components

1. **Backend service** (the actual product): users, agents, policies, policy engine, approvals, card issuing, audit log.
2. **Web dashboard** for humans (mobile-friendly): sign up, create/connect agents, set policies, approve/deny, view history, kill switch.
3. **Notifications** for approvals: email first, then web push. Each has Approve / Deny actions that open a confirmation screen.
4. **MCP server** so agents (e.g., Claude) can connect with tools. This is the primary agent interface.
5. **REST API** for agents that don't use MCP (same logic underneath).
6. **(Later, optional) Browser extension** for agents that browse in the user's Chrome. Not part of the MVP. The extension is a UX/visibility layer, never the enforcement layer.

---

## 4. Suggested tech stack

Use this unless you have a strong reason not to; if you deviate, explain why first.

- TypeScript everywhere
- Next.js (App Router) for the dashboard and REST API
- PostgreSQL with Prisma
- Auth for humans: a standard library (e.g., Auth.js) with email login
- Agent auth: per-agent API keys (store only hashes; show the key once on creation)
- MCP server: the official TypeScript MCP SDK, as a separate package in the same repo, calling the same core logic
- Card issuing: **behind an interface** (`CardIssuer`) with two implementations:
  - `MockCardIssuer` for development and tests (default)
  - `StripeIssuingCardIssuer` (or similar provider) implemented later; verify the provider's current API docs before writing it rather than relying on memory
- Email: a transactional email provider behind an interface, with a console/log implementation for dev
- Monorepo layout, for example:
  ```
  /apps/web          Next.js dashboard + REST API
  /packages/core     domain logic: policy engine, approvals, issuing, audit
  /packages/db       Prisma schema + client
  /packages/mcp      MCP server
  ```

All business rules live in `/packages/core`. The web app, REST API, and MCP server are thin layers on top. No rule logic in UI or route handlers.

---

## 5. Data model (starting point; refine as needed)

- **User**: id, email, created_at
- **Agent**: id, user_id, name, api_key_hash, status (`active` | `frozen`), trust_level, created_at
- **Policy** (one active per agent, versioned): id, agent_id, version, rules (JSON, validated by a schema), created_at
- **PurchaseRequest**: id, agent_id, merchant_domain, merchant_name, mcc (if known), items (JSON: name, category, unit_price, quantity, url), subtotal, tax, shipping, total, currency, agent_reasoning (text), cart_hash, status (`denied` | `pending_approval` | `approved` | `credential_issued` | `completed` | `expired` | `cancelled`), decision_reasons (JSON), created_at
- **Approval**: id, purchase_request_id, decided_by_user_id, decision (`approved` | `denied`), cart_hash, decided_at, expires_at
- **IssuedCredential**: id, purchase_request_id, provider, provider_card_id, amount_limit, allowed_mccs, expires_at, status (`active` | `used` | `cancelled` | `expired`). Never store full card numbers in our DB.
- **Transaction**: id, issued_credential_id, amount, merchant, status, raw provider event (JSON), created_at
- **AuditEvent**: id, user_id, agent_id, type, payload (JSON), created_at. Append-only. Every decision, approval, issuance, policy change, freeze, and transaction gets one.

---

## 6. Policy model

Policies are JSON, validated with a schema (e.g., Zod). Example:

```json
{
  "merchants": {
    "mode": "allowlist",
    "allow_domains": ["amazon.com", "target.com"],
    "deny_mccs": ["7995", "6051", "4829"]
  },
  "categories": {
    "allow": ["groceries", "household", "pet_supplies"],
    "deny": ["gift_cards", "stored_value", "subscriptions", "alcohol", "firearms"]
  },
  "limits": {
    "per_order_total": 75,
    "per_day": 100,
    "per_week": 200,
    "per_month": 500,
    "max_quantity_per_item": 5,
    "max_orders_per_day": 3
  },
  "approval": {
    "always": false,
    "require_if_total_over": 30,
    "require_for_new_merchant": true,
    "require_if_category_uncertain": true
  },
  "schedule": { "timezone": "America/Los_Angeles", "allowed_hours": "08:00-22:00" },
  "currency": "USD"
}
```

### Policy engine requirements

- Input: a purchase request + the agent's active policy + the agent's spending history.
- Output: `allow` | `deny` | `needs_approval`, plus a list of human-readable reasons (which rule fired and why). Every rule check is recorded, not just the deciding one.
- Evaluation order: agent frozen → hard denies (blocked merchant/MCC/category) → limits (per-order, rolling windows, quantity, frequency) → schedule → approval triggers → allow.
- Limits apply to the **full total** (subtotal + tax + shipping), not the sticker price.
- Rolling windows count pending-approval and issued-but-unused amounts too, so an agent can't stack requests to exceed a budget.
- Detect order-splitting: multiple requests to the same merchant in a short window count against the per-order limit as a combined amount, or trigger approval.
- Gift cards, stored value, and subscriptions are denied by default even if the user forgot to list them.
- Category classification: do a best-effort classification of each item (rules + optional LLM classifier behind an interface). If confidence is low, the result is `needs_approval`, never `allow`.
- New agents default to `approval.always = true`.
- The engine is a pure function with no I/O, so it's easy to test exhaustively.

---

## 7. Purchase flow

1. Agent calls `request_purchase` with merchant, items, totals, and its reasoning.
2. Server computes a **cart hash** over merchant + items + quantities + prices + tax + shipping + total.
3. Policy engine decides.
   - `deny` → return reasons to the agent. Log it.
   - `needs_approval` → create a pending request, notify the user, return `pending` with a request id. Agent polls `get_purchase_status` (or waits).
   - `allow` → go to step 5.
4. User approves or denies in the dashboard. The approval is bound to the cart hash and expires (default 15 minutes). The approval screen shows: merchant, each item with link, totals, the agent's reasoning, which rules triggered approval, and the agent's recent history.
5. Issue a credential via `CardIssuer`: single-use, amount limit = approved total (plus an explicit small configurable buffer for tax/shipping drift, default 0), locked to the merchant category where possible, expires in 30 minutes.
6. Return the credential to the agent **only through the authenticated agent channel**, once.
7. Card provider webhooks report authorizations/transactions. Reconcile to the request, mark completed, cancel the card after use. Any authorization that doesn't match (wrong merchant, amount over limit) is declined by the issuer and logged as a security event shown prominently to the user.
8. If the agent's cart changes after approval (different hash), the old approval is invalid and a new request is required.

---

## 8. MCP server tools

Design these for an agent to use well: clear descriptions, clear error messages explaining *why* something was denied and what the agent can do next.

- `get_my_policy` — returns the rules that apply to this agent, in plain language, so it can plan purchases that will pass.
- `get_budget` — remaining amounts for each window, orders left today.
- `request_purchase` — submit a cart; returns `denied` (with reasons), `pending_approval` (with id), or `approved` (with id).
- `get_purchase_status` — status of a request; when approved, includes the single-use credential exactly once.
- `cancel_purchase` — agent abandons a request; any issued credential is cancelled.
- `report_purchase_result` — agent reports order confirmation number/receipt; stored for the audit log.

Tool descriptions must tell the agent: never ask the user for their real card, never save the credential, and never retry a denied purchase by splitting it up.

---

## 9. Dashboard features

- Onboarding: sign up → create first agent → pick a starter policy template ("Approve everything", "Groceries under $50", "Custom") → copy MCP connection instructions and API key.
- Agents list with status, spend this week, trust level, and a big **Freeze** button. A global **Freeze all agents** button too.
- Policy editor with a form UI (not raw JSON), showing a plain-English summary of the rules.
- Approvals inbox (mobile-first): approve / deny with one tap, then a confirm step.
- Activity log: every request, decision, reason, approval, card issuance, and transaction, filterable by agent.
- **Trust building:** after a streak of clean, approved purchases in a category under some amount, suggest loosening a rule (e.g., "15 grocery purchases under $40 with no issues. Auto-approve groceries under $40?"). Suggestions only; the user always decides. Never auto-loosen.

---

## 10. Security requirements

- Agent API keys: hashed at rest, scoped to one agent, revocable, shown once.
- Freeze takes effect immediately: denies new requests and cancels all active credentials for that agent.
- Card data: never stored or logged in our DB or logs beyond the provider's card id and last 4 digits. Redact in logs.
- Approval actions require an authenticated user session; email links lead to a confirmation page, not a one-click GET that approves.
- Webhooks from the card provider are signature-verified.
- Rate-limit agent endpoints.
- Treat all agent-supplied text (item names, reasoning, URLs) as untrusted: escape it in the UI and never execute or follow it.
- Audit log is append-only.

---

## 11. Milestones

Work in this order. At the end of each milestone, run the tests, summarize what was built, and list anything you were unsure about.

1. **Core + DB:** Prisma schema, policy schema (Zod), pure policy engine, cart hashing. Thorough unit tests for the engine, including every edge case in section 12.
2. **Purchase flow with MockCardIssuer:** request → decide → approve → issue → reconcile, with the audit log. Integration tests for the full flow.
3. **REST API for agents** with API key auth.
4. **MCP server** exposing the tools in section 8, sharing core logic. Include a README showing how to connect it to Claude.
5. **Dashboard:** auth, agents, policy editor, approvals inbox, activity log, freeze.
6. **Notifications:** email (with dev console fallback), then web push.
7. **Trust suggestions.**
8. **Real card issuer adapter** (after checking current provider docs), plus webhook handling.
9. *(Later)* Browser extension.

---

## 12. Edge cases the tests must cover

- Total under the per-order limit before tax/shipping but over it after.
- Two requests that each pass, but together exceed the weekly budget (including while the first is still pending).
- Splitting one big order into several small ones at the same merchant.
- Gift card / stored value item hidden in an otherwise allowed cart.
- Unknown merchant with `require_for_new_merchant`.
- Low-confidence category classification → approval, never allow.
- Approval expired before the agent tried to use it.
- Cart changed after approval (hash mismatch).
- Agent frozen between approval and credential issuance.
- Credential used at a different merchant or for a higher amount (issuer declines; we log a security event).
- Request outside allowed hours, respecting the policy's timezone.
- Currency mismatch.
- Refund received: budget is restored and the event is logged.

---

## 13. Code quality expectations

- Strict TypeScript, no `any` in core logic.
- The policy engine and cart hashing are pure and fully unit tested.
- Provider-specific code (card issuer, email, push, classifier) is always behind an interface with a mock.
- Clear README: setup, env vars, running locally, running tests, connecting an agent via MCP.
- `.env.example` with every variable documented. No secrets in code.
- Seed script that creates a demo user, two agents with different policies, and sample history so the dashboard is usable immediately.

---

## 14. Questions to ask me first

Before writing code, ask me about anything here you can't reasonably default:

- Am I in the US, and which card issuer do I have (or plan to get) access to? If unknown, build with the mock and keep the interface clean.
- Do I want to support agents other than MCP-based ones in the MVP?
- Any stack preferences that differ from section 4?
- Where will this be hosted?

For anything else, pick a sensible default, note it in the README under "Decisions", and keep going.
