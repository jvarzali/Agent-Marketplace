"use client";

import Link from "next/link";
import { useState } from "react";
import { CopyField } from "@/components/bits";
import { TEMPLATES, type TemplateId } from "@/lib/policy";
import { useStore } from "@/lib/store";
import type { Agent, AgentClient } from "@/lib/types";

const CLIENTS: AgentClient[] = ["Claude", "ChatGPT", "Custom"];
const STEPS = ["Name it", "Pick starting rules", "Connect it"];

export function NewAgentView() {
  const store = useStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [client, setClient] = useState<AgentClient>("Claude");
  const [template, setTemplate] = useState<TemplateId>("approve_all");
  const [created, setCreated] = useState<{ agent: Agent; apiKey: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const mcpConfig = created
    ? JSON.stringify(
        {
          mcpServers: {
            agentmart: {
              command: "npx",
              args: ["-y", "@agentmart/mcp"],
              env: { AGENTMART_API_KEY: created.apiKey },
            },
          },
        },
        null,
        2,
      )
    : "";

  return (
    <div className="page page--narrow">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/agents">Agents</Link>
      </nav>
      <header className="pagetitle">
        <h1>Add an agent</h1>
      </header>

      <ol className="steps" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} className="steps__item" aria-current={i === step ? "step" : undefined} data-done={i < step || undefined}>
            <span className="steps__n">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <form
          className="ledger stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) setStep(1);
          }}
        >
          <label className="field">
            <span className="field__label">Name</span>
            <input
              className="input"
              autoFocus
              required
              maxLength={40}
              placeholder="Pantry Claude"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <span className="fine">Shown on approvals, so pick something you&rsquo;ll recognize at a glance.</span>
          </label>
          <fieldset className="fs fs--bare">
            <legend className="field__label">Which assistant is it?</legend>
            <div className="choice">
              {CLIENTS.map((c) => (
                <label key={c} className="radio">
                  <input type="radio" name="client" checked={client === c} onChange={() => setClient(c)} />
                  {c === "Custom" ? "My own agent" : c}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="stack__actions">
            <button type="submit" className="btn btn--primary" disabled={!name.trim()}>
              Continue
            </button>
          </div>
        </form>
      )}

      {step === 1 && (
        <div className="ledger stack">
          <div className="templates" role="radiogroup" aria-label="Starting rules">
            {TEMPLATES.map((t) => (
              <label key={t.id} className="template" data-selected={template === t.id || undefined}>
                <input
                  type="radio"
                  name="template"
                  className="sr"
                  checked={template === t.id}
                  onChange={() => setTemplate(t.id)}
                />
                <span className="template__name">{t.name}</span>
                <span className="template__blurb">{t.blurb}</span>
              </label>
            ))}
          </div>
          <p className="fine">You can change any rule later. New agents ask before every purchase until you say otherwise.</p>
          <div className="stack__actions">
            <button className="btn" onClick={() => setStep(0)}>
              Back
            </button>
            <button
              className="btn btn--primary"
              onClick={() => {
                setCreated(store.createAgent(name.trim(), client, template));
                setStep(2);
              }}
            >
              Create {name.trim()}
            </button>
          </div>
        </div>
      )}

      {step === 2 && created && (
        <div className="ledger stack">
          <div className="banner banner--hold">
            This key is shown once. AgentMart only keeps a scrambled copy, so if you lose it you&rsquo;ll need a new one.
          </div>
          <CopyField label="API key" value={created.apiKey} />

          {client === "Custom" ? (
            <>
              <p>Send the key as a bearer token to the REST API:</p>
              <CopyField
                label="Example request"
                multiline
                value={`curl https://api.agentmart.dev/v1/purchases \\\n  -H "Authorization: Bearer ${created.apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d @cart.json`}
              />
            </>
          ) : (
            <>
              <p>
                Add AgentMart as an MCP server in {client === "Claude" ? "Claude" : "your MCP-capable client"}, then
                restart it:
              </p>
              <CopyField label="MCP server config" value={mcpConfig} multiline />
            </>
          )}

          <p className="fine">
            The agent never sees your real card. For each approved purchase it gets a one-time card that only works
            for that exact cart, at that store, for 30 minutes.
          </p>

          <label className="check-row">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I&rsquo;ve copied the key somewhere safe</span>
          </label>
          <div className="stack__actions">
            {template === "custom" ? (
              <Link
                href={`/agents/${created.agent.id}/policy`}
                className="btn btn--primary"
                aria-disabled={!saved}
                onClick={(e) => !saved && e.preventDefault()}
              >
                Set rules
              </Link>
            ) : (
              <Link
                href={`/agents/${created.agent.id}`}
                className="btn btn--primary"
                aria-disabled={!saved}
                onClick={(e) => !saved && e.preventDefault()}
              >
                Go to {created.agent.name}
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
