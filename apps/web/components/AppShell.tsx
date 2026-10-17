"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useStore } from "@/lib/store";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/approvals", label: "Approvals" },
  { href: "/agents", label: "Agents" },
  { href: "/activity", label: "Activity" },
] as const;

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const store = useStore();
  const [confirmReset, setConfirmReset] = useState(false);

  if (path === "/login") return <>{children}</>;

  const activeCount = store.agents.filter((a) => a.status === "active").length;
  const pending = store.pending.length;

  return (
    <div className="shell">
      <aside className="rail" aria-label="Main">
        <Link href="/" className="brand">
          <span className="brand__mark" aria-hidden="true" />
          AgentMart
        </Link>

        <nav className="rail__nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="navlink" aria-current={isActive(path, n.href) ? "page" : undefined}>
              {n.label}
              {n.href === "/approvals" && pending > 0 && <span className="count">{pending}</span>}
            </Link>
          ))}
        </nav>

        <div className="rail__foot">
          <button className="btn btn--stop btn--block" onClick={store.freezeAll} disabled={activeCount === 0}>
            {activeCount === 0 ? "All agents frozen" : "Freeze all agents"}
          </button>
          <p className="rail__hint">
            {activeCount === 0
              ? "Nothing can spend. Unfreeze agents one at a time from Agents."
              : `Stops ${activeCount} ${activeCount === 1 ? "agent" : "agents"} and cancels every card right away.`}
          </p>
          <div className="rail__user">
            <span>{store.userEmail}</span>
            {confirmReset ? (
              <span className="rail__reset">
                <button className="linkbtn" onClick={() => { store.resetDemo(); setConfirmReset(false); }}>
                  Reset
                </button>
                <button className="linkbtn" onClick={() => setConfirmReset(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button className="linkbtn" onClick={() => setConfirmReset(true)}>
                Reset demo data
              </button>
            )}
          </div>
        </div>
      </aside>

      <header className="topbar">
        <Link href="/" className="brand">
          <span className="brand__mark" aria-hidden="true" />
          AgentMart
        </Link>
        <button className="btn btn--stop btn--sm" onClick={store.freezeAll} disabled={activeCount === 0}>
          {activeCount === 0 ? "All frozen" : "Freeze all"}
        </button>
      </header>

      <main className="main" id="main">
        {children}
      </main>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className="tab" aria-current={isActive(path, n.href) ? "page" : undefined}>
            {n.label}
            {n.href === "/approvals" && pending > 0 && <span className="count">{pending}</span>}
          </Link>
        ))}
      </nav>

      <div className="toast-region" role="status" aria-live="polite">
        {store.toast && (
          <div className="toast">
            <span>{store.toast}</span>
            <button className="linkbtn" onClick={store.dismissToast}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
