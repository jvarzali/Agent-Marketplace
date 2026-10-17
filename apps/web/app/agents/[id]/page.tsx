"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Ago, AgentStatus, CopyField, Meter, Pill, Trust } from "@/components/bits";
import { FreezeControl } from "@/components/FreezeControl";
import { money, statusLabel, statusTone } from "@/lib/format";
import { describePolicy } from "@/lib/policy";
import { useStore } from "@/lib/store";

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const store = useStore();
  const agent = store.agent(id);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  if (!agent) {
    return (
      <div className="page">
        <div className="empty">
          <p>This agent doesn&rsquo;t exist or was removed.</p>
          <Link href="/agents" className="textlink">
            Back to agents
          </Link>
        </div>
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

      <header className="pagehead pagehead--split">
        <div>
          <h1>{agent.name}</h1>
          <p className="agent__meta">
            <AgentStatus agent={agent} /> <span className="muted">{agent.client}, added <Ago ts={agent.createdAt} /></span>
          </p>
        </div>
        <FreezeControl agent={agent} large />
      </header>

      {agent.status === "frozen" && (
        <p className="banner banner--stop">
          Frozen. Every request from this agent is blocked and it holds no working cards.
        </p>
      )}

      {suggestions.map((s) => (
        <section key={s.id} className="suggest" aria-label="Suggestion">
          <p className="suggest__evidence">{s.evidence}</p>
          <p className="suggest__proposal">{s.proposal}</p>
          <p className="fine">Only you can loosen a rule. Nothing changes unless you say yes.</p>
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

      <div className="split">
        <section className="panel">
          <h2 className="panel__title">Budget left</h2>
          <div className="meters">
            <Meter label="Today" used={agent.spend.today} limit={l.per_day} />
            <Meter label="This week" used={agent.spend.week} limit={l.per_week} />
            <Meter label="This month" used={agent.spend.month} limit={l.per_month} />
          </div>
          <p className="fine num">
            {agent.spend.ordersToday} of {l.max_orders_per_day} orders used today. Amounts include requests still
            waiting on you.
          </p>
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Rules</h2>
            <Link href={`/agents/${agent.id}/policy`} className="btn btn--sm">
              Edit rules
            </Link>
          </div>
          <ul className="summary">
            {describePolicy(agent.policy).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <p className="fine">Version {agent.policy.version}</p>
        </section>
      </div>

      <div className="split">
        <section className="panel">
          <h2 className="panel__title">Trust</h2>
          <div className="trustblock">
            <Trust level={agent.trustLevel} />
            <span>Level {agent.trustLevel} of 5</span>
          </div>
          <p className="muted">
            Trust grows with clean, approved purchases. When there&rsquo;s a good track record in a category,
            you&rsquo;ll see a suggestion to loosen a rule here.
          </p>
        </section>

        <section className="panel">
          <h2 className="panel__title">API key</h2>
          {newKey ? (
            <>
              <CopyField label="New key" value={newKey} />
              <p className="fine">Shown once. Copy it into your agent now; the old key already stopped working.</p>
              <button className="btn btn--sm" onClick={() => setNewKey(null)}>
                I&rsquo;ve saved it
              </button>
            </>
          ) : (
            <>
              <p>
                <code className="keyprefix">{agent.keyPrefix}…</code>
              </p>
              <p className="fine">Only the start of the key is kept for reference. The full key was shown once.</p>
              {confirmRotate ? (
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
                  Revoke and replace key
                </button>
              )}
            </>
          )}
        </section>
      </div>

      <section className="section">
        <div className="section__head">
          <h2>Purchases</h2>
          <Link href={`/activity?agent=${agent.id}`} className="textlink">
            Full log for {agent.name}
          </Link>
        </div>
        {requests.length === 0 ? (
          <p className="muted">No purchase requests yet. Connect the agent and ask it to buy something.</p>
        ) : (
          <ul className="rows">
            {requests.map((r) => (
              <li key={r.id}>
                <Link href={`/approvals/${r.id}`} className="row">
                  <span className="row__main">
                    <span className="row__title">
                      {money(r.total)} at {r.merchantName}
                    </span>
                    <span className="row__sub">
                      <Ago ts={r.createdAt} />
                    </span>
                  </span>
                  <span className="row__end">
                    <Pill tone={statusTone[r.status]}>{statusLabel[r.status]}</Pill>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
