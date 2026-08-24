import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown } from "./markdown";

describe("parseInline", () => {
  it("reads bold, italic, and inline code", () => {
    expect(parseInline("still **zero plugins attached** here")).toEqual([
      { kind: "text", text: "still " },
      { kind: "bold", children: [{ kind: "text", text: "zero plugins attached" }] },
      { kind: "text", text: " here" },
    ]);
    expect(parseInline("an *emphasis* and _another_ and `code`")).toEqual([
      { kind: "text", text: "an " },
      { kind: "italic", children: [{ kind: "text", text: "emphasis" }] },
      { kind: "text", text: " and " },
      { kind: "italic", children: [{ kind: "text", text: "another" }] },
      { kind: "text", text: " and " },
      { kind: "code", text: "code" },
    ]);
  });

  it("nests inline styles inside bold", () => {
    expect(parseInline("**bold `code`**")).toEqual([
      {
        kind: "bold",
        children: [
          { kind: "text", text: "bold " },
          { kind: "code", text: "code" },
        ],
      },
    ]);
  });

  it("keeps only http(s) links and leaves the rest literal", () => {
    expect(parseInline("[docs](https://example.com/a)")).toEqual([
      { kind: "link", label: "docs", href: "https://example.com/a" },
    ]);
    expect(parseInline("[bad](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[bad](javascript:alert(1))" },
    ]);
  });

  it("returns unmatched markers as plain text", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
  });
});

describe("parseMarkdown", () => {
  it("groups paragraphs and keeps their line breaks", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "one\ntwo" }] },
      { kind: "paragraph", children: [{ kind: "text", text: "three" }] },
    ]);
  });

  it("reads headings, rules, and quotes", () => {
    const blocks = parseMarkdown("## Title\n\n---\n\n> a quote\n> continues");
    expect(blocks[0]).toEqual({
      kind: "heading",
      level: 2,
      children: [{ kind: "text", text: "Title" }],
    });
    expect(blocks[1]).toEqual({ kind: "rule" });
    expect(blocks[2]).toMatchObject({ kind: "quote" });
  });

  it("collects list items of one kind into one list", () => {
    expect(parseMarkdown("- first\n- **second**\n\n1. one\n2. two")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [{ kind: "text", text: "first" }],
          [{ kind: "bold", children: [{ kind: "text", text: "second" }] }],
        ],
      },
      {
        kind: "list",
        ordered: true,
        items: [
          [{ kind: "text", text: "one" }],
          [{ kind: "text", text: "two" }],
        ],
      },
    ]);
  });

  it("keeps fenced code verbatim with its language", () => {
    expect(parseMarkdown("intro\n\n```ts\nconst a = 1;\n```\n\nafter")).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "intro" }] },
      { kind: "code", language: "ts", text: "const a = 1;" },
      { kind: "paragraph", children: [{ kind: "text", text: "after" }] },
    ]);
  });

  it("renders an unterminated fence rather than dropping it", () => {
    expect(parseMarkdown("```\nstill open")).toEqual([
      { kind: "code", language: null, text: "still open" },
    ]);
  });
});
