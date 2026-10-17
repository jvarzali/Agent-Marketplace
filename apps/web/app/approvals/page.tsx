"use client";

import Link from "next/link";
import { Ago, Pill } from "@/components/bits";
import { Decision } from "@/components/Decision";
import { Receipt } from "@/components/Receipt";
import { money, statusLabel, statusTone } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function Approvals() {
  const store = useStore();
  const decided = store.requests
    .filter((r) => r.status !== "pending_approval" && r.decidedAt)
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
    .slice(0, 8);

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Approvals</h1>
        <p className="muted">
          {store.pending.length
            ? "Newest first. Agents get nothing they can spend until you approve."
            : "You're all caught up. New requests show up here and in your email."}
        </p>
      </header>

      {store.pending.length === 0 ? (
        <div className="empty">
          <p>No purchases waiting.</p>
          <Link href="/agents" className="textlink">
            Review what your agents are allowed to buy
          </Link>
        </div>
      ) : (
        <ul className="inbox">
          {store.pending.map((r) => {
            const agent = store.agent(r.agentId);
            const reasons = r.checks.filter((c) => c.outcome === "approval");
            return (
              <li key={r.id} className="inbox__item">
                <div className="inbox__receipt paper">
                  <Receipt request={r} agent={agent} compact />
                </div>
                <div className="inbox__body">
                  <p className="inbox__who">
                    {agent?.name} <span className="muted">asked <Ago ts={r.createdAt} /></span>
                  </p>
                  <ul className="inbox__reasons">
                    {reasons.map((c, i) => (
                      <li key={i}>{c.detail}</li>
                    ))}
                  </ul>
                  <Decision request={r} />
                  <Link href={`/approvals/${r.id}`} className="textlink">
                    Full details
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {decided.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Recently decided</h2>
          </div>
          <ul className="rows">
            {decided.map((r) => (
              <li key={r.id}>
                <Link href={`/approvals/${r.id}`} className="row">
                  <span className="row__main">
                    <span className="row__title">
                      {money(r.total)} at {r.merchantName}
                    </span>
                    <span className="row__sub">
                      {store.agent(r.agentId)?.name}, <Ago ts={r.decidedAt ?? r.createdAt} />
                    </span>
                  </span>
                  <span className="row__end">
                    <Pill tone={statusTone[r.status]}>{statusLabel[r.status]}</Pill>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
