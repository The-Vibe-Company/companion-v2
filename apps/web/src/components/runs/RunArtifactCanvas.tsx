"use client";

/* Authenticated Blob previews intentionally bypass next/image optimization. */
/* eslint-disable @next/next/no-img-element */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  RunFilePreviewKind,
  SkillRunArtifactRow,
  SkillRunAttachmentRow,
} from "@companion/contracts";
import { runArtifactHref, runAttachmentHref } from "@/lib/runQueries";
import { Icon } from "../Icon";
import {
  CanvasStatus,
  FilePreviewBody,
  useFilePreview,
  type FilePreviewState,
} from "../files/filePreview";
import { copyRunText } from "./clipboard";
import { formatRunFileBytes } from "./ChatMedia";

const DEFAULT_WIDTH = 640;
const MIN_WIDTH = 420;
const WIDTH_KEY = "companion:run-artifact-canvas-width";

type CanvasFile = {
  key: string;
  id: string;
  source: "artifact" | "attachment";
  name: string;
  path: string;
  contentType: string;
  previewContentType: string | null;
  byteSize: number;
  previewKind: RunFilePreviewKind | null;
  expiresAt: string | null;
  updatedAt: string | null;
  promptOrdinal: number | null;
};

type PreviewState = FilePreviewState;

type TreeNode = { name: string; path: string; folders: TreeNode[]; files: CanvasFile[] };

function buildGeneratedTree(files: CanvasFile[]): TreeNode {
  const root: TreeNode = { name: "Generated", path: "", folders: [], files: [] };
  for (const file of files) {
    const parts = file.path.replace(/^\.\//, "").replace(/^artifacts\//, "").split("/").filter(Boolean);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.folders.find((candidate) => candidate.name === part);
      if (!child) {
        child = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: [], files: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.files.push(file);
  }
  const sort = (node: TreeNode) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

function formatExpiry(expiresAt: string | null, clock: number): string | null {
  if (!expiresAt) return null;
  const remaining = Date.parse(expiresAt) - clock;
  if (remaining <= 0) return "Expired";
  const hours = Math.max(1, Math.ceil(remaining / 3_600_000));
  return `Expires in ${hours}h`;
}

function TreeFile({ file, selected, onSelect }: { file: CanvasFile; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`run-canvas-file${selected ? " is-selected" : ""}`} aria-current={selected ? "page" : undefined} onClick={onSelect} title={file.path}>
      <Icon name={file.previewKind === "image" ? "image" : file.previewKind === "markdown" ? "file-text" : "file"} size={14} />
      <span>{file.name}</span>
      <small>{formatRunFileBytes(file.byteSize)}</small>
    </button>
  );
}

function TreeFolder({ node, selectedKey, onSelect }: { node: TreeNode; selectedKey: string | null; onSelect: (file: CanvasFile) => void }) {
  return (
    <details className="run-canvas-folder" open>
      <summary><Icon name="chevron-right" size={12} /><Icon name="folder" size={14} /><span>{node.name}</span></summary>
      <div>
        {node.folders.map((folder) => <TreeFolder key={folder.path} node={folder} selectedKey={selectedKey} onSelect={onSelect} />)}
        {node.files.map((file) => <TreeFile key={file.key} file={file} selected={file.key === selectedKey} onSelect={() => onSelect(file)} />)}
      </div>
    </details>
  );
}

function previewHref(runId: string, file: CanvasFile, download = false): string {
  return file.source === "artifact"
    ? runArtifactHref(runId, file.id, download)
    : runAttachmentHref(runId, file.id, download);
}

export function RunArtifactCanvas({
  open,
  runId,
  attachments,
  artifacts,
  collecting,
  selectedKey,
  newCount,
  onSelect,
  onClose,
}: {
  open: boolean;
  runId: string;
  attachments: SkillRunAttachmentRow[];
  artifacts: SkillRunArtifactRow[];
  collecting: boolean;
  selectedKey: string | null;
  newCount: number;
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [clock, setClock] = useState(() => Date.now());
  const [retry, setRetry] = useState(0);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef<HTMLElement | null>(null);
  const viewerRef = useRef<HTMLElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const savedValue = localStorage.getItem(WIDTH_KEY);
    const saved = savedValue === null ? Number.NaN : Number(savedValue);
    if (Number.isFinite(saved)) setWidth(Math.max(MIN_WIDTH, Math.min(saved, window.innerWidth * 0.7)));
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const now = Date.now();
    const nextExpiry = Math.min(...artifacts.map((artifact) => Date.parse(artifact.expires_at)).filter((value) => value > now));
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(nextExpiry - now + 25, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [artifacts, clock]);

  const files = useMemo<CanvasFile[]>(() => [
    ...artifacts.map((artifact) => ({
      key: `artifact:${artifact.id}`,
      id: artifact.id,
      source: "artifact" as const,
      name: artifact.file_name,
      path: artifact.path.startsWith(".") ? artifact.path : `./${artifact.path}`,
      contentType: artifact.content_type,
      previewContentType: artifact.preview_kind === "image" || artifact.preview_kind === "video" ? artifact.content_type : null,
      byteSize: artifact.byte_size,
      previewKind: artifact.preview_kind ?? null,
      expiresAt: artifact.expires_at,
      updatedAt: artifact.updated_at ?? null,
      promptOrdinal: null,
    })),
    ...attachments.map((attachment) => ({
      key: `attachment:${attachment.id}`,
      id: attachment.id,
      source: "attachment" as const,
      name: attachment.file_name,
      path: attachment.file_name,
      contentType: attachment.content_type,
      previewContentType: attachment.preview_content_type,
      byteSize: attachment.byte_size,
      previewKind: attachment.preview_kind ?? null,
      expiresAt: null,
      updatedAt: attachment.created_at ?? null,
      promptOrdinal: attachment.prompt_ordinal,
    })),
  ], [artifacts, attachments]);
  const selected = files.find((file) => file.key === selectedKey) ?? null;
  const generatedTree = useMemo(() => buildGeneratedTree(files.filter((file) => file.source === "artifact")), [files]);
  const uploadedGroups = useMemo(() => {
    const groups = new Map<number, CanvasFile[]>();
    for (const file of files.filter((candidate) => candidate.source === "attachment")) {
      const ordinal = file.promptOrdinal ?? 0;
      groups.set(ordinal, [...(groups.get(ordinal) ?? []), file]);
    }
    return [...groups.entries()].sort(([a], [b]) => a - b);
  }, [files]);

  useEffect(() => {
    setMobilePreview(selected !== null);
  }, [selected]);

  useEffect(() => {
    if (!open || !mobile) return;
    const frame = window.requestAnimationFrame(() => {
      if (mobilePreview) viewerRef.current?.focus();
      else canvasRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mobile, mobilePreview, open]);

  useEffect(() => {
    if (!open || !mobile) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
    };
  }, [mobile, open]);

  // The shared engine owns fetch/decode/limits/cleanup; this surface only supplies the target.
  const preview = useFilePreview({
    href: selected ? previewHref(runId, selected) : null,
    previewKind: selected?.previewKind ?? null,
    byteSize: selected?.byteSize ?? 0,
    generation: selected ? selected.updatedAt ?? selected.expiresAt ?? String(selected.byteSize) : null,
    expiresAt: selected?.expiresAt ?? null,
    enabled: open && Boolean(selected),
    retryToken: retry,
    clock,
  });

  useEffect(() => {
    setCopied(false);
  }, [open, selected]);

  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const move = (pointer: PointerEvent) => setWidth(Math.max(MIN_WIDTH, Math.min(startWidth + startX - pointer.clientX, window.innerWidth * 0.7)));
    const up = (pointer: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const next = Math.max(MIN_WIDTH, Math.min(startWidth + startX - pointer.clientX, window.innerWidth * 0.7));
      setWidth(next);
      localStorage.setItem(WIDTH_KEY, String(Math.round(next)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  if (!open) return null;
  const expiration = formatExpiry(selected?.expiresAt ?? null, clock);
  const format = selected?.name.split(".").pop()?.toUpperCase() ?? "FILE";
  const textContent = preview.kind === "text" ? preview.text : null;

  return (
    <aside
      ref={canvasRef}
      className={`run-artifact-canvas${mobilePreview ? " is-preview" : ""}`}
      style={{ "--run-canvas-width": `${width}px` } as CSSProperties}
      aria-label="Run files"
      role={mobile ? "dialog" : undefined}
      aria-modal={mobile || undefined}
      tabIndex={mobile ? -1 : undefined}
      onKeyDown={(event) => {
        if (!mobile) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (mobilePreview) {
            canvasRef.current?.focus();
            setMobilePreview(false);
          }
          else onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])')]
          .filter((element) => element.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        className="run-artifact-canvas__resize"
        role="separator"
        aria-label="Resize file canvas"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={Math.round(typeof window === "undefined" ? 1280 : window.innerWidth * 0.7)}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={resize}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next = Math.max(MIN_WIDTH, Math.min(width + (event.key === "ArrowLeft" ? 24 : -24), window.innerWidth * 0.7));
          setWidth(next);
          localStorage.setItem(WIDTH_KEY, String(Math.round(next)));
        }}
      />
      <header className="run-artifact-canvas__head">
        <div><span>Artifacts</span><strong>Files · {files.length}</strong></div>
        {collecting && <span className="run-canvas-collecting"><Icon name="loader" size={12} className="ls-spin" />Collecting files…</span>}
        {newCount > 0 && <span className="run-canvas-new">+{newCount} new</span>}
        <button type="button" className="cds-iconbtn cds-iconbtn--md" onClick={onClose} aria-label="Close files"><Icon name="x" size={16} /></button>
      </header>
      <div className="run-artifact-canvas__body">
        <nav className="run-canvas-tree" aria-label="Files">
          <details className="run-canvas-root" open>
            <summary><Icon name="chevron-right" size={12} /><Icon name="sparkles" size={14} /><b>Generated</b><span>{artifacts.length}</span></summary>
            <div>
              {collecting && artifacts.length === 0 && <p><Icon name="loader" size={12} className="ls-spin" />Collecting files…</p>}
              {!collecting && artifacts.length === 0 && <p>No generated files yet.</p>}
              {generatedTree.folders.map((folder) => <TreeFolder key={folder.path} node={folder} selectedKey={selectedKey} onSelect={(file) => onSelect(file.key)} />)}
              {generatedTree.files.map((file) => <TreeFile key={file.key} file={file} selected={file.key === selectedKey} onSelect={() => onSelect(file.key)} />)}
            </div>
          </details>
          <details className="run-canvas-root" open>
            <summary><Icon name="chevron-right" size={12} /><Icon name="upload" size={14} /><b>Uploaded</b><span>{attachments.length}</span></summary>
            <div>
              {uploadedGroups.length === 0 && <p>No uploaded files.</p>}
              {uploadedGroups.map(([ordinal, group]) => (
                <div className="run-canvas-upload-group" key={ordinal}>
                  <span>{ordinal === 0 ? "Initial prompt" : `Follow-up ${ordinal}`}</span>
                  {group.map((file) => <TreeFile key={file.key} file={file} selected={file.key === selectedKey} onSelect={() => onSelect(file.key)} />)}
                </div>
              ))}
            </div>
          </details>
        </nav>
        <section ref={viewerRef} className="run-canvas-viewer" aria-label={selected ? `Preview ${selected.name}` : "File preview"} tabIndex={mobile && mobilePreview ? -1 : undefined}>
          {!selected ? (
            <CanvasStatus icon="folder-open" message={files.length ? "Select a file to preview it." : "Files created by this run will appear here."} />
          ) : (
            <>
              <div className="run-canvas-viewer__bar">
                <button type="button" className="run-canvas-mobile-back" onClick={() => setMobilePreview(false)}><Icon name="arrow-left" size={14} />Files</button>
                <span className="run-canvas-viewer__path" title={selected.path}>{selected.path}</span>
                <span>{format}</span><span>{formatRunFileBytes(selected.byteSize)}</span>{expiration && <span>{expiration}</span>}
                <button type="button" className="cds-iconbtn cds-iconbtn--sm" aria-label="Copy file" title="Copy file" onClick={() => {
                  void copyRunText(textContent ?? selected.path).then((ok) => {
                    setCopied(ok);
                    if (ok) window.setTimeout(() => setCopied(false), 1_300);
                  });
                }}><Icon name={copied ? "check" : "copy"} size={13} /></button>
                <a className="cds-iconbtn cds-iconbtn--sm" href={previewHref(runId, selected, true)} download={selected.name} aria-label={`Download ${selected.name}`} title="Download"><Icon name="download" size={13} /></a>
              </div>
              <div className="run-canvas-viewer__content">
                <FilePreviewBody
                  state={preview}
                  previewKind={selected.previewKind}
                  name={selected.name}
                  downloadHref={previewHref(runId, selected, true)}
                  onRetry={() => setRetry((value) => value + 1)}
                />
              </div>
            </>
          )}
        </section>
      </div>
    </aside>
  );
}
