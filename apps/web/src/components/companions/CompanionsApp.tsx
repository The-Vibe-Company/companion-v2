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
  openCompanionDesktop,
  sendCompanionMessage,
  setCompanionProvider,
  startCompanionRuntime,
  syncCompanionThread,
} from "@/lib/companions";
import { Icon } from "../Icon";
import { CompanionProvidersDialog } from "./CompanionProvidersDialog";
import { CompanionPlugins } from "./CompanionPlugins";
import { CompanionSettings } from "./CompanionSettings";
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
/**
 * How often a runner's status chip re-observes the Box it already runs. This read never resumes a
 * Box, and a Viewer never makes it, so the chip stays honest about a Box that stopped underneath it
 * without anyone's Companion being woken to find out.
 */
const BOX_STATUS_POLL_MS = 15_000;
/**
 * How often a Companion mid-transition re-reads the lifecycle it is waiting on. Nothing else does:
 * the Box-status poll below starts only once the state is already `running`, and the request that
 * began the transition answers once, before the lifecycle finishes when it outlives a proxy. That
 * left the chip reporting Starting against a Box that was already up, beside a reply Pi had already
 * sent. This is the control-plane projection, so it never resumes a Box and is safe for a Viewer.
 */
const PENDING_POLL_MS = 3_000;

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
  initialSettingsCompanionId,
  initialPluginsOpen = false,
}: {
  orgs: OrgVM[];
  currentOrg: OrgVM;
  navigation: CompanionNavigation;
  initialCompanions: Companion[];
  initialProviders: CompanionProvidersResponse;
  initialPlugins: CompanionPluginAccount[];
  initialCompanionId?: string | null;
  initialSettingsCompanionId?: string | null;
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
  const [settingsId, setSettingsId] = useState<string | null>(
    () => initialCompanions.some(
      (item) => item.id === initialSettingsCompanionId && item.access !== "viewer",
    )
      ? initialSettingsCompanionId ?? null
      : null,
  );
  const [openedId, setOpenedId] = useState<string | null>(
    () => !initialSettingsCompanionId
      && initialCompanions.some((item) => item.id === initialCompanionId)
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
  /** Newest runtime read per Companion, so a slower one cannot answer over it. */
  const companionReadRef = useRef(new Map<string, number>());
  const threadQueueRef = useRef(createThreadQueue());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const noop = () => {};

  const opened = useMemo(
    () => companions.find((companion) => companion.id === openedId) ?? null,
    [companions, openedId],
  );
  const settingsCompanion = useMemo(
    () => companions.find((companion) => companion.id === settingsId) ?? null,
    [companions, settingsId],
  );
  const canRunOpened = opened !== null && opened.access !== "viewer";
  const openedAwake = opened?.runtime.state === "running";
  // A lifecycle the control plane is still resolving. `error` is not one of these: it is where a
  // failed transition settles, and its reason is already on screen.
  const openedPending = opened?.runtime.state === "provisioning" || opened?.runtime.state === "stopping";

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
    setDesktopError(null);
    setPluginsOpen(false);
    setSettingsId(null);
    threadUrl(companion.id);
  };

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

  const closeSettings = () => {
    setSettingsId(null);
    router.push("/companions");
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
   * Re-read one Companion; a failed read leaves the current row alone. The control-plane read is the
   * default, so it is safe for a Viewer and after a failed wake. A live read observes an already
   * running Box for a runner and still never resumes one.
   */
  const refreshCompanion = useCallback(async (companionId: string, live = false) => {
    // Reads of one Companion can overlap, and a lifecycle is watched closely enough that they will:
    // an older read that answers late must not put a state the Companion has already left back on
    // screen, which is how a chip that had reached Online would blink back to Starting.
    const readId = (companionReadRef.current.get(companionId) ?? 0) + 1;
    companionReadRef.current.set(companionId, readId);
    try {
      const latest = await getCompanionRuntime(currentOrg.id, companionId, { live });
      if (companionReadRef.current.get(companionId) !== readId) return;
      setCompanions((current) => current.map((item) => item.id === latest.id ? latest : item));
    } catch {
      // The failure that prompted this read is already on screen; do not replace it with this one.
    }
  }, [currentOrg.id]);

  // Only a runner whose Box is already running observes it, so opening a thread never wakes a Box
  // and a Viewer's chip stays on the control-plane projection.
  useEffect(() => {
    if (!openedId || !canRunOpened || !openedAwake) return;
    const timer = setInterval(() => void refreshCompanion(openedId, true), BOX_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [canRunOpened, openedAwake, openedId, refreshCompanion]);

  // A pending lifecycle is the one window where the projection is expected to change on its own, so
  // it is the one window that has to be watched. The chip, the wake control, and the composer footer
  // all read this row, so they leave Starting together as soon as the wake records that it finished.
  useEffect(() => {
    if (!openedId || !openedPending) return;
    const timer = setInterval(() => void refreshCompanion(openedId), PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [openedId, openedPending, refreshCompanion]);

  /** Resolves false when the message never reached the control plane, so the composer keeps its text. */
  const onSend = async (content: string, clientMessageId: string): Promise<boolean> => {
    if (!openedId) return false;
    const companionId = openedId;
    setSending(true);
    setThreadError(null);
    try {
      // Sending also delivers the backlog, so it waits for an in-flight sync instead of racing it.
      // The composer's message id travels with the request, so one submission is one turn however
      // many times the request itself reaches the control plane.
      const next = await threadQueueRef.current.run(
        () => sendCompanionMessage(currentOrg.id, companionId, content, clientMessageId),
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
      // A send can wake this Companion, and it can also fail and record why, so the lifecycle it
      // leaves behind is re-read from the projection the status chip already uses. Everything the
      // thread derives from the runtime — the chip, the wake control, the composer footer, and the
      // live cadence that projects Pi's reply — then moves off the pre-send state together instead
      // of waiting for a reload. The read is the control-plane projection, so it never wakes a Box.
      await refreshCompanion(companionId);
    }
  };

  const onWake = async () => {
    if (!opened) return;
    const companionId = opened.id;
    setWaking(true);
    setThreadError(null);
    try {
      const updated = await startCompanionRuntime(currentOrg.id, companionId);
      setCompanions((current) => current.map((item) => item.id === updated.id ? updated : item));
      await refreshThread(true);
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
        activeCompanionId={openedId ?? settingsId}
        onSelectCompanion={(companionId) => {
          const companion = companions.find((item) => item.id === companionId);
          if (!companion) return;
          if (settingsCompanion) router.push(`/companions?companion=${companion.id}`);
          else openCompanion(companion);
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
        ) : settingsCompanion ? (
          <CompanionSettings
            orgId={currentOrg.id}
            companion={settingsCompanion}
            providers={providers}
            onBack={closeSettings}
            onSaved={(updated) => {
              setCompanions((current) =>
                current.map((item) => item.id === updated.id ? updated : item));
            }}
            onDeleted={(companionId) => {
              setCompanions((current) => current.filter((item) => item.id !== companionId));
              setSettingsId(null);
              router.push("/companions");
            }}
          />
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
                    className="cds-btn cds-btn--ghost cds-btn--md"
                    onClick={() => setManagingProviders(true)}
                  >
                    Providers
                  </button>
                )}
                <button
                  type="button"
                  className="cds-btn cds-btn--ghost cds-btn--md"
                  onClick={openPlugins}
                >
                  Plugins
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
                            {companion.access !== "viewer" && (
                              <button
                                type="button"
                                className="cds-btn cds-btn--ghost cds-btn--sm"
                                onClick={() => router.push(`/companions/${companion.id}/settings`)}
                              >
                                Settings
                              </button>
                            )}
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
