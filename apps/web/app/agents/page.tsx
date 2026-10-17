"use client";

import Link from "next/link";
import { AgentStatus, Meter, Trust } from "@/components/bits";
import { FreezeControl } from "@/components/FreezeControl";
import { useStore } from "@/lib/store";

export default function Agents() {
  const store = useStore();

  return (
    <div className="page">
      <header className="pagehead pagehead--split">
        <div>
          <h1>Agents</h1>
          <p className="muted">Each agent has its own key, its own rules and its own budget.</p>
        </div>
        <Link href="/agents/new" className="btn btn--primary">
          Add an agent
        </Link>
      </header>

      {store.agents.length === 0 ? (
        <div className="empty">
          <p>No agents yet. Add one to get a key you can paste into Claude, ChatGPT or your own agent.</p>
          <Link href="/agents/new" className="btn btn--primary">
            Add an agent
          </Link>
        </div>
      ) : (
        <ul className="agents">
          {store.agents.map((a) => (
            <li key={a.id} className={`agent${a.status === "frozen" ? " agent--frozen" : ""}`}>
              <div className="agent__head">
                <div>
                  <h2 className="agent__name">
                    <Link href={`/agents/${a.id}`}>{a.name}</Link>
                  </h2>
                  <p className="agent__meta">
                    <AgentStatus agent={a} /> <span className="muted">{a.client}</span>
                  </p>
                </div>
                <div className="agent__trust">
                  <Trust level={a.trustLevel} />
                  <span className="fine">Trust {a.trustLevel} of 5</span>
                </div>
              </div>
              <Meter label="This week" used={a.spend.week} limit={a.policy.limits.per_week} />
              <div className="agent__foot">
                <Link href={`/agents/${a.id}`} className="textlink">
                  Rules and history
                </Link>
                <FreezeControl agent={a} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
