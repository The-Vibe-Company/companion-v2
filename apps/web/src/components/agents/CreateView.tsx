"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentDetail, AgentModelRow } from "@companion/contracts";
import { Icon } from "../Icon";
import { createAgent } from "@/lib/agentQueries";
import type { SkillVM } from "@/lib/types";
import type { AgentsLibrary } from "./route";
import { deriveSecretRows, kebabName } from "./derive";

function contextHint(context: number | null): string | null {
  if (!context) return null;
  return `${Math.round(context / 1000)}k context`;
}

/** The create-agent form (design "Create agent" screen; the Model section is a searchable picker). */
export function CreateView({
  lib,
  models,
  registry,
  appOrigin,
  onBack,
  onCreated,
}: {
  lib: AgentsLibrary;
  models: AgentModelRow[];
  registry: SkillVM[];
  appOrigin: string;
  onBack: () => void;
  onCreated: (detail: AgentDetail) => void;
}) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState<string>(() => models[0]?.id ?? "");
  const [modelQ, setModelQ] = useState("");
  const [skillQ, setSkillQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous submit gate (StrictMode-safe: never gate the RPC on state set inside an updater).
  const submittingRef = useRef(false);
  const errorRef = useRef<HTMLPreElement>(null);

  const slug = kebabName(name);
  const canProvision = name.trim().length > 0 && selected.length > 0 && !!model && !busy;

  const modelRows = useMemo(() => {
    const q = modelQ.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.provider_name.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    );
  }, [models, modelQ]);

  const skillRows = useMemo(() => {
    const q = skillQ.trim().toLowerCase();
    if (!q) return registry;
    return registry.filter((s) => s.id.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [registry, skillQ]);

  const secretRows = useMemo(() => deriveSecretRows(selected, registry), [selected, registry]);

  const toggleSkill = (id: string) => {
    setSelected((list) => (list.includes(id) ? list.filter((s) => s !== id) : [...list, id]));
  };

  const provision = () => {
    if (!canProvision || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    const filledSecrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets)) {
      if (value) filledSecrets[key] = value;
    }
    createAgent({
      slug,
      scope: lib === "org" ? "org" : "personal",
      instructions,
      model,
      skills: selected.map((s) => ({ slug: s })),
      secrets: filledSecrets,
    })
      .then((detail) => {
        onCreated(detail);
      })
      .catch((e) => {
        submittingRef.current = false;
        setBusy(false);
        setError(e instanceof Error ? e.message : "Could not provision the agent.");
      });
  };

  // The form is taller than the viewport and Provision also lives in the top bar — bring a failure
  // into view once React has committed the errblock, so it is never silent.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [error]);

  const provisionHint = canProvision
    ? `Forks the golden snapshot and pushes ${selected.length} ${selected.length === 1 ? "skill." : "skills."}`
    : "Name the agent and pick at least one skill.";

  return (
    <div data-screen-label="Create agent" className="dpage">
      <div className="dtop">
        <nav className="crumb">
          <button type="button" className="crumb__btn" onClick={onBack}>
            <Icon name="arrow-left" size={12} />
            Agents
          </button>
          <span className="crumb__sep">/</span>
          <b>New agent</b>
        </nav>
        <span className="dtop__spacer" />
        <button type="button" className="btn-primary" onClick={provision} disabled={!canProvision}>
          Provision agent
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div
          style={{
            maxWidth: 680,
            margin: "0 auto",
            padding: "32px 40px 64px",
            display: "flex",
            flexDirection: "column",
            gap: 28,
          }}
        >
          <div>
            <div className="seclabel">Name</div>
            <input
              className="ag-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. monka-support"
              spellCheck={false}
              aria-label="Agent name"
            />
            <p style={{ margin: "7px 0 0", fontSize: "var(--text-xs)", color: "var(--color-faint)", maxWidth: "68ch" }}>
              Lowercase, dashes. Becomes the chat URL:{" "}
              <span className="mono">
                {appOrigin}/agents/{slug || "<name>"}/chat
              </span>
            </p>
          </div>

          <div>
            <div className="seclabel">Instructions</div>
            <textarea
              className="ag-textarea"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Markdown. What this agent is for, its tone, its boundaries."
              spellCheck={false}
              aria-label="Agent instructions"
            />
          </div>

          <div>
            <div className="seclabel">Model</div>
            <div style={{ border: "1px solid var(--color-line)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0 11px",
                  height: 38,
                  borderBottom: "1px solid var(--color-line)",
                }}
              >
                <Icon name="search" size={13} style={{ color: "var(--color-faint)" }} />
                <input
                  value={modelQ}
                  onChange={(e) => setModelQ(e.target.value)}
                  placeholder="Search models"
                  aria-label="Search models"
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    background: "none",
                    fontFamily: "var(--font-ui)",
                    fontSize: "var(--text-sm)",
                    color: "var(--color-fg)",
                  }}
                />
              </div>
              <div style={{ maxHeight: 264, overflowY: "auto" }} role="radiogroup" aria-label="Model">
                {modelRows.map((m) => {
                  const sel = model === m.id;
                  const hint = m.description ?? contextHint(m.context);
                  return (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => setModel(m.id)}
                      role="radio"
                      aria-checked={sel}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        textAlign: "left",
                        border: "none",
                        borderBottom: "1px solid color-mix(in oklab, var(--color-line) 55%, transparent)",
                        background: sel ? "var(--color-accent-tint)" : "transparent",
                        padding: "9px 11px",
                        cursor: "pointer",
                        fontFamily: "var(--font-ui)",
                      }}
                    >
                      <span className={"addfolder__check" + (sel ? " is-on" : "")}>
                        {sel && <Icon name="check" size={11} />}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--text-xs)",
                          fontWeight: 500,
                          color: "var(--color-fg)",
                          flex: "none",
                        }}
                      >
                        {m.id}
                      </span>
                      <span className="chip">{m.provider_name}</span>
                      {hint && (
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: "var(--text-xs)",
                            color: "var(--color-muted)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {hint}
                        </span>
                      )}
                    </button>
                  );
                })}
                {modelRows.length === 0 && (
                  <div className="alist--empty" style={{ border: "none" }}>
                    No models match.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div>
            <div className="seclabel">
              Skills <span className="seclabel__n">{selected.length} selected</span>
            </div>
            <div style={{ border: "1px solid var(--color-line)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0 11px",
                  height: 38,
                  borderBottom: "1px solid var(--color-line)",
                }}
              >
                <Icon name="search" size={13} style={{ color: "var(--color-faint)" }} />
                <input
                  value={skillQ}
                  onChange={(e) => setSkillQ(e.target.value)}
                  placeholder="Search the registry"
                  aria-label="Search the registry"
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    background: "none",
                    fontFamily: "var(--font-ui)",
                    fontSize: "var(--text-sm)",
                    color: "var(--color-fg)",
                  }}
                />
              </div>
              <div style={{ maxHeight: 264, overflowY: "auto" }}>
                {skillRows.map((s) => {
                  const sel = selected.includes(s.id);
                  const secretKeys = (s.requirements ?? []).map((r) => r.key);
                  return (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => toggleSkill(s.id)}
                      aria-pressed={sel}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        textAlign: "left",
                        border: "none",
                        borderBottom: "1px solid color-mix(in oklab, var(--color-line) 55%, transparent)",
                        background: sel ? "var(--color-accent-tint)" : "transparent",
                        padding: "9px 11px",
                        cursor: "pointer",
                        fontFamily: "var(--font-ui)",
                      }}
                    >
                      <span className={"addfolder__check" + (sel ? " is-on" : "")}>
                        {sel && <Icon name="check" size={11} />}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--text-xs)",
                          fontWeight: 500,
                          color: "var(--color-fg)",
                          flex: "none",
                        }}
                      >
                        {s.id}
                      </span>
                      <span className="chip">{s.version}</span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: "var(--text-xs)",
                          color: "var(--color-muted)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {s.description}
                      </span>
                      {secretKeys.length > 0 && (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            fontFamily: "var(--font-mono)",
                            fontSize: 10,
                            color: "var(--color-faint)",
                            flex: "none",
                          }}
                        >
                          <Icon name="key" size={11} />
                          {secretKeys.join(", ")}
                        </span>
                      )}
                    </button>
                  );
                })}
                {skillRows.length === 0 && (
                  <div className="alist--empty" style={{ border: "none" }}>
                    No skills match.
                  </div>
                )}
              </div>
            </div>
          </div>

          {secretRows.length > 0 && (
            <div>
              <div className="seclabel">
                Secrets <span className="seclabel__n">required by selected skills</span>
              </div>
              <div className="reqlist">
                {secretRows.map((row) => {
                  const value = secrets[row.key] ?? "";
                  return (
                    <div
                      className="req"
                      key={row.key}
                      style={{ border: "1px solid var(--color-line)", borderRadius: "var(--radius-md)", padding: "10px 12px", gap: 7 }}
                    >
                      <div className="req__head">
                        <span className="req__key mono" style={{ fontSize: "var(--text-xs)", fontWeight: 500 }}>
                          {row.key}
                        </span>
                        <span className="req__tag req__tag--secret">secret</span>
                        <span style={{ fontSize: 11, color: "var(--color-faint)" }}>
                          required by <span className="mono">{row.by.join(", ")}</span>
                        </span>
                        <span style={{ flex: 1 }} />
                        <span className={"ag-set " + (value ? "ag-set--ok" : "ag-set--warn")}>
                          {value ? "set" : "not set"}
                        </span>
                      </div>
                      <input
                        type="password"
                        value={value}
                        onChange={(e) => setSecrets((m) => ({ ...m, [row.key]: e.target.value }))}
                        placeholder="Paste value. Stored encrypted, never shown again."
                        aria-label={`Secret value for ${row.key}`}
                        style={{
                          width: "100%",
                          height: 30,
                          padding: "0 10px",
                          border: "1px solid var(--color-line)",
                          borderRadius: "var(--radius-sm)",
                          background: "var(--color-surface-sunken)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--text-xs)",
                          color: "var(--color-fg)",
                          outline: "none",
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {error && (
            <pre ref={errorRef} className="errblock" role="alert" style={{ margin: 0 }}>
              {error}
            </pre>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 12, borderTop: "1px solid var(--color-line)", paddingTop: 20 }}>
            <button type="button" className="btn-primary" onClick={provision} disabled={!canProvision}>
              Provision agent
            </button>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-faint)" }}>{provisionHint}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
