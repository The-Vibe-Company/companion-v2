"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Companion,
  CompanionPluginAccount,
  CompanionProvidersResponse,
  CompanionThread as Thread,
} from "@companion/contracts";
import type { OrgVM } from "@/lib/types";
import {
  getCompanionRuntime,
  getCompanionThread,
  listCompanions,
  openCompanionDesktop,
  sendCompanionMessage,
  setCompanionProvider,
  startCompanionRuntime,
  syncCompanionThread,
} from "@/lib/companions";
import { Icon } from "../Icon";
import { CompanionProvidersDialog } from "./CompanionProvidersDialog";
import { CompanionPlugins } from "./CompanionPlugins";
import { CompanionThread } from "./CompanionThread";
import { NewCompanionDialog } from "./NewCompanionDialog";
import { ShareCompanionDialog } from "./ShareCompanionDialog";
import { applyCompanionRuntime } from "./runtimePool";
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
/**
 * How often a runner's status chip re-observes the Box it already runs. This read never resumes a
 * Box, and a Viewer never makes it, so the chip stays honest about a Box that stopped underneath it
 * without anyone's Companion being woken to find out.
 */
const BOX_STATUS_POLL_MS = 15_000;

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
  if (companionId) {
    url.searchParams.set("companion", companionId);
    url.searchParams.delete("view");
  }
  else url.searchParams.delete("companion");
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

export function CompanionsApp({
  orgs,
  currentOrg,
  navigation,
  initialCompanions,
  initialProviders,
  initialPlugins,
  initialCompanionId,
  initialPluginsOpen = false,
}: {
  orgs: OrgVM[];
  currentOrg: OrgVM;
  navigation: CompanionNavigation;
  initialCompanions: Companion[];
  initialProviders: CompanionProvidersResponse;
  initialPlugins: CompanionPluginAccount[];
  initialCompanionId?: string | null;
  initialPluginsOpen?: boolean;
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
  const [pluginsOpen, setPluginsOpen] = useState(initialPluginsOpen && !initialCompanionId);
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
  /**
   * Why the last desktop handoff opened nothing. It is kept apart from `threadError` because the
   * live thread poll clears that one every couple of seconds, which would erase this answer before
   * anyone could read it and leave a failed handoff looking like nothing happened at all.
   */
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [waking, setWaking] = useState(false);
  const [openingDesktop, setOpeningDesktop] = useState(false);
  const threadRequestRef = useRef(0);
  const threadQueueRef = useRef(createThreadQueue());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
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

  const closeThread = () => {
    const wasOpen = openedId;
    threadRequestRef.current += 1;
    setOpenedId(null);
    setThread(null);
    setThreadError(null);
    setDesktopError(null);
    threadUrl(null);
    // Leaving the thread unmounts the back button, so focus returns to the row it came from.
    window.requestAnimationFrame(() => {
      (wasOpen ? rowRefs.current.get(wasOpen) : null)?.focus();
    });
  };

  const openPlugins = () => {
    setPluginsOpen(true);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("companion");
    url.searchParams.set("view", "plugins");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };

  const closePlugins = () => {
    setPluginsOpen(false);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
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

  /**
   * One Companion's runtime answer belongs to every Companion that shares its Box. The workspace
   * owns the Box, so a wake, a stop, or a status read speaks for the whole scope: applying it to the
   * answered row alone leaves a sibling showing the chip from before the answer.
   */
  const applyRuntime = useCallback((updated: Companion) => {
    setCompanions((current) => applyCompanionRuntime(current, updated, currentOrg.kind));
  }, [currentOrg.kind]);

  /**
   * Re-read every Companion from the control plane. The list already projects each one's shared Box,
   * so this is what makes a chip honest after a lifecycle write, whichever Companion is opened next.
   */
  const reloadCompanions = useCallback(async () => {
    try {
      setCompanions(await listCompanions(currentOrg.id));
    } catch {
      // Keep the projection already on screen rather than emptying the list over a failed read.
    }
  }, [currentOrg.id]);

  /**
   * Re-read one Companion; a failed read leaves the current row alone. The control-plane read is the
   * default, so it is safe for a Viewer and after a failed wake. A live read observes an already
   * running Box for a runner and still never resumes one.
   */
  const refreshCompanion = useCallback(async (companionId: string, live = false) => {
    try {
      applyRuntime(await getCompanionRuntime(currentOrg.id, companionId, { live }));
    } catch {
      // The failure that prompted this read is already on screen; do not replace it with this one.
    }
  }, [applyRuntime, currentOrg.id]);

  const openCompanion = (companion: Companion) => {
    threadRequestRef.current += 1;
    setOpenedId(companion.id);
    setThread(null);
    setThreadError(null);
    setDesktopError(null);
    setPluginsOpen(false);
    threadUrl(companion.id);
    // The list this row came from may predate a wake made on a Companion sharing its Box, so the
    // chip is re-read from the control plane rather than trusted to be current. The read never
    // observes the Box, so opening a Companion still cannot wake one.
    void refreshCompanion(companion.id);
  };

  // Only a runner whose Box is already running observes it, so opening a thread never wakes a Box
  // and a Viewer's chip stays on the control-plane projection.
  useEffect(() => {
    if (!openedId || !canRunOpened || !openedAwake) return;
    const timer = setInterval(() => void refreshCompanion(openedId, true), BOX_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [canRunOpened, openedAwake, openedId, refreshCompanion]);

  /** Resolves false when the message never reached the control plane, so the composer keeps its text. */
  const onSend = async (content: string): Promise<boolean> => {
    if (!openedId) return false;
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
      return true;
    } catch (cause) {
      setThreadError(cause instanceof Error ? cause.message : "The message could not be sent.");
      return false;
    } finally {
      setSending(false);
    }
  };

  const onWake = async () => {
    if (!opened) return;
    const companionId = opened.id;
    setWaking(true);
    setThreadError(null);
    try {
      const updated = await startCompanionRuntime(currentOrg.id, companionId);
      // One wake starts the Box the whole workspace shares, so every loaded Companion in the scope
      // reads that Box immediately, and the list is re-read to confirm it from the control plane.
      applyRuntime(updated);
      await Promise.all([reloadCompanions(), refreshThread(true)]);
    } catch (cause) {
      setThreadError(cause instanceof Error ? cause.message : "This Companion could not be woken.");
      // A failed start records why on the Companion, so re-read it: the status pill must show Error
      // rather than the state the wake started from, and the reason must survive a reload.
      await refreshCompanion(companionId);
    } finally {
      setWaking(false);
    }
  };

  /**
   * Computer use for a runner: one handoff to the Box desktop Lux drives. The Box must already be
   * running, so this never creates or resumes one, and the returned URL opens in its own tab instead
   * of being stored anywhere.
   *
   * A browser only honours a new tab that the click itself asked for, so the tab is claimed on
   * `about:blank` before the handoff request and pointed at the desktop once the URL arrives;
   * anything else closes the claimed tab and leaves the reason on the thread. The claim never asks
   * for the empty URL: a browser may read that as this page and leave a copy of the app behind
   * instead of a tab to hand off. `noopener` cannot be passed as a window feature without losing the
   * handle the handoff needs, so the tab disowns this one only once it is on its way to the desktop:
   * disowning it first can detach the handle, and the handoff then silently never lands.
   */
  const onDesktop = async () => {
    if (!opened || !canRunOpened || !openedAwake) return;
    const tab = window.open("about:blank", "_blank");
    setOpeningDesktop(true);
    setDesktopError(null);
    try {
      const desktop = await openCompanionDesktop(currentOrg.id, opened.id);
      if (desktop.desktop_url && tab) {
        // A refused handoff throws, and the catch below closes the tab and says why rather than
        // leaving a blank tab open as if the desktop had been reached.
        tab.location.replace(desktop.desktop_url);
        try {
          tab.opener = null;
        } catch {
          // A tab already on its way to the desktop may refuse the write; it cannot reach back
          // through a stale handle either way, and the handoff itself has already happened.
        }
        return;
      }
      tab?.close();
      if (!desktop.desktop_url) {
        setDesktopError(desktop.provisioning
          ? "The Box desktop is still starting. Try again in a moment."
          : "This Box has no desktop to open yet.");
        return;
      }
      setDesktopError("This browser blocked the Box desktop tab. Allow pop-ups here, then try again.");
    } catch (cause) {
      tab?.close();
      setDesktopError(cause instanceof Error ? cause.message : "The Box desktop could not be opened.");
    } finally {
      setOpeningDesktop(false);
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
      // Provider selection is the Companion's own, so it lands on that row alone.
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
              error={desktopError ?? threadError}
              busy={sending}
              waking={waking}
              openingDesktop={openingDesktop}
              onBack={closeThread}
              onSend={onSend}
              onWake={() => void onWake()}
              onDesktop={() => void onDesktop()}
            />
          </>
        ) : pluginsOpen ? (
          <CompanionPlugins
            orgId={currentOrg.id}
            initialAccounts={initialPlugins}
            onBack={closePlugins}
          />
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
                  className="cds-btn cds-btn--secondary cds-btn--md"
                  onClick={openPlugins}
                >
                  <Icon name="plug-zap" size={15} /> Plugins
                </button>
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
                            ref={(node) => {
                              if (node) rowRefs.current.set(companion.id, node);
                              else rowRefs.current.delete(companion.id);
                            }}
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
                          <span
                            className={`companions-state companions-state--${status.tone}`}
                            title={companion.runtime.last_error ?? undefined}
                          >
                            <i aria-hidden="true" />
                            {status.label}
                          </span>
                          <UpdatedAt iso={companion.updated_at} />
                          <span className="companions-row-actions">
                            <span className="companions-role">{companion.access}</span>
                            {companion.access === "owner" && currentOrg.kind !== "personal" && (
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
