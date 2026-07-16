"use client";

/* Authenticated media and local blob previews intentionally bypass next/image optimization. */
/* eslint-disable @next/next/no-img-element */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { SkillRunArtifactRow, SkillRunAttachmentRow } from "@companion/contracts";
import { runArtifactHref, runAttachmentHref } from "@/lib/runQueries";
import { Icon } from "../Icon";

type MediaKind = "image" | "video";

const SAFE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const SAFE_VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

export function formatRunFileBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function mediaKind(contentType: string | null | undefined): MediaKind | null {
  const canonical = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!canonical) return null;
  if (SAFE_IMAGE_TYPES.has(canonical)) return "image";
  if (SAFE_VIDEO_TYPES.has(canonical)) return "video";
  return null;
}

function attachmentPreviewKind(attachment: SkillRunAttachmentRow): MediaKind | null {
  return mediaKind(attachment.preview_content_type);
}

function artifactPreviewKind(artifact: SkillRunArtifactRow): MediaKind | null {
  return artifact.previewable ? mediaKind(artifact.content_type) : null;
}

function localPreviewKind(file: File): MediaKind | null {
  return mediaKind(file.type);
}

function useObjectUrl(file: File, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [enabled, file]);
  return url;
}

function MediaViewer({
  kind,
  src,
  downloadHref,
  fileName,
  onClose,
}: {
  kind: MediaKind;
  src: string;
  downloadHref: string;
  fileName: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = closeRef.current?.closest<HTMLElement>(".run-media-viewer");
      if (!dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((item) => !item.hasAttribute("disabled"));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="run-media-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${fileName}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="run-media-viewer__bar">
        <span title={fileName}>{fileName}</span>
        <button ref={closeRef} type="button" className="cds-iconbtn cds-iconbtn--md" onClick={onClose} aria-label="Close preview">
          <Icon name="x" size={16} />
        </button>
      </div>
      {previewFailed ? (
        <div className="run-media-viewer__error" role="status">
          <Icon name="alert-triangle" size={18} />
          <span>Preview unavailable</span>
          <a className="btn-sec" href={downloadHref} download={fileName}>Download file</a>
        </div>
      ) : kind === "image" ? (
        <img className="run-media-viewer__image" src={src} alt={fileName} onError={() => setPreviewFailed(true)} />
      ) : (
        <video
          className="run-media-viewer__video"
          src={src}
          controls
          preload="metadata"
          aria-label={fileName}
          onError={() => setPreviewFailed(true)}
        />
      )}
    </div>,
    document.body,
  );
}

function MediaCard({
  fileName,
  byteSize,
  src,
  downloadHref,
  kind,
  path,
  compact = false,
}: {
  fileName: string;
  byteSize: number;
  src: string;
  downloadHref: string;
  kind: MediaKind | null;
  path?: string;
  compact?: boolean;
}) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeViewer = useCallback(() => {
    setViewerOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <article className={`run-file-card${compact ? " run-file-card--compact" : ""}`}>
      {kind && previewFailed ? (
        <div className="run-file-card__preview-error" role="status">
          <Icon name="alert-triangle" size={compact ? 13 : 16} />
          <span>Preview unavailable</span>
        </div>
      ) : kind === "image" ? (
        <button
          ref={triggerRef}
          type="button"
          className="run-file-card__preview"
          aria-label={`Preview ${fileName}`}
          onClick={() => setViewerOpen(true)}
        >
          <img src={src} alt="" loading="lazy" onError={() => setPreviewFailed(true)} />
        </button>
      ) : kind === "video" ? (
        <video
          className="run-file-card__preview"
          src={src}
          controls
          preload="metadata"
          aria-label={fileName}
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <div className="run-file-card__file" aria-hidden="true">
          <Icon name="file" size={compact ? 16 : 20} />
        </div>
      )}
      <div className="run-file-card__meta">
        <span title={path ?? fileName}>{fileName}</span>
        <small>{formatRunFileBytes(byteSize)}</small>
      </div>
      <a
        className="run-file-card__download cds-iconbtn cds-iconbtn--sm"
        href={downloadHref}
        download={fileName}
        aria-label={`Download ${fileName}`}
        title={`Download ${fileName}`}
      >
        <Icon name="download" size={13} />
      </a>
      {viewerOpen && kind && !previewFailed && (
        <MediaViewer
          kind={kind}
          src={src}
          downloadHref={downloadHref}
          fileName={fileName}
          onClose={closeViewer}
        />
      )}
    </article>
  );
}

export function RunAttachmentList({
  runId,
  attachments,
}: {
  runId: string;
  attachments: SkillRunAttachmentRow[];
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="run-message-files" aria-label="Attached files">
      {attachments.map((attachment) => {
        const href = runAttachmentHref(runId, attachment.id);
        return (
          <MediaCard
            key={attachment.id}
            fileName={attachment.file_name}
            byteSize={attachment.byte_size}
            src={href}
            downloadHref={runAttachmentHref(runId, attachment.id, true)}
            kind={attachmentPreviewKind(attachment)}
            compact
          />
        );
      })}
    </div>
  );
}

function DraftFileCard({ file, onRemove, disabled }: { file: File; onRemove: () => void; disabled: boolean }) {
  const kind = localPreviewKind(file);
  const url = useObjectUrl(file, kind !== null);
  return (
    <article className="run-draft-file">
      {url && kind === "image" ? (
        <img className="run-draft-file__preview" src={url} alt="" />
      ) : url && kind === "video" ? (
        <video className="run-draft-file__preview" src={url} controls preload="metadata" aria-label={`Video preview ${file.name}`} />
      ) : (
        <span className="run-draft-file__icon"><Icon name="file" size={16} /></span>
      )}
      <span className="run-draft-file__meta">
        <b title={file.name}>{file.name}</b>
        <small>{formatRunFileBytes(file.size)}</small>
      </span>
      <button type="button" disabled={disabled} onClick={onRemove} aria-label={`Remove ${file.name}`}>
        <Icon name="x" size={13} />
      </button>
    </article>
  );
}

export function DraftAttachmentList({
  files,
  disabled,
  onRemove,
}: {
  files: File[];
  disabled: boolean;
  onRemove: (index: number) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="run-draft-files" aria-label="Files ready to send">
      {files.map((file, index) => (
        <DraftFileCard
          key={`${file.name}:${file.size}:${file.lastModified}:${index}`}
          file={file}
          disabled={disabled}
          onRemove={() => onRemove(index)}
        />
      ))}
    </div>
  );
}

function ExpiredFile({ fileName, byteSize }: { fileName: string; byteSize: number }) {
  return (
    <article className="run-file-card run-file-card--expired">
      <div className="run-file-card__file"><Icon name="file" size={20} /></div>
      <div className="run-file-card__meta"><span>{fileName}</span><small>{formatRunFileBytes(byteSize)}</small></div>
      <span className="run-file-card__expired-label">Expired</span>
    </article>
  );
}

function useArtifactClock(artifacts: SkillRunArtifactRow[]): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const now = Date.now();
    const nextExpiry = Math.min(
      ...artifacts
        .map((artifact) => Date.parse(artifact.expires_at))
        .filter((expiry) => Number.isFinite(expiry) && expiry > now),
    );
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(nextExpiry - now + 25, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [artifacts, clock]);
  return clock;
}

function useDrawerFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  returnFocusRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const returnFocus = returnFocusRef.current;
    (panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector(".run-media-viewer")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((item) => !item.hasAttribute("disabled"));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      returnFocus?.focus();
    };
  }, [onClose, open, panelRef, returnFocusRef]);
}

export function RunFilesDrawer({
  open,
  runId,
  attachments,
  artifacts,
  returnFocusRef,
  onClose,
}: {
  open: boolean;
  runId: string;
  attachments: SkillRunAttachmentRow[];
  artifacts: SkillRunArtifactRow[];
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const clock = useArtifactClock(artifacts);
  useDrawerFocus(open, panelRef, returnFocusRef, onClose);
  const attachmentGroups = useMemo(() => {
    const groups = new Map<number, SkillRunAttachmentRow[]>();
    for (const attachment of attachments) {
      const current = groups.get(attachment.prompt_ordinal) ?? [];
      current.push(attachment);
      groups.set(attachment.prompt_ordinal, current);
    }
    return [...groups.entries()].sort(([a], [b]) => a - b);
  }, [attachments]);

  if (!open) return null;
  return createPortal(
    <div className="run-files-layer">
      <button type="button" className="run-files-layer__scrim" aria-label="Close files" onClick={onClose} />
      <aside ref={panelRef} className="run-files-drawer" role="dialog" aria-modal="true" aria-labelledby="run-files-title" tabIndex={-1}>
        <header className="run-files-drawer__head">
          <div>
            <span>Run files</span>
            <h2 id="run-files-title">Files · {attachments.length + artifacts.length}</h2>
          </div>
          <button type="button" className="cds-iconbtn cds-iconbtn--md" onClick={onClose} aria-label="Close files">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="run-files-drawer__body">
          <section className="run-files-section">
            <div className="run-files-section__head">
              <h3>Uploaded</h3>
              <span>{attachments.length}</span>
            </div>
            {attachmentGroups.length === 0 ? (
              <p className="run-files-empty">No uploaded files.</p>
            ) : attachmentGroups.map(([ordinal, group]) => (
              <div className="run-files-group" key={ordinal}>
                <div className="run-files-group__label">{ordinal === 0 ? "Initial prompt" : `Follow-up ${ordinal}`}</div>
                <div className="run-files-grid">
                  {group.map((attachment) => {
                    const href = runAttachmentHref(runId, attachment.id);
                    return (
                      <MediaCard
                        key={attachment.id}
                        fileName={attachment.file_name}
                        byteSize={attachment.byte_size}
                        src={href}
                        downloadHref={runAttachmentHref(runId, attachment.id, true)}
                        kind={attachmentPreviewKind(attachment)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
          <section className="run-files-section">
            <div className="run-files-section__head">
              <h3>Generated</h3>
              <span>{artifacts.length}</span>
            </div>
            <p className="run-files-section__note">Generated files belong to this run and expire after 24 hours.</p>
            {artifacts.length === 0 ? (
              <p className="run-files-empty">No generated files.</p>
            ) : (
              <div className="run-files-grid">
                {artifacts.map((artifact) => {
                  if (Date.parse(artifact.expires_at) <= clock) {
                    return <ExpiredFile key={artifact.id} fileName={artifact.file_name} byteSize={artifact.byte_size} />;
                  }
                  const href = runArtifactHref(runId, artifact.id);
                  return (
                    <MediaCard
                      key={artifact.id}
                      fileName={artifact.file_name}
                      byteSize={artifact.byte_size}
                      path={artifact.path}
                      src={href}
                      downloadHref={runArtifactHref(runId, artifact.id, true)}
                      kind={artifactPreviewKind(artifact)}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
