"use client";

import { ArrowUpRight, Ban, Check, CircleCheck, Clock, Copy, Snowflake } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
      {/* Ago is for past events; the shared clock ticks every 15s, so a brand-new timestamp can sit just ahead of it. */}
      {relTime(Math.min(ts, now), now)}
    </time>
  );
}

export function Meter({
  label,
  used,
  limit,
  inline = false,
  bare = false,
  tone: toneOverride,
}: {
  label?: string;
  used: number;
  /** null = no limit set. */
  limit: number | null;
  inline?: boolean;
  /** Bar and percentage only, for tables that already show the amounts. */
  bare?: boolean;
  /** Fixed fill color instead of the usual green / amber / red by how full it is. */
  tone?: Tone | "neutral";
}) {
  const pct = limit === null ? 0 : limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
  const tone = toneOverride ?? (pct >= 90 ? "stop" : pct >= 70 ? "hold" : "good");
  if (limit === null) {
    return (
      <div className={`meter${inline ? " meter--inline" : ""}${bare ? " meter--bare" : ""}`}>
        <div className="meter__row">
          {label && <span>{label}</span>}
          <span className="num">
            {bare ? "No limit" : <>{money(used)} <span className="muted">no limit</span></>}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className={`meter${inline ? " meter--inline" : ""}${bare ? " meter--bare" : ""}`}>
      <div className="meter__row">
        {label && <span>{label}</span>}
        <span className="num">
          {bare ? (
            `${Math.round(pct)}%`
          ) : (
            <>
              {money(used)} <span className="muted">of {money(limit)}</span>
            </>
          )}
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

/** Counts up to a figure when it first appears; jumps straight there under reduced motion. */
export function CountUp({ value, format = money }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(start + (value - start) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className="num">{format(shown)}</span>;
}

/**
 * One figure in the KPI strip: label, big number, a line of context, and an optional bar.
 * With `href` the label becomes a link stretched over the whole tile. `tone` colors the rule
 * on top (neutral when unset) and the bar; `segments` splits the rule into one block per item.
 */
export function Kpi({
  label,
  value,
  format,
  note,
  tone,
  meter,
  href,
  segments,
}: {
  label: string;
  value: number;
  format?: (n: number) => string;
  note: React.ReactNode;
  tone?: Tone;
  meter?: { used: number; limit: number };
  href?: string;
  segments?: Tone[];
}) {
  const cls = `kpi${tone ? ` kpi--${tone}` : ""}${href ? " kpi--link" : ""}${segments ? " kpi--segmented" : ""}`;
  return (
    <div className={cls}>
      <dt className="kpi__label">
        {segments && (
          <span className="kpi__segs" aria-hidden="true">
            {segments.map((t, i) => (
              <span key={i} className={`kpi__seg kpi__seg--${t}`} />
            ))}
          </span>
        )}
        {href ? (
          <Link href={href} className="kpi__link">
            {label}
            <ArrowUpRight size={16} className="kpi__go" aria-hidden="true" />
          </Link>
        ) : (
          label
        )}
      </dt>
      <dd className="kpi__value">
        <CountUp value={value} format={format} />
      </dd>
      <dd className="kpi__note">{note}</dd>
      {meter && (
        <dd className="kpi__meter">
          <Meter used={meter.used} limit={meter.limit} bare tone={tone ?? "neutral"} />
        </dd>
      )}
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
    <span className="trust" aria-label={`Trust level ${level} of 5`} title={level ? `Trust level ${level} of 5` : "New: no clean purchases yet"}>
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
