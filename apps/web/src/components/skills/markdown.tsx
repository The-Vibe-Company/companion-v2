"use client";

/* ───────────────────────────────────────────────────────────────
   markdown.tsx — dependency-free block Markdown renderer + code view
   for the Skill detail Files explorer. Class names mirror app.css
   (.codeview, .tk-*, .md, .md-*, .md-front, …) so styling applies.
   Ported from the Claude-Design prototype (lib.jsx).
   ─────────────────────────────────────────────────────────────── */

import React, { type ReactNode } from "react";
import { langForFile, tokenize, type FileLang } from "./fileFormat";

/** Tokenized read-only code block. */
export function CodeView({ content, lang }: { content: string; lang: FileLang }) {
  const toks = tokenize(content, lang);
  return (
    <pre className="codeview">
      <code>
        {toks.map((t, i) =>
          t.cls ? (
            <span key={i} className={t.cls}>
              {t.text}
            </span>
          ) : (
            <span key={i}>{t.text}</span>
          ),
        )}
      </code>
    </pre>
  );
}

/* ---- Inline markdown (code, bold, links) ------------------------- */
function inlineMd(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push(<code key={keyBase + "-" + i}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**"))
      nodes.push(<strong key={keyBase + "-" + i}>{tok.slice(2, -2)}</strong>);
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      if (mm) {
        nodes.push(
          <a key={keyBase + "-" + i} href={mm[2]} onClick={(e) => e.preventDefault()}>
            {mm[1]}
          </a>,
        );
      }
    }
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* ---- Block markdown renderer ------------------------------------- */
export function MarkdownView({ content }: { content: string }) {
  // Strip + capture leading YAML frontmatter.
  let body = content;
  let front: string | null = null;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (fm) {
    front = fm[1] ?? "";
    body = content.slice(fm[0].length);
  }
  const lines = body.split("\n");
  // `i < lines.length` always guards these reads; `?? ""` only satisfies the
  // noUncheckedIndexedAccess compiler check (the value is never actually undefined).
  const at = (n: number): string => lines[n] ?? "";
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = at(i);
    // code fence
    if (/^```/.test(line)) {
      const fenceLang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(at(i))) {
        buf.push(at(i));
        i++;
      }
      i++; // skip closing fence
      const lang: FileLang =
        fenceLang === "json"
          ? "json"
          : fenceLang === "py" || fenceLang === "python"
            ? "py"
            : "text";
      blocks.push(<CodeView key={key++} content={buf.join("\n")} lang={lang} />);
      continue;
    }
    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = (h[1] ?? "").length;
      const Tag = ("h" + Math.min(lvl + 1, 6)) as keyof React.JSX.IntrinsicElements;
      blocks.push(
        React.createElement(
          Tag,
          { key: key++, className: "md-h md-h" + lvl },
          inlineMd(h[2] ?? "", "h" + key),
        ),
      );
      i++;
      continue;
    }
    // hr
    if (/^---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }
    // blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(at(i))) {
        buf.push(at(i).replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {inlineMd(buf.join(" "), "q" + key)}
        </blockquote>,
      );
      continue;
    }
    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(at(i))) {
        items.push(at(i).replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="md-ul">
          {items.map((it, j) => (
            <li key={j}>{inlineMd(it, "ul" + key + "-" + j)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(at(i))) {
        items.push(at(i).replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="md-ol">
          {items.map((it, j) => (
            <li key={j}>{inlineMd(it, "ol" + key + "-" + j)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    // blank
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    // paragraph (gather until blank / block start)
    const buf: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(at(i)) &&
      !/^#{1,6}\s/.test(at(i)) &&
      !/^```/.test(at(i)) &&
      !/^\s*[-*]\s+/.test(at(i)) &&
      !/^\s*\d+\.\s+/.test(at(i)) &&
      !/^>\s?/.test(at(i)) &&
      !/^---+\s*$/.test(at(i))
    ) {
      buf.push(at(i));
      i++;
    }
    blocks.push(
      <p key={key++} className="md-p">
        {inlineMd(buf.join(" "), "p" + key)}
      </p>,
    );
  }
  return (
    <div className="md">
      {front && (
        <div className="md-front">
          <span className="md-front__tag">frontmatter</span>
          <CodeView content={front} lang="text" />
        </div>
      )}
      {blocks}
    </div>
  );
}

/** Mode for the SKILL.md Preview/Raw toggle. */
export type FileViewMode = "preview" | "raw";

/* ---- Generic file viewer (picks renderer by lang) ---------------- */
export function FileContent({
  path,
  content,
  mode,
}: {
  path: string;
  content: string;
  mode?: FileViewMode;
}) {
  const lang = langForFile(path);
  if (lang === "md" && mode !== "raw") return <MarkdownView content={content} />;
  return <CodeView content={content} lang={lang} />;
}
