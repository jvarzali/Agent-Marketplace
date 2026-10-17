"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { Fragment, useState } from "react";
import { Ago, Facts, LedgerHead, Pill } from "@/components/bits";
import { ApprovalStub } from "@/components/Decision";
import { Receipt } from "@/components/Receipt";
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
  // One row open at a time; clicking it again closes it.
  const [open, setOpen] = useState<string | null>(null);

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
                {decided.map((r) => {
                  const isOpen = open === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr
                        className={`is-toggle${isOpen ? " is-open" : ""}`}
                        onClick={() => setOpen(isOpen ? null : r.id)}
                      >
                        <th scope="row" data-label="Purchase">
                          <button
                            type="button"
                            className="rowtoggle"
                            aria-expanded={isOpen}
                            aria-controls={`receipt-${r.id}`}
                          >
                            <ChevronDown size={16} className="rowtoggle__chev" aria-hidden="true" />
                            {r.merchantName}
                          </button>
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
                      {isOpen && (
                        <tr className="table__expand" id={`receipt-${r.id}`}>
                          <td colSpan={5}>
                            <div className="expand">
                              <section className="expand__box" aria-label="Purchase details">
                                <h3 className="expand__title">Purchase</h3>
                                <Facts
                                  rows={[
                                    { label: "Store", text: `${r.merchantName}, ${r.merchantDomain}` },
                                    { label: "Agent", text: store.agent(r.agentId)?.name ?? "Removed agent" },
                                    {
                                      label: "Outcome",
                                      text: <Pill tone={statusTone[r.status]}>{statusLabel[r.status]}</Pill>,
                                    },
                                    { label: "Total", text: money(r.total) },
                                    {
                                      label: "Items",
                                      text: `${r.items.length} ${r.items.length === 1 ? "item" : "items"}`,
                                    },
                                    { label: "Decided", text: <Ago ts={r.decidedAt ?? r.createdAt} /> },
                                  ]}
                                />
                              </section>
                              <div className="expand__slip">
                                <Receipt request={r} agent={store.agent(r.agentId)} />
                              </div>
                              <section className="expand__box" aria-label="Decision">
                                <h3 className="expand__title">Decision</h3>
                                <ApprovalStub request={r} />
                              </section>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
