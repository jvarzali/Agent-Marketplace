"use client";

import Link from "next/link";
import { useState } from "react";
import { countdown, money } from "@/lib/format";
import { useNow, useStore } from "@/lib/store";
import type { PurchaseRequest } from "@/lib/types";

/**
 * Approve / deny with a confirm step (prompt.md §9). One tap picks the
 * decision; a second, explicit tap commits it.
 */
export function Decision({ request: r, layout = "inline" }: { request: PurchaseRequest; layout?: "inline" | "bar" }) {
  const store = useStore();
  const agent = store.agent(r.agentId);
  const [choice, setChoice] = useState<"approve" | "deny" | null>(null);
  const now = useNow(1000);

  if (r.status !== "pending_approval") {
    return <DecisionResult request={r} now={now} />;
  }

  if (agent?.status === "frozen") {
    return (
      <div className={`decision decision--${layout}`}>
        <p className="decision__note">
          {agent.name} is frozen, so this can&rsquo;t be approved. <Link href={`/agents/${agent.id}`}>Review the agent</Link>
        </p>
        <div className="decision__actions">
          <button className="btn" onClick={() => store.deny(r.id)}>
            Deny
          </button>
        </div>
      </div>
    );
  }

  if (choice) {
    const approving = choice === "approve";
    return (
      <div className={`decision decision--${layout} decision--confirm`} role="group" aria-label="Confirm decision">
        <p className="decision__note">
          {approving
            ? `${agent?.name ?? "The agent"} gets a single-use card for exactly ${money(r.total)} at ${r.merchantDomain}. It stops working in 30 minutes or if the cart changes.`
            : `${agent?.name ?? "The agent"} is told you said no. It won't get a card for this cart.`}
        </p>
        <div className="decision__actions">
          <button className="btn" onClick={() => setChoice(null)}>
            Go back
          </button>
          <button
            className={approving ? "btn btn--go" : "btn btn--stop"}
            autoFocus
            onClick={() => (approving ? store.approve(r.id) : store.deny(r.id))}
          >
            {approving ? `Yes, approve ${money(r.total)}` : "Yes, deny"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`decision decision--${layout}`}>
      <div className="decision__actions">
        <button className="btn" onClick={() => setChoice("deny")}>
          Deny
        </button>
        <button className="btn btn--go" onClick={() => setChoice("approve")}>
          Approve {money(r.total)}
        </button>
      </div>
    </div>
  );
}

function DecisionResult({ request: r, now }: { request: PurchaseRequest; now: number }) {
  if (r.status === "credential_issued" && r.credential) {
    const left = r.credential.expiresAt - now;
    return (
      <div className="decision decision--done" role="status">
        <p className="decision__note">
          {left > 0
            ? `Approved. Card ending ${r.credential.last4} is waiting for the agent and expires in ${countdown(left)}.`
            : `Approved. Card ending ${r.credential.last4} expired before it was used.`}
        </p>
      </div>
    );
  }
  const text: Partial<Record<PurchaseRequest["status"], string>> = {
    denied: "Denied. The agent was told no and got nothing it can spend.",
    cancelled: "Cancelled. Any card for this cart no longer works.",
    completed: "Completed. The card was used once and closed.",
    expired: "Expired before anyone used it.",
  };
  return (
    <div className="decision decision--done" role="status">
      <p className="decision__note">{text[r.status] ?? "Decided."}</p>
    </div>
  );
}
