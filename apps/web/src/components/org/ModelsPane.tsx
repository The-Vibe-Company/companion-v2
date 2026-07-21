"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { ActivatedModels, ModelProviderConnectionRow, ModelRow, ModelsResponse } from "@companion/contracts";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import { fetchModels } from "@/lib/runQueries";
import { filterModelGroups, groupModelsByProvider, toModelProviders, type ModelGroupVM } from "@/components/runs/derive";

/* ============================ Models (activation + dedicated provider credentials) =====================
   One pane per scope (Account → Models, Workspace → Shared models). The workbench is provider-first:
   a provider credential determines readiness for every activated model grouped beneath it. Search stays
   persistent over the full models.dev catalog, while activation remains the hard createRun gate. */

export interface ModelScope {
  title: string;
  desc: string;
  /** Read-only: show the deck but no add/remove/connect (non-admins on the workspace scope). */
  locked: boolean;
  /**
   * What "Ready" means here: `"any"` (personal pane — a binding from either scope serves the viewer)
   * or `"scope"` (workspace pane — only a workspace binding makes a model ready for every member).
   */
  readiness: "any" | "scope";
  /** The list this scope manages, from the one models response. */
  select: (activated: ActivatedModels) => string[];
  /** Rows unioned into the launcher but managed elsewhere (the workspace list, on the personal pane). */
  ghost?: { label: string; select: (activated: ActivatedModels) => string[] };
  /** Persist the full replacement list; returns both lists back. */
  save: (models: string[]) => Promise<ActivatedModels>;
  /** Dedicated model-provider credentials in THIS scope (disconnect is offered only for these). */
  loadConnected: () => Promise<ModelProviderConnectionRow[]>;
  connect: (provider: string, keyName: string, apiKey: string) => Promise<ModelProviderConnectionRow>;
  connectionScope: "personal" | "organization";
  disconnect: (provider: string) => Promise<void>;
}

const SEARCH_RESULT_CAP = 50;

function modelMeta(m: ModelRow): string | null {
  const parts: string[] = [];
  if (m.context) parts.push(`${Math.round(m.context / 1000)}k ctx`);
  if (m.cost_input != null) parts.push(`$${m.cost_input}/M in`);
  return parts.length ? parts.join(" · ") : null;
}

type LauncherProviderGroup = {
  provider: ModelGroupVM["provider"];
  models: Array<{ model: ModelRow; inherited: boolean }>;
};

export function ModelsPane({ scope }: { scope: ModelScope }) {
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [activated, setActivated] = useState<string[]>([]);
  const [ghostIds, setGhostIds] = useState<string[]>([]);
  /** Providers with a dedicated credential in THIS scope (drives disconnect affordances). */
  const [scopeConnections, setScopeConnections] = useState<Map<string, ModelProviderConnectionRow>>(() => new Map());
  /** Providers connected during this visit — flips rows to Ready without a refetch. */
  const [connectedNow, setConnectedNow] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [disconnectingProvider, setDisconnectingProvider] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  /** The ONE spot whose inline write-only credential editor is open. */
  const [keyEntry, setKeyEntry] = useState<{
    anchor: string;
    providerId: string;
    returnFocus: HTMLButtonElement;
  } | null>(null);
  /** Expanded providers in the active workbench. */
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  /** Expanded providers in the full catalog browser. */
  const [browseOpen, setBrowseOpen] = useState<Set<string>>(() => new Set());
  const [tick, setTick] = useState(0);
  /** Full refetch — the server recomputes `connected`, so disconnects can't leave stale "Ready". */
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([fetchModels(), scope.loadConnected()])
      .then(([response, connections]) => {
        if (!live) return;
        const selected = scope.select(response.activated);
        const inherited = scope.ghost ? scope.ghost.select(response.activated) : [];
        const responseById = new Map(response.models.map((model) => [model.id, model]));
        setCatalog(response);
        setActivated(selected);
        setGhostIds(inherited);
        setScopeConnections(new Map(connections.map((connection) => [connection.provider, connection])));
        setConnectedNow(new Set());
        setOpen(new Set([...selected, ...inherited].map((id) => responseById.get(id)?.provider).filter((id): id is string => !!id)));
        setBrowseOpen(new Set());
        setCatalogOpen(false);
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

  /** Per-scope readiness: any binding (personal pane) vs workspace binding only. */
  const usable = (providerId: string): boolean =>
    scopeConnections.has(providerId) ||
    connectedNow.has(providerId) ||
    (scope.readiness === "any" && (providersById.get(providerId)?.connected ?? false));

  const deck = activated.map((id) => byId.get(id)).filter((m): m is ModelRow => !!m);
  const ghost = ghostIds.filter((id) => !activatedSet.has(id)).map((id) => byId.get(id)).filter((m): m is ModelRow => !!m);
  const launcher = [...deck, ...ghost];
  const readyCount = launcher.filter((m) => usable(m.provider)).length;
  const unavailableCount = launcher.filter(
    (model) => !usable(model.provider) && (providersById.get(model.provider)?.envKeys.length ?? 0) === 0,
  ).length;
  const needsKeyCount = launcher.length - readyCount - unavailableCount;

  const groups = useMemo(() => {
    if (!catalog) return [];
    const all = groupModelsByProvider(catalog.models, providers, connectedNow);
    const active = (g: ModelGroupVM) => g.models.some((m) => activatedSet.has(m.id));
    return [...all].sort((a, b) => Number(active(b)) - Number(active(a)));
  }, [catalog, providers, connectedNow, activatedSet]);

  const launcherGroups = useMemo(() => {
    const items = [
      ...deck.map((model) => ({ model, inherited: false })),
      ...ghost.map((model) => ({ model, inherited: true })),
    ];
    const activeProviderIds = new Set(items.map((item) => item.model.provider));
    return groups
      .filter((group) => activeProviderIds.has(group.provider.id))
      .map((group) => ({
        provider: group.provider,
        models: items.filter((item) => item.model.provider === group.provider.id),
      }));
  }, [deck, ghost, groups]);

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
  const addModel = (id: string) => {
    const providerId = byId.get(id)?.provider;
    if (providerId) setOpen((previous) => new Set(previous).add(providerId));
    void save([...activated, id], id);
  };
  const removeModel = (id: string) => void save(activated.filter((m) => m !== id), id);
  const toggleModel = (id: string) => (activatedSet.has(id) ? removeModel(id) : addModel(id));

  const disconnect = async (providerId: string) => {
    if (disconnectingProvider) return;
    setDisconnectingProvider(providerId);
    setError(null);
    try {
      await scope.disconnect(providerId);
      // Refetch instead of pruning local sets: another scope may still make this provider usable.
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect.");
    } finally {
      setDisconnectingProvider(null);
    }
  };

  const restoreKeyFocus = (entry: typeof keyEntry) => {
    requestAnimationFrame(() => {
      const replacement = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-provider-key-trigger]"))
        .find((button) => button.dataset.providerKeyTrigger === entry?.anchor);
      const target = entry?.returnFocus.isConnected ? entry.returnFocus : replacement;
      target?.focus();
    });
  };
  const onKeySaved = (providerId: string, connection: ModelProviderConnectionRow) => {
    const entry = keyEntry;
    setKeyEntry(null);
    setConnectedNow((prev) => new Set(prev).add(providerId));
    setScopeConnections((previous) => new Map(previous).set(providerId, connection));
    restoreKeyFocus(entry);
  };
  const openKeyEntry = (anchor: string, providerId: string, returnFocus: HTMLButtonElement) => {
    setError(null);
    setKeyEntry({ anchor, providerId, returnFocus });
  };
  const closeKeyEntry = () => {
    const entry = keyEntry;
    setKeyEntry(null);
    restoreKeyFocus(entry);
  };
  const setCatalogVisible = (visible: boolean) => {
    if (!visible && keyEntry?.anchor.startsWith("browse:")) setKeyEntry(null);
    setCatalogOpen(visible);
  };

  /** Render the binding editor at exactly ONE anchor. */
  const keyRowAt = (anchor: string) =>
    keyEntry?.anchor === anchor ? (
      <ProviderKeyRow
        providerId={keyEntry.providerId}
        providerName={providersById.get(keyEntry.providerId)?.name ?? keyEntry.providerId}
        envKey={providersById.get(keyEntry.providerId)?.envKeys[0] ?? null}
        scope={scope.connectionScope}
        onConnect={scope.connect}
        onSaved={(connection) => onKeySaved(keyEntry.providerId, connection)}
        onCancel={closeKeyEntry}
      />
    ) : null;

  const inheritedSet = new Set(ghostIds);

  return (
    <div className="sx-pane sx-pane--models">
      <PaneHead title={scope.title} desc={scope.desc} />

      {error && (
        <div className="sx-empty settings-load-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn-sec" onClick={reload}>Retry</button>
        </div>
      )}

      {catalog === null ? (
        <SkeletonDeck />
      ) : (
        <>
          <div className="models-workbench__summary" aria-label="Launcher readiness">
            <span><b>{launcher.length}</b> {launcher.length === 1 ? "model" : "models"} in {scope.ghost ? "your" : "the"} launcher</span>
            <i aria-hidden />
            <span className="is-ready"><b>{readyCount}</b> ready</span>
            {needsKeyCount > 0 && <><i aria-hidden /><span className="is-warning"><b>{needsKeyCount}</b> {needsKeyCount === 1 ? "needs" : "need"} a key</span></>}
            {unavailableCount > 0 && <><i aria-hidden /><span><b>{unavailableCount}</b> unavailable</span></>}
            {ghost.length > 0 && <><i aria-hidden /><span><b>{ghost.length}</b> inherited</span></>}
          </div>

          {!scope.locked && (
            <div className="models-workbench__toolbar">
              <div className="og-search models-workbench__search">
                <Icon name="search" size={15} />
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    if (event.target.value.trim()) setCatalogVisible(false);
                  }}
                  placeholder={`Search active models, providers, or ${catalog.models.length.toLocaleString("en-US")} catalog models`}
                  aria-label="Search active models or catalog"
                />
              </div>
              <button
                type="button"
                className={catalogOpen ? "btn-sec" : "btn-primary"}
                aria-expanded={catalogOpen}
                onClick={() => {
                  setQuery("");
                  setCatalogVisible(!catalogOpen);
                }}
              >
                <Icon name={catalogOpen ? "x" : "plus"} size={14} />
                {catalogOpen ? "Close catalog" : "Add model"}
              </button>
            </div>
          )}

          {searching && (
            <SearchResults
              matches={searchMatches}
              activated={activatedSet}
              inherited={inheritedSet}
              saving={savingId !== null}
              query={query}
              onActivate={addModel}
            />
          )}

          <div className="models-workbench__layout">
            <div className="models-workbench__main">
              <div className="models-workbench__label">
                <span>Active providers</span>
                <span>Credentials apply to every active model below them</span>
              </div>

              {launcherGroups.length === 0 ? (
                <div className="sx-empty models-workbench__empty">
                  {scope.locked
                    ? "Your workspace hasn’t activated any models yet."
                    : "The run launcher only shows models you activate. Search above or browse the catalog to add your first."}
                </div>
              ) : (
                <div className="models-provider-stack">
                  {launcherGroups.map((group) => {
                    const owned = group.models.find((item) => !item.inherited);
                    const anchor = owned ? `deck:${owned.model.id}` : `ghost:${group.models[0]!.model.id}`;
                    return (
                      <ActiveProviderGroup
                        key={group.provider.id}
                        group={group}
                        ready={usable(group.provider.id)}
                        connection={scopeConnections.get(group.provider.id) ?? null}
                        connectionScope={scope.connectionScope}
                        locked={scope.locked}
                        expanded={open.has(group.provider.id)}
                        savingId={savingId}
                        disconnecting={disconnectingProvider === group.provider.id}
                        keyTriggerId={anchor}
                        keyRow={keyRowAt(anchor)}
                        keyEntryOpenForProvider={keyEntry?.providerId === group.provider.id}
                        onToggleExpanded={() =>
                          setOpen((previous) => {
                            const next = new Set(previous);
                            if (next.has(group.provider.id)) next.delete(group.provider.id);
                            else next.add(group.provider.id);
                            return next;
                          })
                        }
                        onAskKey={(trigger) => {
                          openKeyEntry(anchor, group.provider.id, trigger);
                          setOpen((previous) => new Set(previous).add(group.provider.id));
                        }}
                        onDisconnect={() => void disconnect(group.provider.id)}
                        onRemoveModel={removeModel}
                      />
                    );
                  })}
                </div>
              )}

              {!scope.locked && !searching && (
                <button
                  type="button"
                  className="models-workbench__browse"
                  aria-expanded={catalogOpen}
                  onClick={() => setCatalogVisible(!catalogOpen)}
                >
                  <Icon name="layers" size={14} />
                  {catalogOpen ? "Hide model catalog" : `Browse all ${catalog.models.length.toLocaleString("en-US")} models`}
                  <Icon name={catalogOpen ? "chevron-up" : "chevron-right"} size={14} />
                </button>
              )}

              {!scope.locked && catalogOpen && (
                <div className="models-catalog" aria-label="Model catalog by provider">
                  {groups.map((group) => (
                    <ProviderModelsGroup
                      key={group.provider.id}
                      group={group}
                      activated={activatedSet}
                      usable={usable(group.provider.id)}
                      connection={scopeConnections.get(group.provider.id) ?? null}
                      connectionScope={scope.connectionScope}
                      keyTriggerId={`browse:${group.provider.id}`}
                      disconnecting={disconnectingProvider === group.provider.id}
                      expanded={browseOpen.has(group.provider.id)}
                      onToggleExpanded={() =>
                        setBrowseOpen((previous) => {
                          const next = new Set(previous);
                          if (next.has(group.provider.id)) next.delete(group.provider.id);
                          else next.add(group.provider.id);
                          return next;
                        })
                      }
                      savingId={savingId}
                      keyRow={keyRowAt(`browse:${group.provider.id}`)}
                      keyEntryOpenForProvider={keyEntry?.providerId === group.provider.id}
                      onAskKey={(trigger) => {
                        openKeyEntry(`browse:${group.provider.id}`, group.provider.id, trigger);
                        setBrowseOpen((previous) => new Set(previous).add(group.provider.id));
                      }}
                      onDisconnect={() => void disconnect(group.provider.id)}
                      onToggleModel={toggleModel}
                    />
                  ))}
                </div>
              )}
            </div>

            {launcherGroups.length > 0 && (
              <ProviderRail
                groups={launcherGroups}
                readyCount={readyCount}
                needsKeyCount={needsKeyCount}
                unavailableCount={unavailableCount}
                inheritedCount={ghost.length}
                usable={usable}
                connectionScope={scope.connectionScope}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ProviderStatus({ ready, available = true }: { ready: boolean; available?: boolean }) {
  const state = ready ? "ready" : available ? "needs-key" : "unavailable";
  const label = ready ? "Ready" : available ? "Needs key" : "Unavailable";
  return (
    <span className={`models-provider-status models-provider-status--${state}`}>
      <i aria-hidden />
      {label}
    </span>
  );
}

function SearchResults({
  matches,
  activated,
  inherited,
  saving,
  query,
  onActivate,
}: {
  matches: ModelRow[];
  activated: ReadonlySet<string>;
  inherited: ReadonlySet<string>;
  saving: boolean;
  query: string;
  onActivate: (id: string) => void;
}) {
  if (matches.length === 0) return <div className="sx-empty models-search-empty">No models match &ldquo;{query.trim()}&rdquo;.</div>;
  return (
    <section className="models-search-results" aria-label="Model search results">
      <div className="models-search-results__head">
        <span>{matches.length} {matches.length === 1 ? "match" : "matches"}</span>
        {matches.length > SEARCH_RESULT_CAP && <span>Showing first {SEARCH_RESULT_CAP}</span>}
      </div>
      <div className="models-search-results__list">
        {matches.slice(0, SEARCH_RESULT_CAP).map((model) => {
          const activeHere = activated.has(model.id);
          const inheritedHere = inherited.has(model.id) && !activeHere;
          const meta = modelMeta(model);
          return (
            <div className="models-search-row" key={model.id}>
              <span className="models-provider-mark" aria-hidden>{model.provider_name.slice(0, 1).toUpperCase()}</span>
              <div className="models-search-row__identity">
                <strong>{model.name}</strong>
                <code title={model.id}>{model.id}</code>
                {meta && <small>{meta}</small>}
              </div>
              <span className="models-search-row__provider">{model.provider_name}</span>
              {activeHere ? (
                <span className="badge scopebadge">In launcher</span>
              ) : (
                <button
                  type="button"
                  className="btn-sec"
                  disabled={saving}
                  aria-label={inheritedHere ? `Add ${model.name} personally` : `Activate ${model.name}`}
                  onClick={() => onActivate(model.id)}
                >
                  <Icon name="plus" size={13} />
                  {inheritedHere ? "Add personally" : "Activate"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ActiveProviderGroup({
  group,
  ready,
  connection,
  connectionScope,
  locked,
  expanded,
  savingId,
  disconnecting,
  keyTriggerId,
  keyRow,
  keyEntryOpenForProvider,
  onToggleExpanded,
  onAskKey,
  onDisconnect,
  onRemoveModel,
}: {
  group: LauncherProviderGroup;
  ready: boolean;
  connection: ModelProviderConnectionRow | null;
  connectionScope: "personal" | "organization";
  locked: boolean;
  expanded: boolean;
  savingId: string | null;
  disconnecting: boolean;
  keyTriggerId: string;
  keyRow: React.ReactNode;
  keyEntryOpenForProvider: boolean;
  onToggleExpanded: () => void;
  onAskKey: (trigger: HTMLButtonElement) => void;
  onDisconnect: () => void;
  onRemoveModel: (id: string) => void;
}) {
  const { provider, models } = group;
  const canConnect = provider.envKeys.length > 0;
  const inheritedOnly = models.every((item) => item.inherited);
  const credential = connection
    ? `${connection.key_name} · v${connection.credential_version}`
    : ready
      ? "Workspace credential"
      : canConnect
        ? connectionScope === "personal" ? "No personal key" : "Workspace key missing"
        : "No supported key field";
  const scopeLabel = connectionScope === "organization"
    ? "All workspace members"
    : connection
      ? "Only you"
      : ready || inheritedOnly
        ? "Inherited from workspace"
        : "Only you";

  return (
    <section className={`models-provider${!canConnect && !ready ? " is-unavailable" : ""}`}>
      <div className="models-provider__head">
        <button
          type="button"
          className="models-provider__expand"
          aria-label={expanded ? `Collapse ${provider.name}` : `Expand ${provider.name}`}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={13} />
        </button>
        <span className="models-provider-mark" aria-hidden>{provider.name.slice(0, 1).toUpperCase()}</span>
        <div className="models-provider__title">
          <h2>{provider.name}</h2>
          <p title={credential}>{credential}</p>
        </div>
        <span className="models-provider__scope">
          <Icon name={scopeLabel.startsWith("Only") ? "user" : "building-2"} size={13} />
          {scopeLabel}
        </span>
        <span className="models-provider__count">{models.length} active</span>
        <ProviderStatus ready={ready} available={canConnect} />
        {!locked && !keyEntryOpenForProvider && canConnect && (
          <button
            type="button"
            className={!ready ? "btn-primary models-provider__key-action" : "btn-sec models-provider__key-action"}
            data-provider-key-trigger={keyTriggerId}
            onClick={(event) => onAskKey(event.currentTarget)}
          >
            {connection ? "Replace provider key" : ready && connectionScope === "personal" ? "Add personal key" : "Connect"}
          </button>
        )}
        {!locked && connection && !keyEntryOpenForProvider && (
          <button
            type="button"
            className="models-provider__disconnect"
            title={`Disconnect ${provider.name}`}
            aria-label={`Disconnect ${provider.name}`}
            disabled={disconnecting}
            onClick={onDisconnect}
          >
            <Icon name="trash-2" size={14} />
          </button>
        )}
      </div>
      {keyRow}
      {expanded && (
        <div className="models-provider__models">
          {models.map(({ model, inherited }) => {
            const meta = modelMeta(model);
            const pending = savingId === model.id;
            return (
              <div className="models-provider-model" key={model.id} aria-busy={pending || undefined}>
                {inherited ? (
                  <span className="models-provider-model__inherited" title="From workspace"><Icon name="building-2" size={12} /></span>
                ) : (
                  <input
                    type="checkbox"
                    checked
                    disabled={locked || savingId !== null}
                    aria-label={`Deactivate ${model.name}`}
                    onChange={() => onRemoveModel(model.id)}
                  />
                )}
                <div className="models-provider-model__identity">
                  <strong>{model.name}</strong>
                  <code title={model.id}>{model.id}</code>
                  {inherited && <span>From workspace</span>}
                </div>
                <ProviderStatus ready={ready} available={canConnect} />
                {meta && <small>{meta}</small>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProviderRail({
  groups,
  readyCount,
  needsKeyCount,
  unavailableCount,
  inheritedCount,
  usable,
  connectionScope,
}: {
  groups: LauncherProviderGroup[];
  readyCount: number;
  needsKeyCount: number;
  unavailableCount: number;
  inheritedCount: number;
  usable: (providerId: string) => boolean;
  connectionScope: "personal" | "organization";
}) {
  return (
    <aside className="models-workbench__rail" aria-label="Provider summary">
      <section className="models-rail-block">
        <h2>Launcher readiness</h2>
        <div className="models-rail-metrics">
          <span><ProviderStatus ready /><b>{readyCount}</b></span>
          <span><ProviderStatus ready={false} /><b>{needsKeyCount}</b></span>
          {unavailableCount > 0 && <span><ProviderStatus ready={false} available={false} /><b>{unavailableCount}</b></span>}
          {inheritedCount > 0 && <span className="models-rail-inherited"><span>Inherited</span><b>{inheritedCount}</b></span>}
        </div>
      </section>
      <section className="models-rail-block models-rail-providers">
        <div className="models-rail-block__head"><h2>Providers</h2><span>{groups.length}</span></div>
        {groups.map((group) => {
          const available = group.provider.envKeys.length > 0;
          return (
            <div className="models-rail-provider" key={group.provider.id}>
              <span className="models-provider-mark" aria-hidden>{group.provider.name.slice(0, 1).toUpperCase()}</span>
              <strong>{group.provider.name}</strong>
              <ProviderStatus ready={usable(group.provider.id)} available={available} />
            </div>
          );
        })}
      </section>
      <div className="models-rail-note">
        <Icon name={connectionScope === "organization" ? "shield-check" : "lock"} size={15} />
        <div>
          <strong>{connectionScope === "organization" ? "Owner and admin access" : "Keys stay write-only"}</strong>
          <p>{connectionScope === "organization"
            ? "Workspace provider keys are available to every member and managed by owners and admins."
            : "Plaintext credentials are encrypted immediately and never shown again."}</p>
        </div>
      </div>
    </aside>
  );
}

function ProviderModelsGroup({
  group,
  activated,
  usable,
  connection,
  connectionScope,
  keyTriggerId,
  disconnecting,
  expanded,
  onToggleExpanded,
  savingId,
  keyRow,
  keyEntryOpenForProvider,
  onAskKey,
  onDisconnect,
  onToggleModel,
}: {
  group: ModelGroupVM;
  activated: ReadonlySet<string>;
  usable: boolean;
  connection: ModelProviderConnectionRow | null;
  connectionScope: "personal" | "organization";
  keyTriggerId: string;
  disconnecting: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  savingId: string | null;
  keyRow: React.ReactNode;
  keyEntryOpenForProvider: boolean;
  onAskKey: (trigger: HTMLButtonElement) => void;
  onDisconnect: () => void;
  onToggleModel: (id: string) => void;
}) {
  const { provider } = group;
  const activeCount = group.models.reduce((count, model) => count + (activated.has(model.id) ? 1 : 0), 0);
  const canConnect = provider.envKeys.length > 0;
  return (
    <section className="models-catalog-provider">
      <div className="models-catalog-provider__head">
        <button
          type="button"
          className="models-catalog-provider__expand"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${provider.name}` : `Expand ${provider.name}`}
        >
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
          <span className="models-provider-mark" aria-hidden>{provider.name.slice(0, 1).toUpperCase()}</span>
          <strong>{provider.name}</strong>
          <span>{group.models.length}</span>
          {activeCount > 0 && <em>{activeCount} active</em>}
        </button>
        <ProviderStatus ready={usable} available={canConnect} />
        {!keyEntryOpenForProvider && canConnect && (
          <button
            type="button"
            className="btn-sec"
            data-provider-key-trigger={keyTriggerId}
            onClick={(event) => onAskKey(event.currentTarget)}
          >
            {connection ? "Replace" : usable && connectionScope === "personal" ? "Add personal key" : "Connect"}
          </button>
        )}
        {connection && !keyEntryOpenForProvider && (
          <button
            type="button"
            className="models-provider__disconnect"
            title={`Disconnect ${provider.name}`}
            aria-label={`Disconnect ${provider.name}`}
            disabled={disconnecting}
            onClick={onDisconnect}
          >
            <Icon name="trash-2" size={14} />
          </button>
        )}
      </div>
      {keyRow}
      {expanded && (
        <div className="models-catalog-provider__models">
          {group.models.map((model) => {
            const active = activated.has(model.id);
            const meta = modelMeta(model);
            return (
              <label className="models-catalog-model" key={model.id} aria-busy={savingId === model.id || undefined}>
                <input
                  type="checkbox"
                  checked={active}
                  disabled={savingId !== null}
                  onChange={() => onToggleModel(model.id)}
                  aria-label={`${active ? "Deactivate" : "Activate"} ${model.name}`}
                />
                <span>
                  <strong>{model.name}</strong>
                  <code title={model.id}>{model.id}{meta ? ` · ${meta}` : ""}</code>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Store one model-provider key in its dedicated write-only credential store. */
export function ProviderKeyRow({
  providerId,
  providerName,
  envKey,
  scope,
  onConnect,
  onSaved,
  onCancel,
}: {
  providerId: string;
  providerName: string;
  envKey: string | null;
  scope: "personal" | "organization";
  onConnect: (provider: string, keyName: string, apiKey: string) => Promise<ModelProviderConnectionRow>;
  onSaved: (connection: ModelProviderConnectionRow) => void;
  onCancel: () => void;
}) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const [apiKey, setApiKey] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!apiKey.trim() || busy || !envKey) return;
    setBusy(true);
    setFieldError(null);
    try {
      const connection = await onConnect(providerId, envKey, apiKey);
      setApiKey("");
      onSaved(connection);
    } catch (e) {
      // Provider credentials are write-only. Do not retain a submitted value after any response.
      const message = e instanceof Error ? e.message : "Could not save the provider key. Enter it again to retry.";
      setApiKey("");
      setFieldError(message);
      setBusy(false);
    }
  };
  const cancel = () => {
    if (busy) return;
    setApiKey("");
    setFieldError(null);
    onCancel();
  };
  return (
    // data-esc-guard: the settings drawer's capture-phase Escape handler yields to this widget,
    // so Escape cancels the key entry instead of closing the whole drawer mid-typing.
    <div
      className="mrow models-provider-key-row"
      data-esc-guard
      style={{ flexWrap: "wrap", gap: 8 }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <span className="keyic">
        <Icon name="key" size={15} />
      </span>
      <div className="mrow__id">
        <div className="og-mname">{providerName} provider key</div>
        <div className="og-memail">
          This credential is stored separately from Secrets and is never displayed again.
        </div>
      </div>
      <div className="provider-key-editor">
        <label htmlFor={inputId}>{providerName} API key</label>
        <input
          id={inputId}
          className="sx-input mono"
          type="password"
          value={apiKey}
          autoFocus
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          disabled={!envKey || busy}
          aria-invalid={!!fieldError || undefined}
          aria-describedby={`${helpId}${fieldError ? ` ${errorId}` : ""}`}
          onChange={(event) => {
            setApiKey(event.target.value);
            if (fieldError) setFieldError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
        />
        <p id={helpId}>
          {scope === "organization"
            ? "Available to workspace runs. The plaintext is encrypted immediately and cannot be read back."
            : "Personal to you. The plaintext is encrypted immediately and cannot be read back."}
        </p>
        {fieldError && <p className="vault-field__error" id={errorId} role="alert">{fieldError} Enter the key again to retry.</p>}
        <div className="provider-key-editor__actions">
          <button type="button" className="btn-primary" disabled={!apiKey.trim() || busy || !envKey} onClick={() => void save()}>
            {busy ? "Connecting…" : "Connect"}
          </button>
          <button type="button" className="btn-sec" disabled={busy} onClick={cancel}>Cancel</button>
        </div>
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
