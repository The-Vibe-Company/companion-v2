"use client";

/* Authenticated Blob previews intentionally bypass next/image optimization. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import type { RunFilePreviewKind } from "@companion/contracts";
import { Icon } from "../Icon";
import { langForFile } from "../skills/fileFormat";
import { CodeView } from "../skills/markdown";
import { ChatMarkdown } from "../runs/chatMarkdown";

export const TEXT_PREVIEW_LIMIT = 1024 * 1024;
export const XLSX_PREVIEW_LIMIT = 10 * 1024 * 1024;

export type FilePreviewState =
  | { kind: "idle" | "loading" }
  | { kind: "text"; text: string }
  | { kind: "blob"; url: string }
  | { kind: "direct"; url: string }
  | { kind: "xlsx"; bytes: ArrayBuffer }
  | { kind: "expired" | "unsupported" | "too_large"; message: string }
  | { kind: "error"; message: string };

/**
 * Stored content types keep their parameters (`text/markdown; charset=utf-8` — see
 * `detectRunFileType`), so every comparison has to drop them first. Matching the raw value against a
 * bare media-type list silently classifies every generated Markdown, CSV and text file as
 * non-previewable.
 */
export function normalizeContentType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
const TEXT_TYPES = new Set([
  "text/plain",
  "application/json",
  "application/yaml",
  "text/yaml",
]);
const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Mirrors the server-side `detectRunFileType` classification, which stores the content type but not
 * the preview kind for Project files.
 */
export function filePreviewKindFor(
  contentType: string | null | undefined,
  fileName?: string,
): RunFilePreviewKind | null {
  const type = normalizeContentType(contentType);
  if (IMAGE_TYPES.has(type)) return "image";
  if (VIDEO_TYPES.has(type)) return "video";
  if (type === "application/pdf") return "pdf";
  if (type === XLSX_TYPE) return "xlsx";
  if (type === "text/markdown") return "markdown";
  if (type === "text/csv") return "csv";
  if (TEXT_TYPES.has(type)) return "text";
  // Fall back to the extension only when the stored type carries no useful signal.
  if (type === "" || type === "application/octet-stream") {
    const extension = fileName?.slice(fileName.lastIndexOf(".")).toLowerCase();
    if (extension === ".md") return "markdown";
    if (extension === ".csv") return "csv";
    if ([".txt", ".json", ".yaml", ".yml"].includes(extension ?? "")) return "text";
  }
  return null;
}

export function parseCsv(text: string): { rows: string[][]; truncated: boolean } {
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

export function DataTable({ rows, truncated }: { rows: unknown[][]; truncated: boolean }) {
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

export function XlsxPreview({ bytes }: { bytes: ArrayBuffer }) {
  const workerRef = useRef<Worker | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const [sheet, setSheet] = useState<string | undefined>();
  const [result, setResult] = useState<{ sheets: string[]; sheet: string | null; rows: unknown[][]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const worker = new Worker(new URL("../runs/xlsxPreview.worker.ts", import.meta.url), { type: "module" });
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

export function CanvasStatus({ icon, message, spin = false, children }: { icon: string; message: string; spin?: boolean; children?: React.ReactNode }) {
  return (
    <div className="run-canvas-state" role="status">
      <Icon name={icon} size={22} className={spin ? "ls-spin" : undefined} />
      <span>{message}</span>
      {children}
    </div>
  );
}

/**
 * Loads one file into a renderable state. Text-shaped kinds are fetched and decoded so they can be
 * rendered by the product rather than by the browser's built-in viewers, which refuse `text/csv`
 * outright and cannot render Markdown at all.
 */
export function useFilePreview(input: {
  href: string | null;
  previewKind: RunFilePreviewKind | null;
  byteSize: number;
  /** Cache-busting suffix for direct media so a new version replaces the old one. */
  generation?: string | null;
  expiresAt?: string | null;
  enabled?: boolean;
  retryToken?: number;
  clock?: number;
}): FilePreviewState {
  const { href, previewKind, byteSize, generation, expiresAt, enabled = true, retryToken = 0, clock } = input;
  const [preview, setPreview] = useState<FilePreviewState>({ kind: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    let blobUrl: string | null = null;
    const load = async () => {
      if (!enabled || !href) {
        setPreview({ kind: "idle" });
        return;
      }
      if (expiresAt && Date.parse(expiresAt) <= (clock ?? Date.now())) {
        setPreview({ kind: "expired", message: "This generated file has expired." });
        return;
      }
      if (!previewKind) {
        setPreview({ kind: "unsupported", message: "Preview is not supported for this format." });
        return;
      }
      if (["text", "markdown", "csv"].includes(previewKind) && byteSize > TEXT_PREVIEW_LIMIT) {
        setPreview({ kind: "too_large", message: "This preview is larger than the 1 MB display limit." });
        return;
      }
      if (previewKind === "xlsx" && byteSize > XLSX_PREVIEW_LIMIT) {
        setPreview({ kind: "too_large", message: "This workbook is larger than the 10 MB display limit." });
        return;
      }
      if (previewKind === "image" || previewKind === "video") {
        setPreview({
          kind: "direct",
          url: generation ? `${href}${href.includes("?") ? "&" : "?"}v=${encodeURIComponent(generation)}` : href,
        });
        return;
      }
      setPreview({ kind: "loading" });
      try {
        const response = await fetch(href, { signal: controller.signal });
        if (response.status === 404) {
          setPreview({ kind: "expired", message: "This file is no longer available." });
          return;
        }
        if (!response.ok) throw new Error(`Preview failed (${response.status}).`);
        const bytes = await response.arrayBuffer();
        // Selecting another file mid-flight must not render the previous one underneath it, nor
        // strand the object URL this effect would no longer revoke.
        if (controller.signal.aborted) return;
        if (previewKind === "xlsx") {
          setPreview({ kind: "xlsx", bytes });
        } else if (["text", "markdown", "csv"].includes(previewKind)) {
          setPreview({ kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
        } else {
          // A Blob typed `application/pdf` is never sniffed back into markup, and the viewer only
          // runs outside a sandboxed frame, so this stays both safe and renderable.
          blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
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
  }, [byteSize, clock, enabled, expiresAt, generation, href, previewKind, retryToken]);

  return preview;
}

/** Renders one loaded preview state. Callers own the surrounding chrome. */
export function FilePreviewBody({
  state,
  previewKind,
  name,
  downloadHref,
  onRetry,
}: {
  state: FilePreviewState;
  previewKind: RunFilePreviewKind | null;
  name: string;
  downloadHref: string;
  onRetry?: () => void;
}) {
  const download = (
    <a className="btn-sec" href={downloadHref} download={name}>
      Download
    </a>
  );
  switch (state.kind) {
    case "idle":
      return null;
    case "loading":
      return <CanvasStatus icon="loader" spin message="Loading preview…" />;
    case "expired":
      return <CanvasStatus icon="clock" message={state.message}>{download}</CanvasStatus>;
    case "unsupported":
      return <CanvasStatus icon="file" message={state.message}>{download}</CanvasStatus>;
    case "too_large":
      return <CanvasStatus icon="file" message={state.message}>{download}</CanvasStatus>;
    case "error":
      return (
        <CanvasStatus icon="alert-triangle" message={state.message}>
          <div>
            {onRetry && (
              <button type="button" className="btn-sec" onClick={onRetry}>
                Retry
              </button>
            )}
            {download}
          </div>
        </CanvasStatus>
      );
    case "text":
      if (previewKind === "markdown") {
        return <div className="run-canvas-document"><ChatMarkdown text={state.text} /></div>;
      }
      if (previewKind === "csv") {
        const csv = parseCsv(state.text);
        return <DataTable rows={csv.rows} truncated={csv.truncated} />;
      }
      return <div className="run-canvas-code"><CodeView content={state.text} lang={langForFile(name)} gutter /></div>;
    case "xlsx":
      return <XlsxPreview bytes={state.bytes} />;
    case "direct":
      if (previewKind === "image") {
        return <div className="run-canvas-media"><img src={state.url} alt={name} /></div>;
      }
      return <div className="run-canvas-media"><video src={state.url} controls preload="metadata" /></div>;
    case "blob":
      // No sandbox attribute: any value at all disables the browser's PDF viewer.
      return <iframe className="run-canvas-pdf" src={state.url} title={name} />;
  }
}
