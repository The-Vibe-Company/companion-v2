import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SkillFile } from "@companion/contracts";
import { FileViewer } from "./fileview";

function file(overrides: Partial<SkillFile> & { path: string }): SkillFile {
  const { path, ...rest } = overrides;
  return {
    path,
    size: 10,
    content: null,
    binary: true,
    truncated: false,
    preview_kind: "unsupported",
    content_type: null,
    ...rest,
  };
}

describe("FileViewer browser-native previews", () => {
  it("renders markdown tables in preview mode", () => {
    const html = renderToString(
      React.createElement(FileViewer, {
        file: file({
          path: "SKILL.md",
          size: 48,
          content: "| Name | Count |\n| --- | ---: |\n| Alpha | 12 |",
          binary: false,
          preview_kind: "text",
          content_type: "text/markdown; charset=utf-8",
        }),
      }),
    );

    expect(html).toContain("Preview");
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain("<td>Alpha</td>");
    expect(html).toContain("text-align:right");
    expect(html).not.toContain("cv-gutter");
  });

  it("renders image files inline when a content URL is available", () => {
    const html = renderToString(
      React.createElement(FileViewer, {
        file: file({
          path: "assets/logo.svg",
          preview_kind: "image",
          content_type: "image/svg+xml",
        }),
        contentUrl: "/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Flogo.svg",
      }),
    );

    expect(html).toContain("<img");
    expect(html).toContain("assets%2Flogo.svg");
    expect(html).toContain('alt="logo.svg"');
  });

  it("renders PDF files inline when a content URL is available", () => {
    const html = renderToString(
      React.createElement(FileViewer, {
        file: file({
          path: "reference/demo.pdf",
          preview_kind: "pdf",
          content_type: "application/pdf",
        }),
        contentUrl: "/v1/skills/demo/versions/1.0.0/files/content?path=reference%2Fdemo.pdf",
      }),
    );

    expect(html).toContain("<iframe");
    expect(html).toContain("reference%2Fdemo.pdf");
    expect(html).toContain('title="demo.pdf"');
  });

  it("keeps text files on the existing code renderer with copy available", () => {
    const html = renderToString(
      React.createElement(FileViewer, {
        file: file({
          path: "companion.json",
          size: 14,
          content: '{"name":"demo"}',
          binary: false,
          preview_kind: "text",
          content_type: "application/json; charset=utf-8",
        }),
      }),
    );

    expect(html).toContain("codeview");
    expect(html).toContain("Copy file contents");
    expect(html).toContain("companion.json");
  });

  it("shows the binary empty state for unsupported files", () => {
    const html = renderToString(
      React.createElement(FileViewer, {
        file: file({ path: "archive.bin" }),
        contentUrl: "/ignored",
      }),
    );

    expect(html).toContain("Binary file");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
  });
});
