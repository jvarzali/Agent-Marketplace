"use client";

// Client-side mock of the backend. Every mutation here stands in for a call to
// /packages/core via the REST API; pages only talk to this hook, so swapping in
// real fetches later doesn't touch the UI. No rule evaluation happens here: the
// rule checks shown in the UI come from the (mock) policy engine output.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { money } from "./format";
import { seed, type Snapshot } from "./mock-data";
import { ALWAYS_BLOCKED, templatePolicy, type TemplateId } from "./policy";
import type { Agent, AgentClient, AuditEvent, Policy, PurchaseRequest } from "./types";

// Bump when the demo seed changes so browsers pick up the new data.
const STORAGE_KEY = "agentmart.demo.v3";
const CREDENTIAL_TTL_MS = 30 * 60_000;
const BOUGHT = new Set<PurchaseRequest["status"]>(["approved", "credential_issued", "completed"]);

interface Store extends Snapshot {
  toast: string | null;
  dismissToast: () => void;
  agent: (id: string) => Agent | undefined;
  request: (id: string) => PurchaseRequest | undefined;
  pending: PurchaseRequest[];
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
}

const Ctx = createContext<Store | null>(null);

function rid(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function mockApiKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "ag_live_" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function load(): Snapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Snapshot;
  } catch {
    // Storage unavailable or corrupt: fall through to fresh demo data.
  }
  return seed(Date.now());
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setData(load());
  }, []);

  useEffect(() => {
    if (!data) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Non-fatal: the demo just won't survive a reload.
    }
  }, [data]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const update = useCallback((fn: (s: Snapshot) => Snapshot) => {
    setData((s) => (s ? fn(s) : s));
  }, []);

  const store = useMemo<Store | null>(() => {
    if (!data) return null;

    const ev = (e: Omit<AuditEvent, "id" | "createdAt">): AuditEvent => ({
      ...e,
      id: rid("evt"),
      createdAt: Date.now(),
    });

    const freezeIn = (s: Snapshot, agentId: string): { s: Snapshot; cancelled: number } => {
      let cancelled = 0;
      const requests = s.requests.map((r) => {
        if (r.agentId !== agentId) return r;
        if (r.status === "pending_approval") return { ...r, status: "cancelled" as const, decidedAt: Date.now() };
        if (r.credential?.status === "active") {
          cancelled++;
          return { ...r, status: "cancelled" as const, credential: { ...r.credential, status: "cancelled" as const } };
        }
        return r;
      });
      const agent = s.agents.find((a) => a.id === agentId);
      return {
        cancelled,
        s: {
          ...s,
          requests,
          agents: s.agents.map((a) => (a.id === agentId ? { ...a, status: "frozen" } : a)),
          events: [
            ev({
              agentId,
              type: "frozen",
              summary: `You froze ${agent?.name ?? "an agent"}. ${cancelled} active ${cancelled === 1 ? "card" : "cards"} cancelled.`,
            }),
            ...s.events,
          ],
        },
      };
    };

    return {
      ...data,
      toast,
      dismissToast: () => setToast(null),
      agent: (id) => data.agents.find((a) => a.id === id),
      request: (id) => data.requests.find((r) => r.id === id),
      pending: data.requests.filter((r) => r.status === "pending_approval").sort((a, b) => b.createdAt - a.createdAt),
      autoBuys: data.requests
        .filter((r) => BOUGHT.has(r.status) && !r.checks.some((c) => c.outcome === "approval"))
        .sort((a, b) => b.createdAt - a.createdAt),
      markAutoSeen: () => update((s) => ({ ...s, autoSeenAt: Date.now() })),

      approve: (requestId) => {
        const now = Date.now();
        const last4 = String(1000 + Math.floor(Math.random() * 9000));
        const target = data.requests.find((x) => x.id === requestId);
        const owner = target && data.agents.find((a) => a.id === target.agentId);
        if (target?.status === "pending_approval" && owner?.status === "active") {
          notify(`Approved ${money(target.total)} at ${target.merchantName}. Card ending ${last4} issued for this cart only.`);
        }
        update((s) => {
          const r = s.requests.find((x) => x.id === requestId);
          const agent = r && s.agents.find((a) => a.id === r.agentId);
          if (!r || !agent || r.status !== "pending_approval" || agent.status !== "active") return s;
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
              ev({ agentId: r.agentId, type: "approved", requestId, summary: `You approved ${money(r.total)} at ${r.merchantName}.` }),
              ...s.events,
            ],
          };
        });
      },

      deny: (requestId) => {
        const target = data.requests.find((x) => x.id === requestId);
        if (target?.status === "pending_approval") {
          notify(`Denied ${money(target.total)} at ${target.merchantName}. The agent was told no.`);
        }
        update((s) => {
          const r = s.requests.find((x) => x.id === requestId);
          if (!r || r.status !== "pending_approval") return s;
          return {
            ...s,
            requests: s.requests.map((x) => (x.id === requestId ? { ...x, status: "denied", decidedAt: Date.now() } : x)),
            events: [
              ev({ agentId: r.agentId, type: "denied", requestId, summary: `You denied ${money(r.total)} at ${r.merchantName}.` }),
              ...s.events,
            ],
          };
        });
      },

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
      },

      unfreeze: (agentId) => {
        update((s) => {
          const agent = s.agents.find((a) => a.id === agentId);
          return {
            ...s,
            agents: s.agents.map((a) => (a.id === agentId ? { ...a, status: "active" } : a)),
            events: [ev({ agentId, type: "unfrozen", summary: `You unfroze ${agent?.name ?? "an agent"}.` }), ...s.events],
          };
        });
      },

      freezeAll: () => {
        const active = data.agents.filter((a) => a.status === "active");
        update((s) => active.reduce((acc, a) => freezeIn(acc, a.id).s, s));
        notify(
          active.length
            ? `Froze ${active.length} ${active.length === 1 ? "agent" : "agents"}. Every active card is cancelled.`
            : "Every agent was already frozen.",
        );
      },

      savePolicy: (agentId, policy) => {
        update((s) => {
          const agent = s.agents.find((a) => a.id === agentId);
          if (!agent) return s;
          const version = agent.policy.version + 1;
          return {
            ...s,
            agents: s.agents.map((a) => (a.id === agentId ? { ...a, policy: { ...policy, version } } : a)),
            events: [
              ev({ agentId, type: "policy_changed", summary: `You saved version ${version} of ${agent.name}'s rules.` }),
              ...s.events,
            ],
          };
        });
        notify("Rules saved. They apply to the next purchase request.");
      },

      createAgent: (name, client, template) => {
        const apiKey = mockApiKey();
        const agent: Agent = {
          id: rid("agt"),
          name,
          client,
          status: "active",
          trustLevel: 1,
          createdAt: Date.now(),
          keyPrefix: apiKey.slice(0, 12),
          policy: templatePolicy(template),
          spend: { today: 0, week: 0, month: 0, ordersToday: 0 },
        };
        update((s) => ({
          ...s,
          agents: [...s.agents, agent],
          events: [ev({ agentId: agent.id, type: "agent_created", summary: `You added ${name}.` }), ...s.events],
        }));
        return { agent, apiKey };
      },

      rotateKey: (agentId) => {
        const apiKey = mockApiKey();
        update((s) => ({
          ...s,
          agents: s.agents.map((a) => (a.id === agentId ? { ...a, keyPrefix: apiKey.slice(0, 12) } : a)),
        }));
        notify("Old key revoked. Update your agent with the new key.");
        return apiKey;
      },

      acceptSuggestion: (id) => {
        update((s) => {
          const sug = s.suggestions.find((x) => x.id === id);
          const agent = sug && s.agents.find((a) => a.id === sug.agentId);
          if (!sug || !agent) return s;
          const version = agent.policy.version + 1;
          return {
            ...s,
            suggestions: s.suggestions.map((x) => (x.id === id ? { ...x, status: "accepted" } : x)),
            agents: s.agents.map((a) =>
              a.id === agent.id
                ? { ...a, policy: { ...a.policy, version, approval: { ...a.policy.approval, ...sug.apply } } }
                : a,
            ),
            events: [
              ev({
                agentId: agent.id,
                type: "policy_changed",
                summary: `You raised ${agent.name}'s ask-first amount to ${money(sug.apply.require_if_total_over)}.`,
              }),
              ...s.events,
            ],
          };
        });
        notify("Rule updated.");
      },

      dismissSuggestion: (id) => {
        update((s) => ({ ...s, suggestions: s.suggestions.map((x) => (x.id === id ? { ...x, status: "dismissed" } : x)) }));
      },

      resetDemo: () => {
        setData(seed(Date.now()));
        notify("Demo data reset.");
      },
    };
  }, [data, toast, update, notify]);

  if (!store) return <div className="boot" aria-busy="true" />;
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
