"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchConnectedAgents,
  revokeAgentGrant,
  revokeAgentHost,
  revokeConnectedAgent,
  exactWorkspaceConstraint,
  formatAgentConstraints,
  type ConnectedAgentVM,
} from "@/lib/agentAuth";
import { relativeTime } from "@/lib/format";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";

type RevokeTarget =
  | { kind: "grant"; id: string; label: string }
  | { kind: "agent"; id: string; label: string }
  | { kind: "host"; id: string; label: string };

function constraintLabel(constraints: Record<string, unknown> | null): string {
  if (!constraints) return "instance-wide";
  const workspaceId = exactWorkspaceConstraint(constraints);
  if (workspaceId) return `workspace ${workspaceId}`;
  return formatAgentConstraints(constraints);
}

export function ConnectedAgentsPane() {
  const [agents, setAgents] = useState<ConnectedAgentVM[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RevokeTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAgents(await fetchConnectedAgents());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load connected agents.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!confirm) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = confirmRef.current;
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        setConfirm(null);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [confirm]);

  const revoke = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (confirm.kind === "grant") await revokeAgentGrant(confirm.id);
      else if (confirm.kind === "agent") await revokeConnectedAgent(confirm.id);
      else await revokeAgentHost(confirm.id);
      setConfirm(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke access.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sx-pane connected-agents">
      <PaneHead
        title="Connected agents"
        desc="Review delegated capabilities and revoke access without exposing agent credentials."
      />

      {error && (
        <div className="og-errbar" role="alert">
          <Icon name="alert-triangle" size={14} />
          <span>{error}</span>
          <button className="btn-sec" type="button" onClick={() => void load()}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="connected-agents__loading" role="status">Loading connected agents...</div>
      ) : agents.length === 0 ? (
        <div className="connected-agents__empty">
          <Icon name="bot" size={18} />
          <div>
            <strong>No connected agents</strong>
            <p>An agent appears here after you approve its first capability request.</p>
          </div>
        </div>
      ) : (
        <div className="connected-agents__list">
          {agents.map((agent) => (
            <section className="connected-agent" key={agent.id} aria-labelledby={`agent-${agent.id}`}>
              <header>
                <span className="connected-agent__icon"><Icon name="bot" size={16} /></span>
                <div>
                  <h3 id={`agent-${agent.id}`}>{agent.name}</h3>
                  <p>
                    Host <span className="mono">{agent.host.name}</span>
                    <span aria-hidden="true"> · </span>
                    Last used {agent.last_used_at ? relativeTime(agent.last_used_at) : "never"}
                  </p>
                </div>
                <span className="tag">{agent.status}</span>
              </header>

              <div className="connected-agent__grants">
                {agent.grants.length ? agent.grants.map((grant) => (
                  <div className="connected-grant" key={grant.id}>
                    <div>
                      <strong className="mono">{grant.capability}</strong>
                      <span>{constraintLabel(grant.constraints)}</span>
                    </div>
                    <span className="tag">{grant.status}</span>
                    <span className="connected-grant__used">
                      {grant.last_used_at ? `Used ${relativeTime(grant.last_used_at)}` : "Usage unavailable"}
                    </span>
                    {grant.status === "active" && (
                      <button
                        className="btn-ghost"
                        type="button"
                        onClick={() => setConfirm({ kind: "grant", id: grant.id, label: grant.capability })}
                      >
                        Revoke capability
                      </button>
                    )}
                  </div>
                )) : (
                  <p className="connected-agent__no-grants">No active capabilities.</p>
                )}
              </div>

              <footer>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setConfirm({ kind: "host", id: agent.host.id, label: agent.host.name })}
                >
                  Revoke host
                </button>
                <button
                  type="button"
                  className="btn-ghost connected-agent__danger"
                  onClick={() => setConfirm({ kind: "agent", id: agent.id, label: agent.name })}
                >
                  Revoke agent
                </button>
              </footer>
            </section>
          ))}
        </div>
      )}

      {confirm && (
        <div
          className="connected-agents__confirm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="revoke-agent-title"
          ref={confirmRef}
        >
          <div>
            <h3 id="revoke-agent-title">Revoke {confirm.kind} access?</h3>
            <p>
              <span className="mono">{confirm.label}</span> will need a new device approval before using the revoked access again.
            </p>
            <div>
              <button className="btn-ghost" type="button" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
              <button className="btn-danger" type="button" onClick={revoke} disabled={busy}>
                {busy ? <span className="cds-spinner" /> : <Icon name="lock" size={14} />}
                Confirm revoke
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
