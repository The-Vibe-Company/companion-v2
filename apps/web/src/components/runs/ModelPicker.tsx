"use client";

import { useMemo, useRef, useState } from "react";
import type { ModelRow, ModelsResponse } from "@companion/contracts";
import { Icon } from "../Icon";
import { setProviderConnection } from "@/lib/runQueries";
import { filterModelGroups, groupModelsByProvider, toModelProviders, type ModelGroupVM } from "./derive";

/**
 * The grouped-by-provider model picker for the run launcher: connected providers first, an inline
 * "Connect" key input for the rest, radio selection for models. Extracted from the agents
 * create-form prototype; state (selected model + session-connected providers) lives in the parent.
 */

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
            title={canConnect ? undefined : "This provider can't be connected here."}
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
                  placeholder={`Your ${provider.name} API key`}
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

          {group.models.map((m: ModelRow) => {
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

/** Search box + grouped provider list. `connectedNow` flips a provider connected without a refetch. */
export function ModelPicker({
  models,
  model,
  onSelectModel,
  connectedNow,
  onConnected,
}: {
  models: ModelsResponse;
  model: string;
  onSelectModel: (id: string) => void;
  /** Providers connected during this dialog session (inline Connect) — local catalog override. */
  connectedNow: ReadonlySet<string>;
  onConnected: (providerId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const providers = useMemo(() => toModelProviders(models), [models]);
  const groups = useMemo(
    () => groupModelsByProvider(models.models, providers, connectedNow),
    [models.models, providers, connectedNow],
  );
  const visibleGroups = useMemo(() => filterModelGroups(groups, query), [groups, query]);

  return (
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
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
      <div style={{ maxHeight: 260, overflowY: "auto" }} role="radiogroup" aria-label="Model">
        {visibleGroups.map((group) => (
          <ProviderGroup
            key={group.provider.id}
            group={group}
            model={model}
            onSelectModel={onSelectModel}
            onConnected={onConnected}
          />
        ))}
        {visibleGroups.length === 0 && (
          <div style={{ padding: "14px 12px", fontSize: "var(--text-xs)", color: "var(--color-faint)" }}>
            No models match.
          </div>
        )}
      </div>
    </div>
  );
}
