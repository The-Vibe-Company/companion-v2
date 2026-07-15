// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRunFileDrop } from "./useRunFileDrop";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function Harness({ disabled, onFiles }: { disabled: boolean; onFiles: (files: FileList) => void }) {
  const { dragOver, dropProps } = useRunFileDrop<HTMLDivElement>({ disabled, onFiles });
  return React.createElement("div", {
    "data-testid": "dropzone",
    "data-drag-over": dragOver ? "true" : "false",
    ...dropProps,
  });
}

function fileList(files: File[]): FileList {
  return files as unknown as FileList;
}

function dragEvent(type: string, files: File[], types = ["Files"]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: { files: fileList(files), types, dropEffect: "none" },
  });
  return event;
}

async function mount(disabled: boolean, onFiles: (files: FileList) => void): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(React.createElement(Harness, { disabled, onFiles })));
  return container.querySelector<HTMLDivElement>("[data-testid=dropzone]")!;
}

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("useRunFileDrop", () => {
  it("shows the active state and accepts a file drop", async () => {
    const onFiles = vi.fn();
    const zone = await mount(false, onFiles);
    const file = new File(["brief"], "brief.pdf", { type: "application/pdf" });

    await act(async () => zone.dispatchEvent(dragEvent("dragenter", [file])));
    expect(zone.dataset.dragOver).toBe("true");

    const drop = dragEvent("drop", [file]);
    await act(async () => zone.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(true);
    expect(zone.dataset.dragOver).toBe("false");
    expect(onFiles).toHaveBeenCalledWith(expect.objectContaining({ 0: file, length: 1 }));
  });

  it("clears the active state when the file payload leaves the dropzone", async () => {
    const zone = await mount(false, vi.fn());
    const file = new File(["brief"], "brief.pdf");

    await act(async () => zone.dispatchEvent(dragEvent("dragenter", [file])));
    expect(zone.dataset.dragOver).toBe("true");
    await act(async () => zone.dispatchEvent(dragEvent("dragleave", [], [])));
    expect(zone.dataset.dragOver).toBe("false");
  });

  it("prevents browser navigation but ignores drops while disabled", async () => {
    const onFiles = vi.fn();
    const zone = await mount(true, onFiles);
    const drop = dragEvent("drop", [new File(["brief"], "brief.pdf")]);

    await act(async () => zone.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(true);
    expect(zone.dataset.dragOver).toBe("false");
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("does not intercept non-file drags", async () => {
    const zone = await mount(false, vi.fn());
    const drop = dragEvent("drop", [], ["text/plain"]);

    await act(async () => zone.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(false);
  });
});
