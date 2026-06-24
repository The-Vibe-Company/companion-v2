"use client";

/* ───────────────────────────────────────────────────────────────
   fileview.tsx — split-pane file explorer for the Skill detail Files
   tab. A collapsible client-built tree on the left, a reading pane on
   the right. SKILL.md renders as formatted Markdown (Preview/Raw),
   JSON & Python are syntax-highlighted; binaries / over-cap files show
   a calm empty state. Class names mirror app.css (.fx, .fx-tree,
   .fxt-folder, .fxt-file, .fx-pane, .fv-*, .fx-empty).
   Ported from the Claude-Design prototype (app.jsx, "Explorer A").
   ─────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { SkillFile } from "@companion/contracts";
import { Icon } from "../Icon";
import { FileContent, type FileViewMode } from "./markdown";
import { collectHeadings, fileSize, iconForFile, langForFile, LANG_LABEL } from "./fileFormat";

const base = (p: string): string => p.split("/").pop() ?? p;

/* ---- Client-side tree (derived from the flat file list) ----------------- */

/** A single file leaf in the derived tree. */
interface FileNode {
  type: "file";
  path: string;
  file: SkillFile;
}
/** A top-level folder grouping its files (single level — no nesting). */
interface FolderNode {
  type: "folder";
  name: string;
  files: FileNode[];
}
type TreeNode = FileNode | FolderNode;

/**
 * Group a flat file list into a single-level tree: files with no `/` stay at
 * the top level; everything else is bucketed under its first path segment.
 * Path order is preserved (the endpoint already sorts by path asc).
 */
function buildTree(files: SkillFile[]): TreeNode[] {
  const nodes: TreeNode[] = [];
  const folders = new Map<string, FolderNode>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    if (slash === -1) {
      nodes.push({ type: "file", path: file.path, file });
      continue;
    }
    const name = file.path.slice(0, slash);
    let folder = folders.get(name);
    if (!folder) {
      folder = { type: "folder", name, files: [] };
      folders.set(name, folder);
      nodes.push(folder);
    }
    folder.files.push({ type: "file", path: file.path, file });
  }
  return nodes;
}

/* ---- File viewer (reading pane) ----------------------------------------- */
export function FileViewer({ file, onBack }: { file: SkillFile; onBack?: () => void }) {
  const path = file.path;
  const lang = langForFile(path);
  const isMd = lang === "md";
  const [mode, setMode] = useState<FileViewMode>("preview");
  const [copied, setCopied] = useState(false);
  useEffect(() => setMode("preview"), [path]);

  const content = file.content;
  const viewable = !file.binary && content !== null;

  const copy = () => {
    if (content === null) return;
    navigator.clipboard
      ?.writeText(content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  const parts = path.split("/");
  const leaf = parts[parts.length - 1] ?? path;
  const preview = isMd && mode === "preview";

  // On-this-page outline (Markdown Preview only). Ids match MarkdownView's headings.
  const headings = useMemo(
    () => (preview && content !== null ? collectHeadings(content) : []),
    [preview, content],
  );
  const hasOutline = headings.length >= 2;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  // After a click we scroll to a heading; suppress scroll-spy briefly so the clicked
  // entry stays highlighted even when it can't reach the very top (last sections).
  const lockRef = useRef(false);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (lockTimer.current) clearTimeout(lockTimer.current);
  }, []);

  // Seed / reset the active entry whenever the file or view mode changes.
  useEffect(() => {
    setActive(headings[0]?.id ?? null);
  }, [path, mode, headings]);

  // Scroll-spy: mark the heading nearest the top of the reading pane as active.
  useEffect(() => {
    if (!hasOutline) return;
    const root = bodyRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>(".md-h")).filter((el) => el.id);
    if (els.length === 0) return;
    let fired = false;
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        fired = true;
        for (const e of entries) {
          const id = (e.target as HTMLElement).id;
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        if (lockRef.current) return;
        const first = els.find((el) => visible.has(el.id));
        if (first) setActive(first.id);
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    // Fail open: if the observer never fires (some embedded contexts), keep the first.
    const fallback = setTimeout(() => {
      if (!fired) setActive(els[0]?.id ?? null);
    }, 500);
    return () => {
      clearTimeout(fallback);
      io.disconnect();
    };
  }, [hasOutline, path, mode, content]);

  const scrollToHeading = (id: string) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    setActive(id);
    lockRef.current = true;
    if (lockTimer.current) clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(() => {
      lockRef.current = false;
    }, 700);
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  return (
    <>
      <div className="fv-head">
        {onBack && (
          <button className="fv-back" onClick={onBack}>
            <Icon name="arrow-left" size={14} />
            Files
          </button>
        )}
        <span className="fv-path">
          <Icon name={iconForFile(path)} size={14} />
          {parts.slice(0, -1).map((p, i) => (
            <span key={i}>
              <span className="seg">{p}</span>
              <span className="seg">/</span>
            </span>
          ))}
          <span className="leaf">{leaf}</span>
        </span>
        <span className="fv-spacer" />
        <span className="fv-lang">{LANG_LABEL[lang]}</span>
        <span className="fv-size">{fmtSize(file)}</span>
        {viewable && isMd && (
          <span className="fv-seg">
            <button className={mode === "preview" ? "is-on" : ""} onClick={() => setMode("preview")}>
              <Icon name="eye" size={13} />
              Preview
            </button>
            <button className={mode === "raw" ? "is-on" : ""} onClick={() => setMode("raw")}>
              <Icon name="code" size={13} />
              Raw
            </button>
          </span>
        )}
        {viewable && (
          <button
            className={"fv-copy" + (copied ? " done" : "")}
            onClick={copy}
            title="Copy file contents"
          >
            <Icon name={copied ? "check" : "copy"} size={14} />
          </button>
        )}
      </div>
      {viewable ? (
        <div
          ref={bodyRef}
          className={
            "fv-body " +
            (preview ? "fv-body--md" : "fv-body--code") +
            (hasOutline ? " has-outline" : "")
          }
        >
          <div className="fv-main">
            {file.truncated && (
              <p
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  margin: 0,
                  padding: "8px 16px",
                  fontSize: "var(--text-xs)",
                  color: "var(--color-muted)",
                  borderBottom: "1px solid var(--color-line)",
                  background: "var(--color-surface)",
                }}
              >
                <Icon name="info" size={12} />
                Preview truncated — download the package to read the full file.
              </p>
            )}
            <FileContent path={path} content={content} mode={mode} />
          </div>
          {hasOutline && (
            <nav className="fv-outline" aria-label="On this page">
              {headings.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="fv-outitem"
                  data-level={h.level}
                  aria-current={active === h.id ? "true" : undefined}
                  onClick={() => scrollToHeading(h.id)}
                >
                  {h.text}
                </button>
              ))}
            </nav>
          )}
        </div>
      ) : (
        <div className="fv-body">
          <div className="fx-empty">
            <Icon name="file" size={28} />
            <span className="fx-empty__t">Binary file — download the package to view.</span>
          </div>
        </div>
      )}
    </>
  );
}

/** Size label: prefer the server-reported byte count over re-measuring text. */
function fmtSize(file: SkillFile): string {
  if (file.content !== null && !file.binary && !file.truncated) return fileSize(file.content);
  // Binary / truncated: fall back to the declared size.
  if (file.size < 1024) return file.size + " B";
  return (file.size / 1024).toFixed(1) + " KB";
}

/* ---- Tree controls ------------------------------------------------------ */
function TreeFile({
  node,
  sel,
  onSel,
  nested,
}: {
  node: FileNode;
  sel: string | null;
  onSel: (path: string) => void;
  nested?: boolean;
}) {
  const style: CSSProperties | undefined = nested ? { paddingLeft: 26 } : undefined;
  return (
    <button
      className={"fxt-file" + (sel === node.path ? " is-sel" : "")}
      style={style}
      onClick={() => onSel(node.path)}
    >
      <span className="fi">
        <Icon name={iconForFile(node.path)} size={14} />
      </span>
      <span className="nm">{base(node.path)}</span>
      <span className="sz">{fmtSize(node.file)}</span>
    </button>
  );
}

function TreeFolder({
  node,
  sel,
  onSel,
}: {
  node: FolderNode;
  sel: string | null;
  onSel: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button className="fxt-folder" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={"chev" + (open ? " open" : "")}>
          <Icon name="chevron-right" size={13} />
        </span>
        <span className="fi">
          <Icon name={open ? "folder-open" : "folder"} size={14} />
        </span>
        {node.name}
      </button>
      {open && (
        <div className="fxt-kids">
          {node.files.map((f) => (
            <TreeFile key={f.path} node={f} sel={sel} onSel={onSel} nested />
          ))}
        </div>
      )}
    </>
  );
}

/* ---- Split-pane explorer ------------------------------------------------ */
export function FileExplorer({
  files,
  requestedPath,
  panelMode = false,
}: {
  files: SkillFile[];
  requestedPath?: string | null;
  panelMode?: boolean;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const byPath = useMemo(() => {
    const m = new Map<string, SkillFile>();
    for (const f of files) m.set(f.path, f);
    return m;
  }, [files]);

  // Default selection: SKILL.md if present, else the first file.
  const initial = useMemo(() => {
    if (files.some((f) => f.path === "SKILL.md")) return "SKILL.md";
    return files[0]?.path ?? null;
  }, [files]);

  const [sel, setSel] = useState<string | null>(initial);

  // Re-anchor when the underlying file set changes (e.g. version switch).
  useEffect(() => {
    setSel((cur) => (cur && byPath.has(cur) ? cur : initial));
  }, [initial, byPath]);

  // Open the requested file when the Package-contents grid points here.
  useEffect(() => {
    if (requestedPath && byPath.has(requestedPath)) setSel(requestedPath);
  }, [requestedPath, byPath]);

  const selected = sel ? (byPath.get(sel) ?? null) : null;

  if (files.length === 0) {
    return (
      <div className={"fx" + (panelMode ? " fx--panel" : "")}>
        <div className="fx-pane">
          <div className="fv-body">
            <div className="fx-empty">
              <Icon name="package-open" size={28} />
              <span className="fx-empty__t">No files in this package.</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={"fx" + (panelMode ? " fx--panel" : "")}>
      <div className="fx-tree">
        <div className="fx-treehead">
          <Icon name="package-open" size={13} />
          Files
        </div>
        {tree.map((node) =>
          node.type === "file" ? (
            <TreeFile key={node.path} node={node} sel={sel} onSel={setSel} />
          ) : (
            <TreeFolder key={node.name} node={node} sel={sel} onSel={setSel} />
          ),
        )}
      </div>
      <div className="fx-pane">
        {selected ? (
          <FileViewer file={selected} />
        ) : (
          <div className="fv-body">
            <div className="fx-empty">
              <Icon name="file" size={28} />
              <span className="fx-empty__t">Select a file to read it.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
