import { describe, expect, it } from "vitest";

import { plainTextNotificationBody } from "./notificationText";

describe("notification Markdown previews", () => {
  it.each([
    {
      name: "headings and emphasis",
      markdown: "# Release **ready**\n\nUse _safe_ mode with ~~no~~ downtime.",
      plain: "Release ready Use safe mode with no downtime.",
    },
    {
      name: "links and images",
      markdown: "Read the [deployment guide](https://example.com/guide) and view ![the chart](chart.png).",
      plain: "Read the deployment guide and view the chart.",
    },
    {
      name: "lists",
      markdown: "- First\n  - **Nested** item\n1. Ordered\n- [x] Shipped\n- [ ] Verify",
      plain: "• First • Nested item 1. Ordered • ✓ Shipped • ○ Verify",
    },
    {
      name: "nested block markup",
      markdown: "> ## Result\n> Use **[the `safe` path](https://example.com)**.",
      plain: "Result Use the safe path.",
    },
    {
      name: "autolinks and escaped punctuation",
      markdown: "Open <https://example.com> or use \\*literal\\* text.",
      plain: "Open https://example.com or use literal text.",
    },
  ])("converts $name to readable text", ({ markdown, plain }) => {
    expect(plainTextNotificationBody(markdown)).toBe(plain);
  });

  it("keeps fenced code content but removes its Markdown delimiters and language", () => {
    const markdown = [
      "Before",
      "```ts",
      "const result = `ready`;",
      "```",
      "After",
    ].join("\n");
    expect(plainTextNotificationBody(markdown)).toBe("Before const result = ready; After");
    expect(plainTextNotificationBody("```ts const result = `ready`; ```")).toBe(
      "const result = ready;",
    );
  });

  it("cleans incomplete Markdown left by an upstream preview cap", () => {
    const plain = plainTextNotificationBody("**Ready** — see [the runbook](https://example.com/run");
    expect(plain).toBe("Ready — see the runbook");
    expect(plain).not.toMatch(/\*\*|`|\[|\]/);
  });

  it("normalizes block markers after persistence has flattened line breaks", () => {
    const markdown = "- First - **Nested** item 1. Ordered - [x] Shipped > quoted";
    expect(plainTextNotificationBody(markdown))
      .toBe("• First • Nested item 1. Ordered • ✓ Shipped quoted");
  });

  it("drops the info token from a fenced block capped before its closing fence", () => {
    const persistedBody = `\`\`\`typescript ${"const value = 1; ".repeat(20)}`.slice(0, 180);
    const plain = plainTextNotificationBody(persistedBody);
    expect(plain).toMatch(/^const value = 1;/);
    expect(plain).not.toContain("typescript");
    expect(plain).not.toContain("`");
  });

  it("removes code fences before applying the 180-character limit", () => {
    const plain = plainTextNotificationBody(`\`\`\`text\n${"word ".repeat(80)}\n\`\`\``);
    expect(Array.from(plain)).toHaveLength(180);
    expect(plain.endsWith("…")).toBe(true);
    expect(plain).not.toContain("`");
  });

  it("uses a readable fallback when Markdown contains no text", () => {
    expect(plainTextNotificationBody("```\n```"))
      .toBe("Open the conversation for details.");
  });
});
