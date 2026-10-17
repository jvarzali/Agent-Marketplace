"use client";

import { Bot, House, Inbox, ScrollText, Snowflake } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useStore } from "@/lib/store";

const NAV = [
  { href: "/", label: "Overview", Icon: House },
  { href: "/approvals", label: "Approvals", Icon: Inbox },
  { href: "/agents", label: "Agents", Icon: Bot },
  { href: "/activity", label: "Activity", Icon: ScrollText },
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
      <header className="bar">
        <Link href="/" className="brand">
          <span className="brand__mark" aria-hidden="true" />
          AgentMart
        </Link>

        <nav className="bar__nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="navlink" aria-current={isActive(path, n.href) ? "page" : undefined}>
              <n.Icon size={17} aria-hidden="true" />
              {n.label}
              {n.href === "/approvals" && pending > 0 && <span className="count">{pending}</span>}
            </Link>
          ))}
        </nav>

        <div className="bar__end">
          <span className="bar__user">
            {store.userEmail}
            {confirmReset ? (
              <>
                <button
                  className="linkbtn"
                  onClick={() => {
                    store.resetDemo();
                    setConfirmReset(false);
                  }}
                >
                  Reset
                </button>
                <button className="linkbtn" onClick={() => setConfirmReset(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button className="linkbtn" onClick={() => setConfirmReset(true)}>
                Reset demo
              </button>
            )}
          </span>
          <button
            className="btn btn--stop btn--sm"
            onClick={store.freezeAll}
            disabled={activeCount === 0}
            title={activeCount ? `Stops ${activeCount} agents and cancels every card right away` : undefined}
          >
            <Snowflake size={16} aria-hidden="true" />
            {activeCount === 0 ? "All frozen" : "Freeze all"}
          </button>
        </div>
      </header>

      <main className="main" id="main">
        {children}
      </main>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className="tab" aria-current={isActive(path, n.href) ? "page" : undefined}>
            <span className="tab__icon">
              <n.Icon size={20} aria-hidden="true" />
              {n.href === "/approvals" && pending > 0 && <span className="count count--dot">{pending}</span>}
            </span>
            {n.label}
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
