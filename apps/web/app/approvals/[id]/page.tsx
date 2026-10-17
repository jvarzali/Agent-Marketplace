"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Ago, CheckList, Pill } from "@/components/bits";
import { Decision } from "@/components/Decision";
import { Receipt } from "@/components/Receipt";
import { money, statusLabel, statusTone } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function ApprovalDetail() {
  const { id } = useParams<{ id: string }>();
  const store = useStore();
  const r = store.request(id);

  if (!r) {
    return (
      <div className="page">
        <div className="empty">
          <p>This request doesn&rsquo;t exist or was removed.</p>
          <Link href="/approvals" className="textlink">
            Back to approvals
          </Link>
        </div>
      </div>
    );
  }

  const agent = store.agent(r.agentId);
  const history = store.requests
    .filter((x) => x.agentId === r.agentId && x.id !== r.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/approvals">Approvals</Link>
      </nav>
      <header className="pagehead">
        <h1>
          {money(r.total)} at {r.merchantName}
        </h1>
        <p>
          <Pill tone={statusTone[r.status]}>{statusLabel[r.status]}</Pill>{" "}
          <span className="muted">
            {agent?.name} asked <Ago ts={r.createdAt} />
          </span>
        </p>
      </header>

      <div className="detail">
        <div className="detail__receipt">
          <div className="paper">
            <Receipt request={r} agent={agent} />
          </div>
          <div className="detail__decide">
            <Decision request={r} />
          </div>
        </div>

        <div className="detail__side">
          <section className="panel">
            <h2 className="panel__title">What the agent said</h2>
            <blockquote className="quote">{r.reasoning}</blockquote>
            <p className="fine">Written by the agent. Check it against the receipt; it can be wrong or misled by a web page.</p>
          </section>

          <section className="panel">
            <h2 className="panel__title">How your rules handled it</h2>
            <CheckList checks={r.checks} />
          </section>

          <section className="panel">
            <h2 className="panel__title">{agent?.name}&rsquo;s recent purchases</h2>
            {history.length === 0 ? (
              <p className="muted">This is its first request.</p>
            ) : (
              <ul className="mini">
                {history.map((h) => (
                  <li key={h.id}>
                    <Link href={`/approvals/${h.id}`} className="mini__row">
                      <span>
                        {money(h.total)} at {h.merchantName}
                      </span>
                      <Pill tone={statusTone[h.status]}>{statusLabel[h.status]}</Pill>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <div className="actionbar">
        <Decision request={r} layout="bar" />
      </div>
    </div>
  );
}
