"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Companion,
  CompanionProvidersResponse,
  CompanionThread as Thread,
} from "@companion/contracts";
import type { OrgVM } from "@/lib/types";
import {
  getCompanionThread,
  sendCompanionMessage,
  setCompanionProvider,
  startCompanionRuntime,
  syncCompanionThread,
} from "@/lib/companions";
import { Icon } from "../Icon";
import { CompanionProvidersDialog } from "./CompanionProvidersDialog";
import { CompanionThread } from "./CompanionThread";
import { NewCompanionDialog } from "./NewCompanionDialog";
import { ShareCompanionDialog } from "./ShareCompanionDialog";
import { companionStatus, relativeTime } from "./status";
import { createThreadQueue } from "./threadQueue";
import { Onboarding } from "../org/Onboarding";
import { useOrgActions } from "../org/useOrgActions";
import { Sidebar } from "../skills/Sidebar";
import { skillsRouteHref, type SkillsLibrary } from "../skills/route";
import type { TreeRow } from "../skills/sidebarTree";

/** Awake threads pull Pi events; asleep and Viewer threads only re-read the control plane. */
const LIVE_POLL_MS = 2_000;
const READ_MODEL_POLL_MS = 8_000;

export interface CompanionNavigation {
  mineTreeRows: TreeRow[];
  orgTreeRows: TreeRow[];
  mineCount: number;
  orgCount: number;
  installedCount: number;
  installedUpdateCount: number;
  localUpdateCount: number;
  archivedCount: number;
}

/** Server markup keeps the stable ISO day; the relative form appears once the client owns the clock. */
function UpdatedAt({ iso }: { iso: string }) {
  const [text, setText] = useState(() => iso.slice(0, 10));
  useEffect(() => setText(relativeTime(iso)), [iso]);
  return <time className="companions-row__time" dateTime={iso}>{text}</time>;
}

function threadUrl(companionId: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (companionId) url.searchParams.set("companion", companionId);
  else url.searchParams.delete("companion");
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

export function CompanionsApp({
  orgs,
  currentOrg,
  navigation,
  initialCompanions,
  initialProviders,
  initialCompanionId,
}: {
  orgs: OrgVM[];
  currentOrg: OrgVM;
  navigation: CompanionNavigation;
  initialCompanions: Companion[];
  initialProviders: CompanionProvidersResponse;
  initialCompanionId?: string | null;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [companions, setCompanions] = useState(initialCompanions);
  const [providers, setProviders] = useState(initialProviders);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [managingProviders, setManagingProviders] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<Companion | null>(null);
  const [openedId, setOpenedId] = useState<string | null>(
    () => initialCompanions.some((item) => item.id === initialCompanionId)
      ? initialCompanionId ?? null
      : null,
  );
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [waking, setWaking] = useState(false);
  const threadRequestRef = useRef(0);
  const threadQueueRef = useRef(createThreadQueue());
  const noop = () => {};

  const opened = useMemo(
    () => companions.find((companion) => companion.id === openedId) ?? null,
    [companions, openedId],
  );
  const canRunOpened = opened !== null && opened.access !== "viewer";
  const openedAwake = opened?.runtime.state === "running";

  const providerName = (providerId: string) =>
    providers.catalog.find((provider) => provider.id === providerId)?.name ?? providerId;
  const fallbackProvider = providers.default_provider_id
    ?? providers.connections[0]?.provider_id
    ?? "";

  const sidebarCompanions = useMemo(
    () => companions.map((companion) => {
      const status = companionStatus(companion.runtime.state);
      return { id: companion.id, name: companion.name, status: status.label, tone: status.tone };
    }),
    [companions],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-US");
    if (!needle) return companions;
    return companions.filter((companion) =>
      companion.name.toLocaleLowerCase("en-US").includes(needle)
      || (companion.persona ?? "").toLocaleLowerCase("en-US").includes(needle));
  }, [companions, query]);

  const openCompanion = (companion: Companion) => {
    threadRequestRef.current += 1;
    setOpenedId(companion.id);
    setThread(null);
    setThreadError(null);
    threadUrl(companion.id);
  };

  const closeThread = () => {
    threadRequestRef.current += 1;
    setOpenedId(null);
    setThread(null);
    setThreadError(null);
    threadUrl(null);
  };

  /** One refresh of the open thread: Pi delivery plus projection when awake, read model otherwise. */
  const refreshThread = useCallback(async (live: boolean) => {
    if (!openedId) return;
    const requestId = ++threadRequestRef.current;
    try {
      const next = await threadQueueRef.current.run(
        () => live
          ? syncCompanionThread(currentOrg.id, openedId)
          : getCompanionThread(currentOrg.id, openedId),
        { skipWhenBusy: true },
      );
      if (next && requestId === threadRequestRef.current) {
        setThread(next);
        setThreadError(null);
      }
    } catch (cause) {
      if (requestId === threadRequestRef.current) {
        setThreadError(cause instanceof Error ? cause.message : "This thread could not be loaded.");
      }
    }
  }, [currentOrg.id, openedId]);

  useEffect(() => {
    if (!openedId) return;
    void refreshThread(false);
  }, [openedId, refreshThread]);

  useEffect(() => {
    if (!openedId) return;
    const live = canRunOpened && openedAwake;
    const timer = setInterval(
      () => void refreshThread(live),
      live ? LIVE_POLL_MS : READ_MODEL_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [canRunOpened, openedAwake, openedId, refreshThread]);

  const onSend = async (content: string) => {
    if (!openedId) return;
    setSending(true);
    setThreadError(null);
    try {
      // Sending also delivers the backlog, so it waits for an in-flight sync instead of racing it.
      const next = await threadQueueRef.current.run(
        () => sendCompanionMessage(currentOrg.id, openedId, content),
        { skipWhenBusy: false },
      );
      threadRequestRef.current += 1;
      if (next) setThread(next);
    } catch (cause) {
      setThreadError(cause instanceof Error ? cause.message : "The message could not be sent.");
    } finally {
      setSending(false);
    }
  };

  const onWake = async () => {
    if (!opened) return;
    setWaking(true);
    setThreadError(null);
    try {
      const updated = await startCompanionRuntime(currentOrg.id, opened.id);
      setCompanions((current) => current.map((item) => item.id === updated.id ? updated : item));
      await refreshThread(true);
    } catch (cause) {
      setThreadError(cause instanceof Error ? cause.message : "This Companion could not be woken.");
    } finally {
      setWaking(false);
    }
  };

  const onCreated = (companion: Companion) => {
    setCompanions((current) => [companion, ...current]);
    setCreating(false);
    setError(null);
    openCompanion(companion);
  };

  const onSetProvider = async (companion: Companion) => {
    if (!fallbackProvider) {
      setError("Connect a provider before configuring this Companion.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await setCompanionProvider(currentOrg.id, companion.id, fallbackProvider);
      setCompanions((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider could not be set.");
    } finally {
      setBusy(false);
    }
  };

  const navigateToLabel = (lib: SkillsLibrary, path: string) => {
    router.push(skillsRouteHref({ lib, kind: "label", label: path }));
  };
  const toggleExpanded = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileSidebarOpen]);

  const dialogOpen = sharing !== null || creating || managingProviders;

  useEffect(() => {
    if (!dialogOpen) return;
    const sidebar = document.querySelector<HTMLElement>(".side");
    const sidebarWasInert = sidebar?.inert ?? false;
    if (sidebar) sidebar.inert = true;
    return () => {
      if (sidebar) sidebar.inert = sidebarWasInert;
    };
  }, [dialogOpen]);

  return (
    <div className={"app app--skills companions-app" + (mobileSidebarOpen ? " app--side-open" : "")}>
      <Sidebar
        orgs={orgs}
        currentOrg={currentOrg}
        onSwitchOrg={orgActions.switchOrg}
        onOnboard={orgActions.setOnboarding}
        onOpenSettings={() => router.push("/settings")}
        onWarmSettings={noop}
        mineTreeRows={navigation.mineTreeRows}
        orgTreeRows={navigation.orgTreeRows}
        expanded={expanded}
        onToggleExpand={toggleExpanded}
        selection={null}
        mineCount={navigation.mineCount}
        orgCount={navigation.orgCount}
        installedCount={navigation.installedCount}
        installedUpdateCount={navigation.installedUpdateCount}
        onOpenPalette={() => router.push("/skills")}
        onSelectMineAll={() => router.push(skillsRouteHref({ lib: "mine", kind: "all" }))}
        onSelectOrgAll={() => router.push(skillsRouteHref({ lib: "org", kind: "all" }))}
        onSelectInstalled={() => router.push(skillsRouteHref({ lib: "mine", kind: "installed" }))}
        onSelectLabel={navigateToLabel}
        onCreateLabel={noop}
        onSetLabelColor={noop}
        onSetLabelIcon={noop}
        onRenameLabel={noop}
        onDeleteLabel={noop}
        drag={null}
        hovered={null}
        openPendingPath={null}
        dropDone={null}
        onReparentLabel={noop}
        onLabelStartDrag={noop}
        onSelectLocal={() => router.push(skillsRouteHref({ kind: "local" }))}
        onSelectArchived={() => router.push(skillsRouteHref({ kind: "archived" }))}
        onSelectSecrets={() => router.push("/secrets")}
        companionsEnabled
        mode="companions"
        onSelectMode={(mode) => {
          if (mode === "skills") router.push("/skills");
        }}
        companions={sidebarCompanions}
        activeCompanionId={openedId}
        onSelectCompanion={(companionId) => {
          const companion = companions.find((item) => item.id === companionId);
          if (companion) openCompanion(companion);
        }}
        navigationOnly
        localActive={false}
        localUpdateCount={navigation.localUpdateCount}
        archivedActive={false}
        archivedCount={navigation.archivedCount}
        mobileOpen={mobileSidebarOpen}
        onToggleMobile={() => setMobileSidebarOpen((open) => !open)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />
      {mobileSidebarOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <main
        className={"companions-main" + (opened ? " companions-main--chat" : "")}
        aria-hidden={mobileSidebarOpen || dialogOpen || undefined}
        inert={mobileSidebarOpen || dialogOpen ? true : undefined}
      >
        {opened ? (
          <>
            {opened.access === "owner" && !opened.runtime.provider_ids.length && fallbackProvider && (
              <div className="companions-thread-notice">
                <span>This Companion has no provider yet.</span>
                <button
                  type="button"
                  className="cds-btn cds-btn--secondary cds-btn--sm"
                  disabled={busy}
                  onClick={() => void onSetProvider(opened)}
                >
                  {busy ? "Setting..." : `Set ${providerName(fallbackProvider)}`}
                </button>
              </div>
            )}
            <CompanionThread
              companion={opened}
              thread={thread}
              error={threadError}
              busy={sending}
              waking={waking}
              onBack={closeThread}
              onSend={(content) => void onSend(content)}
              onWake={() => void onWake()}
            />
          </>
        ) : (
          <>
            <header className="companions-head">
              <h1>
                Companions
                <span className="companions-count tnum">{companions.length}</span>
              </h1>
              <div className="companions-head-actions">
                {providers.can_manage && (
                  <button
                    type="button"
                    className="cds-btn cds-btn--secondary cds-btn--md"
                    onClick={() => setManagingProviders(true)}
                  >
                    Providers
                  </button>
                )}
                <button
                  type="button"
                  className="cds-btn cds-btn--primary cds-btn--md"
                  onClick={() => setCreating(true)}
                >
                  <Icon name="plus" size={15} /> New companion
                </button>
              </div>
            </header>

            <div className="companions-content">
              {error && <div className="companions-error" role="alert">{error}</div>}

              {companions.length === 0 ? (
                <div className="companions-empty">
                  <Icon name="bot" size={22} />
                  <strong>No Companions yet</strong>
                  <p>A Companion is a name, one line of persona, and a model provider. It stays asleep until you open it.</p>
                  <button
                    type="button"
                    className="cds-btn cds-btn--primary cds-btn--md"
                    onClick={() => setCreating(true)}
                  >
                    New companion
                  </button>
                </div>
              ) : (
                <>
                  <label className="companions-search">
                    <Icon name="search" size={15} />
                    <input
                      type="search"
                      value={query}
                      placeholder="Search companions"
                      aria-label="Search companions"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>

                  <div className="companions-list">
                    <div className="companions-row companions-row--head">
                      <span>Companion</span>
                      <span>Status</span>
                      <span>Updated</span>
                      <span>Access</span>
                    </div>
                    {visible.map((companion) => {
                      const status = companionStatus(companion.runtime.state);
                      return (
                        <div className="companions-row" key={companion.id}>
                          <button
                            type="button"
                            className="companions-row__main"
                            onClick={() => openCompanion(companion)}
                          >
                            <span className="companions-avatar" aria-hidden="true">
                              {companion.name.trim().slice(0, 1).toLocaleUpperCase("en-US") || "C"}
                            </span>
                            <span className="companions-row__text">
                              <strong>{companion.name}</strong>
                              <span>
                                {companion.persona
                                  ?? providerName(companion.runtime.provider_ids[0] ?? "No provider")}
                              </span>
                            </span>
                          </button>
                          <span className={`companions-state companions-state--${status.tone}`}>
                            <i aria-hidden="true" />
                            {status.label}
                          </span>
                          <UpdatedAt iso={companion.updated_at} />
                          <span className="companions-row-actions">
                            <span className="companions-role">{companion.access}</span>
                            {companion.access === "owner" && (
                              <button
                                type="button"
                                className="cds-btn cds-btn--ghost cds-btn--sm"
                                onClick={() => setSharing(companion)}
                              >
                                Share
                              </button>
                            )}
                          </span>
                        </div>
                      );
                    })}
                    {visible.length === 0 && (
                      <p className="companions-list-empty">No Companion matches this search.</p>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </main>

      {creating && (
        <NewCompanionDialog
          orgId={currentOrg.id}
          providers={providers}
          onCreated={onCreated}
          onConnectProvider={() => {
            setCreating(false);
            setManagingProviders(true);
          }}
          onClose={() => setCreating(false)}
        />
      )}

      {managingProviders && (
        <CompanionProvidersDialog
          orgId={currentOrg.id}
          providers={providers}
          onProviders={setProviders}
          onClose={() => setManagingProviders(false)}
        />
      )}

      {sharing && (
        <ShareCompanionDialog
          orgId={currentOrg.id}
          companion={sharing}
          onClose={() => setSharing(null)}
        />
      )}

      {orgActions.onboarding && (
        <Onboarding
          mode={orgActions.onboarding}
          onMode={orgActions.setOnboarding}
          onCreate={orgActions.createOrg}
          onJoin={orgActions.joinOrg}
          busy={orgActions.busy}
        />
      )}
      {orgActions.error && (
        <div className="og-toast" role="alert" onClick={() => orgActions.setError(null)}>
          {orgActions.error}
        </div>
      )}
    </div>
  );
}
