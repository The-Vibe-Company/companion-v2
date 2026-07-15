import type { ReactNode } from "react";

/**
 * Markdown-lite for streamed chat replies (paragraphs, `- ` bullet lists, **bold**, `code`) — a
 * direct port of the design prototype's renderer. The full react-markdown pipeline used for SKILL.md
 * files is the wrong shape here: chat needs cheap re-renders on every streamed delta and only this
 * tiny grammar. Parsing is pure (node-testable); rendering maps blocks to elements.
 */

export type ChatInlinePart =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string };

export type ChatBlock =
  | { kind: "paragraph"; parts: ChatInlinePart[] }
  | { kind: "list"; items: ChatInlinePart[][] };

export function parseChatInline(text: string): ChatInlinePart[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  const out: ChatInlinePart[] = [];
  for (const part of parts) {
    if (part === "") continue;
    if (/^\*\*[^*]+\*\*$/.test(part)) out.push({ kind: "bold", text: part.slice(2, -2) });
    else if (/^`[^`]+`$/.test(part)) out.push({ kind: "code", text: part.slice(1, -1) });
    else out.push({ kind: "text", text: part });
  }
  return out;
}

export function parseChatBlocks(text: string): ChatBlock[] {
  const blocks = String(text)
    .split(/\n\n+/)
    .filter((block) => block.trim() !== "");
  return blocks.map((block) => {
    const lines = block.split("\n");
    const isList = lines.length > 0 && lines.every((line) => line.trim() === "" || line.startsWith("- "));
    if (isList) {
      return {
        kind: "list",
        items: lines.filter((line) => line.trim() !== "").map((line) => parseChatInline(line.slice(2))),
      };
    }
    return { kind: "paragraph", parts: parseChatInline(block) };
  });
}

function renderInline(parts: ChatInlinePart[], keyBase: string): ReactNode[] {
  return parts.map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.kind === "bold") {
      return (
        <strong key={key} style={{ fontWeight: 600 }}>
          {part.text}
        </strong>
      );
    }
    if (part.kind === "code") {
      return (
        <code
          key={key}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.92em",
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-line)",
            borderRadius: 4,
            padding: "0 4px",
          }}
        >
          {part.text}
        </code>
      );
    }
    return part.text;
  });
}

export function ChatMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = parseChatBlocks(text);
  return (
    <>
      {blocks.map((block, bi) =>
        block.kind === "list" ? (
          <ul key={`b${bi}`} style={{ margin: "6px 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            {block.items.map((item, li) => (
              <li key={li} style={{ color: "var(--color-muted)" }}>
                {renderInline(item, `${bi}-${li}`)}
              </li>
            ))}
          </ul>
        ) : (
          <p key={`b${bi}`} style={{ margin: bi === 0 ? 0 : "10px 0 0" }}>
            {renderInline(block.parts, `p${bi}`)}
          </p>
        ),
      )}
      {streaming ? <span className="chat-caret" aria-hidden="true" /> : null}
    </>
  );
}
