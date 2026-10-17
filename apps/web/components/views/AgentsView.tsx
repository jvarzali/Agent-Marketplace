"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { AgentsTable } from "@/components/AgentsTable";
import { useStore } from "@/lib/store";

export function AgentsView() {
  const store = useStore();
  const active = store.agents.filter((a) => a.status === "active").length;

  return (
    <div className="page">
      <header className="pagetitle">
        <h1>Agents</h1>
        <p className="pagetitle__meta">
          {active} of {store.agents.length} active. Each has its own key, rules and budget.
        </p>
        <Link href="/agents/new" className="btn btn--primary pagetitle__action">
          <Plus size={18} aria-hidden="true" />
          Add an agent
        </Link>
      </header>

      {store.agents.length === 0 ? (
        <p className="empty">
          No agents yet. <Link href="/agents/new">Add one</Link> to get a key you can paste into Claude, ChatGPT or your
          own agent.
        </p>
      ) : (
        <section className="ledger">
          <AgentsTable agents={store.agents} />
        </section>
      )}
    </div>
  );
}
