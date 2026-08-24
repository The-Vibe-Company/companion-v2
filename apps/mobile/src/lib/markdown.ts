/**
 * A deliberately small Markdown reader for the chat transcript, mirroring what the web thread
 * renders: headings, lists, quotes, fenced code, and the inline set (bold, italic, code, links).
 * It is pure so the shapes can be unit-tested without React Native, and it degrades to plain text:
 * anything it does not recognize stays visible as the characters Pi wrote.
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: InlineNode[] }
  | { kind: "italic"; children: InlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "link"; label: string; href: string };

export type BlockNode =
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "heading"; level: number; children: InlineNode[] }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] }
  | { kind: "quote"; children: InlineNode[] }
  | { kind: "code"; language: string | null; text: string }
  | { kind: "rule" };

/** Only links a system browser should ever be handed. Anything else renders as its literal text. */
const SAFE_LINK = /^https?:\/\//i;

const INLINE_TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/;

/** Adjacent literal runs merge so a refused token reads as one uninterrupted string. */
function mergedText(nodes: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const node of nodes) {
    const previous = merged.at(-1);
    if (node.kind === "text" && previous?.kind === "text") previous.text += node.text;
    else merged.push(node);
  }
  return merged;
}

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let rest = text;
  while (rest.length > 0) {
    const match = INLINE_TOKEN.exec(rest);
    if (!match || match.index === undefined) {
      nodes.push({ kind: "text", text: rest });
      break;
    }
    if (match.index > 0) nodes.push({ kind: "text", text: rest.slice(0, match.index) });
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      nodes.push({ kind: "bold", children: parseInline(token.slice(2, -2)) });
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push({ kind: "italic", children: parseInline(token.slice(1, -1)) });
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link && SAFE_LINK.test(link[2]!)) {
        nodes.push({ kind: "link", label: link[1]!, href: link[2]! });
      } else {
        nodes.push({ kind: "text", text: token });
      }
    }
    rest = rest.slice(match.index + token.length);
  }
  return mergedText(nodes);
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED_ITEM = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;

function flushParagraph(lines: string[], blocks: BlockNode[]): void {
  if (lines.length === 0) return;
  blocks.push({ kind: "paragraph", children: parseInline(lines.join("\n")) });
  lines.length = 0;
}

function parseLines(text: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  const paragraph: string[] = [];
  let list: { ordered: boolean; items: InlineNode[][] } | null = null;
  const closeList = () => {
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      flushParagraph(paragraph, blocks);
      closeList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph(paragraph, blocks);
      closeList();
      blocks.push({ kind: "heading", level: heading[1]!.length, children: parseInline(heading[2]!) });
      continue;
    }
    if (RULE.test(line)) {
      flushParagraph(paragraph, blocks);
      closeList();
      blocks.push({ kind: "rule" });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph(paragraph, blocks);
      closeList();
      const previous = blocks.at(-1);
      if (previous?.kind === "quote") {
        previous.children.push({ kind: "text", text: "\n" }, ...parseInline(quote[1]!));
      } else {
        blocks.push({ kind: "quote", children: parseInline(quote[1]!) });
      }
      continue;
    }
    const item = UNORDERED_ITEM.exec(line) ?? ORDERED_ITEM.exec(line);
    if (item) {
      flushParagraph(paragraph, blocks);
      const ordered = UNORDERED_ITEM.exec(line) === null;
      if (!list || list.ordered !== ordered) {
        closeList();
        list = { ordered, items: [] };
      }
      list.items.push(parseInline(item[1]!));
      continue;
    }
    // An indented continuation belongs to the open list item rather than starting a paragraph.
    if (list && /^\s{2,}\S/.test(line)) {
      list.items.at(-1)?.push({ kind: "text", text: "\n" }, ...parseInline(line.trim()));
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  flushParagraph(paragraph, blocks);
  closeList();
  return blocks;
}

export function parseMarkdown(content: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  const segments = content.split(/^```/m);
  for (const [index, segment] of segments.entries()) {
    if (index % 2 === 1) {
      // Inside a fence. The first line is the info string; an unterminated fence still renders.
      const newline = segment.indexOf("\n");
      const language = (newline === -1 ? segment : segment.slice(0, newline)).trim();
      const body = newline === -1 ? "" : segment.slice(newline + 1).replace(/\n$/, "");
      blocks.push({ kind: "code", language: language || null, text: body });
    } else if (segment.trim() !== "") {
      blocks.push(...parseLines(segment));
    }
  }
  return blocks;
}
