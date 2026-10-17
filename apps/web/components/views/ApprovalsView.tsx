"use client";

import Link from "next/link";
import { Ago, LedgerHead, Pill } from "@/components/bits";
import { SlipQueue } from "@/components/SlipQueue";
import { money, statusLabel, statusTone } from "@/lib/format";
import { useStore } from "@/lib/store";

export function ApprovalsView() {
  const store = useStore();
  const decided = store.requests
    .filter((r) => r.status !== "pending_approval" && r.decidedAt)
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
    .slice(0, 10);
  const waitingTotal = store.pending.reduce((n, r) => n + r.total, 0);

  return (
    <div className="page">
      <header className="pagetitle">
        <h1>Approvals</h1>
        <p className="pagetitle__meta">
          {store.pending.length
            ? `${store.pending.length} waiting, ${money(waitingTotal)} in total. Newest first.`
            : "You're all caught up."}
        </p>
      </header>

      <section className="ledger ledger--tray" aria-labelledby="waiting">
        <LedgerHead id="waiting" title="Waiting on you" />
        <SlipQueue
          requests={store.pending}
          empty={
            <p className="empty">
              No purchases waiting. New requests show up here and in your email.{" "}
              <Link href="/agents">Review what your agents can buy</Link>
            </p>
          }
        />
      </section>

      {decided.length > 0 && (
        <section className="ledger" aria-labelledby="decided">
          <LedgerHead id="decided" title="Recently decided" />
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th scope="col">Purchase</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="t-num">
                    Total
                  </th>
                  <th scope="col" className="t-end">
                    Decided
                  </th>
                </tr>
              </thead>
              <tbody>
                {decided.map((r) => (
                  <tr key={r.id}>
                    <th scope="row" data-label="Purchase">
                      <Link href={`/approvals/${r.id}`} className="t-link">
                        {r.merchantName}
                      </Link>
                      <span className="t-sub">
                        {r.items.length} {r.items.length === 1 ? "item" : "items"}
                      </span>
                    </th>
                    <td data-label="Agent">{store.agent(r.agentId)?.name}</td>
                    <td data-label="Outcome">
                      <Pill tone={statusTone[r.status]}>{statusLabel[r.status]}</Pill>
                    </td>
                    <td data-label="Total" className="t-num">
                      {money(r.total)}
                    </td>
                    <td data-label="Decided" className="t-end muted">
                      <Ago ts={r.decidedAt ?? r.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
