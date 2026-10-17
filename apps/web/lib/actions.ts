"use server";

// Every dashboard mutation. Server Actions are POST-only and carry Next's origin check, so an
// email or push link (a GET) can never approve or change anything. The user id always comes
// from the server-side session, never from the client.

import { AGENT_CLIENTS, getWallet, WalletError, type AgentClient, type PolicyTemplateId } from "@agent-wallet/core";
import { AuthError } from "next-auth";
import { auth, signIn, signOut } from "@/auth";
import { toSnapshot } from "@/lib/server/snapshot";
import type { Snapshot } from "@/lib/types";

export type ActionResult<T = null> =
  | { ok: true; data: T; snapshot: Snapshot }
  | { ok: false; error: string; snapshot?: Snapshot; signedOut?: boolean };

const TEMPLATES: PolicyTemplateId[] = ["approve_everything", "groceries_under_50", "custom"];

async function sessionUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

async function load(userId: string): Promise<Snapshot> {
  return toSnapshot(await getWallet().owner.getDashboardSnapshot(userId));
}

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await sessionUserId();
  if (!userId) return { ok: false, error: "You're signed out. Sign in again to continue.", signedOut: true };
  try {
    const data = await fn(userId);
    return { ok: true, data, snapshot: await load(userId) };
  } catch (e) {
    if (WalletError.is(e)) return { ok: false, error: e.message, snapshot: await load(userId).catch(() => undefined) };
    getWallet().deps.logger.error("dashboard action failed", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

const id = (v: unknown, what: string) => {
  if (typeof v !== "string" || !v || v.length > 64) throw new WalletError("validation", `Invalid ${what}.`);
  return v;
};

export async function refreshSnapshot(): Promise<ActionResult> {
  return run(async () => null);
}

export async function decideRequest(requestId: string, decision: "approved" | "denied", confirmToken: string) {
  return run((u) => {
    if (decision !== "approved" && decision !== "denied") throw new WalletError("validation", "Invalid decision.");
    return getWallet().owner.decideApproval(u, id(requestId, "request"), decision, id(confirmToken, "cart"));
  });
}

export async function freezeAgent(agentId: string) {
  return run((u) => getWallet().owner.freezeAgent(u, id(agentId, "agent")));
}

export async function unfreezeAgent(agentId: string) {
  return run(async (u) => void (await getWallet().owner.unfreezeAgent(u, id(agentId, "agent"))));
}

export async function freezeAll() {
  return run((u) => getWallet().owner.freezeAll(u));
}

export async function savePolicy(agentId: string, rules: unknown) {
  return run(async (u) => {
    // `version` is display-only on the client; the backend assigns the next one.
    const { version: _version, ...plain } = (rules ?? {}) as Record<string, unknown>;
    return (await getWallet().owner.updatePolicy(u, id(agentId, "agent"), plain)).version;
  });
}

export async function createAgent(name: string, client: AgentClient, template: PolicyTemplateId) {
  return run(async (u) => {
    if (!AGENT_CLIENTS.includes(client)) throw new WalletError("validation", "Pick which assistant this is.");
    if (!TEMPLATES.includes(template)) throw new WalletError("validation", "Pick a starting template.");
    const { agent, apiKey } = await getWallet().owner.createAgent(u, { name: String(name ?? ""), client, template });
    return { agentId: agent.id, apiKey };
  });
}

export async function rotateKey(agentId: string) {
  return run(async (u) => (await getWallet().owner.rotateApiKey(u, id(agentId, "agent"))).apiKey);
}

export async function acceptSuggestion(suggestionId: string) {
  return run(async (u) => void (await getWallet().trust.accept(u, id(suggestionId, "suggestion"))));
}

export async function dismissSuggestion(suggestionId: string) {
  return run((u) => getWallet().trust.dismiss(u, id(suggestionId, "suggestion")));
}

export async function savePushSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  return run((u) => getWallet().owner.savePushSubscription(u, sub));
}

export async function deletePushSubscription(endpoint: string) {
  return run((u) => getWallet().owner.deletePushSubscription(u, String(endpoint)));
}

/** Only same-site paths, so a crafted login link can't bounce the user elsewhere. */
function safeCallback(v: unknown): string {
  return typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/";
}

export async function signInWithEmail(_prev: { error: string | null }, form: FormData): Promise<{ error: string | null }> {
  const email = String(form.get("email") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };
  try {
    // Redirects to /login?type=email once the link is sent.
    await signIn("email", { email, redirectTo: safeCallback(form.get("callbackUrl")) });
  } catch (e) {
    if (e instanceof AuthError) return { error: "We couldn't send the link. Try again in a minute." };
    throw e; // the redirect itself
  }
  return { error: null };
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
