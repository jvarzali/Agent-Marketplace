"use client";

// Client-side view of the backend. The server renders the first snapshot; every mutation is a
// Server Action (lib/actions.ts) that returns a fresh snapshot, and the store polls so new
// requests from agents show up without a reload. No rule evaluation happens here.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as actions from "./actions";
import type { ActionResult } from "./actions";
import { money } from "./format";
import type { TemplateId } from "./policy";
import type { Agent, AgentClient, Policy, PurchaseRequest, Snapshot } from "./types";

const POLL_MS = 15_000;
const BOUGHT = new Set<PurchaseRequest["status"]>(["approved", "credential_issued", "completed"]);
// When this browser last opened Activity > Automated purchases. Per-device, like the theme.
const AUTO_SEEN_KEY = "agentmart.autoSeenAt";

interface Store extends Snapshot {
  toast: string | null;
  dismissToast: () => void;
  agent: (id: string | null) => Agent | undefined;
  request: (id: string) => PurchaseRequest | undefined;
  pending: PurchaseRequest[];
  /** Purchases the rules allowed outright, with no approval step. Newest first. */
  autoBuys: PurchaseRequest[];
  /** Null until read from this browser's storage after hydration. 0 means never checked. */
  autoSeenAt: number | null;
  /** Marks automated purchases as checked now; returns the previous mark. */
  markAutoSeen: () => number;
  approve: (requestId: string) => Promise<void>;
  deny: (requestId: string) => Promise<void>;
  freeze: (agentId: string) => Promise<void>;
  unfreeze: (agentId: string) => Promise<void>;
  freezeAll: () => Promise<void>;
  /** Resolves true when saved. */
  savePolicy: (agentId: string, policy: Policy) => Promise<boolean>;
  createAgent: (name: string, client: AgentClient, template: TemplateId) => Promise<{ agentId: string; apiKey: string } | null>;
  rotateKey: (agentId: string) => Promise<string | null>;
  acceptSuggestion: (id: string) => Promise<void>;
  dismissSuggestion: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ initial, children }: { initial: Snapshot; children: React.ReactNode }) {
  const [data, setData] = useState<Snapshot>(initial);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Responses can land out of order (a poll racing a mutation): only apply the newest.
  const issued = useRef(0);
  const applied = useRef(0);
  const [autoSeenAt, setAutoSeenAt] = useState<number | null>(null);

  useEffect(() => {
    setAutoSeenAt(readAutoSeen());
  }, []);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  /** Run an action, apply its snapshot, surface errors. Returns the data on success. */
  const call = useCallback(
    async <T,>(fn: () => Promise<ActionResult<T>>, quiet = false): Promise<{ data: T } | null> => {
      const n = ++issued.current;
      let r: ActionResult<T>;
      try {
        r = await fn();
      } catch {
        if (!quiet) notify("Couldn't reach the server. Check your connection and try again.");
        return null;
      }
      if (!r.ok && r.signedOut) {
        window.location.assign(`/login?callbackUrl=${encodeURIComponent(window.location.pathname)}`);
        return null;
      }
      if (r.snapshot && n > applied.current) {
        applied.current = n;
        setData(r.snapshot);
      }
      if (!r.ok) {
        if (!quiet) notify(r.error);
        return null;
      }
      return { data: r.data };
    },
    [notify],
  );

  const refresh = useCallback(async () => {
    await call(() => actions.refreshSnapshot(), true);
  }, [call]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  const store = useMemo<Store>(() => {
    const agent = (id: string | null) => (id ? data.agents.find((a) => a.id === id) : undefined);
    const request = (id: string) => data.requests.find((r) => r.id === id);

    return {
      ...data,
      toast,
      dismissToast: () => setToast(null),
      agent,
      request,
      pending: data.requests.filter((r) => r.status === "pending_approval").sort((a, b) => b.createdAt - a.createdAt),
      autoBuys: data.requests
        .filter((r) => BOUGHT.has(r.status) && !r.checks.some((c) => c.outcome === "approval"))
        .sort((a, b) => b.createdAt - a.createdAt),
      autoSeenAt,
      markAutoSeen: () => {
        const before = readAutoSeen();
        const now = Date.now();
        try {
          localStorage.setItem(AUTO_SEEN_KEY, String(now));
        } catch {
          // Storage blocked: the mark just won't survive a reload.
        }
        setAutoSeenAt(now);
        return before;
      },

      approve: async (requestId) => {
        const r = request(requestId);
        if (!r) return;
        const res = await call(() => actions.decideRequest(requestId, "approved", r.cartHash));
        if (!res) return;
        if (res.data.status === "expired") notify("That request expired before you decided. The agent will have to ask again.");
        else
          notify(
            `Approved ${money(r.total)} at ${r.merchantName}. ${agent(r.agentId)?.name ?? "The agent"} gets a single-use card for this cart when it checks back.`,
          );
      },

      deny: async (requestId) => {
        const r = request(requestId);
        if (!r) return;
        const res = await call(() => actions.decideRequest(requestId, "denied", r.cartHash));
        if (res) notify(res.data.status === "expired" ? "That request had already expired." : `Denied ${money(r.total)} at ${r.merchantName}. The agent was told no.`);
      },

      freeze: async (agentId) => {
        const name = agent(agentId)?.name ?? "Agent";
        const res = await call(() => actions.freezeAgent(agentId));
        if (res) {
          const cards = res.data.cancelledCards;
          notify(`${name} is frozen. New requests are blocked${cards ? ` and ${cards} ${cards === 1 ? "card was" : "cards were"} cancelled` : ""}.`);
        }
      },

      unfreeze: async (agentId) => {
        const name = agent(agentId)?.name ?? "Agent";
        if (await call(() => actions.unfreezeAgent(agentId))) notify(`${name} can request purchases again.`);
      },

      freezeAll: async () => {
        const active = data.agents.filter((a) => a.status === "active").length;
        const res = await call(() => actions.freezeAll());
        if (res)
          notify(
            active
              ? `Froze ${active} ${active === 1 ? "agent" : "agents"}. Every active card is cancelled.`
              : "Every agent was already frozen.",
          );
      },

      savePolicy: async (agentId, policy) => {
        const res = await call(() => actions.savePolicy(agentId, policy));
        if (res) notify(`Saved as version ${res.data}. It applies to the next purchase request.`);
        return !!res;
      },

      createAgent: async (name, client, template) => {
        const res = await call(() => actions.createAgent(name, client, template));
        return res ? res.data : null;
      },

      rotateKey: async (agentId) => {
        const res = await call(() => actions.rotateKey(agentId));
        if (res) notify("Old key revoked. Update your agent with the new key.");
        return res ? res.data : null;
      },

      acceptSuggestion: async (id) => {
        if (await call(() => actions.acceptSuggestion(id))) notify("Rule updated as a new version.");
      },

      dismissSuggestion: async (id) => {
        await call(() => actions.dismissSuggestion(id));
      },

      refresh,
    };
  }, [data, toast, autoSeenAt, call, notify, refresh]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

function readAutoSeen(): number {
  try {
    const v = Number(localStorage.getItem(AUTO_SEEN_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore must be used inside StoreProvider");
  return s;
}

/** Current time, re-rendering on an interval. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
