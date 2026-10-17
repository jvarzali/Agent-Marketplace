"use client";

import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { AgentsTable } from "@/components/AgentsTable";
import { Ago, Kpi, LedgerHead, Pill } from "@/components/bits";
import { SlipQueue } from "@/components/SlipQueue";
import { auditLabel, auditTone, money, sumLimits } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { Tone } from "@/lib/types";

const count = (n: number) => Math.round(n).toString();

// Budget tiles stay neutral until spending passes 80% of the budget, then amber, then red once over it.
// No limit (null) means there's nothing to warn about.
function budgetTone(used: number, limit: number | null): Tone | undefined {
  if (limit === null) return undefined;
  if (limit <= 0) return used > 0 ? "stop" : undefined;
  const share = used / limit;
  return share > 1 ? "stop" : share > 0.8 ? "hold" : undefined;
}

export function OverviewView() {
  const store = useStore();
  const { pending, agents, events } = store;
  const security = events.find((e) => e.type === "security");
  const waitingTotal = pending.reduce((n, r) => n + r.total, 0);
  const oldest = pending.reduce((t, r) => Math.min(t, r.createdAt), Infinity);
  const weekTotal = agents.reduce((n, a) => n + a.spend.week, 0);
  const weekLimit = sumLimits(agents.map((a) => a.policy.limits.per_week));
  // Until this browser's "last checked" mark is read, show nothing as new rather than everything.
  const unchecked = store.autoBuys.filter((r) => r.createdAt > (store.autoSeenAt ?? Infinity));
  const uncheckedTotal = unchecked.reduce((n, r) => n + r.total, 0);
  const active = agents.filter((a) => a.status === "active").length;
  const pct = (used: number, limit: number) => (limit > 0 ? Math.round((used / limit) * 100) : 0);
  const budgetNote = (used: number, limit: number | null, period: string) =>
    limit === null ? `At least one agent has no ${period} limit` : `${pct(used, limit)}% of ${money(limit)} ${period} budgets`;

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
          href="/approvals"
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
          label="Automated purchases"
          href="/activity?type=auto"
          value={uncheckedTotal}
          tone={unchecked.length ? "hold" : undefined}
          note={
            unchecked.length
              ? `${unchecked.length} ${unchecked.length === 1 ? "purchase" : "purchases"} since you last checked`
              : "Nothing new since you last checked"
          }
        />
        <Kpi
          label="Spent this week"
          href="/agents"
          value={weekTotal}
          tone={budgetTone(weekTotal, weekLimit)}
          note={budgetNote(weekTotal, weekLimit, "weekly")}
          meter={weekLimit === null ? undefined : { used: weekTotal, limit: weekLimit }}
        />
        <Kpi
          label="Agents active"
          href="/agents"
          value={active}
          format={count}
          segments={agents.map((a) => (a.status === "active" ? "info" : "stop"))}
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
            <strong>Security check.</strong> {security.summary}
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
