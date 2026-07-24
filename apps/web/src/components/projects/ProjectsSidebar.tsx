"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectRowVM, ProjectSessionStatus } from "@/lib/projectsModel";
import type { OrgVM } from "@/lib/types";
import { relativeTime } from "@/lib/format";
import { Icon } from "../Icon";
import { OrgSwitcher } from "../org/OrgSwitcher";
import { SpaceSwitch } from "./SpaceSwitch";

function sessionTone(
  status: ProjectSessionStatus,
): "working" | "waiting" | "done" | "error" {
  if (status === "working") return "working";
  if (status === "queued" || status === "stopping") return "waiting";
  if (status === "error") return "error";
  return "done";
}

function sessionLabel(status: ProjectSessionStatus): string {
  if (status === "working") return "Working";
  if (status === "queued" || status === "stopping") return "Waiting";
  if (status === "error") return "Needs attention";
  if (status === "completed") return "Done";
  if (status === "stopped") return "Stopped";
  return "Idle";
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
  modalOpen?: boolean;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(selectedProjectId ? [selectedProjectId] : []),
  );
  const toggleRef = useRef<HTMLButtonElement>(null);
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseMobile();
      queueMicrotask(() => toggleRef.current?.focus());
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
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
              <span className="sr-only">Search projects and sessions</span>
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
              const activeSessions = project.recentSessions.filter(
                (session) => session.status !== "completed",
              );
              const completedSessions = project.recentSessions.filter(
                (session) => session.status === "completed",
              );
              const sessions = [...activeSessions, ...completedSessions].slice(
                0,
                5,
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
                    <button
                      type="button"
                      className="projects-side__row-action"
                      aria-label={`Project settings for ${project.name}`}
                      title="Project settings"
                      onClick={() => onProjectSettings(project.id)}
                    >
                      <Icon name="settings" size={12} />
                    </button>
                    <button
                      type="button"
                      className="projects-side__row-action"
                      aria-label={
                        runtimeAvailable &&
                        projectAcceptsSessions(project.status)
                          ? `New session in ${project.name}`
                          : `New session unavailable in ${project.name}`
                      }
                      title={
                        runtimeAvailable &&
                        projectAcceptsSessions(project.status)
                          ? "New session"
                          : "Project is not ready for a new session"
                      }
                      disabled={
                        !runtimeAvailable ||
                        !projectAcceptsSessions(project.status)
                      }
                      onClick={() => onNewSession(project.id)}
                    >
                      <Icon name="plus" size={13} />
                    </button>
                  </div>
                  {open && sessions.length > 0 && (
                    <div
                      className="projects-side__sessions"
                      aria-label={`Recent sessions in ${project.name}`}
                    >
                      {sessions.map((session) => (
                        <Link
                          key={session.id}
                          href={`/projects/${project.id}/sessions/${session.id}`}
                          className={`projects-side__session${session.id === selectedSessionId ? " is-active" : ""}`}
                          aria-current={
                            session.id === selectedSessionId
                              ? "page"
                              : undefined
                          }
                          onClick={closeAfterNavigation}
                        >
                          <span className="projects-side__session-title">
                            {session.title}
                          </span>
                          <span className="projects-side__session-status">
                            <span
                              className={`project-status-dot is-${sessionTone(session.status)}`}
                              aria-hidden="true"
                            />
                            {sessionLabel(session.status)}
                          </span>
                          <span className="projects-side__session-time tnum">
                            {relativeTime(session.lastActiveAt).replace(
                              " ago",
                              "",
                            )}
                          </span>
                        </Link>
                      ))}
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
            queueMicrotask(() => toggleRef.current?.focus());
          }}
        />
      )}
    </>
  );
}
