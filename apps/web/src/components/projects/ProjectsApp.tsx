"use client";

import {
  PROJECT_ATTACHMENT_MAX_BYTES,
  PROJECT_ATTACHMENT_MAX_FILES,
} from "@companion/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OrgVM } from "@/lib/types";
import { formatBytes, relativeTime } from "@/lib/format";
import { setCurrentOrg } from "@/lib/org";
import {
  createProject,
  createProjectSession,
  deleteProject,
  fetchProject,
  fetchProjectSessions,
  fetchProjects,
  replaceProjectSkills,
  retryProjectWorkspace,
  updateProject,
  updateProjectSession,
  uploadProjectFiles,
} from "@/lib/projects";
import {
  mergeProjectRow,
  sortProjectSessionsByCreatedAt,
  type ProjectDetailVM,
  type ProjectFileVM,
  type ProjectModelChoice,
  type ProjectRowVM,
  type ProjectRuntimeAvailability,
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
  RenameSessionDialog,
} from "./ProjectDialogs";
import { ProjectRecoveryActions } from "./ProjectRecoveryActions";
import {
  ProjectFilesDrawer,
  ProjectFilesPanel,
  ProjectSessionView,
  type ProjectFilePreviewTarget,
  useDesktopFilesPanel,
} from "./ProjectSessionView";
import { ProjectsActionMenu, ProjectsSidebar } from "./ProjectsSidebar";

type DialogState =
  | { kind: "new-project"; initialSkillSlug: string | null }
  | { kind: "new-session"; projectId: string; initialSkillSlug: string | null }
  | { kind: "settings"; projectId: string }
  | {
      kind: "rename-session";
      projectId: string;
      session: ProjectSessionVM;
    }
  | null;

type HomeFilter = "all" | "working" | "needs_attention" | "archived";
type ProjectToast = {
  tone: "neutral" | "warning" | "danger";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};
type ProjectResultToast = {
  id: string;
  tone: "neutral" | "warning";
  message: string;
  href: string;
};
type ProjectChoiceErrors = {
  skills: string | null;
  models: string | null;
};
type ProjectSessionChange = {
  sequence: number;
  projectId: string;
  session: ProjectSessionVM;
};

const PROJECT_REFRESH_MS = 15_000;
const PROJECT_VIEWED_MAX_ATTEMPTS = 3;
const PROJECT_VIEWED_RETRY_DELAYS_MS = [1_000, 3_000] as const;

function isNotFoundResponse(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "status" in cause &&
    (cause as Error & { status?: unknown }).status === 404
  );
}

function projectStatusLabel(
  status: ProjectRowVM["status"],
  activeSessionCount = 0,
): string {
  switch (status) {
    case "queued":
    case "provisioning":
      return "Getting ready";
    case "ready":
      return "Idle";
    case "running":
      return activeSessionCount > 0 ? "Working" : "Ready";
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
  activeSessionCount = 0,
): "working" | "waiting" | "done" | "error" {
  if (status === "running")
    return activeSessionCount > 0 ? "working" : "done";
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

function projectFilter(
  project: Pick<ProjectRowVM, "status" | "activeSessionCount">,
): HomeFilter {
  if (project.status === "running" && project.activeSessionCount > 0)
    return "working";
  if (project.status === "needs_attention" || project.status === "error")
    return "needs_attention";
  return "all";
}

function humanizeTechnicalName(value: string): string {
  return value
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) =>
      /^(ai|gpt|glm)$/i.test(part)
        ? part.toUpperCase()
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

const KNOWN_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  "z.ai": "Z.ai",
  "z-ai": "Z.ai",
  zai: "Z.ai",
};

function humanizeProviderName(value: string): string {
  return (
    KNOWN_PROVIDER_LABELS[value.trim().toLocaleLowerCase()] ??
    humanizeTechnicalName(value)
  );
}

function humanizeModelSuffix(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) =>
      /^(ai|gpt|glm)$/i.test(part)
        ? part.toUpperCase()
        : /^\d+(?:\.\d+)*$/.test(part)
          ? part
          : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

function humanizeModelName(value: string): string {
  const brandedFamilies: ReadonlyArray<{
    pattern: RegExp;
    label: string;
    separator: string;
  }> = [
    { pattern: /^gpt[-_.]?(.+)$/i, label: "GPT", separator: "-" },
    { pattern: /^glm[-_.]?(.+)$/i, label: "GLM", separator: " " },
    { pattern: /^claude[-_.]?(.+)$/i, label: "Claude", separator: " " },
    { pattern: /^gemini[-_.]?(.+)$/i, label: "Gemini", separator: " " },
  ];
  for (const family of brandedFamilies) {
    const match = family.pattern.exec(value);
    if (match?.[1]) {
      return `${family.label}${family.separator}${humanizeModelSuffix(match[1])}`;
    }
  }
  return humanizeModelSuffix(value);
}

function modelLabel(modelId: string, models: ProjectModelChoice[]): string {
  const model = models.find((candidate) => candidate.id === modelId);
  if (model) return `${model.name} · ${model.providerName}`;
  const parts = modelId.split("/").filter(Boolean);
  const name = humanizeModelName(parts.at(-1) ?? "Model");
  const provider =
    parts.length > 1 ? humanizeProviderName(parts[0]!) : "Configured";
  return `${name} · ${provider}`;
}

function providerLabel(
  providerId: string,
  models: ProjectModelChoice[],
): string {
  return (
    models.find((model) => model.id.split("/")[0] === providerId)
      ?.providerName ?? humanizeProviderName(providerId)
  );
}

function sessionSignal(
  value: Pick<ProjectSessionVM, "status" | "isUnread">,
): { label: "Working" | "New result" | "Failed"; tone: string } | null {
  if (["queued", "working", "stopping"].includes(value.status))
    return { label: "Working", tone: "working" };
  if (value.status === "error") return { label: "Failed", tone: "waiting" };
  if (value.isUnread) return { label: "New result", tone: "new" };
  return null;
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
          "Projects are temporarily unavailable. Try again later or ask your workspace owner for help."}
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
  models,
  archivedProjectsRevision,
  onNewProject,
  onRestoreProject,
}: {
  projects: ProjectRowVM[];
  runtime: ProjectRuntimeAvailability;
  models: ProjectModelChoice[];
  archivedProjectsRevision: number;
  onNewProject: () => void;
  onRestoreProject: (project: ProjectRowVM) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HomeFilter>("all");
  const [archivedProjects, setArchivedProjects] = useState<ProjectRowVM[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(true);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setArchivedLoading(true);
    setArchivedError(null);
    void fetchProjects("archived")
      .then((response) => {
        if (active) setArchivedProjects(response.projects);
      })
      .catch((cause) => {
        if (!active) return;
        setArchivedError(
          cause instanceof Error
            ? cause.message
            : "Archived Projects could not be loaded.",
        );
      })
      .finally(() => {
        if (active) setArchivedLoading(false);
      });
    return () => {
      active = false;
    };
  }, [archivedProjectsRevision]);
  const counts = {
    needsAttention: projects.filter(
      (project) => projectFilter(project) === "needs_attention",
    ).length,
    working: projects.filter(
      (project) => projectFilter(project) === "working",
    ).length,
  };
  const sourceProjects =
    filter === "archived" ? archivedProjects : projects;
  const normalized = query.trim().toLocaleLowerCase();
  const visible = sourceProjects.filter((project) => {
    if (
      filter !== "all" &&
      filter !== "archived" &&
      projectFilter(project) !== filter
    )
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
        <span className="cowork-page-head__count tnum">
          {sourceProjects.length}
        </span>
        <span className="cowork-page-head__summary">
          {filter === "archived"
            ? `${archivedProjects.length} archived`
            : `${counts.working} working · ${counts.needsAttention} need attention`}
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
              ["working", counts.working],
              ["needs_attention", counts.needsAttention],
              ["archived", archivedProjects.length],
            ] as const
          ).map(([value, count]) => (
            <button
              type="button"
              key={value}
              className={filter === value ? "is-active" : undefined}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === "all"
                ? "All"
                : value === "working"
                  ? "Working"
                  : value === "needs_attention"
                    ? "Needs attention"
                    : "Archived"}{" "}
              <span className="tnum">{count}</span>
            </button>
          ))}
        </div>
      </div>
      {filter === "archived" && archivedError && (
        <p className="cowork-conversation-error" role="alert">
          <Icon name="alert-triangle" size={13} />
          {archivedError}
        </p>
      )}
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
                  <small>{modelLabel(project.defaultModel, models)}</small>
                </span>
              </span>
              <span className="cds-status" role="cell">
                <span
                  className={`project-status-dot is-${
                    filter === "archived"
                      ? "waiting"
                      : projectStatusTone(
                          project.status,
                          project.activeSessionCount,
                        )
                  }`}
                />
                {filter === "archived"
                  ? "Archived"
                  : projectStatusLabel(
                      project.status,
                      project.activeSessionCount,
                    )}
              </span>
              <span className="cowork-project-row__meta" role="cell">
                {project.sessionCount} sessions · {project.fileCount} files
              </span>
              <span className="cowork-project-row__time tnum" role="cell">
                <time dateTime={project.updatedAt}>
                  {relativeTime(project.updatedAt)}
                </time>
                {filter === "archived" && (
                  <button
                    type="button"
                    className="cds-iconbtn cds-iconbtn--sm cowork-project-row__restore"
                    aria-label={`Restore ${project.name}`}
                    onClick={() => {
                      void onRestoreProject(project).then((restored) => {
                        if (!restored) return;
                        setArchivedProjects((current) =>
                          current.filter(
                            (candidate) => candidate.id !== project.id,
                          ),
                        );
                      });
                    }}
                  >
                    <Icon name="rotate-ccw" size={13} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {visible.length === 0 && !archivedLoading && (
          <div className="cowork-table-empty">
            <Icon
              name={projects.length === 0 ? "boxes" : "search-x"}
              size={20}
            />
            <strong>
              {filter === "archived"
                ? "No archived Projects"
                : projects.length === 0
                ? "Create your first project"
                : "No projects found"}
            </strong>
            <span>
              {filter === "archived"
                ? "Archived Projects remain recoverable until you delete them permanently."
                : projects.length === 0
                ? "A Project keeps conversations, files, Skills, and Access together."
                : "Try another search or status filter."}
            </span>
            {filter !== "archived" &&
              projects.length === 0 &&
              runtime.available && (
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
        {archivedLoading && (
          <div className="cowork-table-empty" role="status">
            <Icon name="loader" size={18} className="ls-spin" />
            <strong>Loading archived Projects…</strong>
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectOverview({
  project,
  runtime,
  models,
  onOpenNavigation,
  onNewSession,
  onSettings,
  onArchiveProject,
  onRestoreProject,
  onFilesUploaded,
  onRenameSession,
  onArchiveSession,
  onRestoreSession,
  sessionChange,
  onRetry,
  retryBusy,
  retryError,
}: {
  project: ProjectDetailVM;
  runtime: ProjectRuntimeAvailability;
  models: ProjectModelChoice[];
  onOpenNavigation: () => void;
  onNewSession: () => void;
  onSettings: () => void;
  onArchiveProject: () => void;
  onRestoreProject: () => void;
  onFilesUploaded: (files: ProjectFileVM[]) => void;
  onRenameSession: (session: ProjectSessionVM) => void;
  onArchiveSession: (session: ProjectSessionVM) => void;
  onRestoreSession: (session: ProjectSessionVM) => void;
  sessionChange: ProjectSessionChange | null;
  onRetry: () => void;
  retryBusy: boolean;
  retryError: string | null;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  const [sessions, setSessions] = useState(() =>
    sortProjectSessionsByCreatedAt(
      project.sessions.filter(
        (candidate) => (candidate.archivedAt ?? null) === null,
      ),
    ),
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionListError, setSessionListError] = useState<string | null>(null);
  const [contextTab, setContextTab] = useState<"files" | "skills" | "access">(
    "files",
  );
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [fileUploadError, setFileUploadError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [fileSelection, setFileSelection] =
    useState<ProjectFilePreviewTarget | null>(null);
  const filesReturnFocusRef = useRef<HTMLElement | null>(null);
  const desktopFilesPanel = useDesktopFilesPanel();
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const listScope = `${project.id}:${view}:${query}`;
  const listScopeRef = useRef(listScope);
  listScopeRef.current = listScope;

  useEffect(() => {
    setFilesOpen(false);
    setFileSelection(null);
  }, [project.id]);

  useEffect(() => {
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    const controller = new AbortController();
    setLoadingSessions(true);
    setNextCursor(null);
    setSessions([]);
    const timer = window.setTimeout(() => {
      setSessionListError(null);
      void fetchProjectSessions(project.id, {
        query,
        view,
        limit: 50,
        signal: controller.signal,
      })
        .then((response) => {
          if (controller.signal.aborted) return;
          setSessions(response.sessions);
          setNextCursor(response.nextCursor);
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setSessionListError(
            cause instanceof Error
              ? cause.message
              : "Conversations could not be loaded.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingSessions(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      loadMoreControllerRef.current?.abort();
    };
  }, [project.id, query, view]);

  useEffect(() => {
    if (!sessionChange || sessionChange.projectId !== project.id) return;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const belongsInView =
      view === "archived"
        ? sessionChange.session.archivedAt !== null
        : sessionChange.session.archivedAt === null;
    const matchesQuery =
      !normalizedQuery ||
      sessionChange.session.title
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    setSessions((current) =>
      sortProjectSessionsByCreatedAt([
        ...current.filter(
          (candidate) => candidate.id !== sessionChange.session.id,
        ),
        ...(belongsInView && matchesQuery ? [sessionChange.session] : []),
      ]),
    );
  }, [project.id, query, sessionChange, view]);

  useEffect(() => {
    if (view !== "active" || query.trim()) return;
    const fresh = new Map(
      project.sessions
        .filter((candidate) => candidate.archivedAt === null)
        .map((candidate) => [candidate.id, candidate]),
    );
    setSessions((current) => {
      const merged = current.map(
        (candidate) => fresh.get(candidate.id) ?? candidate,
      );
      const currentIds = new Set(current.map((candidate) => candidate.id));
      return sortProjectSessionsByCreatedAt([
        ...merged,
        ...project.sessions.filter(
          (candidate) =>
            candidate.archivedAt === null && !currentIds.has(candidate.id),
        ),
      ]);
    });
  }, [project.id, project.sessions, query, view]);

  const loadMore = () => {
    if (!nextCursor || loadingSessions) return;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    const requestedScope = listScopeRef.current;
    setLoadingSessions(true);
    setSessionListError(null);
    void fetchProjectSessions(project.id, {
      query,
      view,
      cursor: nextCursor,
      limit: 50,
      signal: controller.signal,
    })
      .then((response) => {
        if (
          controller.signal.aborted ||
          listScopeRef.current !== requestedScope
        )
          return;
        setSessions((current) =>
          sortProjectSessionsByCreatedAt([
            ...current,
            ...response.sessions.filter(
              (candidate) =>
                !current.some((existing) => existing.id === candidate.id),
            ),
          ]),
        );
        setNextCursor(response.nextCursor);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setSessionListError(
          cause instanceof Error
            ? cause.message
            : "More conversations could not be loaded.",
        );
      })
      .finally(() => {
        if (loadMoreControllerRef.current !== controller) return;
        loadMoreControllerRef.current = null;
        if (listScopeRef.current === requestedScope) setLoadingSessions(false);
      });
  };

  const acceptsSessions =
    runtime.available &&
    !project.archivedAt &&
    !["needs_attention", "error", "deleting", "deleted"].includes(
      project.status,
    );

  return (
    <>
      <div className="cowork-project-workspace">
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
          <h1>{project.name}</h1>
          <span className="cds-status">
            <span
              className={`project-status-dot is-${projectStatusTone(
                project.status,
                project.activeSessionCount,
              )}`}
            />
            {projectStatusLabel(
              project.status,
              project.activeSessionCount,
            )}
            <span>{modelLabel(project.defaultModel, models)}</span>
          </span>
        </div>
        {project.archivedAt ? (
          <button
            type="button"
            className="cds-btn cds-btn--primary cds-btn--md"
            onClick={onRestoreProject}
          >
            <Icon name="rotate-ccw" size={14} />
            Restore project
          </button>
        ) : (
          <button
            type="button"
            className="cds-btn cds-btn--primary cds-btn--md"
            onClick={onNewSession}
            disabled={!acceptsSessions}
          >
            <Icon name="square-pen" size={14} />
            New conversation
          </button>
        )}
        <ProjectsActionMenu
          label={`Actions for ${project.name}`}
          className="cds-iconbtn cds-iconbtn--md"
          actions={[
            {
              label: "Project settings",
              icon: "settings",
              onSelect: onSettings,
            },
            ...(project.archivedAt
              ? []
              : [
                  {
                    label:
                      project.activeSessionCount > 0
                        ? "Finish conversations to archive"
                        : "Archive project",
                    icon: "archive",
                    disabled: project.activeSessionCount > 0,
                    onSelect: onArchiveProject,
                  } as const,
                ]),
          ]}
        />
      </header>
      {(project.status === "needs_attention" || project.status === "error") && (
        <div className="cowork-project-alert" role="alert">
          <Icon name="alert-triangle" size={14} />
          <span>
            <strong>This project needs attention.</strong>
            Companion could not make this Project’s workspace available. Try
            again, or review its settings if the issue continues.
            <details>
              <summary>Technical details</summary>
              <code>
                {project.statusDetail ||
                  project.workspace.statusDetail ||
                  "The persistent workspace could not be restored."}
              </code>
            </details>
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
              <h2 id="project-sessions-title">Conversations</h2>
              <p>Every conversation shares this Project’s files and context.</p>
            </div>
            <span className="tnum">
              {view === "active"
                ? project.sessionCount
                : project.archivedSessionCount}
            </span>
          </div>
          <div className="cowork-conversation-tools">
            <div
              className="cowork-conversation-tabs"
              role="group"
              aria-label="Conversation views"
            >
              <button
                type="button"
                aria-pressed={view === "active"}
                className={view === "active" ? "is-active" : undefined}
                onClick={() => setView("active")}
              >
                Conversations
              </button>
              <button
                type="button"
                aria-pressed={view === "archived"}
                className={view === "archived" ? "is-active" : undefined}
                onClick={() => setView("archived")}
              >
                Archived
              </button>
            </div>
            <label className="cowork-search cowork-conversation-search">
              <Icon name="search" size={13} />
              <span className="sr-only">Search all conversations</span>
              <input
                value={query}
                placeholder="Search conversations…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {sessionListError && (
            <p className="cowork-conversation-error" role="alert">
              <Icon name="alert-triangle" size={13} />
              {sessionListError}
            </p>
          )}
          {sessions.length > 0 ? (
            <div className="cowork-session-list">
              {sessions.map((conversation) => {
                const signal = sessionSignal(conversation);
                return (
                  <div className="cowork-session-row" key={conversation.id}>
                    <Link
                      href={`/projects/${project.id}/sessions/${conversation.id}`}
                      className="cowork-session-row__link"
                    >
                      <span className="cowork-session-row__copy">
                        <strong>{conversation.title}</strong>
                        <small>
                          <time dateTime={conversation.createdAt}>
                            Created {relativeTime(conversation.createdAt)}
                          </time>
                          <span aria-hidden="true"> · </span>
                          {modelLabel(conversation.model, models)}
                        </small>
                      </span>
                      {signal && (
                        <span
                          className={`cowork-session-row__signal is-${signal.tone}`}
                        >
                          <span
                            className={`project-status-dot is-${signal.tone}`}
                            aria-hidden="true"
                          />
                          {signal.label}
                        </span>
                      )}
                      <Icon name="chevron-right" size={14} />
                    </Link>
                    <ProjectsActionMenu
                      label={`Actions for ${conversation.title}`}
                      className="cowork-session-row__action"
                      actions={[
                        {
                          label: "Rename",
                          icon: "pencil",
                          onSelect: () => onRenameSession(conversation),
                        },
                        conversation.archivedAt
                          ? {
                              label: "Restore",
                              icon: "rotate-ccw",
                              onSelect: () =>
                                onRestoreSession(conversation),
                            }
                          : {
                              label: [
                                "queued",
                                "working",
                                "stopping",
                              ].includes(conversation.status)
                                ? "Stop and archive"
                                : "Archive",
                              icon: "archive",
                              onSelect: () =>
                                onArchiveSession(conversation),
                            },
                      ]}
                    />
                  </div>
                );
              })}
              {nextCursor && (
                <button
                  type="button"
                  className="cowork-conversation-more"
                  disabled={loadingSessions}
                  onClick={loadMore}
                >
                  {loadingSessions ? "Loading…" : "Load more"}
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="cowork-project-empty"
              onClick={
                view === "active" && !query ? onNewSession : undefined
              }
              disabled={
                view === "archived" ||
                Boolean(query) ||
                loadingSessions ||
                !acceptsSessions
              }
            >
              <span>
                <Icon
                  name={view === "active" ? "message-square" : "archive"}
                  size={16}
                />
              </span>
              <strong>
                {loadingSessions
                  ? "Loading conversations…"
                  : query
                    ? "No matching conversations"
                    : view === "archived"
                      ? "No archived conversations"
                      : "Start the first conversation"}
              </strong>
              <small>
                {query
                  ? "Try another search."
                  : view === "archived"
                    ? "Conversations you archive will stay available here."
                    : "Describe an outcome. The agent already has this Project’s context."}
              </small>
              {view === "active" && !query && (
                <Icon name="arrow-right" size={14} />
              )}
            </button>
          )}
        </section>
        <aside className="cowork-project__rail" aria-label="Project context">
          <div
            className="cowork-context-tabs"
            role="group"
            aria-label="Project context"
          >
            {(
              [
                ["files", "folder-open", "Files", project.files.length],
                ["skills", "package", "Skills", project.skills.length],
                [
                  "access",
                  "key-round",
                  "Access",
                  project.secretCount + project.modelConnectionCount,
                ],
              ] as const
            ).map(([value, icon, label, count]) => (
              <button
                type="button"
                key={value}
                aria-pressed={contextTab === value}
                aria-label={
                  value === "access"
                    ? `Access · ${project.secretCount} secrets · ${project.modelConnectionCount} model connections`
                    : undefined
                }
                className={contextTab === value ? "is-active" : undefined}
                onClick={() => setContextTab(value)}
              >
                <Icon name={icon} size={13} />
                <span>{label}</span>
                <b className="tnum">{count}</b>
              </button>
            ))}
          </div>
          <section
            className="cowork-context-panel"
            aria-label={
              contextTab === "files"
                ? "Files"
                : contextTab === "skills"
                  ? "Skills"
                  : "Access"
            }
          >
            {contextTab === "files" && (
              <>
                <div className="cowork-context-panel__head">
                  <span>Shared across conversations</span>
                  <label
                    className={`cowork-context-panel__upload${
                      uploadingFiles ? " is-busy" : ""
                    }`}
                  >
                    {uploadingFiles ? "Adding…" : "Add files"}
                    <input
                      type="file"
                      multiple
                      disabled={uploadingFiles || Boolean(project.archivedAt)}
                      onChange={(event) => {
                        const selected = event.target.files
                          ? Array.from(event.target.files)
                          : [];
                        event.target.value = "";
                        if (selected.length === 0) return;
                        if (
                          selected.length > PROJECT_ATTACHMENT_MAX_FILES
                        ) {
                          setFileUploadError(
                            `Add up to ${PROJECT_ATTACHMENT_MAX_FILES} files at a time.`,
                          );
                          return;
                        }
                        if (
                          selected.some(
                            (file) =>
                              file.size < 1 ||
                              file.size > PROJECT_ATTACHMENT_MAX_BYTES,
                          )
                        ) {
                          setFileUploadError(
                            "Each file must be between 1 byte and 10 MB.",
                          );
                          return;
                        }
                        setUploadingFiles(true);
                        setFileUploadError(null);
                        void uploadProjectFiles(project.id, selected)
                          .then(onFilesUploaded)
                          .catch((cause) =>
                            setFileUploadError(
                              cause instanceof Error
                                ? cause.message
                                : "Files could not be added.",
                            ),
                          )
                          .finally(() => setUploadingFiles(false));
                      }}
                    />
                  </label>
                </div>
                {fileUploadError && (
                  <p className="cowork-context-panel__error" role="alert">
                    {fileUploadError}
                  </p>
                )}
                <div className="cowork-file-list">
                  {project.files.map((file) => (
                    <button
                      type="button"
                      key={file.id}
                      aria-label={`Preview ${file.name}`}
                      onClick={(event) => {
                        filesReturnFocusRef.current = event.currentTarget;
                        setFileSelection({
                          id: file.id,
                          path: file.path,
                          name: file.name,
                          version: file.version,
                          contentType: file.contentType,
                          byteSize: file.byteSize,
                          exactVersion: false,
                        });
                        setFilesOpen(true);
                      }}
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
                    </button>
                  ))}
                  {project.files.length === 0 && (
                    <p>Add a file here, attach one to a message, or ask the agent to create one.</p>
                  )}
                </div>
              </>
            )}
            {contextTab === "skills" && (
              <>
                <div className="cowork-context-panel__head">
                  <span>Synced automatically</span>
                  <button type="button" onClick={onSettings}>
                    Manage
                  </button>
                </div>
                <div className="cowork-rail-list">
                  {project.skills.map((skill) => (
                    <div key={skill.slug}>
                      <Icon name="package" size={12} />
                      <strong>{skill.displayName}</strong>
                      <small>{skill.version}</small>
                    </div>
                  ))}
                  {project.skills.length === 0 && <p>No skills synced.</p>}
                </div>
              </>
            )}
            {contextTab === "access" && (
              <div className="cowork-access-list">
                <p className="cowork-access-summary">
                  Access · {project.secretCount} secrets ·{" "}
                  {project.modelConnectionCount} model connections
                </p>
                <p className="cowork-rail-note">
                  <Icon name="shield-check" size={13} />
                  Access is checked and synced whenever this Project wakes.
                </p>
                {project.access.secrets.map((secret) => (
                  <div key={secret.id}>
                    <Icon name="key-round" size={12} />
                    <span>
                      <strong>{secret.name}</strong>
                      <small>
                        {secret.source === "personal"
                          ? "Personal"
                          : secret.source === "shared"
                            ? `Shared by ${secret.ownerName}`
                            : "Organization"}
                      </small>
                    </span>
                  </div>
                ))}
                {project.access.modelConnections.map((connection) => (
                  <div key={connection.id}>
                    <Icon name="plug-zap" size={12} />
                    <span>
                      <strong title={connection.provider}>
                        {providerLabel(connection.provider, models)}
                      </strong>
                      <small>
                        {connection.source === "personal"
                          ? "Personal model connection"
                          : "Organization model connection"}
                      </small>
                    </span>
                  </div>
                ))}
                {project.access.secrets.length === 0 &&
                  project.access.modelConnections.length === 0 && (
                    <p>
                      {project.secretCount} secrets ·{" "}
                      {project.modelConnectionCount} model connections
                    </p>
                  )}
              </div>
            )}
          </section>
        </aside>
      </div>
        </div>
        {desktopFilesPanel && filesOpen && (
          <ProjectFilesPanel
            projectId={project.id}
            files={project.files}
            selection={fileSelection}
            attachmentPreview={null}
            returnFocusRef={filesReturnFocusRef}
            onSelectionChange={setFileSelection}
            onClose={() => setFilesOpen(false)}
          />
        )}
      </div>
      <ProjectFilesDrawer
        open={!desktopFilesPanel && filesOpen}
        projectId={project.id}
        files={project.files}
        selection={fileSelection}
        attachmentPreview={null}
        returnFocusRef={filesReturnFocusRef}
        onSelectionChange={setFileSelection}
        onClose={() => setFilesOpen(false)}
      />
    </>
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

function mergeSessionIntoRow(
  row: ProjectRowVM,
  next: ProjectSessionVM,
  previous?: ProjectSessionVM,
): ProjectRowVM {
  const wasArchived =
    previous !== undefined && (previous.archivedAt ?? null) !== null;
  const isArchived = (next.archivedAt ?? null) !== null;
  const archivedDelta =
    previous && wasArchived !== isArchived ? (isArchived ? 1 : -1) : 0;
  const activeDelta =
    previous && wasArchived !== isArchived ? (isArchived ? -1 : 1) : 0;
  const previousUnread = Boolean(previous?.isUnread && !wasArchived);
  const nextUnread = Boolean(next.isUnread && !isArchived);
  const previousActive = Boolean(
    previous &&
      !wasArchived &&
      ["queued", "working", "stopping"].includes(previous.status),
  );
  const nextActive =
    !isArchived && ["queued", "working", "stopping"].includes(next.status);
  const recentSessions = sortProjectSessionsByCreatedAt([
    ...row.recentSessions.filter((candidate) => candidate.id !== next.id),
    ...(isArchived ? [] : [next]),
  ]).slice(0, 5);
  return {
    ...row,
    sessionCount: Math.max(0, row.sessionCount + activeDelta),
    activeSessionCount: Math.max(
      0,
      row.activeSessionCount +
        (nextActive ? 1 : 0) -
        (previousActive ? 1 : 0),
    ),
    archivedSessionCount: Math.max(
      0,
      row.archivedSessionCount + archivedDelta,
    ),
    unreadSessionCount: Math.max(
      0,
      row.unreadSessionCount +
        (nextUnread ? 1 : 0) -
        (previousUnread ? 1 : 0),
    ),
    recentSessions,
  };
}

function mergeSessionIntoDetail(
  detail: ProjectDetailVM,
  next: ProjectSessionVM,
  previous?: ProjectSessionVM,
): ProjectDetailVM {
  const row = mergeSessionIntoRow(detail, next, previous);
  const sessions = sortProjectSessionsByCreatedAt([
    ...detail.sessions.filter((candidate) => candidate.id !== next.id),
    ...(next.archivedAt ? [] : [next]),
  ]);
  return { ...detail, ...row, sessions };
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
  const [toast, setToast] = useState<ProjectToast | null>(null);
  const [resultToasts, setResultToasts] = useState<ProjectResultToast[]>([]);
  const [archivedProjectsRevision, setArchivedProjectsRevision] = useState(0);
  const [viewedRetryTick, setViewedRetryTick] = useState(0);
  const [workspaceRetry, setWorkspaceRetry] = useState<{
    projectId: string | null;
    busy: boolean;
    error: string | null;
  }>({ projectId: null, busy: false, error: null });
  const [sessionChange, setSessionChange] =
    useState<ProjectSessionChange | null>(null);
  const dialogRequestRef = useRef(0);
  const terminalProjectIdsRef = useRef(new Set<string>());
  const workspaceRetryRef = useRef<string | null>(null);
  const sessionMutationRef = useRef(new Set<string>());
  const viewedSessionRef = useRef(new Map<string, string>());
  const viewedAttemptRef = useRef(
    new Map<string, { updatedAt: string; attempts: number }>(),
  );
  const viewedRetryTimersRef = useRef(new Map<string, number>());
  const projectsRef = useRef(projects);
  const toggleMobileNavigation = useCallback(
    () => setMobileOpen((current) => !current),
    [],
  );
  const closeMobileNavigation = useCallback(() => setMobileOpen(false), []);

  const sidebarProjects = useMemo(
    () =>
      projects.map((row) => {
        if (row.id !== project?.id) return row;
        return {
          ...mergeProjectRow(project),
          recentSessions: sortProjectSessionsByCreatedAt(
            project.sessions.filter(
              (candidate) => (candidate.archivedAt ?? null) === null,
            ),
          ).slice(0, 5),
        };
      }),
    [project, projects],
  );

  const replaceProject = (next: ProjectDetailVM) => {
    if (terminalProjectIdsRef.current.has(next.id)) return;
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

  const applySessionChange = useCallback(
    (
      projectId: string,
      next: ProjectSessionVM,
      previous?: ProjectSessionVM,
    ) => {
      setSession((current) => (current?.id === next.id ? next : current));
      setProject((current) =>
        current?.id === projectId
          ? mergeSessionIntoDetail(current, next, previous)
          : current,
      );
      setProjects((current) =>
        current.map((candidate) =>
          candidate.id === projectId
            ? mergeSessionIntoRow(candidate, next, previous)
            : candidate,
        ),
      );
      setSessionChange((current) => ({
        sequence: (current?.sequence ?? 0) + 1,
        projectId,
        session: next,
      }));
    },
    [],
  );

  const applyProjectFiles = useCallback(
    (projectId: string, uploaded: ProjectFileVM[]) => {
      const uploadedPaths = new Set(uploaded.map((file) => file.path));
      const knownFileCount =
        project?.id === projectId
          ? new Set([
              ...project.files.map((file) => file.path),
              ...uploadedPaths,
            ]).size
          : null;
      setProject((current) => {
        if (current?.id !== projectId) return current;
        const files = [
          ...current.files.filter((file) => !uploadedPaths.has(file.path)),
          ...uploaded,
        ].sort((left, right) => left.path.localeCompare(right.path));
        return { ...current, files, fileCount: files.length };
      });
      setProjects((current) =>
        current.map((candidate) =>
          candidate.id === projectId && knownFileCount !== null
            ? {
                ...candidate,
                fileCount: knownFileCount,
              }
            : candidate,
        ),
      );
      setToast({
        tone: "neutral",
        message:
          uploaded.length === 1
            ? `${uploaded[0]!.name} added to the Project.`
            : `${uploaded.length} files added to the Project.`,
      });
    },
    [project],
  );

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    setRuntimeState(runtime);
  }, [runtime]);

  useEffect(
    () => () => {
      for (const timer of viewedRetryTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      viewedRetryTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (
      !project ||
      !session ||
      !session.isUnread ||
      viewedSessionRef.current.get(session.id) === session.updatedAt
    )
      return;
    const previousAttempt = viewedAttemptRef.current.get(session.id);
    const attempts =
      previousAttempt?.updatedAt === session.updatedAt
        ? previousAttempt.attempts
        : 0;
    if (attempts >= PROJECT_VIEWED_MAX_ATTEMPTS) return;
    const nextAttempt = attempts + 1;
    viewedAttemptRef.current.set(session.id, {
      updatedAt: session.updatedAt,
      attempts: nextAttempt,
    });
    const pendingTimer = viewedRetryTimersRef.current.get(session.id);
    if (pendingTimer !== undefined) {
      window.clearTimeout(pendingTimer);
      viewedRetryTimersRef.current.delete(session.id);
    }
    viewedSessionRef.current.set(session.id, session.updatedAt);
    const previous = session;
    const viewed = {
      ...session,
      isUnread: false,
      lastViewedAt: new Date().toISOString(),
    };
    applySessionChange(project.id, viewed, previous);
    void updateProjectSession(project.id, session.id, { viewed: true })
      .then((persisted) => {
        viewedSessionRef.current.delete(session.id);
        viewedAttemptRef.current.delete(session.id);
        applySessionChange(project.id, persisted, viewed);
      })
      .catch(() => {
        if (viewedSessionRef.current.get(session.id) !== session.updatedAt) {
          return;
        }
        applySessionChange(project.id, previous, viewed);
        if (nextAttempt >= PROJECT_VIEWED_MAX_ATTEMPTS) return;
        const retryDelay =
          PROJECT_VIEWED_RETRY_DELAYS_MS[nextAttempt - 1] ??
          PROJECT_VIEWED_RETRY_DELAYS_MS.at(-1)!;
        const timer = window.setTimeout(() => {
          viewedRetryTimersRef.current.delete(session.id);
          const latestAttempt = viewedAttemptRef.current.get(session.id);
          if (
            latestAttempt?.updatedAt !== session.updatedAt ||
            viewedSessionRef.current.get(session.id) !== session.updatedAt
          )
            return;
          viewedSessionRef.current.delete(session.id);
          setViewedRetryTick((current) => current + 1);
        }, retryDelay);
        viewedRetryTimersRef.current.set(session.id, timer);
      });
  }, [applySessionChange, project, session, viewedRetryTick]);

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
        const previousProjects = projectsRef.current;
        const newlyUnread = response.projects
          .flatMap((nextProject) => {
            const previousProject = previousProjects.find(
              (candidate) => candidate.id === nextProject.id,
            );
            return nextProject.recentSessions
              .filter((candidate) => candidate.isUnread)
              .filter((candidate) => {
                const previousSession = previousProject?.recentSessions.find(
                  (item) => item.id === candidate.id,
                );
                return !previousSession?.isUnread;
              })
              .map((candidate) => ({ project: nextProject, session: candidate }));
          });
        const nextResultToasts: ProjectResultToast[] = newlyUnread
          .filter((candidate) => candidate.session.id !== activeSessionId)
          .map((candidate) => ({
            id: `session:${candidate.session.id}:${candidate.session.updatedAt}`,
            tone:
              candidate.session.status === "error" ? "warning" : "neutral",
            message:
              candidate.session.status === "error"
                ? `${candidate.session.title} failed.`
                : `${candidate.session.title} has a new result.`,
            href: `/projects/${candidate.project.id}/sessions/${candidate.session.id}`,
          }));
        for (const nextProject of response.projects) {
          const previousProject = previousProjects.find(
            (candidate) => candidate.id === nextProject.id,
          );
          const unreadDelta = Math.max(
            0,
            nextProject.unreadSessionCount -
              (previousProject?.unreadSessionCount ?? 0),
          );
          const listedDelta = newlyUnread.filter(
            (candidate) => candidate.project.id === nextProject.id,
          ).length;
          const unlistedDelta = Math.max(0, unreadDelta - listedDelta);
          if (unlistedDelta === 0) continue;
          nextResultToasts.push({
            id: `project:${nextProject.id}:unread:${nextProject.unreadSessionCount}`,
            tone: "neutral",
            message:
              unlistedDelta === 1
                ? `${nextProject.name} has a new result.`
                : `${nextProject.name} has ${unlistedDelta} new results.`,
            href: `/projects/${nextProject.id}`,
          });
        }
        if (nextResultToasts.length > 0) {
          setResultToasts((current) => {
            const known = new Set(current.map((candidate) => candidate.id));
            return [
              ...current,
              ...nextResultToasts.filter((candidate) => !known.has(candidate.id)),
            ];
          });
        }
        setProjects(response.projects);
        projectsRef.current = response.projects;
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
        if (selectedProjectId) {
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
          } catch (cause) {
            if (!refreshedRow && isNotFoundResponse(cause) && active) {
              terminalProjectIdsRef.current.add(selectedProjectId);
              dialogRequestRef.current += 1;
              setBusy(false);
              setProject((current) =>
                current?.id === selectedProjectId ? null : current,
              );
              setSession((current) =>
                current && project?.id === selectedProjectId ? null : current,
              );
              setSettingsTarget((current) =>
                current?.id === selectedProjectId ? null : current,
              );
              setDialog(null);
              setDialogLoading(false);
              setError(null);
              setToast({
                tone: "neutral",
                message: "This Project was deleted.",
              });
              router.replace("/projects");
              return;
            }
            // An archived Project still resolves through the detail endpoint.
            // Network failures are transient, so retain the last durable view.
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
  }, [dialog, project?.id, router, session?.id]);

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

  const archiveConversation = async (
    projectId: string,
    target: ProjectSessionVM,
  ) => {
    const mutationKey = `archive:${target.id}`;
    if (sessionMutationRef.current.has(mutationKey)) return;
    sessionMutationRef.current.add(mutationKey);
    const stopActive = ["queued", "working", "stopping"].includes(
      target.status,
    );
    try {
      const archived = await updateProjectSession(projectId, target.id, {
        archived: true,
        stopActive,
      });
      applySessionChange(projectId, archived, target);
      if (session?.id === target.id) {
        setSession(null);
        router.push(`/projects/${projectId}`);
      }
      setToast(
        stopActive
          ? {
              tone: "neutral",
              message: "Conversation stopped and archived.",
            }
          : {
              tone: "neutral",
              message: "Conversation archived.",
              actionLabel: "Undo",
              onAction: () => {
                setToast(null);
                void updateProjectSession(projectId, target.id, {
                  archived: false,
                })
                  .then((restored) => {
                    applySessionChange(projectId, restored, archived);
                    setToast({
                      tone: "neutral",
                      message: "Conversation restored.",
                    });
                  })
                  .catch((cause) =>
                    setToast({
                      tone: "danger",
                      message:
                        cause instanceof Error
                          ? cause.message
                          : "Conversation could not be restored.",
                    }),
                  );
              },
            },
      );
    } catch (cause) {
      setToast({
        tone: "danger",
        message:
          cause instanceof Error
            ? cause.message
            : "Conversation could not be archived.",
      });
    } finally {
      sessionMutationRef.current.delete(mutationKey);
    }
  };

  const restoreConversation = async (
    projectId: string,
    target: ProjectSessionVM,
  ) => {
    const mutationKey = `restore:${target.id}`;
    if (sessionMutationRef.current.has(mutationKey)) return;
    sessionMutationRef.current.add(mutationKey);
    try {
      const restored = await updateProjectSession(projectId, target.id, {
        archived: false,
      });
      applySessionChange(projectId, restored, target);
      setToast({ tone: "neutral", message: "Conversation restored." });
    } catch (cause) {
      setToast({
        tone: "danger",
        message:
          cause instanceof Error
            ? cause.message
            : "Conversation could not be restored.",
      });
    } finally {
      sessionMutationRef.current.delete(mutationKey);
    }
  };

  const archiveProjectById = async (projectId: string) => {
    const target = projects.find((candidate) => candidate.id === projectId);
    if (!target || sessionMutationRef.current.has(`project:${projectId}`))
      return;
    sessionMutationRef.current.add(`project:${projectId}`);
    try {
      const archived = await updateProject(projectId, {
        revision: target.revision,
        archived: true,
      });
      setProjects((current) =>
        current.filter((candidate) => candidate.id !== projectId),
      );
      setArchivedProjectsRevision((current) => current + 1);
      if (project?.id === projectId) {
        setProject(null);
        setSession(null);
        router.push("/projects");
      }
      setToast({
        tone: "neutral",
        message: `${target.name} archived.`,
        actionLabel: "Undo",
        onAction: () => {
          setToast(null);
          void updateProject(projectId, {
            revision: archived.revision,
            archived: false,
          })
            .then((restored) => {
              setProjects((current) =>
                current.some((candidate) => candidate.id === restored.id)
                  ? current
                  : [mergeProjectRow(restored), ...current],
              );
              setArchivedProjectsRevision((current) => current + 1);
              setToast({ tone: "neutral", message: `${target.name} restored.` });
            })
            .catch((cause) =>
              setToast({
                tone: "danger",
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Project could not be restored.",
              }),
            );
        },
      });
    } catch (cause) {
      setToast({
        tone: "danger",
        message:
          cause instanceof Error
            ? cause.message
            : "Project could not be archived.",
      });
    } finally {
      sessionMutationRef.current.delete(`project:${projectId}`);
    }
  };

  const restoreProject = async (
    target: ProjectRowVM | ProjectDetailVM,
  ): Promise<boolean> => {
    const mutationKey = `project:${target.id}`;
    if (sessionMutationRef.current.has(mutationKey)) return false;
    sessionMutationRef.current.add(mutationKey);
    try {
      const restored = await updateProject(target.id, {
        revision: target.revision,
        archived: false,
      });
      replaceProject(restored);
      setArchivedProjectsRevision((current) => current + 1);
      setToast({
        tone: "neutral",
        message: `${target.name} restored.`,
      });
      return true;
    } catch (cause) {
      setToast({
        tone: "danger",
        message:
          cause instanceof Error
            ? cause.message
            : "Project could not be restored.",
      });
      return false;
    } finally {
      sessionMutationRef.current.delete(mutationKey);
    }
  };
  const visibleResultToast = resultToasts[0] ?? null;

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
        onToggleMobile={toggleMobileNavigation}
        onCloseMobile={closeMobileNavigation}
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
          dialogRequestRef.current += 1;
          setError(null);
          setDialog({ kind: "new-project", initialSkillSlug: null });
          router.replace("/projects?new=1");
        }}
        onNewSession={(projectId) => {
          if (runtimeState.available) void openNewSession(projectId);
        }}
        onProjectSettings={(projectId) => void openSettings(projectId)}
        onArchiveProject={(projectId) => void archiveProjectById(projectId)}
        onRenameSession={(projectId, target) => {
          setError(null);
          setDialog({ kind: "rename-session", projectId, session: target });
        }}
        onArchiveSession={(projectId, target) =>
          void archiveConversation(projectId, target)
        }
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
            runtime={runtimeState}
            onRetryRuntime={retryRuntime}
            onOpenNavigation={() => setMobileOpen(true)}
            onProjectSettings={() => void openSettings(project.id)}
            onNewSession={() => void openNewSession(project.id)}
            onRenameSession={() => {
              setError(null);
              setDialog({
                kind: "rename-session",
                projectId: project.id,
                session,
              });
            }}
            onArchiveSession={() =>
              void archiveConversation(project.id, session)
            }
            modelLabel={modelLabel(session.model, availableModels)}
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
              applySessionChange(project.id, next, session);
            }}
          />
        ) : project ? (
          <ProjectOverview
            project={project}
            runtime={runtimeState}
            models={availableModels}
            onOpenNavigation={() => setMobileOpen(true)}
            onNewSession={() => void openNewSession(project.id)}
            onSettings={() => void openSettings(project.id)}
            onArchiveProject={() => void archiveProjectById(project.id)}
            onRestoreProject={() => void restoreProject(project)}
            onFilesUploaded={(files) =>
              applyProjectFiles(project.id, files)
            }
            onRenameSession={(target) => {
              setError(null);
              setDialog({
                kind: "rename-session",
                projectId: project.id,
                session: target,
              });
            }}
            onArchiveSession={(target) =>
              void archiveConversation(project.id, target)
            }
            onRestoreSession={(target) =>
              void restoreConversation(project.id, target)
            }
            sessionChange={sessionChange}
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
            models={availableModels}
            archivedProjectsRevision={archivedProjectsRevision}
            onNewProject={() => {
              dialogRequestRef.current += 1;
              setError(null);
              setDialog({ kind: "new-project", initialSkillSlug: null });
              router.replace("/projects?new=1");
            }}
            onRestoreProject={restoreProject}
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
            title="New conversation"
            description="Load the Project before starting a conversation."
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
              const requestId = dialogRequestRef.current;
              const targetProject = selectedDialogProject;
              setBusy(true);
              setError(null);
              void createProjectSession(targetProject.id, input)
                .then((created) => {
                  if (
                    requestId !== dialogRequestRef.current ||
                    terminalProjectIdsRef.current.has(targetProject.id)
                  )
                    return;
                  const nextProject = {
                    ...targetProject,
                    sessionCount: targetProject.sessionCount + 1,
                    activeSessionCount:
                      targetProject.activeSessionCount + 1,
                    sessions: [created, ...targetProject.sessions],
                    recentSessions: [
                      created,
                      ...targetProject.recentSessions,
                    ].slice(0, 5),
                    updatedAt: created.createdAt,
                  };
                  replaceProject(nextProject);
                  setProject(nextProject);
                  setSession(created);
                  setDialog(null);
                  router.push(
                    `/projects/${targetProject.id}/sessions/${created.id}`,
                  );
                  router.refresh();
                })
                .catch((cause) => {
                  if (
                    requestId !== dialogRequestRef.current ||
                    terminalProjectIdsRef.current.has(targetProject.id)
                  )
                    return;
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not start this conversation.",
                  );
                })
                .finally(() => {
                  if (requestId === dialogRequestRef.current) setBusy(false);
                });
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
            const requestId = dialogRequestRef.current;
            const targetProject = settingsTarget;
            setBusy(true);
            setError(null);
            const nameChanged = input.name !== targetProject.name;
            const modelChanged =
              input.defaultModel !== targetProject.defaultModel;
            const updateDetails = nameChanged || modelChanged;
            const currentSlugs = targetProject.skills
              .map((skill) => skill.slug)
              .sort()
              .join("\0");
            const nextSlugs = [...input.skillSlugs].sort().join("\0");
            const saveDetails = updateDetails
              ? updateProject(targetProject.id, {
                  revision: targetProject.revision,
                  ...(nameChanged ? { name: input.name } : {}),
                  ...(modelChanged ? { defaultModel: input.defaultModel } : {}),
                })
              : Promise.resolve(targetProject);
            void saveDetails
              .then((updated) => {
                if (
                  requestId !== dialogRequestRef.current ||
                  terminalProjectIdsRef.current.has(targetProject.id)
                )
                  return null;
                return currentSlugs === nextSlugs
                  ? updated
                  : replaceProjectSkills(
                      updated.id,
                      updated.revision,
                      input.skillSlugs,
                    );
              })
              .then((updated) => {
                if (
                  !updated ||
                  requestId !== dialogRequestRef.current ||
                  terminalProjectIdsRef.current.has(targetProject.id)
                )
                  return;
                replaceProject(updated);
                setDialog(null);
                setSettingsTarget(null);
                router.refresh();
              })
              .catch(async (cause) => {
                if (
                  requestId !== dialogRequestRef.current ||
                  terminalProjectIdsRef.current.has(targetProject.id)
                )
                  return;
                const message =
                  cause instanceof Error
                    ? cause.message
                    : "Could not save project settings.";
                try {
                  const latest = await fetchProject(targetProject.id);
                  if (
                    requestId !== dialogRequestRef.current ||
                    terminalProjectIdsRef.current.has(targetProject.id)
                  )
                    return;
                  replaceProject(latest);
                  setSettingsTarget(latest);
                  setError(
                    `${message} Current settings were refreshed; review them and retry.`,
                  );
                } catch {
                  if (
                    requestId !== dialogRequestRef.current ||
                    terminalProjectIdsRef.current.has(targetProject.id)
                  )
                    return;
                  setError(
                    `${message} Close and reopen settings before retrying.`,
                  );
                }
              })
              .finally(() => {
                if (requestId === dialogRequestRef.current) setBusy(false);
              });
          }}
        />
      )}

      {dialog?.kind === "rename-session" && (
        <RenameSessionDialog
          session={dialog.session}
          busy={busy}
          error={error}
          onClose={closeDialog}
          onRename={(title) => {
            setBusy(true);
            setError(null);
            void updateProjectSession(dialog.projectId, dialog.session.id, {
              title,
            })
              .then((renamed) => {
                applySessionChange(
                  dialog.projectId,
                  renamed,
                  dialog.session,
                );
                setDialog(null);
                setToast({
                  tone: "neutral",
                  message: "Conversation renamed.",
                });
                router.refresh();
              })
              .catch((cause) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Conversation could not be renamed.",
                ),
              )
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
      {visibleResultToast ? (
        <div
          className={`project-toast project-toast--${visibleResultToast.tone}`}
          role="status"
        >
          <Icon
            name={
              visibleResultToast.tone === "neutral"
                ? "check-circle-2"
                : "alert-triangle"
            }
            size={14}
          />
          <span>{visibleResultToast.message}</span>
          <button
            type="button"
            className="project-toast__action"
            onClick={() => {
              setResultToasts((current) =>
                current.filter(
                  (candidate) => candidate.id !== visibleResultToast.id,
                ),
              );
              router.push(visibleResultToast.href);
            }}
          >
            Open
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() =>
              setResultToasts((current) =>
                current.filter(
                  (candidate) => candidate.id !== visibleResultToast.id,
                ),
              )
            }
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : toast ? (
        <div
          className={`project-toast project-toast--${toast.tone}`}
          role={toast.tone === "danger" ? "alert" : "status"}
        >
          <Icon
            name={
              toast.tone === "neutral"
                ? "check-circle-2"
                : "alert-triangle"
            }
            size={14}
          />
          <span>{toast.message}</span>
          {toast.onAction && toast.actionLabel && (
            <button
              type="button"
              className="project-toast__action"
              onClick={toast.onAction}
            >
              {toast.actionLabel}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setToast(null)}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
