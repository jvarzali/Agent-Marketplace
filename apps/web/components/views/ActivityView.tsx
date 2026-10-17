"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Ago, LedgerHead, Pill } from "@/components/bits";
import { auditLabel, auditTone, clockTime, dayLabel, money } from "@/lib/format";
import { useNow, useStore } from "@/lib/store";
import type { AuditEvent, AuditType } from "@/lib/types";

const FILTERS: { id: string; label: string; types: AuditType[] | null }[] = [
  { id: "all", label: "Everything", types: null },
  {
    id: "decisions",
    label: "Decisions",
    types: ["request_denied", "request_pending", "request_auto_approved", "approved", "denied"],
  },
  // Not an event filter: shows the purchases themselves, from store.autoBuys.
  { id: "auto", label: "Automated purchases", types: null },
  {
    id: "money",
    label: "Cards and charges",
    types: ["credential_issued", "credential_cancelled", "transaction", "refund"],
  },
  { id: "security", label: "Security", types: ["security", "frozen", "unfrozen"] },
  { id: "changes", label: "Rule changes", types: ["policy_changed", "agent_created"] },
];

export function ActivityView() {
  const store = useStore();
  const now = useNow(60_000);
  const params = useSearchParams();
  const router = useRouter();
  const agentId = params.get("agent") ?? "all";
  const typeId = params.get("type") ?? "all";
  const filter = FILTERS.find((f) => f.id === typeId) ?? FILTERS[0];

  // Only opening the Automated purchases tab counts as checking them. Keep the
  // previous mark while the tab is open so new ones stay flagged until you leave it.
  const onAuto = filter.id === "auto";
  const [seenBefore, setSeenBefore] = useState(store.autoSeenAt);
  useEffect(() => {
    if (!onAuto) return;
    setSeenBefore(store.autoSeenAt);
    store.markAutoSeen();
    // Runs on entering the tab only; the store object changes on every update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAuto]);
  const autoBuys = store.autoBuys.filter((r) => agentId === "all" || r.agentId === agentId);
  const fresh = autoBuys.filter((r) => r.createdAt > seenBefore);
  const freshTotal = fresh.reduce((n, r) => n + r.total, 0);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v === "all") next.delete(k);
    else next.set(k, v);
    const qs = next.toString();
    router.replace(qs ? `/activity?${qs}` : "/activity", { scroll: false });
  };

  const events = store.events
    .filter((e) => agentId === "all" || e.agentId === agentId)
    .filter((e) => !filter.types || filter.types.includes(e.type))
    .sort((a, b) => b.createdAt - a.createdAt);

  const groups: { day: string; items: AuditEvent[] }[] = [];
  for (const e of events) {
    const day = dayLabel(e.createdAt, now);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(e);
    else groups.push({ day, items: [e] });
  }

  return (
    <div className="page">
      <header className="pagetitle">
        <h1>Activity</h1>
        <p className="pagetitle__meta">
          Every request, decision, card and charge. Entries can&rsquo;t be edited or deleted.
        </p>
      </header>

      <div className="filters">
        <label className="field field--inline">
          <span className="field__label">Agent</span>
          <select className="input" value={agentId} onChange={(e) => setParam("agent", e.target.value)}>
            <option value="all">All agents</option>
            {store.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="seg seg--wrap" role="group" aria-label="Event type">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className="seg__btn"
              aria-pressed={f.id === filter.id}
              onClick={() => setParam("type", f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {onAuto ? (
        <section className="ledger" aria-labelledby="auto-title">
          <LedgerHead
            id="auto-title"
            title="Automated purchases"
            aside={
              <span className="muted">
                {fresh.length
                  ? `${fresh.length} new since you last checked, ${money(freshTotal)}`
                  : "Nothing new since you last checked"}
              </span>
            }
          />
          {autoBuys.length === 0 ? (
            <p className="empty">Purchases your rules allowed outright, with no approval step, show up here.</p>
          ) : (
            <div className="table-wrap">
              <table className="table table--stack">
                <thead>
                  <tr>
                    <th scope="col">Purchase</th>
                    <th scope="col">Agent</th>
                    <th scope="col" className="t-num">
                      Charged
                    </th>
                    <th scope="col" className="t-end">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {autoBuys.map((r) => (
                    <tr key={r.id}>
                      <th scope="row" data-label="Purchase">
                        <Link href={`/approvals/${r.id}`} className="t-link">
                          {r.merchantName}
                        </Link>
                        <span className="t-sub">{r.items.map((i) => i.name).join("; ")}</span>
                      </th>
                      <td data-label="Agent">{store.agent(r.agentId)?.name}</td>
                      <td data-label="Charged" className="t-num">
                        {money(r.total)}
                      </td>
                      <td data-label="When" className="t-end muted">
                        {r.createdAt > seenBefore && <Pill tone="hold">New</Pill>} <Ago ts={r.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : groups.length === 0 ? (
        <p className="ledger empty">
          Nothing matches these filters.{" "}
          <button className="linkbtn" onClick={() => router.replace("/activity")}>
            Show everything
          </button>
        </p>
      ) : (
        <section className="ledger" aria-label="Log entries">
          <div className="table-wrap">
            <table className="table table--stack table--log">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Event</th>
                  <th scope="col">What happened</th>
                  <th scope="col">Agent</th>
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.day}>
                  <tr className="table__day">
                    <th scope="rowgroup" colSpan={4}>
                      {g.day}
                    </th>
                  </tr>
                  {g.items.map((e) => (
                    <tr key={e.id} className={e.type === "security" ? "is-alert" : undefined}>
                      <td data-label="Time" className="muted t-time">
                        {clockTime(e.createdAt)}
                      </td>
                      <td data-label="Event">
                        <Pill tone={auditTone[e.type]}>{auditLabel[e.type]}</Pill>
                      </td>
                      <td data-label="What happened">
                        {e.requestId ? <Link href={`/approvals/${e.requestId}`}>{e.summary}</Link> : e.summary}
                      </td>
                      <td data-label="Agent" className="muted">
                        {store.agent(e.agentId)?.name}
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
