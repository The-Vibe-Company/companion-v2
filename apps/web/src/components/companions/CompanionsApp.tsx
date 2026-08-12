"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Companion,
  CompanionProvidersResponse,
  CompanionTranscript,
} from "@companion/contracts";
import type { OrgVM } from "@/lib/types";
import { getCompanionTranscript, setCompanionProvider } from "@/lib/companions";
import { Icon } from "../Icon";
import { CompanionProvidersDialog } from "./CompanionProvidersDialog";
import { NewCompanionDialog } from "./NewCompanionDialog";
import { ShareCompanionDialog } from "./ShareCompanionDialog";
import { companionStatus, relativeTime } from "./status";
import { Onboarding } from "../org/Onboarding";
import { useOrgActions } from "../org/useOrgActions";
import { Sidebar } from "../skills/Sidebar";
import { skillsRouteHref, type SkillsLibrary } from "../skills/route";
import type { TreeRow } from "../skills/sidebarTree";

const DIALOG_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

export function CompanionsApp({
  orgs,
  currentOrg,
  navigation,
  initialCompanions,
  initialProviders,
}: {
  orgs: OrgVM[];
  currentOrg: OrgVM;
  navigation: CompanionNavigation;
  initialCompanions: Companion[];
  initialProviders: CompanionProvidersResponse;
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
  const [opened, setOpened] = useState<Companion | null>(null);
  const [transcript, setTranscript] = useState<CompanionTranscript | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const threadRef = useRef<HTMLElement>(null);
  const transcriptRequestRef = useRef(0);
  const noop = () => {};

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

  const openCompanion = async (companion: Companion) => {
    const requestId = ++transcriptRequestRef.current;
    setOpened(companion);
    setTranscript(null);
    setTranscriptError(null);
    try {
      const result = await getCompanionTranscript(currentOrg.id, companion.id);
      if (requestId === transcriptRequestRef.current) setTranscript(result);
    } catch (cause) {
      if (requestId === transcriptRequestRef.current) {
        setTranscriptError(cause instanceof Error ? cause.message : "Transcript could not be loaded.");
      }
    }
  };

  const closeThread = () => {
    transcriptRequestRef.current += 1;
    setOpened(null);
  };

  const onCreated = (companion: Companion) => {
    setCompanions((current) => [companion, ...current]);
    setCreating(false);
    setError(null);
    void openCompanion(companion);
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
      setOpened((current) => current?.id === updated.id ? updated : current);
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

  const overlayOpen = opened !== null || sharing !== null || creating || managingProviders;

  useEffect(() => {
    if (!overlayOpen) return;
    const sidebar = document.querySelector<HTMLElement>(".side");
    const sidebarWasInert = sidebar?.inert ?? false;
    if (sidebar) sidebar.inert = true;
    return () => {
      if (sidebar) sidebar.inert = sidebarWasInert;
    };
  }, [overlayOpen]);

  useEffect(() => {
    if (!opened) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = threadRef.current;
    dialog?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        transcriptRequestRef.current += 1;
        setOpened(null);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)).filter(
        (item) => item.offsetParent !== null,
      );
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
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
      opener?.focus();
    };
  }, [opened]);

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
        activeCompanionId={opened?.id ?? null}
        onSelectCompanion={(companionId) => {
          const companion = companions.find((item) => item.id === companionId);
          if (companion) void openCompanion(companion);
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
        className="companions-main"
        aria-hidden={mobileSidebarOpen || overlayOpen || undefined}
        inert={mobileSidebarOpen || overlayOpen ? true : undefined}
      >
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
                        onClick={() => void openCompanion(companion)}
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
      </main>

      {opened && (
        <div className="companions-thread-scrim" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeThread();
        }}>
          <aside
            className="companions-thread"
            role="dialog"
            aria-modal="true"
            aria-labelledby="companions-thread-title"
            ref={threadRef}
            tabIndex={-1}
          >
            <header>
              <div>
                <h2 id="companions-thread-title">{opened.name}</h2>
                <p>
                  {opened.persona ? `${opened.persona} · ` : ""}
                  {opened.access === "viewer"
                    ? "Read-only transcript · Box stays asleep"
                    : "Transcript"}
                </p>
              </div>
              <button
                type="button"
                className="iconbtn"
                aria-label="Close transcript"
                onClick={closeThread}
              >
                <Icon name="x" size={16} />
              </button>
            </header>
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
            <div className="companions-thread-body">
              {transcriptError ? (
                <div className="companions-error" role="alert">{transcriptError}</div>
              ) : !transcript ? (
                <p className="companions-thread-empty">Loading transcript...</p>
              ) : transcript.entries.length ? (
                transcript.entries.map((entry) => (
                  <article className={`companions-message companions-message--${entry.role}`} key={entry.event_id}>
                    <strong>{entry.role === "assistant" ? opened.name : entry.role}</strong>
                    <p>{entry.content}</p>
                    <time dateTime={entry.created_at}>
                      {new Date(entry.created_at).toLocaleString()}
                    </time>
                  </article>
                ))
              ) : (
                <div className="companions-thread-empty">
                  <strong>No messages yet</strong>
                  <p>The control-plane transcript is empty. Opening it did not contact Box.</p>
                </div>
              )}
            </div>
            {opened.access === "viewer" && (
              <footer>
                Viewer access is read-only. Run, plugins, and desktop are unavailable.
              </footer>
            )}
          </aside>
        </div>
      )}

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
