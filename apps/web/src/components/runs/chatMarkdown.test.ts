import { describe, expect, it } from "vitest";
import { parseChatBlocks, parseChatInline } from "./chatMarkdown";

describe("parseChatInline", () => {
  it("splits bold and code spans", () => {
    expect(parseChatInline("a **b** and `c` end")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "text", text: " and " },
      { kind: "code", text: "c" },
      { kind: "text", text: " end" },
    ]);
  });

  it("passes plain text through", () => {
    expect(parseChatInline("plain")).toEqual([{ kind: "text", text: "plain" }]);
  });
});

describe("parseChatBlocks", () => {
  it("splits paragraphs on blank lines", () => {
    const blocks = parseChatBlocks("first\n\nsecond");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.kind).toBe("paragraph");
  });

  it("recognizes bullet lists", () => {
    const blocks = parseChatBlocks("**Highlights**\n\n- one `x`\n- two");
    expect(blocks[1]?.kind).toBe("list");
    const list = blocks[1];
    if (list?.kind === "list") {
      expect(list.items).toHaveLength(2);
      expect(list.items[0]).toEqual([
        { kind: "text", text: "one " },
        { kind: "code", text: "x" },
      ]);
    }
  });

  it("a paragraph containing a dash line is not a list", () => {
    const blocks = parseChatBlocks("intro\n- not all lines are bullets");
    expect(blocks[0]?.kind).toBe("paragraph");
  });

  it("drops empty blocks (streaming edge)", () => {
    expect(parseChatBlocks("")).toEqual([]);
    expect(parseChatBlocks("a\n\n\n\nb")).toHaveLength(2);
  });
});
