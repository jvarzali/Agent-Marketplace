"use client";

import Link from "next/link";
import { Ago, CheckList, LedgerHead, Pill } from "@/components/bits";
import { ApprovalStub } from "@/components/Decision";
import { Receipt } from "@/components/Receipt";
import { money, statusLabel, statusTone } from "@/lib/format";
import { useStore } from "@/lib/store";

export function ApprovalDetailView({ id }: { id: string }) {
  const store = useStore();
  const r = store.request(id);

  if (!r) {
    return (
      <div className="page">
        <p className="empty">
          This request doesn&rsquo;t exist or was removed. <Link href="/approvals">Back to approvals</Link>
        </p>
      </div>
    );
  }

  const agent = store.agent(r.agentId);
  const history = store.requests
    .filter((x) => x.agentId === r.agentId && x.id !== r.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 6);

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/approvals">Approvals</Link>
      </nav>
      <header className="pagetitle">
        <h1>
          {money(r.total)} at {r.merchantName}
        </h1>
        <p className="pagetitle__meta">
          <Pill tone={statusTone[r.status]}>{statusLabel[r.status]}</Pill>
          <span>
            {agent?.name} asked <Ago ts={r.createdAt} />
          </span>
        </p>
      </header>

      <div className="detail">
        <div className="detail__slip">
          <Receipt request={r} agent={agent}>
            <ApprovalStub request={r} detailsLink={false} />
          </Receipt>
        </div>

        <div className="detail__main">
          <section className="ledger" aria-labelledby="said">
            <LedgerHead id="said" title="What the agent said" aside={<span className="muted">Unverified, written by the agent</span>} />
            <blockquote className="quote">{r.reasoning}</blockquote>
          </section>

          <section className="ledger" aria-labelledby="rules">
            <LedgerHead id="rules" title="How your rules handled it" />
            <CheckList checks={r.checks} />
          </section>

          <section className="ledger" aria-labelledby="history">
            <LedgerHead
              id="history"
              title={`${agent?.name ?? "Agent"}'s other purchases`}
              aside={
                agent && (
                  <Link href={`/agents/${agent.id}`} className="textlink">
                    Agent and rules
                  </Link>
                )
              }
            />
            {history.length === 0 ? (
              <p className="empty">This is its first request.</p>
            ) : (
              <table className="table">
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <th scope="row">
                        <Link href={`/approvals/${h.id}`} className="t-link">
                          {h.merchantName}
                        </Link>
                      </th>
                      <td>
                        <Pill tone={statusTone[h.status]}>{statusLabel[h.status]}</Pill>
                      </td>
                      <td className="t-num">{money(h.total)}</td>
                      <td className="t-end muted">
                        <Ago ts={h.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
