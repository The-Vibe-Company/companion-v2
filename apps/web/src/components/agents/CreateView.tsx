"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentDetail, AgentModelRow, AgentModelsResponse } from "@companion/contracts";
import { Icon } from "../Icon";
import { createAgent, setProviderConnection } from "@/lib/agentQueries";
import type { SkillVM } from "@/lib/types";
import type { AgentsLibrary } from "./route";
import {
  deriveSecretRows,
  filterModelGroups,
  firstConnectedModel,
  groupModelsByProvider,
  kebabName,
  modelProviderConnected,
  toModelProviders,
  type ModelGroupVM,
} from "./derive";

function contextHint(context: number | null): string | null {
  if (!context) return null;
  return `${Math.round(context / 1000)}k context`;
}

/** One provider header + its models. Connect reveals an inline key input; connected models are radios. */
function ProviderGroup({
  group,
  model,
  onSelectModel,
  onConnected,
}: {
  group: ModelGroupVM;
  model: string;
  onSelectModel: (id: string) => void;
  onConnected: (providerId: string) => void;
}) {
  const { provider } = group;
  const [connecting, setConnecting] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const savingRef = useRef(false);
  const canConnect = provider.envKeys.length > 0;

  const save = () => {
    if (savingRef.current || !key.trim() || !canConnect) return;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    setProviderConnection({ provider: provider.id, key_name: provider.envKeys[0]!, key: key.trim() })
      .then(() => {
        onConnected(provider.id);
        setConnecting(false);
        setKey("");
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Could not save the key.");
      })
      .finally(() => {
        savingRef.current = false;
        setBusy(false);
      });
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 6px 0 0",
          background: "var(--color-surface-sunken)",
          borderBottom: "1px solid var(--color-line)",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${provider.name}` : `Expand ${provider.name}`}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 11px",
            border: "none",
            background: "none",
            cursor: "pointer",
            fontFamily: "var(--font-ui)",
            color: "var(--color-fg)",
          }}
        >
          <Icon
            name={expanded ? "chevron-down" : "chevron-right"}
            size={12}
            style={{ color: "var(--color-faint)", flex: "none" }}
          />
          <span style={{ fontSize: "var(--text-xs)", fontWeight: 600 }}>{provider.name}</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--color-faint)" }}>
            {group.models.length}
          </span>
        </button>
        {provider.connected ? (
          <span
            className="mono"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--color-ok)" }}
          >
            <Icon name="check" size={11} />
            connected
          </span>
        ) : connecting ? null : (
          <button
            type="button"
            onClick={() => {
              setConnecting(true);
              setExpanded(true);
            }}
            disabled={!canConnect}
            title={canConnect ? undefined : "This provider's key name is unknown."}
            style={{
              height: 24,
              padding: "0 10px",
              border: "1px solid var(--color-line)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface)",
              color: "var(--color-fg)",
              fontFamily: "var(--font-ui)",
              fontSize: "var(--text-xs)",
              fontWeight: 500,
              cursor: canConnect ? "pointer" : "default",
              opacity: canConnect ? 1 : 0.55,
            }}
          >
            Connect
          </button>
        )}
      </div>

      {expanded && (
        <>
          {!provider.connected && connecting && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "9px 11px",
                borderBottom: "1px solid var(--color-line)",
                background: "var(--color-surface-sunken)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={`Paste your ${provider.name} API key (${provider.envKeys[0]})`}
                  aria-label={`API key for ${provider.name}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      save();
                    }
                  }}
                  style={{
                    flex: 1,
                    height: 30,
                    padding: "0 10px",
                    border: "1px solid var(--color-line)",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--color-surface)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    color: "var(--color-fg)",
                    outline: "none",
                  }}
                />
                <button type="button" className="ag-btn" onClick={save} disabled={busy || !key.trim()} style={{ height: 30 }}>
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
              {error && (
                <pre className="errblock" role="alert" style={{ margin: 0 }}>
                  {error}
                </pre>
              )}
            </div>
          )}

          {group.models.map((m: AgentModelRow) => {
            const sel = model === m.id;
            const hint = m.description ?? contextHint(m.context);
            const disabled = !provider.connected;
            return (
              <button
                type="button"
                key={m.id}
                onClick={() => !disabled && onSelectModel(m.id)}
                role="radio"
                aria-checked={sel}
                aria-disabled={disabled}
                disabled={disabled}
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
                  cursor: disabled ? "default" : "pointer",
                  opacity: disabled ? 0.5 : 1,
                  fontFamily: "var(--font-ui)",
                }}
              >
                <span className={"addfolder__check" + (sel ? " is-on" : "")}>{sel && <Icon name="check" size={11} />}</span>
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
                {disabled ? (
                  <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-xs)", color: "var(--color-faint)" }}>
                    connect {provider.name} to use
                  </span>
                ) : (
                  hint && (
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
                  )
                )}
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

/** The create-agent form (design "Create agent" screen; the Model section groups models by provider). */
export function CreateView({
  lib,
  models,
  registry,
  appOrigin,
  workspaceSlug,
  onBack,
  onCreated,
}: {
  lib: AgentsLibrary;
  /** The full models response — models + per-user provider connection state. */
  models: AgentModelsResponse;
  registry: SkillVM[];
  appOrigin: string;
  workspaceSlug: string;
  onBack: () => void;
  onCreated: (detail: AgentDetail) => void;
}) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [modelQ, setModelQ] = useState("");
  const [skillQ, setSkillQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Providers connected during this session (after a successful inline Connect) — local override so
  // the models enable immediately without re-fetching the catalog.
  const [connectedNow, setConnectedNow] = useState<Set<string>>(() => new Set());
  // Synchronous submit gate (StrictMode-safe: never gate the RPC on state set inside an updater).
  const submittingRef = useRef(false);
  const errorRef = useRef<HTMLPreElement>(null);

  const providers = useMemo(() => toModelProviders(models), [models]);
  const groups = useMemo(
    () => groupModelsByProvider(models.models, providers, connectedNow),
    [models.models, providers, connectedNow],
  );
  const visibleGroups = useMemo(() => filterModelGroups(groups, modelQ), [groups, modelQ]);

  // The selected model. Preselect the first connected provider's first model; keep it valid as
  // providers connect. Never auto-select a disabled (unconnected) model.
  const [model, setModel] = useState<string>(() => firstConnectedModel(groups) ?? "");
  useEffect(() => {
    if (model && modelProviderConnected(groups, model)) return;
    const next = firstConnectedModel(groups);
    if (next !== model) setModel(next ?? "");
  }, [groups, model]);

  const slug = kebabName(name);
  const modelConnected = model ? modelProviderConnected(groups, model) : false;

  // An ORG-scoped agent can only carry ORG skills — a personal skill would not be readable by other
  // members. A personal (mine) agent keeps the full pickable set (org + own personal authored).
  const pickable = useMemo(
    () => (lib === "org" ? registry.filter((s) => s.scope === "org") : registry),
    [lib, registry],
  );

  // Secrets are ONLY the skill-required env vars now; the provider key comes from the saved
  // connection (the backend copies it at create).
  const secretRows = useMemo(() => deriveSecretRows(selected, pickable), [selected, pickable]);

  const canProvision =
    kebabName(name).length > 0 && selected.length > 0 && !!model && modelConnected && !busy;

  const skillRows = useMemo(() => {
    const q = skillQ.trim().toLowerCase();
    if (!q) return pickable;
    return pickable.filter((s) => s.id.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [pickable, skillQ]);

  const toggleSkill = (id: string) => {
    setSelected((list) => (list.includes(id) ? list.filter((s) => s !== id) : [...list, id]));
  };

  const provision = () => {
    if (!canProvision || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    // Only submit the values whose key is in the CURRENT secret rows — a deselected skill's secret
    // must not be sent along.
    const wantedKeys = new Set(secretRows.map((row) => row.key));
    const filledSecrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets)) {
      if (value && wantedKeys.has(key)) filledSecrets[key] = value;
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

  const anyConnected = groups.some((g) => g.provider.connected);
  const provisionHint = canProvision
    ? `Forks the golden snapshot and pushes ${selected.length} ${selected.length === 1 ? "skill." : "skills."}`
    : !anyConnected || !modelConnected
      ? "Connect a model provider and pick its model."
      : kebabName(name).length === 0 || selected.length === 0
        ? "Name the agent and pick at least one skill."
        : "";

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
                {appOrigin}/w/{workspaceSlug}/agents/{slug || "<name>"}/chat
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
              <div style={{ maxHeight: 300, overflowY: "auto" }} role="radiogroup" aria-label="Model">
                {visibleGroups.map((group) => (
                  <ProviderGroup
                    key={group.provider.id}
                    group={group}
                    model={model}
                    onSelectModel={setModel}
                    onConnected={(providerId) =>
                      setConnectedNow((prev) => {
                        const next = new Set(prev);
                        next.add(providerId);
                        return next;
                      })
                    }
                  />
                ))}
                {visibleGroups.length === 0 && (
                  <div className="alist--empty" style={{ border: "none" }}>
                    No models match.
                  </div>
                )}
              </div>
            </div>
            {!anyConnected && (
              <p style={{ margin: "7px 0 0", fontSize: "var(--text-xs)", color: "var(--color-faint)" }}>
                Connect at least one model provider to pick a model.
              </p>
            )}
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
                Secrets <span className="seclabel__n">what the selected skills require</span>
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
