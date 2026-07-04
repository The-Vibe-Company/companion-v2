"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentModelsResponse } from "@companion/contracts";
import { Icon } from "../Icon";
import type { AgentSecretVM, AgentVM } from "@/lib/types";
import { groupModelsByProvider, statusBadge, toModelProviders, validateSecretKey } from "./derive";
import { provisionErrorText } from "./ProvisioningCard";

/** Editable instructions + model for a created agent. Saving re-pushes config and relaunches serve. */
function ConfigEditor({
  agent,
  models,
  onUpdate,
}: {
  agent: AgentVM;
  models: AgentModelsResponse;
  onUpdate: (patch: { model?: string; instructions?: string }) => Promise<void>;
}) {
  const [instructions, setInstructions] = useState(agent.instructions);
  const [model, setModel] = useState(agent.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  // Sync local state if the agent prop changes underneath (e.g. after a save refetch).
  useEffect(() => {
    setInstructions(agent.instructions);
    setModel(agent.model);
  }, [agent.instructions, agent.model]);

  // Only connected providers' models are pickable; keep the current model selectable regardless.
  const groups = useMemo(
    () => groupModelsByProvider(models.models, toModelProviders(models)).filter((g) => g.provider.connected),
    [models],
  );
  const hasCurrent = groups.some((g) => g.models.some((m) => m.id === agent.model));
  const dirty = instructions !== agent.instructions || model !== agent.model;

  const save = () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    setApplied(false);
    const patch: { model?: string; instructions?: string } = {};
    if (model !== agent.model) patch.model = model;
    if (instructions !== agent.instructions) patch.instructions = instructions;
    onUpdate(patch)
      .then(() => setApplied(true))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not save the changes."))
      .finally(() => setBusy(false));
  };

  return (
    <section>
      <div className="seclabel">Instructions &amp; model</div>
      <textarea
        className="ag-textarea"
        value={instructions}
        onChange={(e) => {
          setInstructions(e.target.value);
          setApplied(false);
        }}
        placeholder="How this agent should behave…"
        aria-label="Instructions"
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <select
          className="ag-field"
          style={{ maxWidth: 320 }}
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setApplied(false);
          }}
          aria-label="Model"
        >
          {!hasCurrent && <option value={agent.model}>{agent.model}</option>}
          {groups.map((g) => (
            <optgroup key={g.provider.id} label={g.provider.name}>
              {g.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn-primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "Applying…" : "Save changes"}
        </button>
      </div>
      <div className="ag-note" style={{ marginTop: 6 }}>
        Connect more providers in Settings → Model providers to unlock their models.
      </div>
      {applied && (
        <div className="ag-note" style={{ marginTop: 4, color: "var(--color-ok)" }}>
          Saved — the agent restarts to apply. Active chat sessions are interrupted.
        </div>
      )}
      {error && (
        <div className="ag-note" style={{ marginTop: 4, color: "var(--color-danger)" }} role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

/** One installed-skill row: version chip, outdated hint, and the push affordance. */
function SkillRow({
  agent,
  skill,
  onPush,
}: {
  agent: AgentVM;
  skill: AgentVM["skills"][number];
  onPush: (skillSlug: string) => void;
}) {
  const op = agent.pendingOp;
  const pushing =
    op?.kind === "skill-push" && op.skill_slug === skill.id && (op.phase === "pushing" || op.phase === "restarting");
  return (
    <div className="arow" style={{ flexWrap: "wrap" }}>
      <Icon name="package" size={13} style={{ color: "var(--color-faint)" }} />
      <span className="arow__name" style={{ flex: "none" }}>
        {skill.id}
      </span>
      <span className="chip">{skill.version}</span>
      {skill.outdated && skill.latest && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--color-warn)",
            whiteSpace: "nowrap",
          }}
        >
          {skill.latest} available
        </span>
      )}
      <span style={{ flex: 1 }} />
      {pushing ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--color-muted)",
          }}
        >
          <Icon name="loader" size={12} className="ls-spin" />
          pushing
        </span>
      ) : skill.outdated && skill.latest ? (
        <button
          type="button"
          onClick={() => onPush(skill.id)}
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
            cursor: "pointer",
            whiteSpace: "nowrap",
            flex: "none",
          }}
        >
          Push {skill.latest}
        </button>
      ) : (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-faint)" }}>current</span>
      )}
    </div>
  );
}

const secretInputStyle: React.CSSProperties = {
  flex: 1,
  height: 30,
  padding: "0 10px",
  border: "1px solid var(--color-line)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface-sunken)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-fg)",
  outline: "none",
};

/** One agent variable row: set → Replace + Remove; not set → inline value input + Save. */
function SecretRow({
  secret,
  busy,
  onSet,
  onRemove,
}: {
  secret: AgentSecretVM;
  busy: boolean;
  onSet: (key: string, value: string) => void;
  onRemove: (key: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const submittedRef = useRef(false);
  const prevBusyRef = useRef(busy);

  // A save we submitted collapses the editor + clears the value once the RPC round-trip completes
  // (the section-level busy flag falls back to false). Errors surface at the section level.
  useEffect(() => {
    if (prevBusyRef.current && !busy && submittedRef.current) {
      submittedRef.current = false;
      setEditing(false);
      setValue("");
    }
    prevBusyRef.current = busy;
  }, [busy]);

  const save = () => {
    if (!value.trim() || busy) return;
    submittedRef.current = true;
    onSet(secret.key, value);
  };
  const showInput = editing || !secret.set;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 7,
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-md)",
        padding: "9px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <Icon name={secret.kind === "env" ? "settings" : "key"} size={12} style={{ color: "var(--color-faint)" }} />
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--color-fg)", fontWeight: secret.note ? 500 : 400 }} className={secret.note ? undefined : "mono"}>
            {secret.note ?? secret.key}
          </span>
          {secret.note && (
            <span className="mono" style={{ fontSize: 10, color: "var(--color-faint)" }}>
              {secret.key}
            </span>
          )}
        </span>
        {secret.requiredBy.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--color-faint)" }}>
            for <span className="mono">{secret.requiredBy.join(", ")}</span>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className={"ag-set " + (secret.set ? "ag-set--ok" : "ag-set--danger")}>
          {secret.set ? "set" : "not set"}
        </span>
        {secret.set && (
          <>
            <button
              type="button"
              className="ag-btn"
              style={{ height: 24, padding: "0 9px", fontSize: "var(--text-xs)" }}
              onClick={() => setEditing((e) => !e)}
              disabled={busy}
            >
              Replace
            </button>
            <button
              type="button"
              className="ag-btn"
              style={{ height: 24, padding: "0 9px", fontSize: "var(--text-xs)", color: "var(--color-danger)" }}
              onClick={() => onRemove(secret.key)}
              disabled={busy}
              aria-label={`Remove ${secret.key}`}
            >
              Remove
            </button>
          </>
        )}
      </div>
      {showInput && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type={secret.kind === "env" ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={secret.kind === "env" ? "Enter a value." : "Paste value. Stored encrypted, never shown again."}
            aria-label={`Value for ${secret.key}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            style={secretInputStyle}
          />
          <button type="button" className="ag-btn" style={{ height: 30 }} onClick={save} disabled={busy || !value.trim()}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

/** "Add variable" affordance: a validated name + value, submitted as a new agent secret. */
function AddVariable({
  existingKeys,
  busy,
  onAdd,
}: {
  existingKeys: string[];
  busy: boolean;
  onAdd: (key: string, value: string) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    if (busy) return;
    const keyError = validateSecretKey(key, existingKeys);
    if (keyError) {
      setError(keyError);
      return;
    }
    if (!value.trim()) {
      setError("Enter a value.");
      return;
    }
    setError(null);
    onAdd(key.trim(), value);
    setKey("");
    setValue("");
  };

  // Collapse the error once the list length changes (the add landed).
  useEffect(() => {
    setError(null);
  }, [existingKeys.length]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 7,
        border: "1px dashed var(--color-line-strong)",
        borderRadius: "var(--radius-md)",
        padding: "9px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="VARIABLE_NAME"
          spellCheck={false}
          aria-label="New variable name"
          style={{ ...secretInputStyle, flex: "1 1 180px", textTransform: "none" }}
        />
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          aria-label="New variable value"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          style={{ ...secretInputStyle, flex: "1 1 180px" }}
        />
        <button type="button" className="ag-btn" style={{ height: 30 }} onClick={add} disabled={busy}>
          Add
        </button>
      </div>
      {error && (
        <span style={{ fontSize: 11, color: "var(--color-danger)" }} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** The agent detail screen: header actions, content sections, and the Properties rail. */
export function DetailView({
  agent,
  chatUrl,
  models,
  onBack,
  onOpenChat,
  onOpenSession,
  onPauseWake,
  onRetry,
  onPushSkill,
  onSetSecrets,
  onUpdate,
  onDestroy,
}: {
  agent: AgentVM;
  chatUrl: string;
  models: AgentModelsResponse;
  onBack: () => void;
  onOpenChat: () => void;
  onOpenSession: (sessionId: string) => void;
  onPauseWake: () => void;
  onRetry: () => void;
  onPushSkill: (skillSlug: string) => void;
  /** Add/replace/remove agent variables; `null` deletes a key. Returns whether the agent restarts. */
  onSetSecrets: (secrets: Record<string, string | null>) => Promise<{ restarting: boolean }>;
  /** Edit the agent's model and/or instructions; re-pushes config + relaunches serve. */
  onUpdate: (patch: { model?: string; instructions?: string }) => Promise<void>;
  onDestroy: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [destroyVal, setDestroyVal] = useState("");
  const [secretsApplying, setSecretsApplying] = useState(false);
  const [secretsRestarting, setSecretsRestarting] = useState(false);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const secretsBusyRef = useRef(false);

  const applySecrets = (patch: Record<string, string | null>) => {
    if (secretsBusyRef.current) return;
    secretsBusyRef.current = true;
    setSecretsApplying(true);
    setSecretsError(null);
    onSetSecrets(patch)
      .then((res) => {
        setSecretsRestarting(res.restarting);
      })
      .catch((e) => {
        setSecretsError(e instanceof Error ? e.message : "Could not update the variables.");
      })
      .finally(() => {
        secretsBusyRef.current = false;
        setSecretsApplying(false);
      });
  };

  useEffect(() => {
    setDestroyVal("");
    setCopied(false);
    setSecretsRestarting(false);
    setSecretsError(null);
  }, [agent.id]);
  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const copyUrl = () => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(chatUrl).catch(() => {});
    }
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1600);
  };

  const canPause = agent.status === "running" || agent.status === "sleeping";
  const provisionError = agent.status === "error" ? agent.provision?.error ?? null : null;
  const destroyDisabled = destroyVal.trim() !== agent.id;

  return (
    <div data-screen-label="Agent detail" className="dpage">
      <div className="dtop">
        <nav className="crumb">
          <button type="button" className="crumb__btn" onClick={onBack}>
            <Icon name="arrow-left" size={12} />
            Agents
          </button>
          <span className="crumb__sep">/</span>
          <b>{agent.id}</b>
        </nav>
        <span className="dtop__spacer" />
        {canPause && (
          <button type="button" className="ag-btn" onClick={onPauseWake}>
            {agent.status === "running" ? "Pause" : "Wake"}
          </button>
        )}
        <button type="button" className="btn-primary" onClick={onOpenChat}>
          <Icon name="message-square" size={14} />
          Open chat
        </button>
      </div>
      <div className="dbody">
        <div className="dcontent">
          <div className="dcontent__inner">
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <h1 className="dtitle">{agent.id}</h1>
              <span className={`ls-badge ${statusBadge(agent.status)}`}>
                <span className="ls-badge__dot" />
                {agent.status}
              </span>
            </div>
            <p className="ddesc">{agent.description}</p>

            <div className="dblocks">
              {provisionError && (
                <section>
                  <div className="seclabel" style={{ color: "var(--color-danger)" }}>
                    Setup failed
                  </div>
                  <pre className="errblock" style={{ margin: 0 }}>
                    {provisionErrorText(provisionError)}
                  </pre>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                    <button type="button" className="btn-primary" onClick={onRetry}>
                      Try again
                    </button>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--color-faint)" }}>
                      Fix the cause above first, or the retry fails the same way.
                    </span>
                  </div>
                </section>
              )}

              <section>
                <div className="seclabel">Chat URL</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    className="code"
                    style={{
                      flex: 1,
                      padding: "8px 11px",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: "var(--color-fg)",
                    }}
                  >
                    {chatUrl}
                  </span>
                  <button
                    type="button"
                    onClick={copyUrl}
                    className="sh__iconbtn"
                    title="Copy chat URL"
                    aria-label="Copy chat URL"
                    style={{ flex: "none" }}
                  >
                    {copied ? (
                      <Icon name="check" size={14} style={{ color: "var(--color-ok)" }} />
                    ) : (
                      <Icon name="copy" size={14} />
                    )}
                  </button>
                </div>
              </section>

              <ConfigEditor agent={agent} models={models} onUpdate={onUpdate} />

              <section>
                <div className="seclabel">
                  Installed skills <span className="seclabel__n">{agent.skills.length}</span>
                </div>
                <div className="alist">
                  {agent.skills.map((skill) => (
                    <SkillRow key={skill.id} agent={agent} skill={skill} onPush={onPushSkill} />
                  ))}
                </div>
              </section>

              <section>
                <div className="seclabel">
                  Variables <span className="seclabel__n">write-only. Values are never shown.</span>
                </div>
                {secretsRestarting && (
                  <div className="ls-banner ls-banner--warn" style={{ marginBottom: 10 }} role="status">
                    <span className="ls-banner__ico">
                      <Icon name="refresh-cw" size={15} />
                    </span>
                    <span className="ls-banner__text">
                      Applying variables — the agent is restarting. Active chat sessions are interrupted.
                    </span>
                  </div>
                )}
                {secretsError && (
                  <pre className="errblock" role="alert" style={{ margin: "0 0 10px" }}>
                    {secretsError}
                  </pre>
                )}
                <div className="reqlist">
                  {agent.secrets.map((secret) => (
                    <SecretRow
                      key={secret.key}
                      secret={secret}
                      busy={secretsApplying}
                      onSet={(key, value) => applySecrets({ [key]: value })}
                      onRemove={(key) => applySecrets({ [key]: null })}
                    />
                  ))}
                  {agent.secrets.length === 0 && (
                    <div className="alist--empty">No variables yet. Add one below or let a skill declare it.</div>
                  )}
                  <AddVariable
                    existingKeys={agent.secrets.map((s) => s.key)}
                    busy={secretsApplying}
                    onAdd={(key, value) => applySecrets({ [key]: value })}
                  />
                </div>
              </section>

              <section>
                <div className="seclabel">
                  Recent sessions <span className="seclabel__n">{agent.sessionsCount}</span>
                </div>
                <div className="alist">
                  {agent.sessions.map((session) => (
                    <button
                      type="button"
                      className="arow"
                      key={session.id}
                      onClick={() => onOpenSession(session.id)}
                      aria-label={`Open session ${session.title}`}
                      style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
                    >
                      <Icon name="history" size={13} style={{ color: "var(--color-faint)" }} />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: "var(--text-xs)",
                          color: "var(--color-fg)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {session.title}
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-muted)" }}>
                        {session.msgs} msgs
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-faint)" }}>
                        {session.when}
                      </span>
                    </button>
                  ))}
                  {agent.sessions.length === 0 && (
                    <div className="alist--empty">No sessions yet. Share the chat URL to start one.</div>
                  )}
                </div>
              </section>

              <section>
                <div className="seclabel" style={{ color: "var(--color-danger)" }}>
                  Danger zone
                </div>
                <div
                  style={{
                    border: "1px solid var(--color-danger-line)",
                    borderRadius: "var(--radius-md)",
                    padding: "14px 16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                  }}
                >
                  <div>
                    <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--color-fg)" }}>
                      Destroy this agent
                    </div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--color-muted)", marginTop: 2 }}>
                      Deletes the sandbox, its secrets and session history. Not reversible. Type the agent name to
                      confirm.
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      value={destroyVal}
                      onChange={(e) => setDestroyVal(e.target.value)}
                      placeholder={agent.id}
                      spellCheck={false}
                      aria-label="Type the agent name to confirm"
                      style={{
                        flex: 1,
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
                    <button
                      type="button"
                      onClick={onDestroy}
                      disabled={destroyDisabled}
                      style={{
                        height: 30,
                        padding: "0 12px",
                        border: "1px solid var(--color-danger-line)",
                        borderRadius: "var(--radius-md)",
                        background: "var(--color-danger-tint)",
                        color: "var(--color-danger)",
                        fontFamily: "var(--font-ui)",
                        fontSize: "var(--text-sm)",
                        fontWeight: 600,
                        cursor: destroyDisabled ? "default" : "pointer",
                        flex: "none",
                        opacity: destroyDisabled ? 0.55 : 1,
                      }}
                    >
                      Destroy agent
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
        <aside className="dsidebar">
          <p className="railhead">Properties</p>
          <div className="props">
            <div className="prop">
              <span className="prop__label">Created</span>
              <span className="prop__value mono" style={{ fontSize: "var(--text-xs)" }}>
                {agent.created}
              </span>
            </div>
            <div className="prop">
              <span className="prop__label">Last active</span>
              <span className="prop__value mono" style={{ fontSize: "var(--text-xs)" }}>
                {agent.lastActive}
              </span>
            </div>
            <div className="prop">
              <span className="prop__label">Sessions</span>
              <span className="prop__value mono" style={{ fontSize: "var(--text-xs)" }}>
                {agent.sessionsCount}
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
