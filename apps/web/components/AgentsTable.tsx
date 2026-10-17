"use client";

import Link from "next/link";
import { AgentStatus, Meter, Trust } from "@/components/bits";
import { FreezeControl } from "@/components/FreezeControl";
import { money } from "@/lib/format";
import type { Agent } from "@/lib/types";

export function AgentsTable({ agents, compact = false }: { agents: Agent[]; compact?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table table--stack">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Status</th>
            {!compact && (
              <th scope="col" className="t-num">
                Today
              </th>
            )}
            <th scope="col" className="t-wide">
              This week
            </th>
            {!compact && <th scope="col">Trust</th>}
            <th scope="col" className="t-end">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id} className={a.status === "frozen" ? "is-frozen" : undefined}>
              <th scope="row" data-label="Agent">
                <Link href={`/agents/${a.id}`} className="t-link">
                  {a.name}
                </Link>
                <span className="t-sub">{a.client === "Custom" ? "Own agent" : a.client}</span>
              </th>
              <td data-label="Status">
                <AgentStatus agent={a} />
              </td>
              {!compact && (
                <td data-label="Today" className="t-num">
                  {money(a.spend.today)}
                </td>
              )}
              <td data-label="This week" className="t-wide">
                <Meter used={a.spend.week} limit={a.policy.limits.per_week} inline />
              </td>
              {!compact && (
                <td data-label="Trust">
                  <Trust level={a.trustLevel} />
                </td>
              )}
              <td className="t-end">
                <FreezeControl agent={a} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
