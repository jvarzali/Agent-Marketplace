"use client";

import { Check, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { countdown, money } from "@/lib/format";
import { useNow, useStore } from "@/lib/store";
import type { PurchaseRequest } from "@/lib/types";

/**
 * Approve / deny with a confirm step (prompt.md §9). One tap picks the
 * decision; a second, explicit tap commits it. Rendered on the receipt's
 * tear-off stub.
 */
export function Decision({ request: r, intent = null }: { request: PurchaseRequest; intent?: "approve" | "deny" | null }) {
  const store = useStore();
  const agent = store.agent(r.agentId);
  // `intent` (from an email or push link) only preselects; committing still takes a tap.
  const [choice, setChoice] = useState<"approve" | "deny" | null>(intent);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);
  const commit = async (fn: (id: string) => Promise<void>) => {
    setBusy(true);
    try {
      await fn(r.id);
    } finally {
      setBusy(false);
      setChoice(null);
    }
  };

  if (r.status !== "pending_approval") {
    return <DecisionResult request={r} now={now} />;
  }

  if (agent?.status === "frozen") {
    return (
      <div className="decision">
        <p className="decision__note">
          {agent.name} is frozen, so this can&rsquo;t be approved. <Link href={`/agents/${agent.id}`}>Review the agent</Link>
        </p>
        <div className="decision__actions">
          <button className="btn" disabled={busy} onClick={() => commit(store.deny)}>
            <X size={18} aria-hidden="true" />
            Deny
          </button>
        </div>
      </div>
    );
  }

  if (choice) {
    const approving = choice === "approve";
    return (
      <div className="decision decision--confirm" role="group" aria-label="Confirm decision">
        <p className="decision__note">
          {approving
            ? `${agent?.name ?? "The agent"} gets a single-use card for exactly ${money(r.total)} at ${r.merchantDomain}, good for 30 minutes.`
            : `${agent?.name ?? "The agent"} is told no and gets nothing it can spend.`}
        </p>
        <div className="decision__actions">
          <button className="btn" disabled={busy} onClick={() => setChoice(null)}>
            Go back
          </button>
          <button
            className={approving ? "btn btn--go" : "btn btn--stop"}
            autoFocus
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => commit(approving ? store.approve : store.deny)}
          >
            {busy ? "Saving…" : approving ? `Yes, approve ${money(r.total)}` : "Yes, deny"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="decision">
      <div className="decision__actions">
        <button className="btn" onClick={() => setChoice("deny")}>
          <X size={18} aria-hidden="true" />
          Deny
        </button>
        <button className="btn btn--go" onClick={() => setChoice("approve")}>
          <Check size={18} aria-hidden="true" />
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
      <p className="decision__note" role="status">
        {left > 0
          ? `Card ending ${r.credential.last4} is waiting for the agent. Expires in ${countdown(left)}.`
          : `Card ending ${r.credential.last4} expired before it was used.`}
      </p>
    );
  }
  const text: Partial<Record<PurchaseRequest["status"], string>> = {
    approved: "Approved. The agent gets its single-use card the next time it checks in.",
    denied: "The agent was told no and got nothing it can spend.",
    cancelled: "Any card for this cart no longer works.",
    completed: "The card was used once and closed.",
    expired: "Expired before anyone used it.",
  };
  return (
    <p className="decision__note" role="status">
      {text[r.status] ?? "Decided."}
    </p>
  );
}

/** The stub printed under a pending receipt: why it needs you, then the decision. */
export function ApprovalStub({
  request: r,
  detailsLink = true,
  intent = null,
}: {
  request: PurchaseRequest;
  detailsLink?: boolean;
  intent?: "approve" | "deny" | null;
}) {
  const reasons = r.checks.filter((c) => c.outcome === "approval" || c.outcome === "deny");
  return (
    <>
      {r.status === "pending_approval" && reasons.length > 0 && (
        <ul className="stub__reasons">
          {reasons.map((c, i) => (
            <li key={i}>{c.detail}</li>
          ))}
        </ul>
      )}
      <Decision request={r} intent={intent} />
      {detailsLink && (
        <Link href={`/approvals/${r.id}`} className="stub__link">
          Reasoning, rules and history
        </Link>
      )}
    </>
  );
}
