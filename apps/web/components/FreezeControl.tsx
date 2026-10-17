"use client";

import { Play, Snowflake } from "lucide-react";
import { useState } from "react";
import { useStore } from "@/lib/store";
import type { Agent } from "@/lib/types";

/**
 * Freezing is one tap: stopping spending should never be slowed down.
 * Unfreezing asks for confirmation, because it gives spending power back.
 */
export function FreezeControl({ agent, large = false }: { agent: Agent; large?: boolean }) {
  const store = useStore();
  const [confirming, setConfirming] = useState(false);
  const size = large ? " btn--lg" : " btn--sm";

  if (agent.status === "active") {
    return (
      <button className={`btn${large ? " btn--stop" : " btn--stop-quiet"}${size}`} onClick={() => store.freeze(agent.id)}>
        <Snowflake size={large ? 20 : 16} aria-hidden="true" />
        Freeze{large ? ` ${agent.name}` : ""}
      </button>
    );
  }

  if (confirming) {
    return (
      <div className="inline-confirm" role="group" aria-label={`Unfreeze ${agent.name}`}>
        <span className="fine">It can request purchases again under its current rules.</span>
        <button className="btn btn--sm" onClick={() => setConfirming(false)}>
          Keep frozen
        </button>
        <button
          className="btn btn--sm btn--primary"
          onClick={() => {
            store.unfreeze(agent.id);
            setConfirming(false);
          }}
        >
          Unfreeze
        </button>
      </div>
    );
  }

  return (
    <button className={`btn${size}`} onClick={() => setConfirming(true)}>
      <Play size={large ? 18 : 14} aria-hidden="true" />
      Unfreeze{large ? ` ${agent.name}` : ""}
    </button>
  );
}
