/* ───────────────────────────────────────────────────────────────
   fileFormat.ts — pure file helpers + a light JSON/Python syntax
   highlighter for the Skill detail Files explorer. No React, no deps.
   Ported from the Claude-Design prototype (lib.jsx).
   ─────────────────────────────────────────────────────────────── */

/** A recognised display language for a package file. */
export type FileLang = "md" | "json" | "py" | "text";

/** Resolve a file's display language from its path/extension. */
export function langForFile(path: string): FileLang {
  if (path.endsWith(".md")) return "md";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".py")) return "py";
  if (path.endsWith(".gitignore")) return "text";
  return "text";
}

/** Pick the Icon name (data-lucide) for a file path. */
export function iconForFile(path: string): string {
  const l = langForFile(path);
  if (l === "md") return "file-text";
  if (l === "json") return "braces";
  if (l === "py") return "file-code";
  return "file";
}

/** Human label for each language. */
export const LANG_LABEL: Record<FileLang, string> = {
  md: "Markdown",
  json: "JSON",
  py: "Python",
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
