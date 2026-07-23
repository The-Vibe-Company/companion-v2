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
import { RUN_ARTIFACT_PREVIEW_TTL_MS } from "@companion/contracts";
import { createRunArtifactPreview, runArtifactHref, runAttachmentHref } from "@/lib/runQueries";
import { Icon } from "../Icon";
import { langForFile } from "../skills/fileFormat";
import { CodeView } from "../skills/markdown";
import { copyRunText } from "./clipboard";
import { formatRunFileBytes } from "./ChatMedia";
import { ChatMarkdown } from "./chatMarkdown";

const TEXT_PREVIEW_LIMIT = 1024 * 1024;
const XLSX_PREVIEW_LIMIT = 10 * 1024 * 1024;
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

type PreviewState =
  | { kind: "idle" | "loading" }
  | { kind: "text"; text: string }
  | { kind: "blob"; url: string }
  | { kind: "direct"; url: string }
  | { kind: "html"; url: string; expiresAt: string; lifetimeMs: number }
  | { kind: "xlsx"; bytes: ArrayBuffer }
  | { kind: "expired" | "unsupported" | "too_large"; message: string }
  | { kind: "error"; message: string };

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

function parseCsv(text: string): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  const pushCell = () => {
    if (row.length < 100) row.push(cell);
    else truncated = true;
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (rows.length < 500) rows.push(row);
    else truncated = true;
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) pushCell();
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
    } else cell += char;
  }
  if (cell || row.length) pushRow();
  return { rows, truncated };
}

function DataTable({ rows, truncated }: { rows: unknown[][]; truncated: boolean }) {
  if (rows.length === 0) return <div className="run-canvas-state">This file contains no rows.</div>;
  return (
    <div className="run-canvas-table-wrap">
      <table className="run-canvas-table">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th scope="row">{rowIndex + 1}</th>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell instanceof Date ? cell.toLocaleString() : String(cell ?? "")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <p className="run-canvas-limit">Preview limited to 500 rows, 100 columns and 50,000 cells.</p>}
    </div>
  );
}

function XlsxPreview({ bytes }: { bytes: ArrayBuffer }) {
  const workerRef = useRef<Worker | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const [sheet, setSheet] = useState<string | undefined>();
  const [result, setResult] = useState<{ sheets: string[]; sheet: string | null; rows: unknown[][]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const worker = new Worker(new URL("./xlsxPreview.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<{ requestId: number; error?: string; sheets?: string[]; sheet?: string | null; rows?: unknown[][]; truncated?: boolean }>) => {
      if (event.data.requestId !== requestRef.current) return;
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      setLoading(false);
      if (event.data.error) {
        setError(event.data.error);
        return;
      }
      setError(null);
      setResult({
        sheets: event.data.sheets ?? [],
        sheet: event.data.sheet ?? null,
        rows: event.data.rows ?? [],
        truncated: event.data.truncated ?? false,
      });
    };
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      worker.terminate();
      workerRef.current = null;
    };
  }, [bytes]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    requestRef.current += 1;
    setLoading(true);
    setError(null);
    worker.postMessage({ requestId: requestRef.current, bytes, sheet });
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      worker.terminate();
      workerRef.current = null;
      setLoading(false);
      setError("This workbook is too complex to preview safely.");
    }, 8_000);
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, [bytes, sheet]);

  if (loading && !result) return <CanvasStatus icon="loader" spin message="Loading workbook…" />;
  if (error) return <CanvasStatus icon="alert-triangle" message={error} />;
  return (
    <div className="run-canvas-xlsx">
      {(result?.sheets.length ?? 0) > 1 && (
        <div
          className="run-canvas-sheets"
          role="tablist"
          aria-label="Workbook sheets"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
            const current = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement));
            const next = event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next]?.focus();
            if (tabs[next]) setSheet(tabs[next]!.textContent ?? undefined);
          }}
        >
          {result!.sheets.map((name) => (
            <button key={name} type="button" role="tab" aria-selected={result?.sheet === name} tabIndex={result?.sheet === name ? 0 : -1} onClick={() => setSheet(name)}>{name}</button>
          ))}
        </div>
      )}
      {loading
        ? <CanvasStatus icon="loader" spin message="Loading workbook…" />
        : <DataTable rows={result?.rows ?? []} truncated={result?.truncated ?? false} />}
    </div>
  );
}

function CanvasStatus({ icon, message, spin = false, children }: { icon: string; message: string; spin?: boolean; children?: React.ReactNode }) {
  return (
    <div className="run-canvas-state" role="status">
      <Icon name={icon} size={22} className={spin ? "ls-spin" : undefined} />
      <span>{message}</span>
      {children}
    </div>
  );
}

function TreeFile({ file, selected, onSelect }: { file: CanvasFile; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`run-canvas-file${selected ? " is-selected" : ""}`} aria-current={selected ? "page" : undefined} onClick={onSelect} title={file.path}>
      <Icon name={file.previewKind === "image" ? "image" : file.previewKind === "markdown" || file.previewKind === "html" ? "file-text" : "file"} size={14} />
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

function previewHref(runId: string, file: Pick<CanvasFile, "id" | "source">, download = false): string {
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
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
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
  const selectedId = selected?.id ?? null;
  const selectedSource = selected?.source ?? null;
  const selectedPreviewContentType = selected?.previewContentType ?? null;
  const selectedByteSize = selected?.byteSize ?? null;
  const selectedPreviewKind = selected?.previewKind ?? null;
  const selectedExpiresAt = selected?.expiresAt ?? null;
  const selectedUpdatedAt = selected?.updatedAt ?? null;
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

  useEffect(() => {
    const controller = new AbortController();
    let blobUrl: string | null = null;
    const load = async () => {
      setCopied(false);
      if (!open) {
        setPreview({ kind: "idle" });
        return;
      }
      if (!selectedId || !selectedSource) {
        setPreview({ kind: "idle" });
        return;
      }
      const target = { id: selectedId, source: selectedSource };
      if (selectedExpiresAt && Date.parse(selectedExpiresAt) <= Date.now()) {
        setPreview({ kind: "expired", message: "This generated file has expired." });
        return;
      }
      if (!selectedPreviewKind) {
        setPreview({ kind: "unsupported", message: "Preview is not supported for this format." });
        return;
      }
      if (
        ["text", "markdown", "csv"].includes(selectedPreviewKind)
        && selectedByteSize !== null
        && selectedByteSize > TEXT_PREVIEW_LIMIT
      ) {
        setPreview({ kind: "too_large", message: "This preview is larger than the 1 MB display limit." });
        return;
      }
      if (selectedPreviewKind === "xlsx" && selectedByteSize !== null && selectedByteSize > XLSX_PREVIEW_LIMIT) {
        setPreview({ kind: "too_large", message: "This workbook is larger than the 10 MB display limit." });
        return;
      }
      if (selectedPreviewKind === "image" || selectedPreviewKind === "video") {
        const generation = selectedUpdatedAt ?? selectedExpiresAt ?? String(selectedByteSize);
        setPreview({ kind: "direct", url: `${previewHref(runId, target)}?v=${encodeURIComponent(generation)}` });
        return;
      }
      if (selectedPreviewKind === "html" && selectedSource === "artifact") {
        setPreview({ kind: "loading" });
        try {
          const issued = await createRunArtifactPreview(runId, selectedId, controller.signal);
          setPreview({
            kind: "html",
            url: issued.url,
            expiresAt: issued.expires_at,
            lifetimeMs: issued.lifetime_ms,
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          setPreview({ kind: "error", message: error instanceof Error ? error.message : "HTML preview unavailable." });
        }
        return;
      }
      setPreview({ kind: "loading" });
      try {
        const response = await fetch(previewHref(runId, target), { signal: controller.signal });
        if (response.status === 404) {
          setPreview({ kind: "expired", message: "This file is no longer available." });
          return;
        }
        if (!response.ok) throw new Error(`Preview failed (${response.status}).`);
        const bytes = await response.arrayBuffer();
        if (selectedPreviewKind === "xlsx") {
          setPreview({ kind: "xlsx", bytes });
        } else if (["text", "markdown", "csv"].includes(selectedPreviewKind)) {
          setPreview({ kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
        } else {
          const safeContentType = selectedPreviewKind === "pdf"
            ? "application/pdf"
            : selectedPreviewContentType ?? "application/octet-stream";
          blobUrl = URL.createObjectURL(new Blob([bytes], { type: safeContentType }));
          setPreview({ kind: "blob", url: blobUrl });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setPreview({ kind: "error", message: error instanceof Error ? error.message : "Preview unavailable." });
      }
    };
    void load();
    return () => {
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [
    clock,
    open,
    retry,
    runId,
    selectedByteSize,
    selectedExpiresAt,
    selectedId,
    selectedPreviewContentType,
    selectedPreviewKind,
    selectedSource,
    selectedUpdatedAt,
  ]);

  useEffect(() => {
    if (preview.kind !== "html") return;
    if (
      !Number.isFinite(preview.lifetimeMs)
      || preview.lifetimeMs <= 0
      || preview.lifetimeMs > RUN_ARTIFACT_PREVIEW_TTL_MS
    ) {
      setPreview({ kind: "error", message: "Preview session expired. Retry to continue." });
      return;
    }
    const ticketUrl = preview.url;
    const timer = window.setTimeout(() => {
      setPreview((current) => current.kind === "html" && current.url === ticketUrl
        ? { kind: "error", message: "Preview session expired. Retry to continue." }
        : current);
    }, preview.lifetimeMs);
    return () => window.clearTimeout(timer);
  }, [preview]);

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
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary, iframe, [tabindex]:not([tabindex="-1"])')]
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
                {preview.kind === "loading" && <CanvasStatus icon="loader" spin message="Loading preview…" />}
                {preview.kind === "expired" && <CanvasStatus icon="clock" message={preview.message}><a className="btn-sec" href={previewHref(runId, selected, true)} download={selected.name}>Download</a></CanvasStatus>}
                {preview.kind === "unsupported" && <CanvasStatus icon="file" message={preview.message}><a className="btn-sec" href={previewHref(runId, selected, true)} download={selected.name}>Download</a></CanvasStatus>}
                {preview.kind === "too_large" && <CanvasStatus icon="file" message={preview.message}><a className="btn-sec" href={previewHref(runId, selected, true)} download={selected.name}>Download</a></CanvasStatus>}
                {preview.kind === "error" && <CanvasStatus icon="alert-triangle" message={preview.message}><div><button type="button" className="btn-sec" onClick={() => setRetry((value) => value + 1)}>Retry</button><a className="btn-sec" href={previewHref(runId, selected, true)} download={selected.name}>Download</a></div></CanvasStatus>}
                {preview.kind === "text" && selected.previewKind === "markdown" && <div className="run-canvas-document"><ChatMarkdown text={preview.text} /></div>}
                {preview.kind === "text" && selected.previewKind === "csv" && (() => { const csv = parseCsv(preview.text); return <DataTable rows={csv.rows} truncated={csv.truncated} />; })()}
                {preview.kind === "text" && selected.previewKind === "text" && <div className="run-canvas-code"><CodeView content={preview.text} lang={langForFile(selected.name)} gutter /></div>}
                {preview.kind === "xlsx" && <XlsxPreview bytes={preview.bytes} />}
                {preview.kind === "direct" && selected.previewKind === "image" && <div className="run-canvas-media"><img src={preview.url} alt={selected.name} /></div>}
                {preview.kind === "direct" && selected.previewKind === "video" && <div className="run-canvas-media"><video src={preview.url} controls preload="metadata" /></div>}
                {preview.kind === "blob" && selected.previewKind === "pdf" && <iframe className="run-canvas-pdf" src={preview.url} title={selected.name} sandbox="" />}
                {preview.kind === "html" && selected.previewKind === "html" && (
                  <iframe
                    className="run-canvas-html"
                    src={preview.url}
                    title={selected.name}
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    tabIndex={0}
                  />
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </aside>
  );
}
