"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch, ApiFetchError } from "@/lib/apiClient";
import { formatAgentConstraints } from "@/lib/agentAuth";
import { Icon } from "@/components/Icon";

interface RequestedCapability {
  name: string;
  constraints: Record<string, unknown> | null;
  reason: string | null;
}

interface ApprovalRequest {
  agent_id: string;
  agent_name: string;
  host: { id: string; name: string };
  capabilities: RequestedCapability[];
  workspace_id: string | null;
  workspace_name: string | null;
  expires_at: string;
}

const FRESH_SESSION_MESSAGE = "Approval requires a sign-in from the last five minutes. Sign in again to continue.";

export function DeviceCapabilitiesApproval({ agentId, code }: { agentId: string; code: string }) {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"loading" | "ready" | "approving" | "denying" | "approved" | "denied" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [reauthRequired, setReauthRequired] = useState(false);

  const query = useMemo(
    () => `agent_id=${encodeURIComponent(agentId)}&code=${encodeURIComponent(code)}`,
    [agentId, code],
  );

  useEffect(() => {
    if (!agentId || !code) {
      setReauthRequired(false);
      setState("error");
      setError("This approval link is incomplete. Return to the agent and restart the device flow.");
      return;
    }
    let active = true;
    setReauthRequired(false);
    apiFetch<{ request: ApprovalRequest }>(`/v1/agent-auth/device-approval?${query}`)
      .then((result) => {
        if (!active) return;
        setRequest(result.request);
        setSelected(new Set(result.request.capabilities.map((capability) => capability.name)));
        setState("ready");
      })
      .catch((cause) => {
        if (!active) return;
        const freshSessionRequired = cause instanceof ApiFetchError && (cause.status === 401 || cause.status === 403);
        setReauthRequired(freshSessionRequired);
        setState("error");
        setError(
          freshSessionRequired
            ? FRESH_SESSION_MESSAGE
            : cause instanceof Error
              ? cause.message
              : "Could not load this approval request.",
        );
      });
    return () => {
      active = false;
    };
  }, [agentId, code, query]);

  const act = async (decision: "approve" | "deny") => {
    if (!request || state === "approving" || state === "denying") return;
    setState(decision === "approve" ? "approving" : "denying");
    setError(null);
    try {
      if (decision === "approve") {
        await apiFetch(`/v1/agent-auth/device-approval/approve`, {
          method: "POST",
          body: JSON.stringify({ agent_id: agentId, code, capabilities: [...selected] }),
        });
        setState("approved");
      } else {
        await apiFetch(`/v1/agent-auth/device-approval/deny`, {
          method: "POST",
          body: JSON.stringify({ agent_id: agentId, code, reason: "Denied by user" }),
        });
        setState("denied");
      }
    } catch (cause) {
      const freshSessionRequired = cause instanceof ApiFetchError && (cause.status === 401 || cause.status === 403);
      setReauthRequired(freshSessionRequired);
      setState("error");
      setError(
        freshSessionRequired
          ? FRESH_SESSION_MESSAGE
          : cause instanceof Error
            ? cause.message
            : "Could not record your decision.",
      );
    }
  };

  if (state === "loading") {
    return (
      <section className="device-approval" aria-busy="true">
        <div className="device-approval__skeleton" role="status">Loading capability request...</div>
      </section>
    );
  }

  if (!request || state === "error") {
    return (
      <section className="device-approval device-approval--error" role="alert">
        <span className="device-approval__mark"><Icon name="alert-triangle" size={18} /></span>
        <h1>Approval could not continue</h1>
        <p>{error ?? "This request is unavailable or has expired."}</p>
        {reauthRequired ? (
          <form className="device-approval__reauth" method="post" action="/v1/auth/logout">
            <input type="hidden" name="next" value={`/device/capabilities?${query}`} />
            <button className="btn-primary" type="submit">Sign in again</button>
          </form>
        ) : (
          <a className="btn-sec" href={`/device/capabilities?${query}`}>Try again</a>
        )}
      </section>
    );
  }

  if (state === "approved" || state === "denied") {
    return (
      <section className="device-approval" role="status">
        <span className="device-approval__mark"><Icon name={state === "approved" ? "shield-check" : "lock"} size={18} /></span>
        <h1>{state === "approved" ? "Agent approved" : "Request denied"}</h1>
        <p>
          {state === "approved"
            ? `${request.agent_name} can continue with the capabilities you selected.`
            : `${request.agent_name} was not granted access.`}
        </p>
        <p className="device-approval__quiet">You can close this page and return to the agent.</p>
      </section>
    );
  }

  return (
    <section className="device-approval" aria-labelledby="device-approval-title">
      <header>
        <span className="device-approval__mark"><Icon name="bot" size={18} /></span>
        <div>
          <p className="device-approval__brand">Companion Agent Auth</p>
          <h1 id="device-approval-title">Approve agent capabilities</h1>
        </div>
      </header>

      <dl className="device-approval__identity">
        <div><dt>Agent</dt><dd>{request.agent_name}</dd></div>
        <div><dt>Host</dt><dd>{request.host.name}</dd></div>
        {request.workspace_id && (
          <div>
            <dt>Workspace</dt>
            <dd>
              <span>{request.workspace_name ?? "Unknown workspace"}</span>
              <small className="mono">{request.workspace_id}</small>
            </dd>
          </div>
        )}
        <div><dt>Device code</dt><dd className="mono">{code}</dd></div>
        <div><dt>Expires</dt><dd className="mono">{request.expires_at}</dd></div>
      </dl>

      <fieldset className="device-approval__capabilities">
        <legend>Requested permissions</legend>
        <p>Select only the capabilities this agent should receive.</p>
        {request.capabilities.map((capability) => {
          const checked = selected.has(capability.name);
          return (
            <label key={capability.name}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => setSelected((current) => {
                  const next = new Set(current);
                  if (checked) next.delete(capability.name);
                  else next.add(capability.name);
                  return next;
                })}
              />
              <span>
                <b className="mono">{capability.name}</b>
                <small>{capability.reason || formatAgentConstraints(capability.constraints)}</small>
                {capability.reason && <small className="mono">{formatAgentConstraints(capability.constraints)}</small>}
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="device-approval__notice">
        <Icon name="info" size={14} />
        Grants stay active until revoked in Settings. Short-lived request tokens do not expose your session to the agent.
      </div>

      <footer>
        <button className="btn-sec" type="button" disabled={state !== "ready"} onClick={() => void act("deny")}>
          {state === "denying" ? <span className="cds-spinner" /> : <Icon name="x" size={14} />}
          Deny
        </button>
        <button className="btn-primary" type="button" disabled={state !== "ready" || selected.size === 0} onClick={() => void act("approve")}>
          {state === "approving" ? <span className="cds-spinner" /> : <Icon name="shield-check" size={14} />}
          Approve selected
        </button>
      </footer>
    </section>
  );
}
