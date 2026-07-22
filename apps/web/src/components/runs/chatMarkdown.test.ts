// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./chatMarkdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

async function renderMarkdown(text: string): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(ChatMarkdown, { text })));
  return container;
}

describe("ChatMarkdown", () => {
  it("renders GFM tables, task lists, and fenced code", async () => {
    const container = await renderMarkdown([
      "| Name | State |",
      "| --- | --- |",
      "| api | healthy |",
      "",
      "- [x] checked",
      "",
      "```ts",
      "const healthy = true;",
      "```",
    ].join("\n"));

    expect(container.querySelector("table")?.textContent).toContain("healthy");
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(container.querySelector(".run-md__code")?.textContent).toContain("const healthy");
    expect(container.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  });

  it("keeps raw HTML inert and protects external links", async () => {
    const container = await renderMarkdown('<script>bad()</script>\n\n[Docs](https://example.com)');
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>bad()</script>");
    expect(container.querySelector("a")?.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("never fetches images embedded in untrusted assistant Markdown", async () => {
    const container = await renderMarkdown("![tracking pixel](https://attacker.example/pixel.png)");

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Image not loaded · tracking pixel");
  });

  it("turns verified artifact paths into canvas controls", async () => {
    const onOpenArtifact = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(ChatMarkdown, {
      text: "Created `./artifacts/todo.txt`.",
      artifactPaths: { "./artifacts/todo.txt": "artifact-1" },
      onOpenArtifact,
    })));

    const path = container.querySelector<HTMLButtonElement>(".run-artifact-link--code");
    expect(path?.textContent).toBe("./artifacts/todo.txt");
    await act(async () => path?.click());
    expect(onOpenArtifact).toHaveBeenCalledWith("artifact-1");
  });

  it("throttles expensive Markdown commits while preserving the final delta", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(React.createElement(ChatMarkdown, { text: "First", streaming: true })));
    await act(async () => root.render(React.createElement(ChatMarkdown, { text: "Second", streaming: true })));
    expect(container.textContent).toContain("First");
    expect(container.textContent).not.toContain("Second");

    await act(async () => vi.advanceTimersByTime(80));
    expect(container.textContent).toContain("Second");

    await act(async () => root.render(React.createElement(ChatMarkdown, { text: "Final", streaming: false })));
    expect(container.textContent).toContain("Final");
    await act(async () => root.unmount());
  });
});
