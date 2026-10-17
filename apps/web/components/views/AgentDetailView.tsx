"use client";

import { KeyRound, Pencil } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Ago, AgentStatus, CopyField, Facts, LedgerHead, Meter, Pill, Trust } from "@/components/bits";
import { FreezeControl } from "@/components/FreezeControl";
import { money, statusLabel, statusTone } from "@/lib/format";
import { describePolicy } from "@/lib/policy";
import { useStore } from "@/lib/store";

export function AgentDetailView({ id }: { id: string }) {
  const store = useStore();
  const agent = store.agent(id);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  if (!agent) {
    return (
      <div className="page">
        <p className="empty">
          This agent doesn&rsquo;t exist or was removed. <Link href="/agents">Back to agents</Link>
        </p>
      </div>
    );
  }

  const l = agent.policy.limits;
  const suggestions = store.suggestions.filter((s) => s.agentId === agent.id && s.status === "open");
  const requests = store.requests.filter((r) => r.agentId === agent.id).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/agents">Agents</Link>
      </nav>

      <header className="pagetitle">
        <h1>{agent.name}</h1>
        <p className="pagetitle__meta">
          <AgentStatus agent={agent} />
          <span>
            {agent.client === "Custom" ? "Own agent" : agent.client}, added <Ago ts={agent.createdAt} />
          </span>
        </p>
        <div className="pagetitle__action">
          <FreezeControl agent={agent} large />
        </div>
      </header>

      {agent.status === "frozen" && (
        <p className="banner banner--stop">Frozen. Every request from this agent is blocked and it holds no working cards.</p>
      )}

      {suggestions.map((s) => (
        <section key={s.id} className="suggest" aria-label="Suggestion">
          <div>
            <p className="suggest__proposal">{s.proposal}</p>
            <p className="suggest__evidence">{s.evidence} Nothing changes unless you say yes.</p>
          </div>
          <div className="suggest__actions">
            <button className="btn" onClick={() => store.dismissSuggestion(s.id)}>
              Not now
            </button>
            <button className="btn btn--primary" onClick={() => store.acceptSuggestion(s.id)}>
              Yes, change the rule
            </button>
          </div>
        </section>
      ))}

      <div className="grid3">
        <section className="ledger" aria-labelledby="budget">
          <LedgerHead id="budget" title="Budget" />
          <div className="meters">
            <Meter label="Today" used={agent.spend.today} limit={l.per_day} />
            <Meter label="This week" used={agent.spend.week} limit={l.per_week} />
            <Meter label="This month" used={agent.spend.month} limit={l.per_month} />
          </div>
          <p className="fine">
            {agent.spend.ordersToday} of {l.max_orders_per_day} orders used today. Includes requests still waiting on you.
          </p>
        </section>

        <section className="ledger" aria-labelledby="rules">
          <LedgerHead
            id="rules"
            title={`Rules, version ${agent.policy.version}`}
            aside={
              <Link href={`/agents/${agent.id}/policy`} className="btn btn--sm">
                <Pencil size={14} aria-hidden="true" />
                Edit rules
              </Link>
            }
          />
          <Facts rows={describePolicy(agent.policy)} />
        </section>

        <section className="ledger" aria-labelledby="access">
          <LedgerHead id="access" title="Trust and access" />
          <Facts
            rows={[
              {
                label: "Trust",
                text: (
                  <span className="trustblock">
                    <Trust level={agent.trustLevel} /> Level {agent.trustLevel} of 5
                  </span>
                ),
              },
              {
                label: "API key",
                text: newKey ? "New key below" : <code className="keyprefix">{agent.keyPrefix}…</code>,
              },
            ]}
          />
          {newKey ? (
            <div className="stack">
              <CopyField label="New key, shown once" value={newKey} />
              <button className="btn btn--sm" onClick={() => setNewKey(null)}>
                I&rsquo;ve saved it
              </button>
            </div>
          ) : confirmRotate ? (
            <div className="inline-confirm">
              <span className="fine">The current key stops working immediately.</span>
              <button className="btn btn--sm" onClick={() => setConfirmRotate(false)}>
                Cancel
              </button>
              <button
                className="btn btn--sm btn--stop"
                onClick={() => {
                  setNewKey(store.rotateKey(agent.id));
                  setConfirmRotate(false);
                }}
              >
                Revoke and replace
              </button>
            </div>
          ) : (
            <button className="btn btn--sm" onClick={() => setConfirmRotate(true)}>
              <KeyRound size={14} aria-hidden="true" />
              Revoke and replace key
            </button>
          )}
        </section>
      </div>

      <section className="ledger" aria-labelledby="purchases">
        <LedgerHead
          id="purchases"
          title="Purchases"
          aside={
            <Link href={`/activity?agent=${agent.id}`} className="textlink">
              Full log
            </Link>
          }
        />
        {requests.length === 0 ? (
          <p className="empty">No purchase requests yet. Connect the agent and ask it to buy something.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th scope="col">Store</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Items</th>
                  <th scope="col" className="t-num">
                    Total
                  </th>
                  <th scope="col" className="t-end">
                    Requested
                  </th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <th scope="row" data-label="Store">
                      <Link href={`/approvals/${r.id}`} className="t-link">
                        {r.merchantName}
                      </Link>
                    </th>
                    <td data-label="Outcome">
                      <Pill tone={statusTone[r.status]}>{statusLabel[r.status]}</Pill>
                    </td>
                    <td data-label="Items" className="t-clip">
                      {r.items.map((i) => i.name).join("; ")}
                    </td>
                    <td data-label="Total" className="t-num">
                      {money(r.total)}
                    </td>
                    <td data-label="Requested" className="t-end muted">
                      <Ago ts={r.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
