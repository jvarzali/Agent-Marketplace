"use client";

// Client-side view of the backend. The server renders the first snapshot; every mutation is a
// Server Action (lib/actions.ts) that returns a fresh snapshot, and the store polls so new
// requests from agents show up without a reload. No rule evaluation happens here.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as actions from "./actions";
import type { ActionResult } from "./actions";
import { money } from "./format";
<<<<<<< HEAD
import { seed, type Snapshot } from "./mock-data";
import { ALWAYS_BLOCKED, templatePolicy, type TemplateId } from "./policy";
import type { Agent, AgentClient, AuditEvent, Policy, PurchaseRequest } from "./types";

// Bump when the demo seed changes so browsers pick up the new data.
const STORAGE_KEY = "agentmart.demo.v3";
const CREDENTIAL_TTL_MS = 30 * 60_000;
const BOUGHT = new Set<PurchaseRequest["status"]>(["approved", "credential_issued", "completed"]);
=======
import type { TemplateId } from "./policy";
import type { Agent, AgentClient, Policy, PurchaseRequest, Snapshot } from "./types";

const POLL_MS = 15_000;
>>>>>>> 3b72f5c5b735cc16badeda0fc3b180f0e1a8d16e

interface Store extends Snapshot {
  toast: string | null;
  dismissToast: () => void;
  agent: (id: string | null) => Agent | undefined;
  request: (id: string) => PurchaseRequest | undefined;
  pending: PurchaseRequest[];
<<<<<<< HEAD
  /** Purchases the rules allowed outright, with no approval step. Newest first. */
  autoBuys: PurchaseRequest[];
  markAutoSeen: () => void;
  approve: (requestId: string) => void;
  deny: (requestId: string) => void;
  /** Approve a purchase that was denied, by you or by the rules. See overrideBlock for when it isn't allowed. */
  overrideDenied: (requestId: string) => void;
  freeze: (agentId: string) => void;
  unfreeze: (agentId: string) => void;
  freezeAll: () => void;
  savePolicy: (agentId: string, policy: Policy) => void;
  createAgent: (name: string, client: AgentClient, template: TemplateId) => { agent: Agent; apiKey: string };
  rotateKey: (agentId: string) => string;
  acceptSuggestion: (id: string) => void;
  dismissSuggestion: (id: string) => void;
  resetDemo: () => void;
=======
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
>>>>>>> 3b72f5c5b735cc16badeda0fc3b180f0e1a8d16e
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ initial, children }: { initial: Snapshot; children: React.ReactNode }) {
  const [data, setData] = useState<Snapshot>(initial);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Responses can land out of order (a poll racing a mutation): only apply the newest.
  const issued = useRef(0);
  const applied = useRef(0);

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
      markAutoSeen: () => update((s) => ({ ...s, autoSeenAt: Date.now() })),

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

<<<<<<< HEAD
      overrideDenied: (requestId) => {
        const now = Date.now();
        const last4 = String(1000 + Math.floor(Math.random() * 9000));
        const target = data.requests.find((x) => x.id === requestId);
        const owner = target && data.agents.find((a) => a.id === target.agentId);
        if (!target || overrideBlock(target, owner)) return;
        notify(`Overrode the denial: ${money(target.total)} at ${target.merchantName}. Card ending ${last4} issued for this cart only.`);
        update((s) => {
          const r = s.requests.find((x) => x.id === requestId);
          const agent = r && s.agents.find((a) => a.id === r.agentId);
          if (!r || overrideBlock(r, agent)) return s;
          return {
            ...s,
            requests: s.requests.map((x) =>
              x.id === requestId
                ? {
                    ...x,
                    status: "credential_issued",
                    decidedAt: now,
                    credential: { last4, amountLimit: x.total, expiresAt: now + CREDENTIAL_TTL_MS, status: "active" },
                  }
                : x,
            ),
            events: [
              ev({
                agentId: r.agentId,
                type: "credential_issued",
                requestId,
                summary: `Single-use card ending ${last4} issued for ${money(r.total)} at ${r.merchantName}, good for 30 minutes.`,
              }),
              ev({
                agentId: r.agentId,
                type: "approved",
                requestId,
                summary: `You overrode the denial and approved ${money(r.total)} at ${r.merchantName}.`,
              }),
              ...s.events,
            ],
          };
        });
      },

      freeze: (agentId) => {
        const name = data.agents.find((a) => a.id === agentId)?.name ?? "Agent";
        update((s) => freezeIn(s, agentId).s);
        notify(`${name} is frozen. New requests are blocked and its cards are cancelled.`);
=======
      freezeAll: async () => {
        const active = data.agents.filter((a) => a.status === "active").length;
        const res = await call(() => actions.freezeAll());
        if (res)
          notify(
            active
              ? `Froze ${active} ${active === 1 ? "agent" : "agents"}. Every active card is cancelled.`
              : "Every agent was already frozen.",
          );
>>>>>>> 3b72f5c5b735cc16badeda0fc3b180f0e1a8d16e
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
  }, [data, toast, call, notify, refresh]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/**
 * Why a denied purchase can't be overridden, or null if it can. Categories no agent may ever
 * buy (gift cards, stored value, subscriptions) stay blocked: they are how a hijacked agent
 * would cash out, so no single tap should undo that.
 */
export function overrideBlock(r: PurchaseRequest, agent: Agent | undefined): string | null {
  if (r.status !== "denied") return "Only denied purchases can be overridden.";
  const locked = r.items.find((i) => ALWAYS_BLOCKED.includes(i.category));
  if (locked) return "This cart has an item no agent is ever allowed to buy, so the denial can't be overridden.";
  if (!agent) return "This agent no longer exists.";
  if (agent.status === "frozen") return `${agent.name} is frozen. Unfreeze it first to approve this.`;
  return null;
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
