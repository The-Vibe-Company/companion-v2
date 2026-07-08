"use client";

import { useEffect, useMemo, useState } from "react";
import type { ActivatedModels, ModelRow, ModelsResponse } from "@companion/contracts";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import { fetchModels } from "@/lib/runQueries";
import { filterModelGroups, groupModelsByProvider, toModelProviders, type ModelGroupVM } from "@/components/runs/derive";

/* ============================ Models (activation + provider keys, merged) ============================
   One pane per scope (Account → Models, Workspace → Shared models; same keyed-usage rule as the old
   provider panes). The organizing concept is READINESS, not configuration: the deck at the top
   mirrors exactly what the run launcher will offer, each row telling the one truth that matters —
   `Ready` (activated + a reachable key) or `Needs key` (key captured inline, right on the row).
   Below it, a search-first add bar over the full models.dev catalog, then a per-provider browse
   accordion for exploration. Activation is a hard gate: createRun rejects non-activated models. */

export interface ModelScope {
  title: string;
  desc: string;
  lockText: string;
  /** Read-only: show the deck but no add/remove/connect (non-admins on the workspace scope). */
  locked: boolean;
  /**
   * What "Ready" means here: `"any"` (personal pane — a key from anywhere serves the viewer) or
   * `"scope"` (workspace pane — only a SHARED key makes a model ready for every member; the
   * viewer's personal key must not overstate what the workspace provides).
   */
  readiness: "any" | "scope";
  /** The list this scope manages, from the one models response. */
  select: (activated: ActivatedModels) => string[];
  /** Rows unioned into the launcher but managed elsewhere (the workspace list, on the personal pane). */
  ghost?: { label: string; select: (activated: ActivatedModels) => string[] };
  /** Persist the full replacement list; returns both lists back. */
  save: (models: string[]) => Promise<ActivatedModels>;
  /** Provider ids with a key in THIS scope (disconnect is offered only for these). */
  loadConnected: () => Promise<Set<string>>;
  connect: (provider: string, keyName: string, key: string) => Promise<void>;
  disconnect: (provider: string) => Promise<void>;
}

const SEARCH_RESULT_CAP = 50;

function modelMeta(m: ModelRow): string | null {
  const parts: string[] = [];
  if (m.context) parts.push(`${Math.round(m.context / 1000)}k ctx`);
  if (m.cost_input != null) parts.push(`$${m.cost_input}/M in`);
  return parts.length ? parts.join(" · ") : null;
}

export function ModelsPane({ scope }: { scope: ModelScope }) {
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [activated, setActivated] = useState<string[]>([]);
  const [ghostIds, setGhostIds] = useState<string[]>([]);
  /** Providers with a key in THIS scope (drives disconnect affordances). */
  const [scopeKeys, setScopeKeys] = useState<Set<string>>(() => new Set());
  /** Providers connected during this visit — flips rows to Ready without a refetch. */
  const [connectedNow, setConnectedNow] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  /** The ONE spot whose inline key input is open: a specific deck/ghost row or a browse header. */
  const [keyEntry, setKeyEntry] = useState<{ anchor: string; providerId: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [tick, setTick] = useState(0);
  /** Full refetch — the server recomputes `connected`, so disconnects can't leave stale "Ready". */
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let live = true;
    Promise.all([fetchModels(), scope.loadConnected()])
      .then(([response, keys]) => {
        if (!live) return;
        setCatalog(response);
        setActivated(scope.select(response.activated));
        setGhostIds(scope.ghost ? scope.ghost.select(response.activated) : []);
        setScopeKeys(keys);
        setConnectedNow(new Set());
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load the model catalog."));
    return () => {
      live = false;
    };
    // scope member identities are stable per render; tick drives reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const byId = useMemo(() => new Map((catalog?.models ?? []).map((m) => [m.id, m])), [catalog]);
  const providers = useMemo(() => (catalog ? toModelProviders(catalog) : []), [catalog]);
  const providersById = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);
  const activatedSet = useMemo(() => new Set(activated), [activated]);

  /** Per-scope readiness: any key (personal pane) vs shared keys only (workspace pane). */
  const usable = (providerId: string): boolean =>
    scopeKeys.has(providerId) ||
    connectedNow.has(providerId) ||
    (scope.readiness === "any" && (providersById.get(providerId)?.connected ?? false));

  const deck = activated.map((id) => byId.get(id)).filter((m): m is ModelRow => !!m);
  const ghost = ghostIds.filter((id) => !activatedSet.has(id)).map((id) => byId.get(id)).filter((m): m is ModelRow => !!m);
  const launcher = [...deck, ...ghost];
  const readyCount = launcher.filter((m) => usable(m.provider)).length;
  const needsKeyCount = launcher.length - readyCount;

  const groups = useMemo(() => {
    if (!catalog) return [];
    const all = groupModelsByProvider(catalog.models, providers, connectedNow);
    const active = (g: ModelGroupVM) => g.models.some((m) => activatedSet.has(m.id));
    return [...all].sort((a, b) => Number(active(b)) - Number(active(a)));
  }, [catalog, providers, connectedNow, activatedSet]);

  const searching = query.trim().length > 0;
  const searchMatches = useMemo(
    () => (searching ? filterModelGroups(groups, query).flatMap((g) => g.models) : []),
    [groups, query, searching],
  );

  const save = async (next: string[], touchedId: string) => {
    if (savingId || scope.locked) return;
    const previous = activated;
    setSavingId(touchedId);
    setError(null);
    setActivated(next); // optimistic — the deck is the launcher, it should feel immediate
    try {
      const lists = await scope.save(next);
      setActivated(scope.select(lists));
      setGhostIds(scope.ghost ? scope.ghost.select(lists) : []);
    } catch (e) {
      setActivated(previous);
      setError(e instanceof Error ? e.message : "Could not save the model list.");
    } finally {
      setSavingId(null);
    }
  };
  const addModel = (id: string) => void save([...activated, id], id);
  const removeModel = (id: string) => void save(activated.filter((m) => m !== id), id);
  const toggleModel = (id: string) => (activatedSet.has(id) ? removeModel(id) : addModel(id));

  const disconnect = async (providerId: string) => {
    setError(null);
    try {
      await scope.disconnect(providerId);
      // Refetch instead of pruning local sets: `provider.connected` from the server included the
      // just-deleted key, so only a reload can say whether the provider is still usable elsewhere.
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect.");
    }
  };

  const onKeySaved = (providerId: string) => {
    setKeyEntry(null);
    setConnectedNow((prev) => new Set(prev).add(providerId));
    setScopeKeys((prev) => new Set(prev).add(providerId));
  };

  /** Render the key input at exactly ONE anchor (the row/header that asked for it). */
  const keyRowAt = (anchor: string) =>
    keyEntry?.anchor === anchor ? (
      <KeyRow
        providerId={keyEntry.providerId}
        providerName={providersById.get(keyEntry.providerId)?.name ?? keyEntry.providerId}
        envKey={providersById.get(keyEntry.providerId)?.envKeys[0] ?? null}
        onConnect={scope.connect}
        onSaved={() => onKeySaved(keyEntry.providerId)}
        onCancel={() => setKeyEntry(null)}
        onError={setError}
      />
    ) : null;

  return (
    <div className="sx-pane">
      <PaneHead title={scope.title} desc={scope.desc} />

      <div className="og-lockbar og-lockbar--wide" style={{ marginBottom: 18 }}>
        <Icon name="shield-check" size={13} />
        <span>{scope.lockText}</span>
      </div>

      {error && (
        <div className="sx-empty" role="alert" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {catalog === null ? (
        <SkeletonDeck />
      ) : (
        <>
          {/* ---- The deck: exactly what the run launcher offers ---- */}
          <div className="mlist__lbl">
            <span>
              {launcher.length === 0
                ? "In your launcher"
                : `${launcher.length} ${launcher.length === 1 ? "model" : "models"} in ${scope.ghost ? "your" : "the"} launcher · ${readyCount} ready${needsKeyCount ? ` · ${needsKeyCount} ${needsKeyCount === 1 ? "needs" : "need"} a key` : ""}`}
            </span>
          </div>
          {launcher.length === 0 ? (
            <div className="sx-empty">
              {scope.locked
                ? "Your workspace hasn’t activated any models yet."
                : "The run launcher only shows models you activate. Search below to add your first."}
            </div>
          ) : (
            <div className="mlist">
              {deck.map((m) => (
                <DeckRow
                  key={m.id}
                  model={m}
                  ready={usable(m.provider)}
                  locked={scope.locked}
                  pending={savingId === m.id}
                  keyRow={keyRowAt(`deck:${m.id}`)}
                  keyEntryOpenForProvider={keyEntry?.providerId === m.provider}
                  onAskKey={() => setKeyEntry({ anchor: `deck:${m.id}`, providerId: m.provider })}
                  onRemove={() => removeModel(m.id)}
                />
              ))}
              {ghost.length > 0 && (
                <>
                  <div
                    className="mono"
                    style={{
                      padding: "7px 12px",
                      fontSize: 10,
                      color: "var(--color-faint)",
                      background: "var(--color-surface-sunken)",
                      borderBottom: "1px solid var(--color-line)",
                    }}
                  >
                    {scope.ghost!.label} — {ghost.length}
                  </div>
                  {ghost.map((m) => (
                    <DeckRow
                      key={m.id}
                      model={m}
                      ready={usable(m.provider)}
                      locked={scope.locked}
                      pending={false}
                      shared
                      keyRow={keyRowAt(`ghost:${m.id}`)}
                      keyEntryOpenForProvider={keyEntry?.providerId === m.provider}
                      onAskKey={() => setKeyEntry({ anchor: `ghost:${m.id}`, providerId: m.provider })}
                    />
                  ))}
                </>
              )}
            </div>
          )}

          {!scope.locked && (
            <>
              {/* ---- Add bar: search-first over the full catalog ---- */}
              <div className="mlist__lbl" style={{ marginTop: 18 }}>
                <span>Add models</span>
                <span className="n">{catalog.models.length}</span>
              </div>
              <div className="og-toolbar" style={{ marginBottom: 10 }}>
                <div className="og-search">
                  <Icon name="search" size={15} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search ${catalog.models.length.toLocaleString("en-US")} models or providers`}
                    aria-label="Search models or providers"
                  />
                </div>
              </div>

              {searching ? (
                searchMatches.length === 0 ? (
                  <div className="sx-empty">No models match &ldquo;{query.trim()}&rdquo;.</div>
                ) : (
                  <>
                    <div className="mlist" style={{ maxHeight: 420, overflowY: "auto" }}>
                      {searchMatches.slice(0, SEARCH_RESULT_CAP).map((m) => {
                        const on = activatedSet.has(m.id);
                        const meta = modelMeta(m);
                        return (
                          <div className="mrow" key={m.id}>
                            <div className="mrow__id">
                              <div className="og-mname">{m.name}</div>
                              <div className="og-memail">
                                {m.id}
                                {meta ? ` · ${meta}` : ""}
                              </div>
                            </div>
                            <div className="mrow__end">
                              {on ? (
                                <span className="badge scopebadge">In launcher</span>
                              ) : (
                                <button className="btn-sec" disabled={savingId !== null} onClick={() => addModel(m.id)}>
                                  Activate
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {searchMatches.length > SEARCH_RESULT_CAP && (
                      <p style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--color-faint)" }}>
                        Showing the first {SEARCH_RESULT_CAP} of {searchMatches.length} matches — keep typing to narrow down.
                      </p>
                    )}
                  </>
                )
              ) : (
                /* ---- Browse: per-provider accordion, keys managed on the headers ---- */
                <div
                  style={{
                    border: "1px solid var(--color-line)",
                    borderRadius: "var(--radius-md)",
                    overflow: "hidden auto",
                    maxHeight: 480,
                  }}
                >
                  {groups.map((group) => (
                    <ProviderModelsGroup
                      key={group.provider.id}
                      group={group}
                      activated={activatedSet}
                      usable={usable(group.provider.id)}
                      scopeKey={scopeKeys.has(group.provider.id)}
                      expanded={open.has(group.provider.id)}
                      onToggleExpanded={() =>
                        setOpen((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.provider.id)) next.delete(group.provider.id);
                          else next.add(group.provider.id);
                          return next;
                        })
                      }
                      savingId={savingId}
                      keyRow={keyRowAt(`browse:${group.provider.id}`)}
                      onAskKey={() => {
                        setKeyEntry({ anchor: `browse:${group.provider.id}`, providerId: group.provider.id });
                        setOpen((prev) => new Set(prev).add(group.provider.id));
                      }}
                      onDisconnect={() => void disconnect(group.provider.id)}
                      onToggleModel={toggleModel}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Dot + text — status never rides on color alone. */
function ReadyBadge({ ready }: { ready: boolean }) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10,
        color: ready ? "var(--color-ok)" : "var(--color-warn)",
        flex: "none",
        width: 74,
      }}
    >
      <span
        aria-hidden
        style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor", flex: "none" }}
      />
      {ready ? "Ready" : "Needs key"}
    </span>
  );
}

/** One launcher row: status, identity, and the single action that matters right now. */
function DeckRow({
  model,
  ready,
  locked,
  pending,
  shared,
  keyRow,
  keyEntryOpenForProvider,
  onAskKey,
  onRemove,
}: {
  model: ModelRow;
  ready: boolean;
  locked: boolean;
  pending: boolean;
  shared?: boolean;
  keyRow: React.ReactNode;
  /** True when the provider's key input is already open somewhere — hide this row's Add-key button. */
  keyEntryOpenForProvider?: boolean;
  onAskKey: () => void;
  onRemove?: () => void;
}) {
  const meta = modelMeta(model);
  return (
    <>
      <div className="mrow" style={{ opacity: pending ? 0.6 : 1 }}>
        <ReadyBadge ready={ready} />
        <div className="mrow__id">
          <div className="og-mname">{model.name}</div>
          <div className="og-memail">
            {model.id}
            {meta ? ` · ${meta}` : ""}
          </div>
        </div>
        <div className="mrow__end">
          {shared && <span className="badge scopebadge">shared</span>}
          {!ready && !locked && !keyEntryOpenForProvider && (
            <button className="btn-sec" onClick={onAskKey}>
              Add {model.provider_name} key
            </button>
          )}
          {!locked && onRemove && (
            <button className="mrow__x" title={`Remove ${model.name}`} disabled={pending} onClick={onRemove}>
              <Icon name="x" size={15} />
            </button>
          )}
        </div>
      </div>
      {keyRow}
    </>
  );
}

/** One provider header (chevron, counts, key state) + its checkbox model rows. */
function ProviderModelsGroup({
  group,
  activated,
  usable,
  scopeKey,
  expanded,
  onToggleExpanded,
  savingId,
  keyRow,
  onAskKey,
  onDisconnect,
  onToggleModel,
}: {
  group: ModelGroupVM;
  activated: ReadonlySet<string>;
  /** A key reaches this provider from any scope. */
  usable: boolean;
  /** THIS scope holds the key (disconnect is offered). */
  scopeKey: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  savingId: string | null;
  keyRow: React.ReactNode;
  onAskKey: () => void;
  onDisconnect: () => void;
  onToggleModel: (id: string) => void;
}) {
  const { provider } = group;
  const activeCount = group.models.reduce((n, m) => n + (activated.has(m.id) ? 1 : 0), 0);
  const canConnect = provider.envKeys.length > 0;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px 0 0",
          background: "var(--color-surface-sunken)",
          borderBottom: "1px solid var(--color-line)",
        }}
      >
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${provider.name}` : `Expand ${provider.name}`}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "9px 11px",
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
          {activeCount > 0 && (
            <span className="mono" style={{ fontSize: 10, color: "var(--color-ok)" }}>
              · {activeCount} activated
            </span>
          )}
        </button>
        {usable ? (
          <span
            className="mono"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--color-ok)" }}
          >
            <Icon name="check" size={11} />
            connected
          </span>
        ) : keyRow !== null ? null : (
          <button
            className="btn-sec"
            disabled={!canConnect}
            title={canConnect ? undefined : "This provider can't be connected here."}
            style={{ opacity: canConnect ? 1 : 0.55 }}
            onClick={onAskKey}
          >
            Connect
          </button>
        )}
        {scopeKey && (
          <button className="mrow__x" title={`Disconnect ${provider.name}`} onClick={onDisconnect}>
            <Icon name="trash-2" size={15} />
          </button>
        )}
      </div>
      {expanded && keyRow}
      {expanded &&
        group.models.map((m) => {
          const on = activated.has(m.id);
          const meta = modelMeta(m);
          return (
            <label
              key={m.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px 8px 29px",
                borderBottom: "1px solid var(--color-line)",
                cursor: "pointer",
                opacity: savingId === m.id ? 0.6 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={savingId !== null}
                onChange={() => onToggleModel(m.id)}
                aria-label={`${on ? "Deactivate" : "Activate"} ${m.name}`}
                style={{ flex: "none" }}
              />
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "var(--text-sm)", color: "var(--color-fg)", fontWeight: 500 }}>{m.name}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--color-faint)" }}>
                  {m.id}
                  {meta ? ` · ${meta}` : ""}
                </span>
              </span>
            </label>
          );
        })}
    </div>
  );
}

/** Inline key entry — password field + Connect/Cancel; the key is write-only and never re-shown. */
function KeyRow({
  providerId,
  providerName,
  envKey,
  onConnect,
  onSaved,
  onCancel,
  onError,
}: {
  providerId: string;
  providerName: string;
  envKey: string | null;
  onConnect: (provider: string, keyName: string, key: string) => Promise<void>;
  onSaved: () => void;
  onCancel: () => void;
  onError: (message: string | null) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!key.trim() || busy || !envKey) return;
    setBusy(true);
    onError(null);
    try {
      await onConnect(providerId, envKey, key.trim());
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save the key.");
      setBusy(false);
    }
  };
  return (
    // data-esc-guard: the settings drawer's capture-phase Escape handler yields to this widget,
    // so Escape cancels the key entry instead of closing the whole drawer mid-typing.
    <div className="mrow" data-esc-guard style={{ flexWrap: "wrap", gap: 8 }}>
      <span className="keyic">
        <Icon name="key" size={15} />
      </span>
      <div className="mrow__id">
        <div className="og-mname">{providerName} API key</div>
        <div className="og-memail">Stored encrypted, used only for runs you launch, never shown again.</div>
      </div>
      <div className="mrow__end" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          className="sx-input"
          type="password"
          autoFocus
          placeholder={`Your ${providerName} API key`}
          aria-label={`API key for ${providerName}`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onCancel();
          }}
          style={{ minWidth: 220 }}
        />
        <button className="btn-primary" disabled={!key.trim() || busy || !envKey} onClick={() => void save()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <button className="btn-sec" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Loading placeholder — quiet rows, not a spinner in the middle of content. */
function SkeletonDeck() {
  return (
    <div className="mlist" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div className="mrow" key={i} style={{ opacity: 0.55 }}>
          <span style={{ width: 74, height: 10, borderRadius: 5, background: "var(--color-surface-sunken)" }} />
          <div className="mrow__id" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ width: 140 + i * 40, height: 10, borderRadius: 5, background: "var(--color-surface-sunken)" }} />
            <span style={{ width: 220 - i * 30, height: 8, borderRadius: 5, background: "var(--color-surface-sunken)" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
