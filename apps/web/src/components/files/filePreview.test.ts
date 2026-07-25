// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FilePreviewBody,
  filePreviewKindFor,
  normalizeContentType,
  useFilePreview,
} from "./filePreview";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * `detectRunFileType` stores `text/markdown; charset=utf-8` for every generated Markdown file, so a
 * classifier that compares the raw value against bare media types marks the most common Cowork
 * deliverable as non-previewable. That defect showed the user "Preview is not supported for this
 * format" for their own report.
 */
describe("filePreviewKindFor", () => {
  it("classifies the content types the server actually stores, parameters included", () => {
    expect(filePreviewKindFor("text/markdown; charset=utf-8")).toBe("markdown");
    expect(filePreviewKindFor("text/csv; charset=utf-8")).toBe("csv");
    expect(filePreviewKindFor("text/plain; charset=utf-8")).toBe("text");
    expect(filePreviewKindFor("application/json")).toBe("text");
    expect(filePreviewKindFor("APPLICATION/PDF")).toBe("pdf");
    expect(filePreviewKindFor("image/png")).toBe("image");
    expect(filePreviewKindFor("video/mp4")).toBe("video");
    expect(
      filePreviewKindFor(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("xlsx");
  });

  it("leaves genuinely unsupported formats unpreviewable", () => {
    expect(filePreviewKindFor("application/vnd.ms-powerpoint")).toBeNull();
    expect(filePreviewKindFor("application/zip")).toBeNull();
    expect(filePreviewKindFor(null)).toBeNull();
  });

  it("falls back to the extension only when the stored type carries no signal", () => {
    expect(filePreviewKindFor("application/octet-stream", "notes.md")).toBe("markdown");
    expect(filePreviewKindFor(null, "rows.csv")).toBe("csv");
    // A declared type always wins so a misleading extension cannot upgrade the renderer.
    expect(filePreviewKindFor("application/zip", "sneaky.md")).toBeNull();
  });

  it("normalizes parameters and casing", () => {
    expect(normalizeContentType("Text/Markdown; charset=UTF-8")).toBe("text/markdown");
    expect(normalizeContentType(null)).toBe("");
  });
});

function Harness({
  contentType,
  name,
  byteSize = 64,
}: {
  contentType: string;
  name: string;
  byteSize?: number;
}) {
  const kind = filePreviewKindFor(contentType, name);
  const state = useFilePreview({
    href: "/v1/projects/p/files/f",
    previewKind: kind,
    byteSize,
  });
  return React.createElement(FilePreviewBody, {
    state,
    previewKind: kind,
    name,
    downloadHref: "/v1/projects/p/files/f?download=1",
  });
}

async function mount(props: { contentType: string; name: string; byteSize?: number }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(Harness, props));
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

describe("FilePreviewBody", () => {
  it("renders a Markdown deliverable as a formatted document rather than raw source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# Quarterly report\n\nRevenue is **up**.\n", { status: 200 })),
    );
    const container = await mount({
      contentType: "text/markdown; charset=utf-8",
      name: "report.md",
    });
    expect(container.querySelector(".run-canvas-document")).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Quarterly report");
    expect(container.querySelector("strong")?.textContent).toBe("up");
    expect(container.textContent).not.toContain("# Quarterly report");
  });

  it("renders CSV as a table, which the browser refuses to display inline at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("region,revenue\nEMEA,120000\n", { status: 200 })),
    );
    const container = await mount({
      contentType: "text/csv; charset=utf-8",
      name: "data.csv",
    });
    const cells = [...container.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells).toEqual(["region", "revenue", "EMEA", "120000"]);
  });

  it("renders plain text through the code view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("first line\nsecond line\n", { status: 200 })),
    );
    const container = await mount({
      contentType: "text/plain; charset=utf-8",
      name: "notes.txt",
    });
    expect(container.querySelector(".run-canvas-code")?.textContent).toContain("second line");
  });

  it("offers a download instead of an empty canvas for an unsupported format", async () => {
    const container = await mount({
      contentType: "application/vnd.ms-powerpoint",
      name: "deck.ppt",
    });
    expect(container.textContent).toContain("Preview is not supported for this format.");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/v1/projects/p/files/f?download=1",
    );
  });

  it("refuses to buffer a text file past the display limit and keeps the download reachable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount({
      contentType: "text/markdown; charset=utf-8",
      name: "huge.md",
      byteSize: 2 * 1024 * 1024,
    });
    expect(container.textContent).toContain("larger than the 1 MB display limit");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/v1/projects/p/files/f?download=1",
    );
  });

  it("surfaces a failed load with both Retry and Download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        React.createElement(() => {
          const state = useFilePreview({
            href: "/v1/projects/p/files/f",
            previewKind: "markdown",
            byteSize: 10,
          });
          return React.createElement(FilePreviewBody, {
            state,
            previewKind: "markdown",
            name: "report.md",
            downloadHref: "/v1/projects/p/files/f?download=1",
            onRetry: () => {},
          });
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Preview failed (500).");
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent === "Retry"),
    ).toBe(true);
  });

  it("keeps the PDF frame unsandboxed so the browser viewer runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70, 45]), { status: 200 })),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview-pdf");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const container = await mount({ contentType: "application/pdf", name: "report.pdf" });
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.hasAttribute("sandbox")).toBe(false);
    // The Blob type is forced, so mislabelled bytes can never be parsed as markup.
    expect(URL.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: "application/pdf" }),
    );
  });

  it("serves images straight from the authenticated URL without buffering", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount({ contentType: "image/png", name: "chart.png" });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/v1/projects/p/files/f");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
