"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import type { AgentVM } from "@/lib/types";
import { statusBadge, statusDot } from "./derive";
import { provisionErrorText } from "./ProvisioningCard";

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

/** The agent detail screen: header actions, content sections, and the Properties rail. */
export function DetailView({
  agent,
  chatUrl,
  onBack,
  onOpenChat,
  onPauseWake,
  onRetry,
  onPushSkill,
  onDestroy,
}: {
  agent: AgentVM;
  chatUrl: string;
  onBack: () => void;
  onOpenChat: () => void;
  onPauseWake: () => void;
  onRetry: () => void;
  onPushSkill: (skillSlug: string) => void;
  onDestroy: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [destroyVal, setDestroyVal] = useState("");

  useEffect(() => {
    setDestroyVal("");
    setCopied(false);
  }, [agent.id]);
  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const copyUrl = () => {
    const url = chatUrl || `${window.location.origin}/agents/${agent.id}/chat`;
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(url).catch(() => {});
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
                    Provisioning failed
                  </div>
                  <pre className="errblock" style={{ margin: 0 }}>
                    {provisionErrorText(provisionError)}
                  </pre>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                    <button type="button" className="btn-primary" onClick={onRetry}>
                      Retry provisioning
                    </button>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--color-faint)" }}>
                      Set the missing secret first or the retry fails the same way.
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
                  Secrets <span className="seclabel__n">names only. Values are never shown.</span>
                </div>
                <div className="reqlist">
                  {agent.secrets.map((secret) => (
                    <div
                      key={secret.key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        border: "1px solid var(--color-line)",
                        borderRadius: "var(--radius-md)",
                        padding: "8px 12px",
                      }}
                    >
                      <Icon name="key" size={12} style={{ color: "var(--color-faint)" }} />
                      <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--color-fg)" }}>
                        {secret.key}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--color-faint)" }}>
                        required by <span className="mono">{secret.requiredBy.join(", ")}</span>
                      </span>
                      <span style={{ flex: 1 }} />
                      <span className={"ag-set " + (secret.set ? "ag-set--ok" : "ag-set--danger")}>
                        {secret.set ? "set" : "not set"}
                      </span>
                    </div>
                  ))}
                  {agent.secrets.length === 0 && (
                    <div className="alist--empty">No secrets. None of this agent&apos;s skills require env vars.</div>
                  )}
                </div>
              </section>

              <section>
                <div className="seclabel">
                  Recent sessions <span className="seclabel__n">{agent.sessionsCount}</span>
                </div>
                <div className="alist">
                  {agent.sessions.map((session) => (
                    <div className="arow" key={session.id}>
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
                    </div>
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
              <span className="prop__label">Status</span>
              <span className="prop__value">
                <span className={statusDot(agent.status)} />
                <span className="mono" style={{ fontSize: "var(--text-xs)" }}>
                  {agent.status}
                </span>
              </span>
            </div>
            <div className="prop">
              <span className="prop__label">Model</span>
              <span className="prop__value mono" style={{ fontSize: "var(--text-xs)" }}>
                {agent.model}
              </span>
            </div>
            <div className="prop">
              <span className="prop__label">Client</span>
              <span className="prop__value" style={{ fontSize: "var(--text-xs)" }}>
                {agent.client ?? "—"}
              </span>
            </div>
            <div className="prop">
              <span className="prop__label">Region</span>
              <span className="prop__value mono" style={{ fontSize: "var(--text-xs)" }}>
                {agent.region}
              </span>
            </div>
            <div className="prop">
              <span className="prop__label">Sandbox</span>
              <span className="prop__value mono" style={{ fontSize: "var(--text-xs)" }}>
                {agent.sandboxName ?? agent.sandboxId ?? "—"}
              </span>
            </div>
            <div className="divider" />
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
