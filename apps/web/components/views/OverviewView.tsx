"use client";

import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { AgentsTable } from "@/components/AgentsTable";
import { Ago, Kpi, LedgerHead, Pill } from "@/components/bits";
import { SlipQueue } from "@/components/SlipQueue";
import { auditLabel, auditTone, money } from "@/lib/format";
import { useStore } from "@/lib/store";

const count = (n: number) => Math.round(n).toString();

export function OverviewView() {
  const store = useStore();
  const { pending, agents, events } = store;
  const security = events.find((e) => e.type === "security");
  const waitingTotal = pending.reduce((n, r) => n + r.total, 0);
  const oldest = pending.reduce((t, r) => Math.min(t, r.createdAt), Infinity);
  const weekTotal = agents.reduce((n, a) => n + a.spend.week, 0);
  const weekLimit = agents.reduce((n, a) => n + a.policy.limits.per_week, 0);
  const monthTotal = agents.reduce((n, a) => n + a.spend.month, 0);
  const monthLimit = agents.reduce((n, a) => n + a.policy.limits.per_month, 0);
  const active = agents.filter((a) => a.status === "active").length;
  const pct = (used: number, limit: number) => (limit > 0 ? Math.round((used / limit) * 100) : 0);

  return (
    <div className="page">
      <header className="pagetitle">
        <h1>Overview</h1>
        <p className="pagetitle__meta">
          {pending.length === 0
            ? "Nothing is waiting on you."
            : pending.length === 1
              ? "One purchase is waiting on you."
              : `${pending.length} purchases are waiting on you.`}
        </p>
      </header>

      <dl className="kpis">
        <Kpi
          label="Waiting on you"
          value={waitingTotal}
          tone={pending.length ? "hold" : undefined}
          note={
            pending.length ? (
              <>
                {pending.length} {pending.length === 1 ? "purchase" : "purchases"}, oldest <Ago ts={oldest} />
              </>
            ) : (
              "No open requests"
            )
          }
        />
        <Kpi
          label="Spent this week"
          value={weekTotal}
          note={`${pct(weekTotal, weekLimit)}% of ${money(weekLimit)} weekly budgets`}
          meter={{ used: weekTotal, limit: weekLimit }}
        />
        <Kpi
          label="Spent this month"
          value={monthTotal}
          note={`${pct(monthTotal, monthLimit)}% of ${money(monthLimit)} monthly budgets`}
          meter={{ used: monthTotal, limit: monthLimit }}
        />
        <Kpi
          label="Agents active"
          value={active}
          format={count}
          tone={active < agents.length ? "stop" : "good"}
          note={
            active < agents.length
              ? `${agents.length - active} of ${agents.length} frozen`
              : `All ${agents.length} can buy`
          }
        />
      </dl>

      {security && (
        <div className="alertrow" role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <p>
            <strong>A card blocked a charge it wasn&rsquo;t issued for.</strong> {security.summary}
          </p>
          <Link href="/activity?type=security" className="textlink">
            Security events
          </Link>
        </div>
      )}

      <section className="ledger ledger--tray" aria-labelledby="waiting">
        <LedgerHead
          id="waiting"
          title="Waiting on you"
          aside={
            pending.length > 0 && (
              <Link href="/approvals" className="textlink">
                Open approvals
              </Link>
            )
          }
        />
        <SlipQueue
          requests={pending}
          empty={
            <p className="empty">
              Your agents will ask here before buying anything your rules don&rsquo;t already allow.
            </p>
          }
        />
      </section>

      <div className="columns">
        <section className="ledger" aria-labelledby="agents">
          <LedgerHead
            id="agents"
            title="Budget vs. spent, this week"
            aside={
              <Link href="/agents" className="textlink">
                All agents
              </Link>
            }
          />
          <AgentsTable agents={agents} budget />
        </section>

        <section className="ledger" aria-labelledby="recent">
          <LedgerHead
            id="recent"
            title="Recent activity"
            aside={
              <Link href="/activity" className="textlink">
                Full log
              </Link>
            }
          />
          <ul className="log">
            {events.slice(0, 7).map((e) => (
              <li key={e.id} className="log__item">
                <span className="log__time">
                  <Ago ts={e.createdAt} />
                </span>
                <span className="log__text">
                  <Pill tone={auditTone[e.type]}>{auditLabel[e.type]}</Pill> {e.summary}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
