"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelRow, ModelsResponse } from "@companion/contracts";
import { Icon } from "../Icon";
import { setProviderConnection } from "@/lib/runQueries";
import {
  availableModelsFromGroups,
  disconnectedGroups,
  filterGroupsToActivated,
  filterModels,
  groupModelsByProvider,
  toModelProviders,
  type ModelGroupVM,
} from "./derive";

/** Compact model picker for the run launcher composer — button + upward popover menu. */

function contextHint(context: number | null): string | null {
  if (!context) return null;
  return `${Math.round(context / 1000)}k context`;
}

function ConnectProviderRow({
  group,
  onConnected,
}: {
  group: ModelGroupVM;
  onConnected: (providerId: string) => void;
}) {
  const { provider } = group;
  const [connecting, setConnecting] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    <div className="modelsel__connect">
      <div className="modelsel__connect-head">
        <span>{provider.name}</span>
        {!connecting && (
          <button
            type="button"
            className="ag-btn"
            style={{ height: 24 }}
            onClick={() => setConnecting(true)}
            disabled={!canConnect}
            title={canConnect ? undefined : "This provider can't be connected here."}
          >
            Connect
          </button>
        )}
      </div>
      {connecting && (
        <div className="modelsel__connect-form">
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
          />
          <button type="button" className="ag-btn" onClick={save} disabled={busy || !key.trim()} style={{ height: 28 }}>
            {busy ? "Saving…" : "Save"}
          </button>
          {error && (
            <pre className="errblock" role="alert" style={{ margin: 0, gridColumn: "1 / -1" }}>
              {error}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function ModelSelect({
  models,
  model,
  onSelectModel,
  connectedNow,
  onConnected,
  activated,
  onAddModels,
}: {
  models: ModelsResponse;
  model: string;
  onSelectModel: (id: string) => void;
  connectedNow: ReadonlySet<string>;
  onConnected: (providerId: string) => void;
  activated: ReadonlySet<string>;
  onAddModels: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLSpanElement>(null);
  const providers = useMemo(() => toModelProviders(models), [models]);
  const groups = useMemo(
    () => filterGroupsToActivated(groupModelsByProvider(models.models, providers, connectedNow), activated),
    [models.models, providers, connectedNow, activated],
  );
  const available = useMemo(() => availableModelsFromGroups(groups), [groups]);
  const visible = useMemo(() => filterModels(available, query), [available, query]);
  const needsConnect = useMemo(() => disconnectedGroups(groups), [groups]);
  const selected = useMemo(() => available.find((m) => m.id === model) ?? null, [available, model]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (groups.length === 0) {
    return (
      <button type="button" className="modelsel__btn" onClick={onAddModels}>
        <Icon name="plus" size={12} />
        Add models
      </button>
    );
  }

  const label = selected?.name ?? (available.length > 0 ? "Select model" : "Connect provider");

  return (
    <span className="modelsel" ref={ref}>
      <button
        type="button"
        className="modelsel__btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Model"
      >
        <span className="modelsel__lead">
          <Icon name="bot" size={12} />
        </span>
        <b>{label}</b>
        <span className="modelsel__caret">
          <Icon name="chevron-down" size={12} />
        </span>
      </button>
      {open && (
        <div className="modelsel__menu" role="menu">
          {available.length > 0 && (
            <>
              <div className="modelsel__search">
                <Icon name="search" size={12} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models"
                  aria-label="Search models"
                />
              </div>
              <div className="modelsel__list" role="radiogroup" aria-label="Model">
                {visible.map((row) => (
                  <ModelMenuItem
                    key={row.id}
                    row={row}
                    selected={model === row.id}
                    onSelect={() => {
                      onSelectModel(row.id);
                      setOpen(false);
                    }}
                  />
                ))}
                {visible.length === 0 && <div className="modelsel__empty">No models match.</div>}
              </div>
            </>
          )}
          {needsConnect.length > 0 && (
            <div className="modelsel__connect-block">
              {available.length === 0 && (
                <div className="modelsel__empty">Connect a provider to use your activated models.</div>
              )}
              {needsConnect.map((group) => (
                <ConnectProviderRow key={group.provider.id} group={group} onConnected={onConnected} />
              ))}
            </div>
          )}
          <div className="modelsel__foot">
            <button type="button" className="modelsel__add" onClick={onAddModels}>
              <Icon name="plus" size={12} />
              Add more models
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

function ModelMenuItem({
  row,
  selected,
  onSelect,
}: {
  row: ModelRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const hint = row.description ?? contextHint(row.context);
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} className={"modelsel__item" + (selected ? " is-sel" : "")} onClick={onSelect}>
      <span className="modelsel__item-txt">
        <span className="modelsel__item-name">{row.name}</span>
        {hint && <span className="modelsel__item-hint">{hint}</span>}
      </span>
      {selected && (
        <span className="modelsel__item-check">
          <Icon name="check" size={13} />
        </span>
      )}
    </button>
  );
}
