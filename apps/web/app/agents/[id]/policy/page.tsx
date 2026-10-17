"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { categoryLabel } from "@/lib/format";
import { ALWAYS_BLOCKED, SELECTABLE_CATEGORIES, TIMEZONES, describePolicy, policyWarnings } from "@/lib/policy";
import { useStore } from "@/lib/store";
import type { Category, Policy } from "@/lib/types";

const LIMIT_FIELDS: { key: keyof Policy["limits"]; label: string; money: boolean }[] = [
  { key: "per_order_total", label: "Per order, with tax and shipping", money: true },
  { key: "per_day", label: "Per day", money: true },
  { key: "per_week", label: "Per week", money: true },
  { key: "per_month", label: "Per month", money: true },
  { key: "max_orders_per_day", label: "Orders per day", money: false },
  { key: "max_quantity_per_item", label: "Quantity of any one item", money: false },
];

export default function PolicyEditor() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const store = useStore();
  const agent = store.agent(id);
  const [p, setP] = useState<Policy | null>(agent ? structuredClone(agent.policy) : null);
  const [domainDraft, setDomainDraft] = useState("");

  if (!agent || !p) {
    return (
      <div className="page">
        <div className="empty">
          <p>This agent doesn&rsquo;t exist or was removed.</p>
          <Link href="/agents" className="textlink">
            Back to agents
          </Link>
        </div>
      </div>
    );
  }

  const warnings = policyWarnings(p);
  const dirty = JSON.stringify(p) !== JSON.stringify(agent.policy);
  const set = (fn: (d: Policy) => void) =>
    setP((cur) => {
      if (!cur) return cur;
      const next = structuredClone(cur);
      fn(next);
      return next;
    });

  const addDomain = () => {
    const d = domainDraft
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
    if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return;
    set((x) => {
      if (!x.merchants.allow_domains.includes(d)) x.merchants.allow_domains.push(d);
    });
    setDomainDraft("");
  };

  const toggleCat = (c: Category, list: "allow" | "deny") =>
    set((x) => {
      const other = list === "allow" ? "deny" : "allow";
      const arr = x.categories[list];
      x.categories[list] = arr.includes(c) ? arr.filter((v) => v !== c) : [...arr, c];
      x.categories[other] = x.categories[other].filter((v) => v !== c);
    });

  const [from, to] = (p.schedule.allowed_hours ?? "08:00-22:00").split("-");

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/agents">Agents</Link> <span aria-hidden="true">/</span>{" "}
        <Link href={`/agents/${agent.id}`}>{agent.name}</Link>
      </nav>
      <header className="pagehead">
        <h1>Rules for {agent.name}</h1>
        <p className="muted">Changes apply to the next purchase request. Requests already approved keep their card.</p>
      </header>

      <form
        className="editor"
        onSubmit={(e) => {
          e.preventDefault();
          store.savePolicy(agent.id, p);
          router.push(`/agents/${agent.id}`);
        }}
      >
        <div className="editor__form">
          <fieldset className="fs">
            <legend>Where it can shop</legend>
            <div className="choice">
              <label className="radio">
                <input
                  type="radio"
                  name="mode"
                  checked={p.merchants.mode === "allowlist"}
                  onChange={() => set((x) => void (x.merchants.mode = "allowlist"))}
                />
                Only stores I list
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="mode"
                  checked={p.merchants.mode === "any"}
                  onChange={() => set((x) => void (x.merchants.mode = "any"))}
                />
                Any store
              </label>
            </div>
            {p.merchants.mode === "allowlist" && (
              <>
                <ul className="chips" aria-label="Allowed stores">
                  {p.merchants.allow_domains.map((d) => (
                    <li key={d} className="chip">
                      {d}
                      <button
                        type="button"
                        className="chip__x"
                        aria-label={`Remove ${d}`}
                        onClick={() => set((x) => void (x.merchants.allow_domains = x.merchants.allow_domains.filter((v) => v !== d)))}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="addrow">
                  <label className="sr" htmlFor="domain">
                    Store website
                  </label>
                  <input
                    id="domain"
                    className="input"
                    placeholder="walmart.com"
                    value={domainDraft}
                    onChange={(e) => setDomainDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDomain();
                      }
                    }}
                  />
                  <button type="button" className="btn" onClick={addDomain}>
                    Add store
                  </button>
                </div>
              </>
            )}
            <p className="fine">Gambling, money transfer and crypto merchants are always blocked.</p>
          </fieldset>

          <fieldset className="fs">
            <legend>What it can buy</legend>
            <p className="fine">Pick what&rsquo;s allowed. Leave all unpicked to allow anything that isn&rsquo;t blocked.</p>
            <div className="cats">
              {SELECTABLE_CATEGORIES.map((c) => {
                const allowed = p.categories.allow.includes(c);
                const denied = p.categories.deny.includes(c);
                return (
                  <div key={c} className="cat">
                    <span className="cat__name">{categoryLabel[c]}</span>
                    <div className="seg" role="group" aria-label={categoryLabel[c]}>
                      <button
                        type="button"
                        className="seg__btn"
                        aria-pressed={allowed}
                        onClick={() => toggleCat(c, "allow")}
                      >
                        Allow
                      </button>
                      <button
                        type="button"
                        className="seg__btn seg__btn--stop"
                        aria-pressed={denied}
                        onClick={() => toggleCat(c, "deny")}
                      >
                        Block
                      </button>
                    </div>
                  </div>
                );
              })}
              {ALWAYS_BLOCKED.map((c) => (
                <div key={c} className="cat cat--locked">
                  <span className="cat__name">{categoryLabel[c]}</span>
                  <span className="fine">Always blocked</span>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset className="fs">
            <legend>How much it can spend</legend>
            <div className="limits">
              {LIMIT_FIELDS.map((f) => (
                <label key={f.key} className="field">
                  <span className="field__label">{f.label}</span>
                  <span className={f.money ? "field__money" : undefined}>
                    <input
                      className="input num"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={f.money ? 1 : 1}
                      value={p.limits[f.key]}
                      onChange={(e) => set((x) => void (x.limits[f.key] = Number(e.target.value)))}
                    />
                  </span>
                </label>
              ))}
            </div>
            <p className="fine">Budgets count requests still waiting on you, so an agent can&rsquo;t stack requests past them.</p>
          </fieldset>

          <fieldset className="fs">
            <legend>When it asks you first</legend>
            <label className="check-row">
              <input
                type="checkbox"
                checked={p.approval.always}
                onChange={(e) => set((x) => void (x.approval.always = e.target.checked))}
              />
              <span>
                Every purchase
                <span className="fine block">Recommended until you&rsquo;ve seen this agent shop.</span>
              </span>
            </label>
            {!p.approval.always && (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={p.approval.require_if_total_over !== null}
                    onChange={(e) => set((x) => void (x.approval.require_if_total_over = e.target.checked ? 30 : null))}
                  />
                  <span className="check-row__inline">
                    Orders over
                    <span className="field__money">
                      <input
                        className="input input--short num"
                        type="number"
                        min={0}
                        aria-label="Ask-first amount"
                        disabled={p.approval.require_if_total_over === null}
                        value={p.approval.require_if_total_over ?? ""}
                        onChange={(e) => set((x) => void (x.approval.require_if_total_over = Number(e.target.value)))}
                      />
                    </span>
                  </span>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={p.approval.require_for_new_merchant}
                    onChange={(e) => set((x) => void (x.approval.require_for_new_merchant = e.target.checked))}
                  />
                  <span>A store it hasn&rsquo;t bought from before</span>
                </label>
                <label className="check-row check-row--locked">
                  <input type="checkbox" checked disabled />
                  <span>
                    It isn&rsquo;t sure what an item is
                    <span className="fine block">Always on. Unclear items never go through without you.</span>
                  </span>
                </label>
              </>
            )}
          </fieldset>

          <fieldset className="fs">
            <legend>When it can shop</legend>
            <label className="check-row">
              <input
                type="checkbox"
                checked={p.schedule.allowed_hours === null}
                onChange={(e) => set((x) => void (x.schedule.allowed_hours = e.target.checked ? null : "08:00-22:00"))}
              />
              <span>Any time of day</span>
            </label>
            {p.schedule.allowed_hours !== null && (
              <div className="hours">
                <label className="field">
                  <span className="field__label">From</span>
                  <input
                    className="input"
                    type="time"
                    value={from}
                    onChange={(e) => set((x) => void (x.schedule.allowed_hours = `${e.target.value}-${to}`))}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Until</span>
                  <input
                    className="input"
                    type="time"
                    value={to}
                    onChange={(e) => set((x) => void (x.schedule.allowed_hours = `${from}-${e.target.value}`))}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Time zone</span>
                  <select
                    className="input"
                    value={p.schedule.timezone}
                    onChange={(e) => set((x) => void (x.schedule.timezone = e.target.value))}
                  >
                    {TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </fieldset>
        </div>

        <aside className="editor__summary" aria-label="Summary">
          <div className="sticky">
            <h2 className="panel__title">In plain English</h2>
            <ul className="summary">
              {describePolicy(p).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
            {warnings.length > 0 && (
              <ul className="warnings" role="alert">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <div className="editor__actions">
              <Link href={`/agents/${agent.id}`} className="btn">
                Cancel
              </Link>
              <button type="submit" className="btn btn--primary" disabled={!dirty}>
                Save as version {agent.policy.version + 1}
              </button>
            </div>
          </div>
        </aside>
      </form>
    </div>
  );
}
