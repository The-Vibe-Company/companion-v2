import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileContent, MarkdownView } from "./markdown";

describe("MarkdownView", () => {
  it("renders GFM tables with alignment and inline markdown", () => {
    const html = renderToString(
      React.createElement(MarkdownView, {
        content: [
          "| Name | Count | Notes |",
          "| :--- | ---: | :---: |",
          "| **Alpha** | `12` | [docs](https://example.com) |",
          "| Pipe | 3 | `a-b` and escaped \\| pipe |",
        ].join("\n"),
      }),
    );

    expect(html).toContain('<div class="md-tablewrap"><table class="md-table">');
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<strong>Alpha</strong>");
    expect(html).toContain("<code>12</code>");
    expect(html).toContain('<a href="https://example.com">docs</a>');
    expect(html).toContain("<code>a-b</code> and escaped | pipe");
    expect(html).toContain("text-align:left");
    expect(html).toContain("text-align:right");
    expect(html).toContain("text-align:center");
  });

  it("does not render raw HTML from uploaded markdown", () => {
    const html = renderToString(
      React.createElement(MarkdownView, {
        content: '<script>alert("x")</script>\n\n<div>raw</div>',
      }),
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<div>raw</div>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;div&gt;raw&lt;/div&gt;");
  });

  it("keeps heading ids aligned for setext and ATX headings", () => {
    const html = renderToString(
      React.createElement(MarkdownView, {
        content: "Overview\n---\n\n## API",
      }),
    );

    expect(html).toContain('<h3 id="overview" class="md-h md-h2">Overview</h3>');
    expect(html).toContain('<h3 id="api" class="md-h md-h2">API</h3>');
  });

  it("keeps heading ids aligned after generated frontmatter", () => {
    const html = renderToString(
      React.createElement(MarkdownView, {
        content: [
          "---",
          "name: markdown-table-preview",
          "description: Browser validation fixture for Markdown tables.",
          "metadata: {}",
          "---",
          "",
          "Overview",
          "---",
          "",
          "## API",
        ].join("\n"),
      }),
    );

    expect(html).toContain('<h3 id="overview" class="md-h md-h2">Overview</h3>');
    expect(html).toContain('<h3 id="api" class="md-h md-h2">API</h3>');
  });

  it("does not shift heading ids after list items followed by thematic breaks", () => {
    const html = renderToString(
      React.createElement(MarkdownView, {
        content: "- item\n---\n\n## Real",
      }),
    );

    expect(html).toContain('<hr class="md-hr"/>');
    expect(html).toContain('<h3 id="real" class="md-h md-h2">Real</h3>');
    expect(html).not.toContain('id="item"');
  });

  it("keeps markdown raw mode on the code renderer", () => {
    const html = renderToString(
      React.createElement(FileContent, {
        path: "SKILL.md",
        content: "| Name | Count |\n| --- | ---: |\n| Alpha | 12 |",
        mode: "raw",
      }),
    );

    expect(html).toContain("codeview");
    expect(html).not.toContain("md-table");
    expect(html).toContain("| Name | Count |");
  });
});
