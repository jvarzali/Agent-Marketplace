"use client";

import { Bot, House, Inbox, ScrollText, Snowflake } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PushToggle } from "@/components/PushToggle";
import { signOutAction } from "@/lib/actions";
import { useNow, useStore } from "@/lib/store";

const NAV = [
  { href: "/", label: "Overview", Icon: House },
  { href: "/approvals", label: "Approvals", Icon: Inbox },
  { href: "/agents", label: "Agents", Icon: Bot },
  { href: "/activity", label: "Activity", Icon: ScrollText },
] as const;

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function AppShell({ children, vapidPublicKey }: { children: React.ReactNode; vapidPublicKey: string | null }) {
  const path = usePathname();
  const store = useStore();
  const now = useNow(60_000);

  const activeCount = store.agents.filter((a) => a.status === "active").length;
  const pending = store.pending.length;
  const section = NAV.find((n) => isActive(path, n.href))?.label ?? "Overview";
  const today = new Date(now).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const freezeAll = (
    <button
      className="btn btn--stop btn--sm"
      onClick={store.freezeAll}
      disabled={activeCount === 0}
      title={activeCount ? `Stops ${activeCount} agents and cancels every card right away` : undefined}
    >
      <Snowflake size={16} aria-hidden="true" />
      {activeCount === 0 ? "All frozen" : "Freeze all"}
    </button>
  );

  return (
    <div className="shell">
      <aside className="side" aria-label="Sidebar">
        <Link href="/" className="brand">
          <span className="brand__mark" aria-hidden="true" />
          AgentMart
        </Link>

        <nav className="side__nav" aria-label="Main">
          <p className="side__label">Dashboard</p>
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="navlink"
              aria-current={isActive(path, n.href) ? "page" : undefined}
            >
              <n.Icon size={17} aria-hidden="true" />
              {n.label}
              {n.href === "/approvals" && pending > 0 && <span className="count">{pending}</span>}
            </Link>
          ))}
        </nav>

        {store.agents.length > 0 && (
          <div className="side__agents">
            <p className="side__label">Your agents</p>
            <ul>
              {store.agents.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/agents/${a.id}`}
                    className="side__agent"
                    aria-current={path.startsWith(`/agents/${a.id}`) ? "page" : undefined}
                  >
                    <span className={`side__dot side__dot--${a.status}`} aria-hidden="true" />
                    <span className="side__agentname">{a.name}</span>
                    <span className="side__agentstate">{a.status === "frozen" ? "Frozen" : "Active"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="side__foot">
          {freezeAll}
          <p className="side__hint">
            {activeCount === 0
              ? "Every agent is frozen."
              : `Stops ${activeCount} active agents and cancels every card.`}
          </p>
        </div>
      </aside>

      <div className="frame">
        <header className="bar">
          <Link href="/" className="brand brand--bar">
            <span className="brand__mark" aria-hidden="true" />
            AgentMart
          </Link>
          <div className="bar__where">
            <span className="bar__section">{section}</span>
            <span className="bar__date">{today}</span>
          </div>
          <div className="bar__end">
            <span className="bar__user">
              {store.userEmail}
              <PushToggle vapidPublicKey={vapidPublicKey} />
              <form action={signOutAction}>
                <button className="linkbtn" type="submit">
                  Sign out
                </button>
              </form>
            </span>
            <span className="bar__freeze">{freezeAll}</span>
          </div>
        </header>

        <main className="main" id="main">
          {children}
        </main>
      </div>

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
