"use client";

import Link from "next/link";
import { Ago, AgentStatus, Pill } from "@/components/bits";
import { Decision } from "@/components/Decision";
import { Receipt } from "@/components/Receipt";
import { auditLabel, auditTone, money } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function Overview() {
  const store = useStore();
  const { pending, agents, events } = store;
  const first = pending[0];
  const rest = pending.slice(1);
  const security = events.find((e) => e.type === "security");
  const weekTotal = agents.reduce((n, a) => n + a.spend.week, 0);

  return (
    <div className="page">
      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title" className="hero__title">
          {pending.length === 0
            ? "Nothing is waiting on you."
            : pending.length === 1
              ? "One purchase is waiting on you."
              : `${pending.length} purchases are waiting on you.`}
        </h1>
        <p className="hero__sub">
          {pending.length === 0
            ? "Your agents will ask here before buying anything your rules don't already allow."
            : "Your agents can't spend a cent on these until you decide."}
        </p>
      </section>

      {first && (
        <section className="feature" aria-label="Latest request">
          <div className="feature__receipt paper">
            <Receipt request={first} agent={store.agent(first.agentId)} />
          </div>
          <div className="feature__side">
            <p className="feature__why">
              {first.checks
                .filter((c) => c.outcome === "approval")
                .map((c) => c.detail)
                .join(" ")}
            </p>
            <Decision request={first} />
            <Link href={`/approvals/${first.id}`} className="textlink">
              See the agent&rsquo;s reasoning and history
            </Link>
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Also waiting</h2>
            <Link href="/approvals" className="textlink">
              Open approvals
            </Link>
          </div>
          <ul className="rows">
            {rest.map((r) => (
              <li key={r.id}>
                <Link href={`/approvals/${r.id}`} className="row">
                  <span className="row__main">
                    <span className="row__title">
                      {money(r.total)} at {r.merchantName}
                    </span>
                    <span className="row__sub">{store.agent(r.agentId)?.name}</span>
                  </span>
                  <span className="row__end muted">
                    <Ago ts={r.createdAt} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {security && (
        <section className="alert" role="alert">
          <h2 className="alert__title">A card blocked a charge it wasn&rsquo;t issued for</h2>
          <p>{security.summary}</p>
          <p className="muted">
            <Ago ts={security.createdAt} />. <Link href="/activity?type=security">See security events</Link>
          </p>
        </section>
      )}

      <section className="section">
        <div className="section__head">
          <h2>Agents</h2>
          <span className="muted num">{money(weekTotal)} spent this week</span>
        </div>
        <ul className="rows">
          {agents.map((a) => (
            <li key={a.id}>
              <Link href={`/agents/${a.id}`} className="row">
                <span className="row__main">
                  <span className="row__title">{a.name}</span>
                  <span className="row__sub num">
                    {money(a.spend.week)} of {money(a.policy.limits.per_week)} this week
                  </span>
                </span>
                <span className="row__end">
                  <AgentStatus agent={a} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <div className="section__head">
          <h2>Recent activity</h2>
          <Link href="/activity" className="textlink">
            Full log
          </Link>
        </div>
        <ul className="log">
          {events.slice(0, 6).map((e) => (
            <li key={e.id} className="log__item">
              <Pill tone={auditTone[e.type]}>{auditLabel[e.type]}</Pill>
              <span className="log__text">{e.summary}</span>
              <span className="log__time muted">
                <Ago ts={e.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
