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
  useMemo,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
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
  ProjectPromptAttachmentVM,
  ProjectRuntimeAvailability,
  ProjectSessionStatus,
  ProjectSessionVM,
} from "@/lib/projectsModel";
import { Icon } from "../Icon";
import {
  ChatTranscript,
  type GeneratedProjectFile,
} from "../runs/ChatTranscript";
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
  "application/pdf",
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

type ProjectFilePreviewKind = "image" | "video" | "document";
type ProjectAttachmentPreview = {
  attachment: ProjectPromptAttachmentVM;
  href: string;
  downloadHref: string;
};

export type ProjectFilePreviewTarget = {
  id: string;
  path: string;
  name: string;
  version: number;
  contentType: string | null;
  byteSize: number;
  exactVersion: boolean;
};

function currentFilePreviewTarget(
  file: ProjectFileVM,
): ProjectFilePreviewTarget {
  return {
    id: file.id,
    path: file.path,
    name: file.name,
    version: file.version,
    contentType: file.contentType,
    byteSize: file.byteSize,
    exactVersion: false,
  };
}

function filePreviewKind(
  contentType: string | null,
): ProjectFilePreviewKind | null {
  if (!contentType || !PREVIEWABLE_FILE_TYPES.has(contentType)) return null;
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return "document";
}

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
      return "Task stopped";
  }
}

function statusTone(
  status: ProjectSessionStatus,
): "working" | "waiting" | "done" | "error" {
  if (status === "working") return "working";
  if (status === "queued" || status === "stopping") return "waiting";
  if (status === "error") return "waiting";
  return "done";
}

export function SessionComposer({
  draftKey = "companion:project-draft:standalone",
  disabled,
  disabledReason,
  focusRequest = 0,
  projectFileCount = 0,
  working,
  onOpenProjectFiles = () => undefined,
  onSend,
}: {
  draftKey?: string;
  disabled: boolean;
  disabledReason?: string;
  focusRequest?: number;
  projectFileCount?: number;
  working: boolean;
  onOpenProjectFiles?: () => void;
  onSend: (input: {
    prompt: string;
    files: File[];
    idempotencyKey: string;
  }) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const loadedDraftKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let saved = "";
    try {
      saved = window.sessionStorage.getItem(draftKey) ?? "";
    } catch {
      // Storage can be unavailable in locked-down browser contexts. The in-memory
      // draft still works for the current page lifetime.
    }
    loadedDraftKeyRef.current = draftKey;
    setText(saved);
    setFiles([]);
    setError(null);
    idempotencyKeyRef.current = null;
  }, [draftKey]);

  useEffect(() => {
    if (loadedDraftKeyRef.current !== draftKey) return;
    try {
      if (text) window.sessionStorage.setItem(draftKey, text);
      else window.sessionStorage.removeItem(draftKey);
    } catch {
      // See the read fallback above.
    }
  }, [draftKey, text]);

  useEffect(() => {
    if (focusRequest < 1 || disabled) return;
    textareaRef.current?.focus();
  }, [disabled, focusRequest]);

  const appendFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;
      if (
        incoming.some(
          (file) =>
            file.size < 1 || file.size > PROJECT_ATTACHMENT_MAX_BYTES,
        )
      ) {
        setError("Each file must be between 1 byte and 10 MB.");
        return;
      }
      if (files.length + incoming.length > PROJECT_ATTACHMENT_MAX_FILES) {
        setError(`Attach up to ${PROJECT_ATTACHMENT_MAX_FILES} files.`);
        return;
      }
      setError(null);
      idempotencyKeyRef.current = null;
      setFiles((current) => [...current, ...incoming]);
    },
    [files.length],
  );

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
      try {
        window.sessionStorage.removeItem(draftKey);
      } catch {
        // The draft is already cleared from component state.
      }
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
    <div
      className={`cowork-session-composer${dragging ? " is-dragover" : ""}`}
      onDragEnter={(event: DragEvent<HTMLDivElement>) => {
        if (disabled || sending || !event.dataTransfer.types.includes("Files"))
          return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        if (disabled || sending || !event.dataTransfer.types.includes("Files"))
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event: DragEvent<HTMLDivElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        setDragging(false);
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        setDragging(false);
        if (disabled || sending) return;
        event.preventDefault();
        appendFiles(Array.from(event.dataTransfer.files));
      }}
    >
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
              ? disabledReason ??
                "This conversation is no longer accepting messages."
              : "Message the agent…"
          }
          onChange={(event) => {
            idempotencyKeyRef.current = null;
            setText(event.target.value);
          }}
          onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
            if (disabled || sending) return;
            const pastedFiles = Array.from(event.clipboardData.files);
            if (pastedFiles.length === 0) return;
            event.preventDefault();
            appendFiles(pastedFiles);
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
                appendFiles(incoming);
              }}
            />
          </label>
          <button
            type="button"
            className="cowork-session-composer__project-files"
            disabled={sending}
            onClick={onOpenProjectFiles}
          >
            <Icon name="folder-open" size={13} />
            From project
            {projectFileCount > 0 && (
              <span className="tnum">{projectFileCount}</span>
            )}
          </button>
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

function projectPromptAttachmentHref(
  projectId: string,
  sessionId: string,
  attachmentId: string,
  download = false,
): string {
  const path =
    `/v1/projects/${encodeURIComponent(projectId)}` +
    `/sessions/${encodeURIComponent(sessionId)}` +
    `/attachments/${encodeURIComponent(attachmentId)}`;
  return download ? `${path}?download=1` : path;
}

function ProjectPromptAttachmentList({
  projectId,
  sessionId,
  attachments,
  onPreview,
}: {
  projectId: string;
  sessionId: string;
  attachments: ProjectPromptAttachmentVM[];
  onPreview: (preview: ProjectAttachmentPreview) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="cowork-prompt-attachments" aria-label="Attached files">
      {attachments.map((attachment) => {
        const previewable =
          attachment.status !== "failed" &&
          filePreviewKind(attachment.contentType) !== null;
        return (
          <article key={attachment.id}>
            <span className="cowork-prompt-attachments__icon">
              <Icon name="file" size={14} />
            </span>
            <span>
              <strong title={attachment.workspacePath}>
                {attachment.fileName}
              </strong>
              <small>
                {attachment.status === "failed"
                  ? "Upload failed"
                  : formatBytes(attachment.byteSize)}
              </small>
            </span>
            {attachment.status !== "failed" && (
              <span className="cowork-prompt-attachments__actions">
                {previewable && (
                  <button
                    type="button"
                    className="cds-iconbtn cds-iconbtn--sm"
                    aria-label={`Preview ${attachment.fileName}`}
                    onClick={() =>
                      onPreview({
                        attachment,
                        href: projectPromptAttachmentHref(
                          projectId,
                          sessionId,
                          attachment.id,
                        ),
                        downloadHref: projectPromptAttachmentHref(
                          projectId,
                          sessionId,
                          attachment.id,
                          true,
                        ),
                      })
                    }
                  >
                    <Icon name="eye" size={13} />
                  </button>
                )}
                <a
                  className="cds-iconbtn cds-iconbtn--sm"
                  href={projectPromptAttachmentHref(
                    projectId,
                    sessionId,
                    attachment.id,
                    true,
                  )}
                  aria-label={`Download ${attachment.fileName}`}
                >
                  <Icon name="download" size={13} />
                </a>
              </span>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function ProjectFileCard({
  projectId,
  file,
  selected = false,
  onPreview,
}: {
  projectId: string;
  file: ProjectFileVM;
  selected?: boolean;
  onPreview?: (file: ProjectFileVM) => void;
}) {
  const historyId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [versions, setVersions] = useState<ProjectFileVersionVM[] | null>(null);
  const previewKind = filePreviewKind(file.contentType);
  const previewable = previewKind !== null;
  const canPreview = previewable && onPreview !== undefined;

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
    <article
      className={`project-file-card${selected ? " is-selected" : ""}`}
    >
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
        {canPreview && (
          <button
            type="button"
            className="cds-btn cds-btn--ghost cds-btn--sm"
            aria-pressed={selected}
            onClick={() => onPreview(file)}
          >
            {selected ? "Open" : "Preview"}
          </button>
        )}
        <a
          className={
            canPreview
              ? "cds-iconbtn cds-iconbtn--sm"
              : "cds-btn cds-btn--ghost cds-btn--sm"
          }
          href={projectFileHref(projectId, file.id, true)}
          aria-label={`Download ${file.name}`}
        >
          <Icon name="download" size={13} />
          {!canPreview && "Download"}
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

function ProjectFilePreview({
  projectId,
  target,
}: {
  projectId: string;
  target: ProjectFilePreviewTarget;
}) {
  const kind = filePreviewKind(target.contentType);
  const src = target.exactVersion
    ? projectFileVersionHref(projectId, target.id, target.version)
    : projectFileHref(projectId, target.id);
  const downloadHref = target.exactVersion
    ? projectFileVersionHref(projectId, target.id, target.version, true)
    : projectFileHref(projectId, target.id, true);
  return (
    <section
      className="cowork-file-preview"
      aria-label={`Preview ${target.name}`}
    >
      <header>
        <span>
          <strong title={target.path}>{target.name}</strong>
          <small>
            v{target.version}
            {target.exactVersion && " · saved version"}
            {` · ${formatBytes(target.byteSize)}`}
          </small>
        </span>
        <a
          className="cds-iconbtn cds-iconbtn--sm"
          href={downloadHref}
          aria-label={`Download ${target.name} version ${target.version}`}
        >
          <Icon name="download" size={13} />
        </a>
      </header>
      <div className="cowork-file-preview__canvas">
        {kind === null ? (
          <div className="project-files-drawer__empty">
            <Icon name="file" size={18} />
            <strong>Preview not available</strong>
            <span>Download this saved version to open it.</span>
          </div>
        ) : kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated project file URL
          <img src={src} alt={`Preview of ${target.name}`} />
        ) : kind === "video" ? (
          <video
            src={src}
            controls
            preload="metadata"
            aria-label={`Preview of ${target.name}`}
          />
        ) : (
          <iframe
            src={src}
            title={`Preview ${target.name}`}
            sandbox=""
            loading="lazy"
          />
        )}
      </div>
    </section>
  );
}

function ProjectPromptAttachmentPreview({
  preview,
}: {
  preview: ProjectAttachmentPreview;
}) {
  const kind = filePreviewKind(preview.attachment.contentType);
  if (!kind) return null;
  return (
    <section
      className="cowork-file-preview"
      aria-label={`Preview ${preview.attachment.fileName}`}
    >
      <header>
        <span>
          <strong title={preview.attachment.workspacePath}>
            {preview.attachment.fileName}
          </strong>
          <small>Message attachment · {formatBytes(preview.attachment.byteSize)}</small>
        </span>
        <a
          className="cds-iconbtn cds-iconbtn--sm"
          href={preview.downloadHref}
          aria-label={`Download ${preview.attachment.fileName}`}
        >
          <Icon name="download" size={13} />
        </a>
      </header>
      <div className="cowork-file-preview__canvas">
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated Project attachment URL
          <img
            src={preview.href}
            alt={`Preview of ${preview.attachment.fileName}`}
          />
        ) : kind === "video" ? (
          <video
            src={preview.href}
            controls
            preload="metadata"
            aria-label={`Preview of ${preview.attachment.fileName}`}
          />
        ) : (
          <iframe
            src={preview.href}
            title={`Preview ${preview.attachment.fileName}`}
            sandbox=""
            loading="lazy"
          />
        )}
      </div>
    </section>
  );
}

function ProjectFilesContent({
  projectId,
  files,
  selection,
  attachmentPreview,
  onSelectionChange,
}: {
  projectId: string;
  files: ProjectFileVM[];
  selection: ProjectFilePreviewTarget | null;
  attachmentPreview: ProjectAttachmentPreview | null;
  onSelectionChange: (target: ProjectFilePreviewTarget | null) => void;
}) {
  return (
    <div className="run-files-drawer__body project-files-drawer__body">
      <p className="project-files-drawer__note">
        Every conversation can use these files. Previous versions stay
        available from History.
      </p>
      {files.length === 0 && !selection && !attachmentPreview ? (
        <div className="project-files-drawer__empty">
          <Icon name="folder-open" size={18} />
          <strong>No files yet</strong>
          <span>Attach a file to a message or ask the agent to create one.</span>
        </div>
      ) : (
        <div
          className={`project-files-layout${
            selection || attachmentPreview ? " has-preview" : ""
          }`}
        >
          <div className="project-files-drawer__list">
            {files.map((file) => (
              <ProjectFileCard
                key={file.id}
                projectId={projectId}
                file={file}
                selected={file.id === selection?.id}
                onPreview={(nextFile) =>
                  onSelectionChange(
                    selection?.id === nextFile.id && !selection.exactVersion
                      ? null
                      : currentFilePreviewTarget(nextFile),
                  )
                }
              />
            ))}
          </div>
          {selection && (
            <ProjectFilePreview
              projectId={projectId}
              target={selection}
            />
          )}
          {!selection && attachmentPreview && (
            <ProjectPromptAttachmentPreview preview={attachmentPreview} />
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectFilesPanel({
  projectId,
  files,
  selection,
  attachmentPreview,
  returnFocusRef,
  onSelectionChange,
  onClose,
}: {
  projectId: string;
  files: ProjectFileVM[];
  selection: ProjectFilePreviewTarget | null;
  attachmentPreview: ProjectAttachmentPreview | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  onSelectionChange: (target: ProjectFilePreviewTarget | null) => void;
  onClose: () => void;
}) {
  useEffect(
    () => () => {
      returnFocusRef.current?.focus();
    },
    [returnFocusRef],
  );
  return (
    <aside className="cowork-session-files-panel" aria-label="Project files">
      <header className="run-files-drawer__head">
        <div>
          <span>Project files</span>
          <h2>Files · {files.length}</h2>
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
      <ProjectFilesContent
        projectId={projectId}
        files={files}
        selection={selection}
        attachmentPreview={attachmentPreview}
        onSelectionChange={onSelectionChange}
      />
    </aside>
  );
}

export function ProjectFilesDrawer({
  open,
  projectId,
  files,
  selection,
  attachmentPreview,
  returnFocusRef,
  onSelectionChange,
  onClose,
}: {
  open: boolean;
  projectId: string;
  files: ProjectFileVM[];
  selection: ProjectFilePreviewTarget | null;
  attachmentPreview: ProjectAttachmentPreview | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  onSelectionChange: (target: ProjectFilePreviewTarget | null) => void;
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
        <ProjectFilesContent
          projectId={projectId}
          files={files}
          selection={selection}
          attachmentPreview={attachmentPreview}
          onSelectionChange={onSelectionChange}
        />
      </aside>
    </div>,
    document.body,
  );
}

export function useDesktopFilesPanel(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return desktop;
}

function historySignature(session: ProjectSessionVM): string {
  return JSON.stringify(session.history);
}

export function ProjectSessionView({
  project,
  initialSession,
  onOpenNavigation,
  onNewSession,
  onRenameSession,
  onArchiveSession,
  onProjectSettings,
  onRetryWorkspace,
  runtime,
  onRetryRuntime,
  modelLabel,
  retryBusy,
  retryError,
  onSessionChange,
}: {
  project: ProjectDetailVM;
  initialSession: ProjectSessionVM;
  onOpenNavigation: () => void;
  onNewSession?: () => void;
  onRenameSession?: () => void;
  onArchiveSession?: () => Promise<void> | void;
  onProjectSettings: () => void;
  onRetryWorkspace: () => void;
  runtime: ProjectRuntimeAvailability;
  onRetryRuntime?: () => Promise<void> | void;
  modelLabel?: string;
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
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [runtimeRetryBusy, setRuntimeRetryBusy] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [files, setFiles] = useState(project.files);
  const [filesOpen, setFilesOpen] = useState(false);
  const [fileSelection, setFileSelection] =
    useState<ProjectFilePreviewTarget | null>(null);
  const [attachmentPreview, setAttachmentPreview] =
    useState<ProjectAttachmentPreview | null>(null);
  const [rowOverride, setRowOverride] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const filesButtonRef = useRef<HTMLButtonElement>(null);
  const filesReturnFocusRef = useRef<HTMLElement>(null);
  const refreshBusyRef = useRef(false);
  const lastEventIdRef = useRef<string | null>(null);
  const appliedHistoryRef = useRef<string | null>(null);
  const initialSessionRef = useRef(initialSession);
  const onSessionChangeRef = useRef(onSessionChange);
  const desktopFilesPanel = useDesktopFilesPanel();
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
        dispatch({
          kind: "user",
          text: prompt.text,
          messageId: prompt.messageId,
        });
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
          : "Could not refresh this conversation.",
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

  const openFiles = useCallback(
    (
      fileId?: string,
      version?: number,
      generatedFile?: GeneratedProjectFile,
    ) => {
      filesReturnFocusRef.current =
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
          ? document.activeElement
          : filesButtonRef.current;
      const currentFile = fileId
        ? files.find((candidate) => candidate.id === fileId)
        : null;
      setFileSelection(
        generatedFile
          ? {
              id: generatedFile.id,
              path: generatedFile.path,
              name: generatedFile.name,
              version: generatedFile.version,
              contentType: generatedFile.contentType,
              byteSize: generatedFile.byteSize,
              exactVersion: true,
            }
          : currentFile
            ? {
                ...currentFilePreviewTarget(currentFile),
                version: version ?? currentFile.version,
                exactVersion: version !== undefined,
              }
            : null,
      );
      setAttachmentPreview(null);
      setFilesOpen(true);
      void refreshFiles();
    },
    [files, refreshFiles],
  );

  const openAttachment = useCallback((preview: ProjectAttachmentPreview) => {
    filesReturnFocusRef.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : filesButtonRef.current;
    setFileSelection(null);
    setAttachmentPreview(preview);
    setFilesOpen(true);
  }, []);

  useEffect(() => {
    const nextSession = initialSessionRef.current;
    setSession(nextSession);
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
    setFileSelection(null);
    setAttachmentPreview(null);
    setComposerFocusRequest(0);
    setRowOverride(new Map());
  }, [initialSession.id, project.id, reconcileHistory]);

  useEffect(() => {
    setFiles(project.files);
  }, [project.files]);

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
    const interval = ACTIVE_SESSION_STATUSES.has(session.status)
      ? 2_500
      : 5_000;
    const timer = window.setInterval(() => void refresh(), interval);
    return () => window.clearInterval(timer);
  }, [refresh, session.status]);

  const workspaceBlocked = [
    project.status,
    project.workspace.status,
  ].some((status) => status === "needs_attention" || status === "error");
  const projectArchived = project.archivedAt !== null;
  const sessionArchived = session.archivedAt !== null;
  const working =
    !workspaceBlocked &&
    !projectArchived &&
    !sessionArchived &&
    (session.status === "queued" || session.status === "working");
  const composerDisabled =
    workspaceBlocked ||
    projectArchived ||
    session.status === "stopping" ||
    sessionArchived ||
    !runtime.available;
  const composerDisabledReason = workspaceBlocked
    ? "Messages are paused while this project needs attention."
    : projectArchived
      ? "Restore this project to continue the conversation."
      : sessionArchived
        ? "Restore this conversation from the Project archive to continue."
        : session.status === "stopping"
          ? "This conversation is stopping."
          : !runtime.available
            ? "Messages are paused while Projects reconnects."
            : undefined;
  const workspaceTechnicalDetail =
    project.statusDetail ||
    project.workspace.statusDetail ||
    "The persistent workspace could not be restored.";
  const visibleFiles = useMemo(
    () =>
      [...files].sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          left.name.localeCompare(right.name),
      ),
    [files],
  );
  const resolvedFileSelection = useMemo(() => {
    if (!fileSelection || fileSelection.exactVersion) return fileSelection;
    const current = visibleFiles.find(
      (candidate) => candidate.id === fileSelection.id,
    );
    return current ? currentFilePreviewTarget(current) : null;
  }, [fileSelection, visibleFiles]);
  const generatedFileTurns = useMemo(
    () =>
      session.prompts.flatMap((prompt) => {
        if (prompt.fileChanges.length === 0) return [];
        return [
          {
            messageId: prompt.messageId,
            files: [...prompt.fileChanges]
              .sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
              )
              .map((change) => ({
                id: change.fileId,
                path: change.path,
                name: change.path.replace(/^files\//, ""),
                version: change.version,
                contentType: change.contentType,
                byteSize: change.byteSize,
                action: change.kind,
              })),
          },
        ];
      }),
    [session.prompts],
  );
  const promptLookup = useMemo(() => {
    const byId = new Map<string, ProjectSessionVM["prompts"][number]>();
    for (const prompt of session.prompts) {
      byId.set(prompt.id, prompt);
      byId.set(prompt.messageId, prompt);
    }
    return byId;
  }, [session.prompts]);
  const renderPromptAttachments = useCallback(
    (messageId: string | null, text: string) => {
      const prompt =
        (messageId ? promptLookup.get(messageId) : null) ??
        session.prompts.find(
          (candidate) =>
            candidate.text === text && candidate.attachments.length > 0,
        );
      return prompt ? (
        <ProjectPromptAttachmentList
          projectId={project.id}
          sessionId={session.id}
          attachments={prompt.attachments}
          onPreview={openAttachment}
        />
      ) : null;
    },
    [openAttachment, project.id, promptLookup, session.id, session.prompts],
  );

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
          <h1 className="cowork-session__title">{session.title}</h1>
        </div>
        <span className="cowork-session__spacer" />
        <span
          className={`cds-status cowork-session__status${
            !workspaceBlocked &&
            !projectArchived &&
            !sessionArchived &&
            (session.status === "idle" || session.status === "completed")
              ? " is-passive"
              : ""
          }`}
        >
          <span
            className={`project-status-dot is-${
              workspaceBlocked
                ? "error"
                : projectArchived || sessionArchived
                  ? "waiting"
                  : statusTone(session.status)
            }`}
            aria-hidden="true"
          />
          {workspaceBlocked
            ? "Needs attention"
            : projectArchived || sessionArchived
              ? "Archived"
              : statusLabel(session.status)}
        </span>
        <span
          className="cowork-session__model"
        >
          {modelLabel ?? session.model}
        </span>
        <button
          ref={filesButtonRef}
          type="button"
          className="cds-btn cds-btn--ghost cds-btn--sm cowork-session__files"
          aria-expanded={filesOpen}
          onClick={() => openFiles()}
        >
          <Icon name="folder-open" size={13} />
          Files <span className="tnum">{visibleFiles.length}</span>
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
                      : "Could not stop the conversation.",
                  ),
                )
                .finally(() => setStopBusy(false));
            }}
          >
            <span className="cowork-stop-icon" aria-hidden="true" />
            {stopBusy ? "Stopping…" : "Stop"}
          </button>
        )}
        {(onNewSession || onRenameSession || onArchiveSession) && (
          <details className="cowork-session__menu">
            <summary
              className="cds-iconbtn cds-iconbtn--sm"
              aria-label="Conversation actions"
            >
              <Icon name="more-horizontal" size={14} />
            </summary>
            <div role="menu">
              {onNewSession && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                    onNewSession();
                  }}
                >
                  <Icon name="square-pen" size={13} />
                  New conversation
                </button>
              )}
              {onRenameSession && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                    onRenameSession();
                  }}
                >
                  <Icon name="pencil" size={13} />
                  Rename
                </button>
              )}
              {onArchiveSession && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={archiveBusy}
                  onClick={(event) => {
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                    setArchiveBusy(true);
                    void Promise.resolve(onArchiveSession()).finally(() =>
                      setArchiveBusy(false),
                    );
                  }}
                >
                  <Icon name="archive" size={13} />
                  {working ? "Stop and archive" : "Archive"}
                </button>
              )}
            </div>
          </details>
        )}
      </header>

      <div className="cowork-session__workspace">
        <div className="cowork-session__body">
          <div className="cowork-transcript cowork-transcript--live">
          <ChatTranscript
            run={null}
            chat={chat}
            ariaLabel="Conversation transcript"
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
            onOpenFiles={openFiles}
            generatedFileTurns={generatedFileTurns}
            renderUserAttachments={renderPromptAttachments}
            showChatError={false}
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
          </div>
          {workspaceBlocked && (
            <div className="cowork-session__workspace-alert" role="alert">
              <Icon name="alert-triangle" size={15} />
              <span className="cowork-session__workspace-alert-copy">
                <strong>This project needs attention.</strong>
                <span>
                  Companion could not make this Project’s workspace available.
                  Try again, or review its settings if the issue continues.
                </span>
                <small>
                  Messages are paused until the project is available again.
                </small>
                <details>
                  <summary>Technical details</summary>
                  <code>{workspaceTechnicalDetail}</code>
                </details>
              </span>
              <ProjectRecoveryActions
                busy={retryBusy}
                error={retryError}
                onRetry={onRetryWorkspace}
                onSettings={onProjectSettings}
              />
            </div>
          )}
          {!workspaceBlocked && session.status === "error" && (
              <div className="cowork-session__turn-alert" role="status">
                <Icon name="alert-triangle" size={15} />
                <span className="cowork-session__turn-alert-copy">
                  <strong>Previous task stopped</strong>
                  <span>
                    Your conversation and files are safe. Send a message to
                    continue.
                  </span>
                  {session.errorMessage && (
                    <details>
                      <summary>Technical details</summary>
                      <code>{session.errorMessage}</code>
                    </details>
                  )}
                </span>
                <span className="cowork-session__turn-alert-actions">
                  <button
                    type="button"
                    className="cds-btn cds-btn--secondary cds-btn--sm"
                    onClick={() =>
                      setComposerFocusRequest((current) => current + 1)
                    }
                  >
                    Continue
                  </button>
                  {onNewSession && (
                    <button
                      type="button"
                      className="cds-btn cds-btn--ghost cds-btn--sm"
                      onClick={onNewSession}
                    >
                      New conversation
                    </button>
                  )}
                  {onArchiveSession && (
                    <button
                      type="button"
                      className="cds-btn cds-btn--ghost cds-btn--sm"
                      disabled={archiveBusy}
                      onClick={() => {
                        setArchiveBusy(true);
                        void Promise.resolve(onArchiveSession()).finally(() =>
                          setArchiveBusy(false),
                        );
                      }}
                    >
                      {archiveBusy ? "Archiving…" : "Archive"}
                    </button>
                  )}
                </span>
              </div>
            )}
          {!runtime.available &&
            !workspaceBlocked &&
            !projectArchived &&
            !sessionArchived && (
              <div
                className="cowork-session__runtime-state"
                role="status"
                aria-live="polite"
              >
                <Icon name="alert-triangle" size={14} />
                <span>
                  <strong>Messages are temporarily paused.</strong>
                  <span>
                    {runtime.message ||
                      "Companion is reconnecting to Projects. Your conversation, files, and draft are safe."}
                  </span>
                </span>
                {onRetryRuntime && (
                  <button
                    type="button"
                    className="cds-btn cds-btn--secondary cds-btn--sm"
                    disabled={runtimeRetryBusy}
                    onClick={() => {
                      setRuntimeRetryBusy(true);
                      void Promise.resolve(onRetryRuntime()).finally(() =>
                        setRuntimeRetryBusy(false),
                      );
                    }}
                  >
                    {runtimeRetryBusy ? "Checking…" : "Check again"}
                  </button>
                )}
              </div>
            )}
          <SessionComposer
            draftKey={`companion:project-draft:${project.id}:${session.id}`}
            disabled={composerDisabled}
            disabledReason={composerDisabledReason}
            focusRequest={composerFocusRequest}
            projectFileCount={visibleFiles.length}
            working={working}
            onOpenProjectFiles={() => openFiles()}
            onSend={async ({ prompt, files: nextFiles, idempotencyKey }) => {
              const next = await sendProjectPrompt(project.id, session.id, {
                prompt,
                model: session.model,
                files: nextFiles,
                idempotencyKey,
              });
              const acceptedPrompt = [...next.prompts]
                .reverse()
                .find((candidate) => candidate.text === prompt);
              dispatch({
                kind: "user",
                text: prompt,
                messageId: acceptedPrompt?.messageId,
              });
              dispatch({ kind: "send" });
              apply(next);
            }}
          />
        </div>
        {desktopFilesPanel && filesOpen && (
          <ProjectFilesPanel
            projectId={project.id}
            files={visibleFiles}
            selection={resolvedFileSelection}
            attachmentPreview={attachmentPreview}
            returnFocusRef={filesReturnFocusRef}
            onSelectionChange={(next) => {
              setFileSelection(next);
              setAttachmentPreview(null);
            }}
            onClose={() => setFilesOpen(false)}
          />
        )}
      </div>

      <ProjectFilesDrawer
        open={!desktopFilesPanel && filesOpen}
        projectId={project.id}
        files={visibleFiles}
        selection={resolvedFileSelection}
        attachmentPreview={attachmentPreview}
        returnFocusRef={filesReturnFocusRef}
        onSelectionChange={(next) => {
          setFileSelection(next);
          setAttachmentPreview(null);
        }}
        onClose={() => setFilesOpen(false)}
      />

      <span className="sr-only" aria-live="polite">
        Last activity {relativeTime(session.lastActiveAt)}
        {streamConnected ? " · Live updates connected" : ""}
      </span>
    </div>
  );
}
