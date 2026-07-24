"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OrgVM } from "@/lib/types";
import { formatBytes, relativeTime } from "@/lib/format";
import { setCurrentOrg } from "@/lib/org";
import {
  createProject,
  createProjectSession,
  deleteProject,
  fetchProject,
  fetchProjects,
  replaceProjectSkills,
  retryProjectWorkspace,
  updateProject,
} from "@/lib/projects";
import {
  mergeProjectRow,
  type ProjectDetailVM,
  type ProjectModelChoice,
  type ProjectRowVM,
  type ProjectRuntimeAvailability,
  type ProjectSessionStatus,
  type ProjectSessionVM,
  type ProjectSkillChoice,
} from "@/lib/projectsModel";
import { Icon } from "../Icon";
import { Onboarding } from "../org/Onboarding";
import { useOrgActions } from "../org/useOrgActions";
import {
  NewProjectDialog,
  NewSessionDialog,
  CoworkDialog,
  ProjectSettingsDialog,
} from "./ProjectDialogs";
import { ProjectRecoveryActions } from "./ProjectRecoveryActions";
import { ProjectSessionView } from "./ProjectSessionView";
import { ProjectsSidebar } from "./ProjectsSidebar";

type DialogState =
  | { kind: "new-project"; initialSkillSlug: string | null }
  | { kind: "new-session"; projectId: string; initialSkillSlug: string | null }
  | { kind: "settings"; projectId: string }
  | null;

type HomeFilter = "all" | "waiting" | "working";
type ProjectChoiceErrors = {
  skills: string | null;
  models: string | null;
};

const PROJECT_REFRESH_MS = 15_000;

function projectStatusLabel(status: ProjectRowVM["status"]): string {
  switch (status) {
    case "queued":
    case "provisioning":
      return "Getting ready";
    case "ready":
      return "Idle";
    case "running":
      return "Working";
    case "stopping":
      return "Going to sleep";
    case "stopped":
      return "Sleeping";
    case "needs_attention":
    case "error":
      return "Needs attention";
    case "deleting":
    case "deleted":
      return "Deleting";
  }
}

function projectStatusTone(
  status: ProjectRowVM["status"],
): "working" | "waiting" | "done" | "error" {
  if (status === "running") return "working";
  if (
    status === "queued" ||
    status === "provisioning" ||
    status === "stopping" ||
    status === "deleting"
  )
    return "waiting";
  if (status === "needs_attention" || status === "error") return "error";
  return "done";
}

function sessionStatusLabel(status: ProjectSessionStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "working":
      return "Working";
    case "idle":
      return "Ready";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
    case "completed":
      return "Done";
    case "error":
      return "Needs attention";
  }
}

function sessionStatusTone(
  status: ProjectSessionStatus,
): "working" | "waiting" | "done" | "error" {
  if (status === "working") return "working";
  if (status === "queued" || status === "stopping") return "waiting";
  if (status === "error") return "error";
  return "done";
}

function projectFilter(status: ProjectRowVM["status"]): HomeFilter {
  if (status === "running") return "working";
  if (
    status === "needs_attention" ||
    status === "error" ||
    status === "queued" ||
    status === "provisioning" ||
    status === "stopping" ||
    status === "deleting"
  )
    return "waiting";
  return "all";
}

function projectInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "P"
  );
}

function RuntimeNotice({ runtime }: { runtime: ProjectRuntimeAvailability }) {
  if (runtime.available) return null;
  return (
    <div className="cowork-runtime-notice" role="status">
      <Icon name="alert-triangle" size={15} />
      <span>
        <strong>Projects are not available yet.</strong>
        {runtime.message ||
          "A Projects worker and persistent sandbox snapshot must be configured first."}
      </span>
      <Link
        href="/settings?view=models"
        className="cds-btn cds-btn--secondary cds-btn--sm"
      >
        Open settings
      </Link>
    </div>
  );
}

function ProjectsHome({
  projects,
  runtime,
  onNewProject,
}: {
  projects: ProjectRowVM[];
  runtime: ProjectRuntimeAvailability;
  onNewProject: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HomeFilter>("all");
  const counts = {
    waiting: projects.filter(
      (project) => projectFilter(project.status) === "waiting",
    ).length,
    working: projects.filter(
      (project) => projectFilter(project.status) === "working",
    ).length,
  };
  const normalized = query.trim().toLocaleLowerCase();
  const visible = projects.filter((project) => {
    if (filter !== "all" && projectFilter(project.status) !== filter)
      return false;
    return (
      !normalized ||
      `${project.name} ${project.recentSessions.map((session) => session.title).join(" ")}`
        .toLocaleLowerCase()
        .includes(normalized)
    );
  });
  return (
    <div className="cowork-home">
      <header className="cowork-page-head">
        <h1>Projects</h1>
        <span className="cowork-page-head__count tnum">{projects.length}</span>
        <span className="cowork-page-head__summary">
          {counts.working} working · {counts.waiting} waiting
        </span>
        <span />
        <button
          type="button"
          className="cds-btn cds-btn--primary cds-btn--md"
          onClick={onNewProject}
          disabled={!runtime.available}
        >
          <Icon name="plus" size={14} />
          New project
        </button>
      </header>
      <RuntimeNotice runtime={runtime} />
      <div className="cowork-commandbar">
        <label className="cowork-search">
          <Icon name="search" size={14} />
          <span className="sr-only">Search projects</span>
          <input
            value={query}
            placeholder="Search projects…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          className="cowork-filterset"
          role="group"
          aria-label="Filter projects by status"
        >
          {(
            [
              ["all", projects.length],
              ["waiting", counts.waiting],
              ["working", counts.working],
            ] as const
          ).map(([value, count]) => (
            <button
              type="button"
              key={value}
              className={filter === value ? "is-active" : undefined}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value} <span className="tnum">{count}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="cowork-project-table" role="table" aria-label="Projects">
        <div className="cowork-project-table__head" role="row">
          <span role="columnheader">Project</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Contents</span>
          <span role="columnheader">Updated</span>
        </div>
        {visible.map((project) => {
          return (
            <div key={project.id} className="cowork-project-row" role="row">
              <span className="cowork-project-row__project" role="cell">
                <span className="cowork-project-avatar">
                  {projectInitials(project.name)}
                </span>
                <span>
                  <Link
                    href={`/projects/${project.id}`}
                    className="cowork-project-row__link"
                  >
                    <strong>{project.name}</strong>
                  </Link>
                  <small>{project.defaultModel}</small>
                </span>
              </span>
              <span className="cds-status" role="cell">
                <span
                  className={`project-status-dot is-${projectStatusTone(project.status)}`}
                />
                {projectStatusLabel(project.status)}
              </span>
              <span className="cowork-project-row__meta" role="cell">
                {project.sessionCount} sessions · {project.fileCount} files
              </span>
              <span className="cowork-project-row__time tnum" role="cell">
                {relativeTime(project.updatedAt)}
              </span>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="cowork-table-empty">
            <Icon
              name={projects.length === 0 ? "boxes" : "search-x"}
              size={20}
            />
            <strong>
              {projects.length === 0
                ? "Create your first project"
                : "No projects found"}
            </strong>
            <span>
              {projects.length === 0
                ? "A project keeps sessions, files, skills and secrets together."
                : "Try another search or status filter."}
            </span>
            {projects.length === 0 && runtime.available && (
              <button
                type="button"
                className="cds-btn cds-btn--primary cds-btn--sm"
                onClick={onNewProject}
              >
                <Icon name="plus" size={13} />
                New project
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectOverview({
  project,
  runtime,
  onOpenNavigation,
  onNewSession,
  onSettings,
  onRetry,
  retryBusy,
  retryError,
}: {
  project: ProjectDetailVM;
  runtime: ProjectRuntimeAvailability;
  onOpenNavigation: () => void;
  onNewSession: () => void;
  onSettings: () => void;
  onRetry: () => void;
  retryBusy: boolean;
  retryError: string | null;
}) {
  return (
    <div className="cowork-project">
      <header className="cowork-project__head">
        <button
          type="button"
          className="projects-mobile-nav"
          onClick={onOpenNavigation}
          aria-label="Open navigation"
        >
          <Icon name="panel-left-open" size={15} />
        </button>
        <span className="cowork-project-avatar cowork-project-avatar--large">
          {projectInitials(project.name)}
        </span>
        <div className="cowork-project__identity">
          <div>
            <h1>{project.name}</h1>
            <button
              type="button"
              className="cds-iconbtn cds-iconbtn--sm"
              onClick={onSettings}
              aria-label="Project settings"
            >
              <Icon name="settings" size={13} />
            </button>
          </div>
          <span className="cds-status">
            <span
              className={`project-status-dot is-${projectStatusTone(project.status)}`}
            />
            {projectStatusLabel(project.status)}
            <code>{project.defaultModel}</code>
          </span>
        </div>
        <button
          type="button"
          className="cds-btn cds-btn--primary cds-btn--md"
          onClick={onNewSession}
          disabled={
            !runtime.available ||
            project.status === "needs_attention" ||
            project.status === "error" ||
            project.status === "deleting" ||
            project.status === "deleted"
          }
        >
          <Icon name="square-pen" size={14} />
          New session
        </button>
      </header>
      {(project.status === "needs_attention" || project.status === "error") && (
        <div className="cowork-project-alert" role="alert">
          <Icon name="alert-triangle" size={14} />
          <span>
            <strong>This project needs attention.</strong>
            {project.statusDetail ||
              project.workspace.statusDetail ||
              "The persistent workspace could not be restored."}
          </span>
          <ProjectRecoveryActions
            busy={retryBusy}
            error={retryError}
            onRetry={onRetry}
            onSettings={onSettings}
          />
        </div>
      )}
      <div className="cowork-project__grid">
        <section
          className="cowork-project__sessions"
          aria-labelledby="project-sessions-title"
        >
          <div className="cowork-section-head">
            <div>
              <h2 id="project-sessions-title">Sessions</h2>
              <p>Every session works in the same project space.</p>
            </div>
            <span className="tnum">{project.sessions.length}</span>
          </div>
          {project.sessions.length > 0 ? (
            <div className="cowork-session-list">
              {project.sessions.map((session) => (
                <Link
                  href={`/projects/${project.id}/sessions/${session.id}`}
                  key={session.id}
                  className="cowork-session-row"
                >
                  <span
                    className={`project-status-dot is-${sessionStatusTone(session.status)}`}
                  />
                  <span className="cowork-session-row__copy">
                    <strong>{session.title}</strong>
                    <small>
                      {sessionStatusLabel(session.status)} ·{" "}
                      <code>{session.model}</code>
                    </small>
                  </span>
                  <span className="cowork-session-row__time tnum">
                    {relativeTime(session.lastActiveAt)}
                  </span>
                  <Icon name="chevron-right" size={14} />
                </Link>
              ))}
            </div>
          ) : (
            <button
              type="button"
              className="cowork-project-empty"
              onClick={onNewSession}
              disabled={!runtime.available}
            >
              <span>
                <Icon name="message-square" size={16} />
              </span>
              <strong>Start the first session</strong>
              <small>
                Describe an outcome. The agent already has this project's
                context.
              </small>
              <Icon name="arrow-right" size={14} />
            </button>
          )}
        </section>
        <aside className="cowork-project__rail" aria-label="Project context">
          <section>
            <div className="cowork-rail-head">
              <span>
                <Icon name="package" size={13} />
                Skills
              </span>
              <b className="tnum">{project.skills.length}</b>
              <button type="button" onClick={onSettings}>
                Manage
              </button>
            </div>
            <div className="cowork-rail-list">
              {project.skills.slice(0, 5).map((skill) => (
                <div key={skill.slug}>
                  <Icon name="package" size={12} />
                  <strong>{skill.displayName}</strong>
                  <small>{skill.version}</small>
                </div>
              ))}
              {project.skills.length === 0 && <p>No skills synced.</p>}
            </div>
          </section>
          <section>
            <div className="cowork-rail-head">
              <span>
                <Icon name="key-round" size={13} />
                Secrets
              </span>
              <b className="tnum">{project.secretCount}</b>
            </div>
            <p className="cowork-rail-note">
              <Icon name="shield-check" size={13} />
              Synced automatically when the project wakes.
            </p>
          </section>
          <section>
            <div className="cowork-rail-head">
              <span>
                <Icon name="folder-open" size={13} />
                Files
              </span>
              <b className="tnum">{project.files.length}</b>
            </div>
            <div className="cowork-file-list">
              {project.files.slice(0, 6).map((file) => (
                <a
                  key={file.id}
                  href={`/v1/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(file.id)}`}
                  target="_blank"
                >
                  <Icon name="file" size={13} />
                  <span title={file.path}>{file.name}</span>
                  <small
                    className={
                      file.conflictDetected ? "is-conflict" : undefined
                    }
                    title={
                      file.conflictDetected
                        ? "Concurrent edit detected · latest version kept"
                        : undefined
                    }
                  >
                    {file.conflictDetected
                      ? "conflict"
                      : formatBytes(file.byteSize)}
                  </small>
                </a>
              ))}
              {project.files.length === 0 && (
                <p>Files created by sessions appear here.</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ProjectDialogState({
  title,
  description,
  headline = "Project could not be loaded.",
  loading,
  error,
  onClose,
  onRetry,
}: {
  title: string;
  description: string;
  headline?: string;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry?: () => void;
}) {
  return (
    <CoworkDialog
      title={title}
      description={description}
      onClose={onClose}
      width="520px"
    >
      <div className="cowork-dialog__body cowork-dialog-state">
        {loading ? (
          <div className="cowork-project-picker__loading" role="status">
            <Icon name="loader" size={15} className="ls-spin" />
            Loading project…
          </div>
        ) : (
          <div className="cowork-project-picker__empty" role="alert">
            <Icon name="alert-triangle" size={18} />
            <strong>{headline}</strong>
            <span>{error ?? "Try loading the project again."}</span>
          </div>
        )}
      </div>
      <footer className="cowork-dialog__foot">
        <button
          type="button"
          className="cds-btn cds-btn--ghost cds-btn--md"
          onClick={onClose}
        >
          Close
        </button>
        {!loading && onRetry && (
          <button
            type="button"
            className="cds-btn cds-btn--primary cds-btn--md"
            onClick={onRetry}
          >
            Retry
          </button>
        )}
      </footer>
    </CoworkDialog>
  );
}

export function ProjectsApp({
  initialProjects,
  initialProject,
  initialSession,
  availableSkills,
  availableModels,
  runtime,
  orgs,
  currentOrg,
  initialDialog,
  choiceErrors = { skills: null, models: null },
}: {
  initialProjects: ProjectRowVM[];
  initialProject: ProjectDetailVM | null;
  initialSession: ProjectSessionVM | null;
  availableSkills: ProjectSkillChoice[];
  availableModels: ProjectModelChoice[];
  runtime: ProjectRuntimeAvailability;
  orgs: OrgVM[];
  currentOrg: OrgVM;
  initialDialog: DialogState;
  choiceErrors?: ProjectChoiceErrors;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const [projects, setProjects] = useState(initialProjects);
  const [project, setProject] = useState(initialProject);
  const [session, setSession] = useState(initialSession);
  const [dialog, setDialog] = useState<DialogState>(initialDialog);
  const [settingsTarget, setSettingsTarget] = useState<ProjectDetailVM | null>(
    initialDialog?.kind === "settings" ? initialProject : null,
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogLoading, setDialogLoading] = useState(false);
  const [runtimeState, setRuntimeState] = useState(runtime);
  const [workspaceRetry, setWorkspaceRetry] = useState<{
    projectId: string | null;
    busy: boolean;
    error: string | null;
  }>({ projectId: null, busy: false, error: null });
  const dialogRequestRef = useRef(0);
  const workspaceRetryRef = useRef<string | null>(null);

  const sidebarProjects = useMemo(
    () =>
      projects.map((row) => {
        if (row.id !== project?.id) return row;
        return {
          ...mergeProjectRow(project),
          recentSessions: project.sessions.slice(0, 5),
        };
      }),
    [project, projects],
  );

  const replaceProject = (next: ProjectDetailVM) => {
    setProject((current) => (current?.id === next.id ? next : current));
    const row = mergeProjectRow(next);
    setProjects((current) =>
      current.some((candidate) => candidate.id === next.id)
        ? current.map((candidate) =>
            candidate.id === next.id ? row : candidate,
          )
        : [row, ...current],
    );
    setSettingsTarget((current) => (current?.id === next.id ? next : current));
  };

  useEffect(() => {
    setRuntimeState(runtime);
  }, [runtime]);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const selectedProjectId = project?.id ?? null;
    const activeSessionId = session?.id ?? null;
    const refresh = async () => {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      try {
        const response = await fetchProjects();
        if (!active) return;
        setProjects(response.projects);
        setRuntimeState(response.runtime);
        const refreshedRow = selectedProjectId
          ? response.projects.find(
              (candidate) => candidate.id === selectedProjectId,
            )
          : null;
        if (refreshedRow) {
          setProject((current) =>
            current?.id === refreshedRow.id
              ? {
                  ...current,
                  ...refreshedRow,
                  workspace: {
                    ...current.workspace,
                    status: refreshedRow.status,
                    statusDetail: refreshedRow.statusDetail,
                    lastActiveAt: refreshedRow.updatedAt,
                  },
                }
              : current,
          );
        }
        if (selectedProjectId && !activeSessionId && dialog === null) {
          try {
            const detail = await fetchProject(selectedProjectId);
            if (!active) return;
            setProject((current) =>
              current?.id === detail.id ? detail : current,
            );
            const row = mergeProjectRow(detail);
            setProjects((current) =>
              current.map((candidate) =>
                candidate.id === row.id ? row : candidate,
              ),
            );
          } catch {
            // Keep the last durable detail visible; the list refresh still carries lifecycle truth.
          }
        }
      } catch {
        // Background refreshes are best-effort and must not replace usable server-rendered state.
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), PROJECT_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [dialog, project?.id, session?.id]);

  const closeDialog = () => {
    if (busy) return;
    dialogRequestRef.current += 1;
    setDialog(null);
    setSettingsTarget(null);
    setError(null);
    setDialogLoading(false);
    const href =
      project && session
        ? `/projects/${project.id}/sessions/${session.id}`
        : project
          ? `/projects/${project.id}`
          : "/projects";
    router.replace(href);
  };

  const openSettings = async (projectId: string) => {
    const requestId = ++dialogRequestRef.current;
    setError(null);
    setDialog({ kind: "settings", projectId });
    if (project?.id === projectId) {
      setSettingsTarget(project);
      setDialogLoading(false);
      return;
    }
    setSettingsTarget(null);
    setDialogLoading(true);
    try {
      const detail = await fetchProject(projectId);
      if (requestId !== dialogRequestRef.current) return;
      setSettingsTarget(detail);
      replaceProject(detail);
    } catch (cause) {
      if (requestId !== dialogRequestRef.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load project settings.",
      );
    } finally {
      if (requestId === dialogRequestRef.current) setDialogLoading(false);
    }
  };

  const openNewSession = async (
    projectId: string,
    initialSkillSlug: string | null = null,
  ) => {
    const requestId = ++dialogRequestRef.current;
    setError(null);
    setDialog({ kind: "new-session", projectId, initialSkillSlug });
    if (project?.id === projectId) {
      setDialogLoading(false);
      return;
    }
    setDialogLoading(true);
    try {
      const detail = await fetchProject(projectId);
      if (requestId !== dialogRequestRef.current) return;
      setProject(detail);
      replaceProject(detail);
    } catch (cause) {
      if (requestId !== dialogRequestRef.current) return;
      setError(
        cause instanceof Error ? cause.message : "Could not load this project.",
      );
    } finally {
      if (requestId === dialogRequestRef.current) setDialogLoading(false);
    }
  };

  const selectedDialogProject =
    dialog?.kind === "new-session" && project?.id === dialog.projectId
      ? project
      : null;
  const catalogError = [choiceErrors.skills, choiceErrors.models]
    .filter(Boolean)
    .join(" ");
  const retryCatalogs = () => router.refresh();
  const retryRuntime = async () => {
    setDialogLoading(true);
    setError(null);
    try {
      const response = await fetchProjects();
      setProjects(response.projects);
      setRuntimeState(response.runtime);
      if (!response.runtime.available) {
        setError(
          response.runtime.message ??
            "The Projects runtime is still unavailable.",
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not refresh Projects runtime status.",
      );
    } finally {
      setDialogLoading(false);
    }
  };

  const retryWorkspace = async (projectId: string) => {
    if (workspaceRetryRef.current) return;
    workspaceRetryRef.current = projectId;
    setWorkspaceRetry({ projectId, busy: true, error: null });
    try {
      const refreshed = await retryProjectWorkspace(projectId);
      replaceProject(refreshed);
      setWorkspaceRetry({ projectId: null, busy: false, error: null });
    } catch (cause) {
      setWorkspaceRetry({
        projectId,
        busy: false,
        error:
          cause instanceof Error
            ? cause.message
            : "The project could not be restarted. Try again or review its settings.",
      });
    } finally {
      workspaceRetryRef.current = null;
    }
  };

  return (
    <div className={`app app--projects${mobileOpen ? " app--side-open" : ""}`}>
      <ProjectsSidebar
        projects={sidebarProjects}
        selectedProjectId={project?.id ?? null}
        selectedSessionId={session?.id ?? null}
        orgs={orgs}
        currentOrg={currentOrg}
        runtimeAvailable={runtimeState.available}
        mobileOpen={mobileOpen}
        onToggleMobile={() => setMobileOpen((current) => !current)}
        onCloseMobile={() => setMobileOpen(false)}
        onSwitchOrg={(id) => {
          orgActions.setError(null);
          void setCurrentOrg(id)
            .then(() => {
              router.replace("/projects");
              router.refresh();
            })
            .catch((cause) =>
              orgActions.setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not switch workspace.",
              ),
            );
        }}
        onOnboard={orgActions.setOnboarding}
        onNewProject={() => {
          if (!runtimeState.available) return;
          setDialog({ kind: "new-project", initialSkillSlug: null });
          router.replace("/projects?new=1");
        }}
        onNewSession={(projectId) => {
          if (runtimeState.available) void openNewSession(projectId);
        }}
        onProjectSettings={(projectId) => void openSettings(projectId)}
        modalOpen={dialog !== null}
      />
      <main
        className="main projects-main"
        aria-hidden={mobileOpen || dialog !== null || undefined}
        inert={mobileOpen || dialog !== null ? true : undefined}
      >
        {project && session ? (
          <ProjectSessionView
            project={project}
            initialSession={session}
            onOpenNavigation={() => setMobileOpen(true)}
            onProjectSettings={() => void openSettings(project.id)}
            onRetryWorkspace={() => void retryWorkspace(project.id)}
            retryBusy={
              workspaceRetry.projectId === project.id && workspaceRetry.busy
            }
            retryError={
              workspaceRetry.projectId === project.id
                ? workspaceRetry.error
                : null
            }
            onSessionChange={(next) => {
              setSession(next);
              setProject((current) =>
                current
                  ? {
                      ...current,
                      sessions: current.sessions.map((candidate) =>
                        candidate.id === next.id ? next : candidate,
                      ),
                      recentSessions: [
                        next,
                        ...current.recentSessions.filter(
                          (candidate) => candidate.id !== next.id,
                        ),
                      ].slice(0, 5),
                    }
                  : current,
              );
            }}
          />
        ) : project ? (
          <ProjectOverview
            project={project}
            runtime={runtimeState}
            onOpenNavigation={() => setMobileOpen(true)}
            onNewSession={() => void openNewSession(project.id)}
            onSettings={() => void openSettings(project.id)}
            onRetry={() => void retryWorkspace(project.id)}
            retryBusy={
              workspaceRetry.projectId === project.id && workspaceRetry.busy
            }
            retryError={
              workspaceRetry.projectId === project.id
                ? workspaceRetry.error
                : null
            }
          />
        ) : (
          <ProjectsHome
            projects={projects}
            runtime={runtimeState}
            onNewProject={() => {
              setDialog({ kind: "new-project", initialSkillSlug: null });
              router.replace("/projects?new=1");
            }}
          />
        )}
      </main>

      {(dialog?.kind === "new-project" || dialog?.kind === "new-session") &&
        !runtimeState.available && (
          <ProjectDialogState
            title="Projects unavailable"
            description="The persistent workspace runtime must be ready before starting work."
            headline="Projects are not available yet."
            loading={dialogLoading}
            error={error ?? runtimeState.message}
            onClose={closeDialog}
            onRetry={() => void retryRuntime()}
          />
        )}

      {dialog?.kind === "new-project" && runtimeState.available && (
        <NewProjectDialog
          skills={availableSkills}
          models={availableModels}
          initialSkillSlug={dialog.initialSkillSlug}
          busy={busy}
          error={error}
          catalogError={catalogError}
          onClose={closeDialog}
          onRetryCatalog={retryCatalogs}
          onCreate={(input) => {
            setBusy(true);
            setError(null);
            void createProject(input)
              .then((created) => {
                replaceProject(created);
                setProject(created);
                setSession(null);
                setDialog({
                  kind: "new-session",
                  projectId: created.id,
                  initialSkillSlug: dialog.initialSkillSlug,
                });
                router.replace(
                  `/projects/${created.id}?newSession=1${dialog.initialSkillSlug ? `&skill=${encodeURIComponent(dialog.initialSkillSlug)}` : ""}`,
                );
              })
              .catch((cause) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not create this project.",
                ),
              )
              .finally(() => setBusy(false));
          }}
        />
      )}

      {dialog?.kind === "new-session" &&
        runtimeState.available &&
        !selectedDialogProject && (
          <ProjectDialogState
            title="New session"
            description="Load the Project before starting a session."
            loading={dialogLoading}
            error={error}
            onClose={closeDialog}
            onRetry={() =>
              void openNewSession(dialog.projectId, dialog.initialSkillSlug)
            }
          />
        )}

      {dialog?.kind === "new-session" &&
        selectedDialogProject &&
        runtimeState.available && (
          <NewSessionDialog
            project={selectedDialogProject}
            models={availableModels}
            initialSkillSlug={dialog.initialSkillSlug}
            busy={busy}
            error={error}
            catalogError={choiceErrors.models}
            onClose={closeDialog}
            onRetryCatalog={retryCatalogs}
            onStart={(input) => {
              setBusy(true);
              setError(null);
              void createProjectSession(selectedDialogProject.id, input)
                .then((created) => {
                  const nextProject = {
                    ...selectedDialogProject,
                    sessionCount: selectedDialogProject.sessionCount + 1,
                    sessions: [created, ...selectedDialogProject.sessions],
                    recentSessions: [
                      created,
                      ...selectedDialogProject.recentSessions,
                    ].slice(0, 5),
                    updatedAt: created.createdAt,
                  };
                  replaceProject(nextProject);
                  setProject(nextProject);
                  setSession(created);
                  setDialog(null);
                  router.push(
                    `/projects/${selectedDialogProject.id}/sessions/${created.id}`,
                  );
                  router.refresh();
                })
                .catch((cause) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not start this session.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          />
        )}

      {dialog?.kind === "settings" && !settingsTarget && (
        <ProjectDialogState
          title="Project settings"
          description="Load the Project before changing its settings."
          loading={dialogLoading}
          error={error}
          onClose={closeDialog}
          onRetry={() => void openSettings(dialog.projectId)}
        />
      )}

      {dialog?.kind === "settings" && settingsTarget && (
        <ProjectSettingsDialog
          key={`${settingsTarget.id}:${settingsTarget.revision}`}
          project={settingsTarget}
          skills={availableSkills}
          models={availableModels}
          busy={busy}
          error={error}
          catalogError={catalogError}
          onClose={closeDialog}
          onRetryCatalog={retryCatalogs}
          onDelete={() => {
            setBusy(true);
            setError(null);
            void deleteProject(settingsTarget.id)
              .then(() => {
                setProjects((current) =>
                  current.filter(
                    (candidate) => candidate.id !== settingsTarget.id,
                  ),
                );
                setProject(null);
                setSession(null);
                setDialog(null);
                setSettingsTarget(null);
                router.push("/projects");
                router.refresh();
              })
              .catch((cause) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not delete this project.",
                ),
              )
              .finally(() => setBusy(false));
          }}
          onSave={(input) => {
            setBusy(true);
            setError(null);
            const nameChanged = input.name !== settingsTarget.name;
            const modelChanged =
              input.defaultModel !== settingsTarget.defaultModel;
            const updateDetails = nameChanged || modelChanged;
            const currentSlugs = settingsTarget.skills
              .map((skill) => skill.slug)
              .sort()
              .join("\0");
            const nextSlugs = [...input.skillSlugs].sort().join("\0");
            const saveDetails = updateDetails
              ? updateProject(settingsTarget.id, {
                  revision: settingsTarget.revision,
                  ...(nameChanged ? { name: input.name } : {}),
                  ...(modelChanged ? { defaultModel: input.defaultModel } : {}),
                })
              : Promise.resolve(settingsTarget);
            void saveDetails
              .then((updated) =>
                currentSlugs === nextSlugs
                  ? updated
                  : replaceProjectSkills(
                      updated.id,
                      updated.revision,
                      input.skillSlugs,
                    ),
              )
              .then((updated) => {
                replaceProject(updated);
                setDialog(null);
                setSettingsTarget(null);
                router.refresh();
              })
              .catch(async (cause) => {
                const message =
                  cause instanceof Error
                    ? cause.message
                    : "Could not save project settings.";
                try {
                  const latest = await fetchProject(settingsTarget.id);
                  replaceProject(latest);
                  setSettingsTarget(latest);
                  setError(
                    `${message} Current settings were refreshed; review them and retry.`,
                  );
                } catch {
                  setError(
                    `${message} Close and reopen settings before retrying.`,
                  );
                }
              })
              .finally(() => setBusy(false));
          }}
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
        <div className="project-toast" role="alert">
          <Icon name="alert-triangle" size={14} />
          <span>{orgActions.error}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => orgActions.setError(null)}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
