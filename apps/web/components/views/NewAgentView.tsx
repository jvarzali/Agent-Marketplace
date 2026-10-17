"use client";

import Link from "next/link";
import { useState } from "react";
import { CopyField } from "@/components/bits";
import { clientLabel } from "@/lib/format";
import { TEMPLATES, type TemplateId } from "@/lib/policy";
import { useStore } from "@/lib/store";
import type { AgentClient } from "@/lib/types";

const CLIENTS: AgentClient[] = ["claude", "chatgpt", "custom"];
const STEPS = ["Name it", "Pick starting rules", "Connect it"];

export function NewAgentView() {
  const store = useStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [client, setClient] = useState<AgentClient>("claude");
  const [template, setTemplate] = useState<TemplateId>("approve_everything");
  const [created, setCreated] = useState<{ agentId: string; apiKey: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [saved, setSaved] = useState(false);

  // Only read once the agent exists, which is always after hydration.
  const origin = created ? window.location.origin : "";
  const mcpUrl = `${origin}/api/mcp`;
  const mcpConfig = created
    ? JSON.stringify(
        {
          mcpServers: {
            agentmart: {
              type: "http",
              url: mcpUrl,
              headers: { Authorization: `Bearer ${created.apiKey}` },
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
                  {c === "custom" ? "My own agent" : clientLabel[c]}
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
              disabled={creating}
              onClick={async () => {
                setCreating(true);
                const res = await store.createAgent(name.trim(), client, template);
                setCreating(false);
                if (res) {
                  setCreated(res);
                  setStep(2);
                }
              }}
            >
              {creating ? "Creating…" : `Create ${name.trim()}`}
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

          {client === "custom" ? (
            <>
              <p>Send the key as a bearer token to the REST API. Start by reading the rules, then submit a cart:</p>
              <CopyField
                label="Example requests"
                multiline
                value={`curl ${origin}/api/v1/agent/policy \\\n  -H "Authorization: Bearer ${created.apiKey}"\n\ncurl ${origin}/api/v1/purchases \\\n  -H "Authorization: Bearer ${created.apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d @cart.json`}
              />
              <p className="fine">It can also connect over MCP at {mcpUrl} with the same bearer token.</p>
            </>
          ) : client === "claude" ? (
            <>
              <p>In Claude Code, run:</p>
              <CopyField
                label="Claude Code"
                multiline
                value={`claude mcp add --transport http agentmart ${mcpUrl} \\\n  --header "Authorization: Bearer ${created.apiKey}"`}
              />
              <p>For Claude Desktop or another client that takes a JSON config, add this and restart it:</p>
              <CopyField label="MCP server config" value={mcpConfig} multiline />
            </>
          ) : (
            <>
              <p>
                Add AgentMart as a remote MCP server at <code>{mcpUrl}</code>, sending the key as a bearer token. In a
                client that takes a JSON config:
              </p>
              <CopyField label="MCP server config" value={mcpConfig} multiline />
              <p className="fine">If your client can&rsquo;t send an Authorization header, use the REST API with the same key.</p>
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
                href={`/agents/${created.agentId}/policy`}
                className="btn btn--primary"
                aria-disabled={!saved}
                onClick={(e) => !saved && e.preventDefault()}
              >
                Set rules
              </Link>
            ) : (
              <Link
                href={`/agents/${created.agentId}`}
                className="btn btn--primary"
                aria-disabled={!saved}
                onClick={(e) => !saved && e.preventDefault()}
              >
                Go to {name.trim()}
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
