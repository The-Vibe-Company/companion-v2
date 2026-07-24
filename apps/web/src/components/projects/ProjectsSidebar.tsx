"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  ProjectRowVM,
  ProjectSessionVM,
} from "@/lib/projectsModel";
import { sortProjectSessionsByCreatedAt } from "@/lib/projectsModel";
import type { OrgVM } from "@/lib/types";
import { relativeTime } from "@/lib/format";
import { Icon } from "../Icon";
import { OrgSwitcher } from "../org/OrgSwitcher";
import { SpaceSwitch } from "./SpaceSwitch";

type ActionMenuItem = {
  label: string;
  icon: string;
  disabled?: boolean;
  tone?: "default" | "danger";
  onSelect: () => void;
};

export function ProjectsActionMenu({
  label,
  actions,
  className = "projects-side__row-action",
}: {
  label: string;
  actions: ActionMenuItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = 216;
      const height = actions.length * 34 + 10;
      const left = Math.max(
        8,
        Math.min(rect.right - width, window.innerWidth - width - 8),
      );
      const top =
        rect.bottom + height + 8 <= window.innerHeight
          ? rect.bottom + 4
          : Math.max(8, rect.top - height - 4);
      setPosition({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [actions.length, open]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", closeFromOutside);
    return () => document.removeEventListener("mousedown", closeFromOutside);
  }, [open]);

  useEffect(() => {
    if (!open || !position) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, [open, position]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus)
      window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <Icon name="more-horizontal" size={14} />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            className="cowork-action-menu"
            style={position}
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                event.preventDefault();
                close();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
              }
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              const items = [
                ...(
                  menuRef.current?.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]:not(:disabled)',
                  ) ?? []
                ),
              ];
              const current = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const delta = event.key === "ArrowDown" ? 1 : -1;
              items[(current + delta + items.length) % items.length]?.focus();
            }}
          >
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                className={
                  action.tone === "danger" ? "is-danger" : undefined
                }
                disabled={action.disabled}
                onClick={() => {
                  close(false);
                  // Make the trigger the hand-off target before a selected action
                  // opens a dialog. The dialog can then capture it for focus
                  // restoration without briefly focusing the removed portal item.
                  triggerRef.current?.focus();
                  action.onSelect();
                }}
              >
                <Icon name={action.icon} size={14} />
                <span>{action.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function sessionSignal(
  session: ProjectSessionVM,
): { label: "Working" | "New result" | "Failed"; tone: string } | null {
  if (["queued", "working", "stopping"].includes(session.status))
    return { label: "Working", tone: "working" };
  if (session.status === "error") return { label: "Failed", tone: "waiting" };
  if (session.isUnread) return { label: "New result", tone: "new" };
  return null;
}

function projectAcceptsSessions(status: ProjectRowVM["status"]): boolean {
  return !["needs_attention", "error", "deleting", "deleted"].includes(status);
}

export function ProjectsSidebar({
  projects,
  selectedProjectId,
  selectedSessionId,
  orgs,
  currentOrg,
  runtimeAvailable,
  mobileOpen,
  onToggleMobile,
  onCloseMobile,
  onSwitchOrg,
  onOnboard,
  onNewProject,
  onNewSession,
  onProjectSettings,
  onArchiveProject,
  onRenameSession,
  onArchiveSession,
  modalOpen = false,
}: {
  projects: ProjectRowVM[];
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  orgs: OrgVM[];
  currentOrg: OrgVM;
  runtimeAvailable: boolean;
  mobileOpen: boolean;
  onToggleMobile: () => void;
  onCloseMobile: () => void;
  onSwitchOrg: (id: string) => void;
  onOnboard: (mode: "create" | "join") => void;
  onNewProject: () => void;
  onNewSession: (projectId: string) => void;
  onProjectSettings: (projectId: string) => void;
  onArchiveProject: (projectId: string) => void;
  onRenameSession: (projectId: string, session: ProjectSessionVM) => void;
  onArchiveSession: (projectId: string, session: ProjectSessionVM) => void;
  modalOpen?: boolean;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(selectedProjectId ? [selectedProjectId] : []),
  );
  const toggleRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selectedProjectId) return;
    setExpanded((current) => {
      if (current.has(selectedProjectId)) return current;
      return new Set([...current, selectedProjectId]);
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  useEffect(() => {
    if (!mobileOpen || modalOpen) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const fallbackRestoreTarget = toggleRef.current;
    queueMicrotask(() => toggleRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseMobile();
        return;
      }
      if (event.key !== "Tab" || !asideRef.current) return;
      const focusable = [
        ...asideRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const restoreTarget =
        previous && previous !== document.body ? previous : fallbackRestoreTarget;
      window.requestAnimationFrame(() => restoreTarget?.focus());
    };
  }, [mobileOpen, modalOpen, onCloseMobile]);

  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) =>
      `${project.name} ${project.recentSessions.map((session) => session.title).join(" ")}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [projects, query]);

  const closeAfterNavigation = () => {
    onCloseMobile();
    setSearching(false);
    setQuery("");
  };

  const toggle = (projectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <>
      <aside
        ref={asideRef}
        className={`side projects-side${mobileOpen ? " side--mobile-open" : ""}`}
        aria-hidden={modalOpen || undefined}
        inert={modalOpen ? true : undefined}
      >
        <div className="side__brand">
          <button
            ref={toggleRef}
            className="side__toggle"
            type="button"
            onClick={onToggleMobile}
            aria-label={
              mobileOpen ? "Collapse navigation" : "Expand navigation"
            }
            aria-expanded={mobileOpen}
          >
            <Icon
              name={mobileOpen ? "panel-left-close" : "panel-left-open"}
              size={15}
            />
          </button>
          <OrgSwitcher
            orgs={orgs}
            current={currentOrg}
            onSwitch={(id) => {
              onSwitchOrg(id);
              closeAfterNavigation();
            }}
            onOnboard={(mode) => {
              onOnboard(mode);
              onCloseMobile();
            }}
          />
          <button
            ref={searchToggleRef}
            type="button"
            className={`side__search${searching ? " is-active" : ""}`}
            aria-label={searching ? "Close project search" : "Search projects"}
            title={searching ? "Close search" : "Search projects"}
            onClick={() => {
              setSearching((current) => !current);
              if (searching) setQuery("");
            }}
          >
            <Icon name={searching ? "x" : "search"} size={14} />
          </button>
        </div>

        <SpaceSwitch active="projects" onNavigate={closeAfterNavigation} />

        <nav className="side__nav projects-side__nav" aria-label="Primary">
          <div className="projects-side__group">
            <span>Projects</span>
            <button
              type="button"
              aria-label={
                runtimeAvailable
                  ? "New project"
                  : "New project unavailable while the runtime is offline"
              }
              title={
                runtimeAvailable
                  ? "New project"
                  : "Projects runtime unavailable"
              }
              disabled={!runtimeAvailable}
              onClick={onNewProject}
            >
              <Icon name="folder-plus" size={14} />
            </button>
          </div>

          {searching && (
            <label className="projects-side__search">
              <Icon name="search" size={13} />
              <span className="sr-only">Search projects and conversations</span>
              <input
                ref={searchRef}
                value={query}
                placeholder="Find a project…"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  setSearching(false);
                  setQuery("");
                  queueMicrotask(() => searchToggleRef.current?.focus());
                }}
              />
            </label>
          )}

          <div className="projects-side__list" aria-label="All projects">
            {visibleProjects.map((project) => {
              const open = expanded.has(project.id);
              const active = project.id === selectedProjectId;
              const sessions = sortProjectSessionsByCreatedAt(
                project.recentSessions.filter(
                  (candidate) => (candidate.archivedAt ?? null) === null,
                ),
              ).slice(0, 5);
              const hiddenSessionCount = Math.max(
                0,
                project.sessionCount - sessions.length,
              );
              return (
                <div className="projects-side__branch" key={project.id}>
                  <div
                    className={`projects-side__project${active ? " is-active" : ""}`}
                  >
                    <button
                      type="button"
                      className="projects-side__chevron"
                      aria-label={
                        open
                          ? `Collapse ${project.name}`
                          : `Expand ${project.name}`
                      }
                      aria-expanded={open}
                      onClick={() => toggle(project.id)}
                    >
                      <Icon name={open ? "chevron-down" : "folder"} size={14} />
                    </button>
                    <Link
                      href={`/projects/${project.id}`}
                      className="projects-side__project-link"
                      aria-current={
                        active && !selectedSessionId ? "page" : undefined
                      }
                      title={project.name}
                      onClick={closeAfterNavigation}
                    >
                      {project.name}
                    </Link>
                    {project.unreadSessionCount > 0 && (
                      <span
                        className="projects-side__unread tnum"
                        aria-label={`${project.unreadSessionCount} unread results`}
                      >
                        {project.unreadSessionCount}
                      </span>
                    )}
                    <ProjectsActionMenu
                      label={`Actions for ${project.name}`}
                      actions={[
                        {
                          label: "New conversation",
                          icon: "square-pen",
                          disabled:
                            !runtimeAvailable ||
                            !projectAcceptsSessions(project.status),
                          onSelect: () => onNewSession(project.id),
                        },
                        {
                          label: "Project settings",
                          icon: "settings",
                          onSelect: () => onProjectSettings(project.id),
                        },
                        {
                          label:
                            project.activeSessionCount > 0
                              ? "Finish conversations to archive"
                              : "Archive project",
                          icon: "archive",
                          disabled: project.activeSessionCount > 0,
                          onSelect: () => onArchiveProject(project.id),
                        },
                      ]}
                    />
                  </div>
                  {open &&
                    (sessions.length > 0 || hiddenSessionCount > 0) && (
                    <div
                      className="projects-side__sessions"
                      aria-label={`Recent conversations in ${project.name}`}
                    >
                      {sessions.map((session) => {
                        const signal = sessionSignal(session);
                        const selected = session.id === selectedSessionId;
                        return (
                          <div
                            key={session.id}
                            className={`projects-side__session${selected ? " is-active" : ""}`}
                          >
                            <Link
                              href={`/projects/${project.id}/sessions/${session.id}`}
                              className="projects-side__session-link"
                              aria-current={selected ? "page" : undefined}
                              onClick={closeAfterNavigation}
                            >
                              <span
                                className="projects-side__session-title"
                                title={session.title}
                              >
                                {session.title}
                              </span>
                              <span className="projects-side__session-meta">
                                {signal && (
                                  <span
                                    className={`projects-side__session-status is-${signal.tone}`}
                                  >
                                    <span
                                      className={`project-status-dot is-${signal.tone}`}
                                      aria-hidden="true"
                                    />
                                    {signal.label}
                                  </span>
                                )}
                                <time
                                  className="projects-side__session-time tnum"
                                  dateTime={session.createdAt}
                                >
                                  {relativeTime(session.createdAt)}
                                </time>
                              </span>
                            </Link>
                            <ProjectsActionMenu
                              label={`Actions for ${session.title}`}
                              className="projects-side__session-action"
                              actions={[
                                {
                                  label: "Rename",
                                  icon: "pencil",
                                  onSelect: () =>
                                    onRenameSession(project.id, session),
                                },
                                {
                                  label: ["queued", "working", "stopping"].includes(
                                    session.status,
                                  )
                                    ? "Stop and archive"
                                    : "Archive",
                                  icon: "archive",
                                  onSelect: () =>
                                    onArchiveSession(project.id, session),
                                },
                              ]}
                            />
                          </div>
                        );
                      })}
                      {hiddenSessionCount > 0 && (
                        <Link
                          href={`/projects/${project.id}`}
                          className="projects-side__all"
                          onClick={closeAfterNavigation}
                        >
                          All conversations
                          <span className="tnum">· {project.sessionCount}</span>
                        </Link>
                      )}
                    </div>
                    )}
                </div>
              );
            })}
            {visibleProjects.length === 0 && (
              <p className="projects-side__empty">
                {projects.length === 0
                  ? "Your projects will appear here."
                  : "No matching projects."}
              </p>
            )}
          </div>

          <Link
            className="navitem navitem--bottom"
            href="/secrets"
            onClick={closeAfterNavigation}
          >
            <span className="navitem__ico">
              <Icon name="key-round" />
            </span>
            <span className="navitem__label">Secrets</span>
          </Link>
        </nav>

        <Link
          className="side__foot side__foot--btn"
          href="/settings"
          onClick={closeAfterNavigation}
        >
          <Icon name="settings" size={14} />
          <span className="side__foot__label">Settings</span>
        </Link>
      </aside>
      {mobileOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Close navigation"
          onClick={() => {
            onCloseMobile();
          }}
        />
      )}
    </>
  );
}
