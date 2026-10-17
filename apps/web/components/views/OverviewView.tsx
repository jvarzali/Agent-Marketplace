"use client";

import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { AgentsTable } from "@/components/AgentsTable";
import { Ago, LedgerHead, Pill } from "@/components/bits";
import { SlipQueue } from "@/components/SlipQueue";
import { auditLabel, auditTone, money } from "@/lib/format";
import { useStore } from "@/lib/store";

export function OverviewView() {
  const store = useStore();
  const { pending, agents, events } = store;
  const security = events.find((e) => e.type === "security");
  const waitingTotal = pending.reduce((n, r) => n + r.total, 0);
  const weekTotal = agents.reduce((n, a) => n + a.spend.week, 0);
  const active = agents.filter((a) => a.status === "active").length;

  return (
    <div className="page">
      <header className="pagetitle">
        <h1>
          {pending.length === 0
            ? "Nothing is waiting on you."
            : pending.length === 1
              ? "One purchase is waiting on you."
              : `${pending.length} purchases are waiting on you.`}
        </h1>
        <dl className="figures">
          <div>
            <dt>Waiting on you</dt>
            <dd>{money(waitingTotal)}</dd>
          </div>
          <div>
            <dt>Spent this week</dt>
            <dd>{money(weekTotal)}</dd>
          </div>
          <div>
            <dt>Agents active</dt>
            <dd>
              {active} of {agents.length}
            </dd>
          </div>
        </dl>
      </header>

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

      <section className="ledger" aria-labelledby="waiting">
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
            <p className="empty">Your agents will ask here before buying anything your rules don&rsquo;t already allow.</p>
          }
        />
      </section>

      <div className="columns">
        <section className="ledger" aria-labelledby="agents">
          <LedgerHead
            id="agents"
            title="Agents"
            aside={
              <Link href="/agents" className="textlink">
                All agents
              </Link>
            }
          />
          <AgentsTable agents={agents} compact />
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
