"use client";

/* ───────────────────────────────────────────────────────────────
   markdown.tsx — Markdown renderer + code view for the Skill detail
   Files explorer. Class names mirror app.css
   (.codeview, .tk-*, .md, .md-*, .md-front, …) so styling applies.
   ─────────────────────────────────────────────────────────────── */

import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { collectHeadings, langForFile, tokenize, type FileLang } from "./fileFormat";

/**
 * Tokenized read-only code block. With `gutter`, prepend an aria-hidden line-number
 * column kept outside the horizontally-scrolling `<pre>` so it stays pinned; vertical
 * scroll is shared with the surrounding `.fv-body`.
 */
export function CodeView({
  content,
  lang,
  gutter = false,
}: {
  content: string;
  lang: FileLang;
  gutter?: boolean;
}) {
  const toks = tokenize(content, lang);
  const code = (
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
  if (!gutter) return code;
  const lineCount = content.split("\n").length;
  return (
    <div className="cv">
      <div className="cv-gutter" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      {code}
    </div>
  );
}

function langFromFence(className?: string): FileLang {
  const lang = /(?:^|\s)language-([A-Za-z0-9_-]+)/.exec(className ?? "")?.[1]?.toLowerCase();
  if (lang === "json") return "json";
  if (lang === "py" || lang === "python") return "py";
  return "text";
}

type MarkdownAstNode = {
  type?: string;
  children?: MarkdownAstNode[];
  data?: {
    hProperties?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

function visitMarkdownAst(node: MarkdownAstNode, visitor: (node: MarkdownAstNode) => void) {
  visitor(node);
  node.children?.forEach((child) => visitMarkdownAst(child, visitor));
}

function createHeadingIdPlugin(ids: string[]) {
  return function remarkHeadingIds() {
    return function addHeadingIds(tree: MarkdownAstNode) {
      let headingIdx = 0;
      visitMarkdownAst(tree, (node) => {
        if (node.type !== "heading") return;
        const id = ids[headingIdx++];
        if (!id) return;
        node.data = node.data ?? {};
        node.data.hProperties = { ...node.data.hProperties, id };
      });
    };
  };
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
  // Anchor ids for the on-this-page outline. `collectHeadings` walks the same
  // body passed to react-markdown, so consuming ids by occurrence index keeps the
  // rendered heading id identical to the outline entry.
  const headingIdPlugin = React.useMemo(
    () => createHeadingIdPlugin(collectHeadings(body).map((heading) => heading.id)),
    [body],
  );

  const makeHeading = (level: 1 | 2 | 3 | 4 | 5 | 6): Components["h1"] =>
    function Heading({ children, id }) {
      const Tag = ("h" + Math.min(level + 1, 6)) as keyof React.JSX.IntrinsicElements;
      return React.createElement(Tag, { id, className: "md-h md-h" + level }, children);
    };

  const components: Components = {
    h1: makeHeading(1),
    h2: makeHeading(2),
    h3: makeHeading(3),
    h4: makeHeading(4),
    h5: makeHeading(5),
    h6: makeHeading(6),
    p({ children }) {
      return <p className="md-p">{children}</p>;
    },
    ul({ children }) {
      return <ul className="md-ul">{children}</ul>;
    },
    ol({ children }) {
      return <ol className="md-ol">{children}</ol>;
    },
    blockquote({ children }) {
      return <blockquote className="md-quote">{children}</blockquote>;
    },
    hr() {
      return <hr className="md-hr" />;
    },
    a({ children, href }) {
      return (
        <a href={href} onClick={(e) => e.preventDefault()}>
          {children}
        </a>
      );
    },
    code({ children, className }) {
      const raw = String(children);
      const isBlock = Boolean(className) || raw.includes("\n");
      if (isBlock) {
        return <CodeView content={raw.replace(/\n$/, "")} lang={langFromFence(className)} />;
      }
      return <code>{children}</code>;
    },
    pre({ children }) {
      return <>{children}</>;
    },
    table({ children }) {
      return (
        <div className="md-tablewrap">
          <table className="md-table">{children}</table>
        </div>
      );
    },
    th({ children, style }) {
      return <th style={style}>{children}</th>;
    },
    td({ children, style }) {
      return <td style={style}>{children}</td>;
    },
  };

  return (
    <div className="md">
      {front && (
        <div className="md-front">
          <span className="md-front__tag">frontmatter</span>
          <CodeView content={front} lang="text" />
        </div>
      )}
      <ReactMarkdown remarkPlugins={[remarkGfm, headingIdPlugin]} components={components}>
        {body}
      </ReactMarkdown>
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
  return <CodeView content={content} lang={lang} gutter />;
}
