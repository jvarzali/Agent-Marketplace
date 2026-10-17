"use client";

import { Ban, Check, CircleCheck, Clock, Copy, Snowflake } from "lucide-react";
import { useState } from "react";
import { money, relTime } from "@/lib/format";
import { useNow } from "@/lib/store";
import type { Agent, CheckOutcome, Tone } from "@/lib/types";

// Each tone has its own shape too, so status never depends on color alone.
const TONE_ICON = { good: CircleCheck, hold: Clock, stop: Ban, info: null } as const;

export function Pill({ tone, icon, children }: { tone: Tone; icon?: React.ReactNode; children: React.ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={`pill pill--${tone}`}>
      {icon ?? (Icon && <Icon size={12} strokeWidth={2.5} aria-hidden="true" />)}
      {children}
    </span>
  );
}

export function AgentStatus({ agent }: { agent: Agent }) {
  if (agent.status === "frozen") {
    return (
      <Pill tone="stop" icon={<Snowflake size={12} strokeWidth={2.5} aria-hidden="true" />}>
        Frozen
      </Pill>
    );
  }
  return <Pill tone="good">Active</Pill>;
}

export function Ago({ ts }: { ts: number }) {
  const now = useNow();
  return (
    <time dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString()}>
      {relTime(ts, now)}
    </time>
  );
}

export function Meter({
  label,
  used,
  limit,
  inline = false,
}: {
  label?: string;
  used: number;
  limit: number;
  inline?: boolean;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
  const tone = pct >= 90 ? "stop" : pct >= 70 ? "hold" : "good";
  return (
    <div className={inline ? "meter meter--inline" : "meter"}>
      <div className="meter__row">
        {label && <span>{label}</span>}
        <span className="num">
          {money(used)} <span className="muted">of {money(limit)}</span>
        </span>
      </div>
      <div
        className="meter__track"
        role="meter"
        aria-label={label ?? "Spent of limit"}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
      >
        <div className={`meter__fill meter__fill--${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Ledger section heading: a heavy rule, the title, and an optional aside on the right. */
export function LedgerHead({ title, aside, id }: { title: string; aside?: React.ReactNode; id?: string }) {
  return (
    <div className="ledger__head">
      <h2 id={id}>{title}</h2>
      {aside && <div className="ledger__aside">{aside}</div>}
    </div>
  );
}

/** Label / value rows, like the lines of a statement. */
export function Facts({ rows }: { rows: { label: string; text: React.ReactNode }[] }) {
  return (
    <dl className="facts">
      {rows.map((r) => (
        <div key={r.label} className="facts__row">
          <dt>{r.label}</dt>
          <dd>{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Trust({ level }: { level: number }) {
  return (
    <span className="trust" aria-label={`Trust level ${level} of 5`} title={`Trust level ${level} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= level ? "trust__pip trust__pip--on" : "trust__pip"} />
      ))}
    </span>
  );
}

const checkWord: Record<CheckOutcome, string> = { pass: "Passed", approval: "Needs you", deny: "Blocked" };

export function CheckList({ checks }: { checks: { rule: string; outcome: CheckOutcome; detail: string }[] }) {
  return (
    <ul className="checks">
      {checks.map((c, i) => (
        <li key={i} className={`check check--${c.outcome}`}>
          <span className="check__mark" aria-hidden="true" />
          <div>
            <p className="check__rule">
              {c.rule} <span className="check__word">{checkWord[c.outcome]}</span>
            </p>
            <p className="check__detail">{c.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CopyField({ value, label, multiline = false }: { value: string; label: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="copy">
      <div className="copy__head">
        <span>{label}</span>
        <button className="btn btn--sm" onClick={copy}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {multiline ? <pre className="copy__value">{value}</pre> : <code className="copy__value">{value}</code>}
    </div>
  );
}
