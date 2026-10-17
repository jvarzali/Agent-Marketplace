# AgentMart (working name)

> A marketplace where AI agents discover, compare, and buy products and services on behalf of the humans (and businesses) they work for.

---

## Why this exists

Today's online stores are built for people: visual layouts, persuasive copy, checkout flows with CAPTCHAs, and pages that change constantly. AI agents can scrape and click through them, but it's slow, brittle, and hard to trust.

AgentMart flips that. It's a storefront designed **agent-first**:

- **Structured, machine-readable listings** instead of HTML pages to scrape
- **A stable API / tool interface** agents can call directly
- **Delegated, bounded spending**, so a human stays in control of what an agent is allowed to buy
- **Verifiable identity and audit trails** for every agent, seller, and transaction

The goal: let an agent go from *"find me a 27-inch 4K monitor under $350 that ships by Friday"* to a completed, human-approved purchase without ever rendering a web page.

---

## Goals and non-goals

### Goals (v1)
- Agents can search, filter, and compare listings through a structured API
- Sellers can publish listings with standardized, machine-readable attributes
- Humans can grant agents **spending mandates** (budgets, categories, approval rules)
- Every action is logged and attributable to a specific agent and its owner
- Safe-by-default checkout: anything outside a mandate requires human approval

### Non-goals (for now)
- Building our own AI agent (we're the marketplace, not the shopper)
- Holding customer funds directly (use an established payment processor)
- Physical fulfillment / logistics
- Agent-to-agent negotiation and bidding (see Roadmap)

---

## Core concepts

| Concept | Description |
|---|---|
| **Principal** | The human or organization an agent acts for. Owns the money and the final say. |
| **Agent** | A registered software client acting on a principal's behalf. Has its own identity and API credentials. |
| **Mandate** | A set of rules a principal grants an agent: budget caps, allowed categories/sellers, expiry, and which purchases need approval. |
| **Seller** | A merchant (or another service) that publishes listings. |
| **Listing** | A product or service with a standardized schema: price, availability, shipping, attributes, return policy. |
| **Cart / Intent** | What an agent proposes to buy. Becomes an order only once it passes mandate checks (and approval, if required). |
| **Order** | A confirmed, paid transaction with a full audit record. |

---

## How it works

```
 ┌───────────┐  grants mandate   ┌───────────┐
 │ Principal │ ────────────────▶ │   Agent   │
 └─────┬─────┘                   └─────┬─────┘
       │ approves (if needed)          │ search / compare / propose cart
       ▼                               ▼
 ┌──────────────────────────────────────────────┐
 │                 AgentMart API                │
 │  Catalog · Mandate engine · Checkout · Audit │
 └───────────────┬──────────────────────┬───────┘
                 │                      │
          ┌──────▼──────┐        ┌──────▼──────┐
          │   Sellers   │        │  Payments   │
          │ (listings)  │        │ (processor) │
          └─────────────┘        └─────────────┘
```

1. **Principal registers an agent** and issues a mandate (e.g., "up to $500/month on office supplies, approve anything over $100").
2. **Agent searches the catalog** using structured queries and gets back typed results.
3. **Agent builds a cart** and submits it as a purchase intent.
4. **Mandate engine evaluates** the intent: auto-approve, require human approval, or reject.
5. **Checkout** charges the principal's payment method via the processor.
6. **Audit log** records who did what, when, and under which mandate.

---

## Architecture

| Component | Responsibility | Suggested tech (TBD) |
|---|---|---|
| **Catalog service** | Listing storage, search, filtering, ranking | Postgres + a search index |
| **Agent gateway** | Auth, rate limiting, API + agent tool interface | REST/JSON + an MCP server |
| **Mandate engine** | Evaluates purchases against principal rules | Policy-as-code module |
| **Checkout service** | Carts, orders, payment orchestration | Payment processor SDK |
| **Approval service** | Notifies principals and records approve/deny decisions | Email / push / web dashboard |
| **Audit log** | Append-only record of every agent action | Immutable event table |
| **Seller portal** | Listing management, order handling | Web app |
| **Principal dashboard** | Manage agents, mandates, approvals, spending | Web app |

### Agent interface
Agents should be able to use AgentMart in two ways:
- **HTTP API** — documented with OpenAPI so any agent framework can call it
- **Tool server (MCP)** — exposes the same capabilities as tools LLM-based agents can call directly

---

## API sketch

> Illustrative only. The real spec lives in `docs/api/`.

```http
GET  /v1/listings?q=4k+monitor&max_price=350&ships_by=2026-10-23
GET  /v1/listings/{id}
POST /v1/carts                     # create a cart
POST /v1/carts/{id}/items          # add items
POST /v1/carts/{id}/submit         # submit as a purchase intent
GET  /v1/intents/{id}              # status: approved | pending_approval | rejected
GET  /v1/orders/{id}
```

Example listing:

```json
{
  "id": "lst_01H...",
  "seller_id": "sel_01H...",
  "title": "27\" 4K IPS Monitor",
  "category": "electronics/monitors",
  "price": { "amount": 32999, "currency": "USD" },
  "availability": { "in_stock": true, "quantity": 42 },
  "shipping": { "earliest_delivery": "2026-10-21", "cost": 0 },
  "attributes": { "resolution": "3840x2160", "panel": "IPS", "refresh_hz": 60 },
  "return_policy": { "days": 30, "restocking_fee_pct": 0 }
}
```

Example mandate:

```json
{
  "agent_id": "agt_01H...",
  "budget": { "amount": 50000, "currency": "USD", "period": "month" },
  "allowed_categories": ["office", "electronics/accessories"],
  "require_approval_over": { "amount": 10000, "currency": "USD" },
  "expires_at": "2027-01-01T00:00:00Z"
}
```

---

## Trust and safety principles

These guide every design decision:

1. **Humans hold the money and the veto.** Agents never get raw payment credentials; they only act within a mandate.
2. **Least privilege.** Mandates default to narrow budgets and short expiry.
3. **Everything is attributable.** Every request carries an agent identity tied to a principal.
4. **Listings are data, not instructions.** Seller-provided text is never treated as commands to the agent (guard against prompt injection in product descriptions).
5. **Reversibility.** Clear cancellation and return paths for agent-initiated orders.
6. **Fair ranking.** Search ranking rules are documented; paid placement is always labeled.

---

## Getting started

> Fill in once the stack is chosen.

```bash
git clone https://github.com/<org>/agentmart.git
cd agentmart
cp .env.example .env        # add payment processor test keys, DB URL
make dev                    # start services locally
make seed                   # load sample sellers and listings
```

Then point a sample agent at `http://localhost:<port>` (see `examples/`).

---

## Repository layout (proposed)

```
agentmart/
├── services/
│   ├── catalog/
│   ├── gateway/
│   ├── mandates/
│   ├── checkout/
│   └── audit/
├── apps/
│   ├── seller-portal/
│   └── principal-dashboard/
├── mcp-server/          # agent tool interface
├── examples/            # sample agents that shop the marketplace
├── docs/
│   ├── api/             # OpenAPI spec
│   └── design/          # design docs and decisions
└── README.md
```

---

## Roadmap

### Phase 0 — Foundations
- [ ] Listing schema and catalog search
- [ ] Agent registration and API keys
- [ ] Seeded demo catalog
- [ ] Read-only MCP tools (search, get listing)

### Phase 1 — Safe purchasing
- [ ] Mandate engine
- [ ] Carts, intents, human approval flow
- [ ] Payment processor integration (test mode)
- [ ] Audit log and principal dashboard

### Phase 2 — Sellers
- [ ] Seller onboarding and portal
- [ ] Inventory and order webhooks
- [ ] Returns and cancellations

### Phase 3 — Smarter commerce
- [ ] Comparison and recommendation endpoints
- [ ] Price watches and restock alerts for agents
- [ ] Agent-to-seller negotiation (offers / counteroffers)
- [ ] Reputation scores for sellers and agents

---

## Open questions

- How do we verify an agent's identity and link it to a principal?
- What's the dispute process when an agent buys the wrong thing within its mandate?
- Should services (APIs, compute, data) be listed alongside physical goods?
- How do we keep ranking fair when sellers optimize listings for agents?
- Which existing agent-commerce and payment standards should we adopt rather than invent?

---

## Contributing

1. Check open issues or the roadmap above.
2. For anything non-trivial, open a short design doc in `docs/design/` first.
3. Branch from `main`, keep PRs focused, include tests.
4. All changes touching mandates, checkout, or payments need two reviewers.

---

## License

TBD.