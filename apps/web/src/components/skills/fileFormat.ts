/* ───────────────────────────────────────────────────────────────
   fileFormat.ts — pure file helpers + a light JSON/Python syntax
   highlighter for the Skill detail Files explorer. No React, no deps.
   Ported from the Claude-Design prototype (lib.jsx).
   ─────────────────────────────────────────────────────────────── */

/** A recognised display language for a package file. */
export type FileLang = "md" | "json" | "py" | "pdf" | "image" | "text";

/** Resolve a file's display language from its path/extension. */
export function langForFile(path: string): FileLang {
  const lower = path.toLowerCase();
  if (path.endsWith(".md")) return "md";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".py")) return "py";
  if (lower.endsWith(".pdf")) return "pdf";
  if (/\.(png|jpe?g|webp|gif|svg)$/.test(lower)) return "image";
  if (lower.endsWith(".gitignore")) return "text";
  return "text";
}

/** Pick the Icon name (data-lucide) for a file path. */
export function iconForFile(path: string): string {
  const l = langForFile(path);
  if (l === "md") return "file-text";
  if (l === "json") return "braces";
  if (l === "py") return "file-code";
  if (l === "pdf") return "file-text";
  if (l === "image") return "image";
  return "file";
}

/** Human label for each language. */
export const LANG_LABEL: Record<FileLang, string> = {
  md: "Markdown",
  json: "JSON",
  py: "Python",
  pdf: "PDF",
  image: "Image",
  text: "Text",
};

/** Format a byte count as `B` / `KB`. */
export function fmtBytes(n: number): string {
  if (n < 1024) return n + " B";
  return (n / 1024).toFixed(1) + " KB";
}

/** Byte size of a UTF-8 string. */
export function fileSize(content: string): string {
  return fmtBytes(new Blob([content]).size);
}

/** A heading extracted from a Markdown body for the on-this-page outline. */
export interface Heading {
  /** `#` count (1–6). */
  level: number;
  /** Display text with inline markers stripped. */
  text: string;
  /** Anchor id, GitHub-style slug, de-duplicated within the document. */
  id: string;
}

/** Drop inline Markdown markers (`code`, **bold**, [label](url)) for plain display/slug text. */
function stripInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

/** GitHub-style slug: lowercase, keep word chars/spaces/hyphens, spaces → `-`, collapse. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isFenceStart(line: string): boolean {
  return /^ {0,3}(`{3,}|~{3,})/.test(line);
}

function isThematicBreak(line: string): boolean {
  return /^ {0,3}(?:(?:- *){3,}|(?:_ *){3,}|(?:\* *){3,})$/.test(line);
}

function isSetextTextLine(line: string): boolean {
  if (!/\S/.test(line)) return false;
  if (/^ {4}/.test(line)) return false;
  if (isFenceStart(line)) return false;
  if (isThematicBreak(line)) return false;
  if (/^ {0,3}(?:#{1,6}(?:\s+|$)|>|\[[^\]]+\]:)/.test(line)) return false;
  if (/^ {0,3}(?:[*+-]\s+|\d{1,9}[.)]\s+)/.test(line)) return false;
  if (/^ {0,3}<\/?[A-Za-z][\w:-]*(?:\s|>|\/>)/.test(line)) return false;
  return true;
}

/**
 * Extract the heading outline from a Markdown body. Mirrors `MarkdownView`'s parse
 * closely enough that anchor ids line up by occurrence: strip leading frontmatter
 * with the same regex, walk lines fence-aware (headings inside ``` / ~~~ fences
 * are ignored), include ATX and setext headings, and de-duplicate slugs with a
 * `name`, `name-1`, `name-2`… counter.
 */
export function collectHeadings(content: string): Heading[] {
  let body = content;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (fm) body = content.slice(fm[0].length);
  const out: Heading[] = [];
  const counts = new Map<string, number>();
  let fence: { marker: "`" | "~"; length: number } | null = null;
  const lines = body.split("\n");
  const pushHeading = (level: number, rawText: string) => {
    const text = stripInline(rawText).trim();
    const base = slugify(text) || "section";
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.push({ level, text, id: n === 0 ? base : `${base}-${n}` });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        (fenceMatch[1]?.[0] as "`" | "~" | undefined) === fence.marker &&
        (fenceMatch[1]?.length ?? 0) >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]?.[0] as "`" | "~", length: fenceMatch[1]?.length ?? 3 };
      continue;
    }

    const atx = /^ {0,3}(#{1,6})(?:\s+|$)(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      pushHeading((atx[1] ?? "").length, atx[2] ?? "");
      continue;
    }

    if (isSetextTextLine(line)) {
      const paragraphLines = [line];
      let j = i + 1;
      while (j < lines.length) {
        const paragraphNext = lines[j] ?? "";
        const paragraphSetext = /^ {0,3}(=+|-+)\s*$/.exec(paragraphNext);
        if (paragraphSetext) {
          pushHeading((paragraphSetext[1]?.[0] ?? "-") === "=" ? 1 : 2, paragraphLines.join(" "));
          i = j;
          break;
        }
        if (!isSetextTextLine(paragraphNext)) {
          i = Math.max(i, j - 1);
          break;
        }
        paragraphLines.push(paragraphNext);
        j++;
      }
    }
  }
  return out;
}

/** A single highlighted token: `cls` is the CSS class, or `null` for plain text. */
export interface Token {
  text: string;
  cls: string | null;
}

/**
 * Light, low-chroma syntax highlighter. Returns a flat token stream for
 * `json` and `py`; everything else is returned as a single plain token.
 */
export function tokenize(code: string, lang: FileLang): Token[] {
  const out: Token[] = [];
  let last = 0;
  const push = (text: string, cls: string | null) => {
    if (text) out.push({ text, cls });
  };
  let re: RegExp;
  if (lang === "json") {
    re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],])/g;
  } else if (lang === "py") {
    re = /(#[^\n]*)|('''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|(@[A-Za-z_][\w.]*)|\b(def|class|return|import|from|as|if|elif|else|for|while|try|except|finally|with|in|not|and|or|is|None|True|False|lambda|yield|raise|pass|break|continue|global|nonlocal|assert|del|async|await)\b|\b(\d+(?:\.\d+)?)\b/g;
  } else {
    return [{ text: code, cls: null }];
  }
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    push(code.slice(last, m.index), null);
    last = re.lastIndex;
    if (lang === "json") {
      if (m[1] !== undefined) {
        push(m[1], m[2] ? "tk-key" : "tk-str");
        if (m[2]) push(m[2], "tk-punct");
      } else if (m[3] !== undefined) push(m[3], "tk-lit");
      else if (m[4] !== undefined) push(m[4], "tk-num");
      else if (m[5] !== undefined) push(m[5], "tk-punct");
    } else {
      if (m[1] !== undefined) push(m[1], "tk-com");
      else if (m[2] !== undefined) push(m[2], "tk-str");
      else if (m[3] !== undefined) push(m[3], "tk-dec");
      else if (m[4] !== undefined) push(m[4], "tk-kw");
      else if (m[5] !== undefined) push(m[5], "tk-num");
    }
  }
  push(code.slice(last), null);
  return out;
}
