"use client";

import Link from "next/link";
import { AgentStatus, Meter, Trust } from "@/components/bits";
import { FreezeControl } from "@/components/FreezeControl";
import { money } from "@/lib/format";
import type { Agent } from "@/lib/types";

/** The full agents list, or with `budget` a budget-vs-actual statement for this week with a totals row. */
export function AgentsTable({ agents, budget = false }: { agents: Agent[]; budget?: boolean }) {
  if (budget) return <BudgetTable agents={agents} />;
  return (
    <div className="table-wrap">
      <table className="table table--stack">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Status</th>
            <th scope="col" className="t-num">
              Today
            </th>
            <th scope="col" className="t-wide">
              This week
            </th>
            <th scope="col">Trust</th>
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
              <td data-label="Today" className="t-num">
                {money(a.spend.today)}
              </td>
              <td data-label="This week" className="t-wide">
                <Meter used={a.spend.week} limit={a.policy.limits.per_week} inline />
              </td>
              <td data-label="Trust">
                <Trust level={a.trustLevel} />
              </td>
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

function BudgetTable({ agents }: { agents: Agent[] }) {
  const spent = agents.reduce((n, a) => n + a.spend.week, 0);
  const limit = agents.reduce((n, a) => n + a.policy.limits.per_week, 0);
  return (
    <div className="table-wrap">
      <table className="table table--stack table--figures">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col" className="t-num">
              Spent
            </th>
            <th scope="col" className="t-num">
              Budget
            </th>
            <th scope="col" className="t-num">
              Left
            </th>
            <th scope="col" className="t-meter">
              Used
            </th>
            <th scope="col" className="t-end">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const cap = a.policy.limits.per_week;
            const left = cap - a.spend.week;
            return (
              <tr key={a.id} className={a.status === "frozen" ? "is-frozen" : undefined}>
                <th scope="row" data-label="Agent">
                  <Link href={`/agents/${a.id}`} className="t-link">
                    {a.name}
                  </Link>
                  <span className="t-sub">
                    <AgentStatus agent={a} />
                  </span>
                </th>
                <td data-label="Spent" className="t-num">
                  {money(a.spend.week)}
                </td>
                <td data-label="Budget" className="t-num muted">
                  {money(cap)}
                </td>
                <td data-label="Left" className={`t-num${left < 0 ? " t-neg" : ""}`}>
                  {money(left)}
                </td>
                <td data-label="Used" className="t-meter">
                  <Meter used={a.spend.week} limit={cap} inline bare />
                </td>
                <td className="t-end">
                  <FreezeControl agent={a} />
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">All agents</th>
            <td data-label="Spent" className="t-num">
              {money(spent)}
            </td>
            <td data-label="Budget" className="t-num">
              {money(limit)}
            </td>
            <td data-label="Left" className={`t-num${limit - spent < 0 ? " t-neg" : ""}`}>
              {money(limit - spent)}
            </td>
            <td data-label="Used" className="t-meter">
              <Meter used={spent} limit={limit} inline bare />
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
