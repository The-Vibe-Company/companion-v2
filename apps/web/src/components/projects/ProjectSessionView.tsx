"use client";

import {
  PROJECT_ATTACHMENT_MAX_BYTES,
  PROJECT_ATTACHMENT_MAX_FILES,
  type RunChatEvent,
} from "@companion/contracts";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { formatBytes, relativeTime } from "@/lib/format";
import {
  fetchProjectFileVersions,
  fetchProjectFiles,
  fetchProjectSession,
  projectFileHref,
  projectFileVersionHref,
  sendProjectPrompt,
  stopProjectSession,
} from "@/lib/projects";
import type {
  ProjectDetailVM,
  ProjectFileVM,
  ProjectFileVersionVM,
  ProjectSessionStatus,
  ProjectSessionVM,
} from "@/lib/projectsModel";
import { Icon } from "../Icon";
import { ChatTranscript } from "../runs/ChatTranscript";
import {
  chatReducer,
  initChatState,
  openProjectStream,
} from "../runs/chatStream";
import { ProjectRecoveryActions } from "./ProjectRecoveryActions";

const ACTIVE_SESSION_STATUSES = new Set<ProjectSessionStatus>([
  "queued",
  "working",
  "stopping",
]);
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const PREVIEWABLE_FILE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
]);

function statusLabel(status: ProjectSessionStatus): string {
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

function statusTone(
  status: ProjectSessionStatus,
): "working" | "waiting" | "done" | "error" {
  if (status === "working") return "working";
  if (status === "queued" || status === "stopping") return "waiting";
  if (status === "error") return "error";
  return "done";
}

export function SessionComposer({
  disabled,
  disabledReason,
  working,
  onSend,
}: {
  disabled: boolean;
  disabledReason?: string;
  working: boolean;
  onSend: (input: {
    prompt: string;
    files: File[];
    idempotencyKey: string;
  }) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  const send = async () => {
    if (sending || disabled || !text.trim()) return;
    idempotencyKeyRef.current ??= crypto.randomUUID();
    setSending(true);
    setError(null);
    try {
      await onSend({
        prompt: text.trim(),
        files,
        idempotencyKey: idempotencyKeyRef.current,
      });
      setText("");
      setFiles([]);
      idempotencyKeyRef.current = null;
      textareaRef.current?.focus();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not send this message.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="cowork-session-composer">
      {files.length > 0 && (
        <div className="cowork-draft-files">
          {files.map((file, index) => (
            <span
              className="cowork-file-chip"
              key={`${file.name}:${file.lastModified}:${index}`}
            >
              <Icon name="file" size={12} />
              <span>{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                disabled={disabled || sending}
                onClick={() => {
                  idempotencyKeyRef.current = null;
                  setFiles((current) =>
                    current.filter((_, candidate) => candidate !== index),
                  );
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="cowork-session-composer__box">
        <label className="sr-only" htmlFor="project-follow-up">
          Message the agent
        </label>
        <textarea
          ref={textareaRef}
          id="project-follow-up"
          rows={1}
          value={text}
          disabled={disabled || sending}
          placeholder={
            disabled
              ? disabledReason ?? "This session is no longer accepting messages."
              : "Message the agent…"
          }
          onChange={(event) => {
            idempotencyKeyRef.current = null;
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              !text.trim()
            )
              return;
            event.preventDefault();
            void send();
          }}
        />
        <div className="cowork-session-composer__actions">
          <label className="cds-iconbtn cds-iconbtn--sm" title="Attach files">
            <Icon name="paperclip" size={14} />
            <span className="sr-only">Attach files</span>
            <input
              type="file"
              multiple
              disabled={disabled || sending}
              onChange={(event) => {
                const incoming = event.target.files
                  ? Array.from(event.target.files)
                  : [];
                event.target.value = "";
                if (
                  incoming.some(
                    (file) => file.size > PROJECT_ATTACHMENT_MAX_BYTES,
                  )
                ) {
                  setError("Each attachment must be 10 MB or smaller.");
                  return;
                }
                if (
                  files.length + incoming.length >
                  PROJECT_ATTACHMENT_MAX_FILES
                ) {
                  setError(
                    `Attach up to ${PROJECT_ATTACHMENT_MAX_FILES} files.`,
                  );
                  return;
                }
                setError(null);
                idempotencyKeyRef.current = null;
                setFiles((current) => [...current, ...incoming]);
              }}
            />
          </label>
          {working && (
            <span className="cowork-session-composer__working">
              <Icon name="loader" size={12} className="ls-spin" />
              Working
            </span>
          )}
          <span />
          <button
            type="button"
            className="cowork-session-composer__send"
            aria-label="Send"
            disabled={disabled || sending || !text.trim()}
            onClick={() => void send()}
          >
            {sending ? (
              <Icon name="loader" size={14} className="ls-spin" />
            ) : (
              <Icon name="arrow-up" size={14} />
            )}
          </button>
        </div>
      </div>
      <div className="cowork-session-composer__hint">
        <kbd>Enter</kbd> send · <kbd>Shift Enter</kbd> new line
      </div>
      {error && (
        <p className="project-inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ProjectFileCard({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFileVM;
}) {
  const historyId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [versions, setVersions] = useState<ProjectFileVersionVM[] | null>(null);
  const previewable = file.contentType
    ? PREVIEWABLE_FILE_TYPES.has(file.contentType)
    : false;

  useEffect(() => {
    setHistoryOpen(false);
    setHistoryLoading(false);
    setHistoryError(null);
    setVersions(null);
  }, [file.id, file.version]);

  const loadHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const rows = await fetchProjectFileVersions(projectId, file.id);
      setVersions(
        rows
          .filter((row) => row.version < file.version)
          .sort((a, b) => b.version - a.version),
      );
    } catch (cause) {
      setHistoryError(
        cause instanceof Error ? cause.message : "Could not load file history.",
      );
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <article className="project-file-card">
      <span className="project-file-card__icon">
        <Icon name="file" size={15} />
      </span>
      <div>
        <strong title={file.path}>{file.name}</strong>
        <small>
          v{file.version} · {formatBytes(file.byteSize)} ·{" "}
          {relativeTime(file.updatedAt)}
        </small>
        {file.conflictDetected && (
          <span className="project-file-card__conflict">
            <Icon name="alert-triangle" size={11} />
            Concurrent edit · latest kept
          </span>
        )}
      </div>
      <div className="project-file-card__actions">
        {file.version > 1 && (
          <button
            type="button"
            className="cds-btn cds-btn--ghost cds-btn--sm"
            aria-expanded={historyOpen}
            aria-controls={historyId}
            onClick={() => {
              const nextOpen = !historyOpen;
              setHistoryOpen(nextOpen);
              if (nextOpen && versions === null && !historyLoading) {
                void loadHistory();
              }
            }}
          >
            History
          </button>
        )}
        {previewable && (
          <a
            className="cds-btn cds-btn--ghost cds-btn--sm"
            href={projectFileHref(projectId, file.id)}
            target="_blank"
            rel="noreferrer"
          >
            Preview
          </a>
        )}
        <a
          className={
            previewable
              ? "cds-iconbtn cds-iconbtn--sm"
              : "cds-btn cds-btn--ghost cds-btn--sm"
          }
          href={projectFileHref(projectId, file.id, true)}
          aria-label={`Download ${file.name}`}
        >
          <Icon name="download" size={13} />
          {!previewable && "Download"}
        </a>
      </div>
      {historyOpen && (
        <div className="project-file-history" id={historyId}>
          {historyLoading ? (
            <span className="project-file-history__state" role="status">
              <Icon name="loader" size={12} className="ls-spin" />
              Loading history…
            </span>
          ) : historyError ? (
            <div className="project-file-history__state is-error" role="alert">
              <span>{historyError}</span>
              <button type="button" onClick={() => void loadHistory()}>
                Retry
              </button>
            </div>
          ) : versions?.length ? (
            <ol>
              {versions.map((version) => (
                <li key={version.version}>
                  <div>
                    <strong>Version {version.version}</strong>
                    <small>
                      {formatBytes(version.byteSize)} ·{" "}
                      {relativeTime(version.createdAt)}
                      {version.modifiedBySessionId && (
                        <>
                          {" · "}
                          <span title={version.modifiedBySessionId}>
                            session {version.modifiedBySessionId.slice(0, 8)}
                          </span>
                        </>
                      )}
                    </small>
                    {(version.baseVersion !== null ||
                      version.conflictDetected) && (
                      <span
                        className={
                          version.conflictDetected
                            ? "project-file-card__conflict"
                            : "project-file-history__base"
                        }
                      >
                        {version.conflictDetected && (
                          <Icon name="alert-triangle" size={11} />
                        )}
                        {version.conflictDetected
                          ? "Conflict detected"
                          : "Saved"}
                        {version.baseVersion !== null
                          ? ` · based on version ${version.baseVersion}`
                          : ""}
                      </span>
                    )}
                  </div>
                  <a
                    className="cds-iconbtn cds-iconbtn--sm"
                    href={projectFileVersionHref(
                      projectId,
                      file.id,
                      version.version,
                      true,
                    )}
                    aria-label={`Download ${file.name} version ${version.version}`}
                  >
                    <Icon name="download" size={13} />
                  </a>
                </li>
              ))}
            </ol>
          ) : (
            <span className="project-file-history__state">
              No prior versions were returned.
            </span>
          )}
        </div>
      )}
    </article>
  );
}

function ProjectFilesDrawer({
  open,
  projectId,
  files,
  returnFocusRef,
  onClose,
}: {
  open: boolean;
  projectId: string;
  files: ProjectFileVM[];
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const returnFocus = returnFocusRef.current;
    const background = [...document.body.children]
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          !element.classList.contains("project-files-layer"),
      )
      .map((element) => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute("aria-hidden"),
      }));
    for (const item of background) {
      item.element.inert = true;
      item.element.setAttribute("aria-hidden", "true");
    }
    const panel = panelRef.current;
    queueMicrotask(() =>
      (panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus(),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => !item.hasAttribute("disabled"),
      );
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
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
      for (const item of background) {
        item.element.inert = item.inert;
        if (item.ariaHidden === null)
          item.element.removeAttribute("aria-hidden");
        else item.element.setAttribute("aria-hidden", item.ariaHidden);
      }
      returnFocus?.focus();
    };
  }, [open, returnFocusRef]);

  if (!open) return null;
  return createPortal(
    <div className="run-files-layer project-files-layer">
      <button
        type="button"
        className="run-files-layer__scrim"
        aria-label="Close files"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        className="run-files-drawer project-files-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-files-title"
        tabIndex={-1}
      >
        <header className="run-files-drawer__head">
          <div>
            <span>Project files</span>
            <h2 id="project-files-title">Files · {files.length}</h2>
          </div>
          <button
            type="button"
            className="cds-iconbtn cds-iconbtn--md"
            onClick={onClose}
            aria-label="Close files"
          >
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="run-files-drawer__body">
          <p className="project-files-drawer__note">
            Sessions share this folder. The latest saved version appears here.
          </p>
          {files.length === 0 ? (
            <div className="project-files-drawer__empty">
              <Icon name="folder-open" size={18} />
              <strong>No files yet</strong>
              <span>Uploaded and generated files appear here.</span>
            </div>
          ) : (
            <div className="project-files-drawer__list">
              {files.map((file) => (
                <ProjectFileCard
                  key={file.id}
                  projectId={projectId}
                  file={file}
                />
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function historySignature(session: ProjectSessionVM): string {
  return JSON.stringify(session.history);
}

export function ProjectSessionView({
  project,
  initialSession,
  onOpenNavigation,
  onProjectSettings,
  onRetryWorkspace,
  retryBusy,
  retryError,
  onSessionChange,
}: {
  project: ProjectDetailVM;
  initialSession: ProjectSessionVM;
  onOpenNavigation: () => void;
  onProjectSettings: () => void;
  onRetryWorkspace: () => void;
  retryBusy: boolean;
  retryError: string | null;
  onSessionChange: (session: ProjectSessionVM) => void;
}) {
  const [session, setSession] = useState(initialSession);
  const [chat, dispatch] = useReducer(chatReducer, undefined, initChatState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [streamDead, setStreamDead] = useState(false);
  const [streamNonce, setStreamNonce] = useState(0);
  const [stopBusy, setStopBusy] = useState(false);
  const [files, setFiles] = useState(project.files);
  const [filesOpen, setFilesOpen] = useState(false);
  const [rowOverride, setRowOverride] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const filesButtonRef = useRef<HTMLButtonElement>(null);
  const refreshBusyRef = useRef(false);
  const lastEventIdRef = useRef<string | null>(null);
  const appliedHistoryRef = useRef<string | null>(null);
  const initialSessionRef = useRef(initialSession);
  const onSessionChangeRef = useRef(onSessionChange);
  initialSessionRef.current = initialSession;
  onSessionChangeRef.current = onSessionChange;

  const resolveToolLabel = useCallback(
    (tool: string, skill: string | null) => ({
      label: skill ?? tool,
      action: tool,
    }),
    [],
  );

  const reconcileHistory = useCallback(
    (next: ProjectSessionVM, force = false) => {
      const signature = historySignature(next);
      if (!force && signature === appliedHistoryRef.current) return;
      appliedHistoryRef.current = signature;
      dispatch({
        kind: "history",
        items: next.history,
        resolveToolLabel,
      });
      for (const prompt of next.pendingPrompts) {
        dispatch({ kind: "user", text: prompt.text, messageId: prompt.id });
      }
    },
    [resolveToolLabel],
  );

  const apply = useCallback(
    (next: ProjectSessionVM) => {
      setSession(next);
      onSessionChangeRef.current(next);
      setLoadError(null);
      if (!ACTIVE_SESSION_STATUSES.has(next.status)) reconcileHistory(next);
    },
    [reconcileHistory],
  );

  const refresh = useCallback(async () => {
    if (refreshBusyRef.current) return null;
    refreshBusyRef.current = true;
    try {
      const next = await fetchProjectSession(project.id, session.id);
      apply(next);
      return next;
    } catch (cause) {
      setLoadError(
        cause instanceof Error
          ? cause.message
          : "Could not refresh this session.",
      );
      return null;
    } finally {
      refreshBusyRef.current = false;
    }
  }, [apply, project.id, session.id]);

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await fetchProjectFiles(project.id));
    } catch {
      // The durable list already on screen remains useful while a refresh is unavailable.
    }
  }, [project.id]);

  useEffect(() => {
    const nextSession = initialSessionRef.current;
    setSession(nextSession);
    setFiles(project.files);
    dispatch({ kind: "reset" });
    appliedHistoryRef.current = null;
    reconcileHistory(nextSession, true);
    lastEventIdRef.current =
      nextSession.latestEventSequence > 0
        ? String(nextSession.latestEventSequence)
        : null;
    setLoadError(null);
    setStreamDead(false);
    setStreamConnected(false);
    setFilesOpen(false);
    setRowOverride(new Map());
  }, [initialSession.id, project.id, project.files, reconcileHistory]);

  useEffect(() => {
    const controller = new AbortController();
    setStreamConnected(false);
    setStreamDead(false);
    void openProjectStream(
      project.id,
      session.id,
      (event: RunChatEvent) => {
        dispatch({ kind: "event", event, resolveToolLabel });
        if (
          event.type === "session.idle" ||
          (event.type === "prompt.status" &&
            ["completed", "canceled", "error"].includes(event.status))
        ) {
          void refresh();
        }
        if (event.type === "artifacts.updated") void refreshFiles();
      },
      controller.signal,
      {
        lastEventId: lastEventIdRef.current,
        onEventId: (id) => {
          if (id === lastEventIdRef.current) return;
          lastEventIdRef.current = id;
        },
        onConnected: () => {
          setStreamConnected(true);
          setStreamDead(false);
          dispatch({ kind: "connected" });
        },
        onStreamEnd: async () => {
          const next = await refresh();
          return next ? !ACTIVE_SESSION_STATUSES.has(next.status) : false;
        },
      },
    ).then(() => {
      if (controller.signal.aborted) return;
      setStreamConnected(false);
      if (ACTIVE_SESSION_STATUSES.has(session.status)) setStreamDead(true);
    });
    return () => controller.abort();
  }, [
    project.id,
    refresh,
    refreshFiles,
    resolveToolLabel,
    session.id,
    session.status,
    streamNonce,
  ]);

  useEffect(() => {
    if (!ACTIVE_SESSION_STATUSES.has(session.status)) return;
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [refresh, session.status]);

  const workspaceBlocked = [
    project.status,
    project.workspace.status,
  ].some((status) => status === "needs_attention" || status === "error");
  const working =
    !workspaceBlocked &&
    (session.status === "queued" || session.status === "working");
  const composerDisabled =
    workspaceBlocked ||
    session.status === "stopping" ||
    session.status === "completed";
  const workspaceErrorDetail =
    project.statusDetail ||
    project.workspace.statusDetail ||
    "The persistent workspace could not be restored.";

  return (
    <div className="cowork-session">
      <header className="cowork-session__top">
        <button
          type="button"
          className="projects-mobile-nav"
          onClick={onOpenNavigation}
          aria-label="Open navigation"
        >
          <Icon name="panel-left-open" size={15} />
        </button>
        <div className="cowork-session__crumb">
          <Link href={`/projects/${project.id}`}>
            <Icon name="arrow-left" size={13} />
            {project.name}
          </Link>
          <span>/</span>
          <strong>{session.title}</strong>
        </div>
        <span className="cowork-session__spacer" />
        <span className="cds-status">
          <span
            className={`project-status-dot is-${
              workspaceBlocked ? "error" : statusTone(session.status)
            }`}
            aria-hidden="true"
          />
          {workspaceBlocked ? "Needs attention" : statusLabel(session.status)}
        </span>
        <code className="cowork-session__model">{session.model}</code>
        <button
          ref={filesButtonRef}
          type="button"
          className="cds-btn cds-btn--ghost cds-btn--sm cowork-session__files"
          aria-expanded={filesOpen}
          onClick={() => {
            setFilesOpen(true);
            void refreshFiles();
          }}
        >
          <Icon name="folder-open" size={13} />
          Files <span className="tnum">{files.length}</span>
        </button>
        {working && (
          <button
            type="button"
            className="cds-btn cds-btn--ghost cds-btn--sm"
            disabled={stopBusy}
            onClick={() => {
              setStopBusy(true);
              void stopProjectSession(project.id, session.id)
                .then(apply)
                .catch((cause) =>
                  setLoadError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not stop the session.",
                  ),
                )
                .finally(() => setStopBusy(false));
            }}
          >
            <span className="cowork-stop-icon" aria-hidden="true" />
            {stopBusy ? "Stopping…" : "Stop"}
          </button>
        )}
      </header>

      <div className="cowork-session__body">
        <div className="cowork-transcript cowork-transcript--live">
          <ChatTranscript
            run={null}
            chat={chat}
            showPromptBubble={false}
            showWorking={
              !workspaceBlocked && (working || chat.working.active)
            }
            streamDead={streamDead}
            rowExpanded={(id, defaultOpen) =>
              rowOverride.get(id) ?? defaultOpen
            }
            onToggleRow={(id, defaultOpen) =>
              setRowOverride((current) => {
                const next = new Map(current);
                next.set(id, !(current.get(id) ?? defaultOpen));
                return next;
              })
            }
            onReconnect={() => setStreamNonce((current) => current + 1)}
            onOpenFiles={() => setFilesOpen(true)}
          />
          {loadError && (
            <div className="cowork-session__load-error" role="alert">
              <Icon name="alert-triangle" size={14} />
              <span>{loadError}</span>
              <button type="button" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          )}
          {streamDead &&
            !workspaceBlocked &&
            ACTIVE_SESSION_STATUSES.has(session.status) && (
            <div className="cowork-session__load-error" role="alert">
              <Icon name="alert-triangle" size={14} />
              <span>Live updates disconnected.</span>
              <button
                type="button"
                onClick={() => setStreamNonce((current) => current + 1)}
              >
                Reconnect
              </button>
            </div>
          )}
          {session.errorMessage && (
            <div className="cowork-session__load-error" role="alert">
              <Icon name="alert-triangle" size={14} />
              <span>{session.errorMessage}</span>
            </div>
          )}
        </div>
        {workspaceBlocked && (
          <div className="cowork-session__workspace-alert" role="alert">
            <Icon name="alert-triangle" size={15} />
            <span className="cowork-session__workspace-alert-copy">
              <strong>This project needs attention.</strong>
              <span>{workspaceErrorDetail}</span>
              <small>
                Messages are paused until the workspace is available again.
              </small>
            </span>
            <ProjectRecoveryActions
              busy={retryBusy}
              error={retryError}
              onRetry={onRetryWorkspace}
              onSettings={onProjectSettings}
            />
          </div>
        )}
        <SessionComposer
          disabled={composerDisabled}
          disabledReason={
            workspaceBlocked
              ? "Messages are paused while this project needs attention."
              : undefined
          }
          working={working}
          onSend={async ({ prompt, files: nextFiles, idempotencyKey }) => {
            const next = await sendProjectPrompt(project.id, session.id, {
              prompt,
              model: session.model,
              files: nextFiles,
              idempotencyKey,
            });
            dispatch({ kind: "user", text: prompt });
            dispatch({ kind: "send" });
            apply(next);
          }}
        />
      </div>

      <ProjectFilesDrawer
        open={filesOpen}
        projectId={project.id}
        files={files}
        returnFocusRef={filesButtonRef}
        onClose={() => setFilesOpen(false)}
      />

      <span className="sr-only" aria-live="polite">
        Last activity {relativeTime(session.lastActiveAt)}
        {streamConnected ? " · Live updates connected" : ""}
      </span>
    </div>
  );
}
