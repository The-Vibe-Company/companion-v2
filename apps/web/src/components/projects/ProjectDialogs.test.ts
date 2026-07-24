// @vitest-environment happy-dom

import {
  PROJECT_ATTACHMENT_MAX_BYTES,
  PROJECT_ATTACHMENT_MAX_FILES,
} from "@companion/contracts";
import {
  act,
  createElement,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetailVM } from "@/lib/projectsModel";
import { CoworkDialog, NewSessionDialog } from "./ProjectDialogs";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "September launch",
  defaultModel: "openai/gpt-5",
  revision: 1,
  status: "running",
  statusDetail: null,
  skillCount: 0,
  sessionCount: 0,
  activeSessionCount: 0,
  archivedSessionCount: 0,
  unreadSessionCount: 0,
  fileCount: 0,
  secretCount: 0,
  archivedAt: null,
  createdAt: "2026-07-24T09:00:00.000Z",
  updatedAt: "2026-07-24T09:00:00.000Z",
  recentSessions: [],
  skills: [],
  sessions: [],
  files: [],
  workspace: {
    status: "running",
    statusDetail: null,
    lastActiveAt: "2026-07-24T09:00:00.000Z",
    sleepAt: null,
  },
  modelConnectionCount: 1,
  access: {
    secrets: [],
    modelConnections: [],
  },
} satisfies ProjectDetailVM;

const models = [
  { id: "openai/gpt-5", name: "GPT-5", providerName: "OpenAI" },
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  host?.remove();
  root = null;
  host = null;
  document.body.replaceChildren();
});

async function renderNewSession(
  overrides: Partial<ComponentProps<typeof NewSessionDialog>> = {},
) {
  const onStart = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(NewSessionDialog, {
        project,
        models,
        busy: false,
        error: null,
        onClose: vi.fn(),
        onStart,
        ...overrides,
      }),
    );
    await Promise.resolve();
  });
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  return { dialog, onStart };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fileEvent(
  type: "dragenter" | "dragover" | "drop",
  files: File[],
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      files,
      types: ["Files"],
      dropEffect: "none",
    },
  });
  return event;
}

function pasteEvent(files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { files },
  });
  return event;
}

describe("CoworkDialog", () => {
  it("defers its portal until hydration so deep-linked dialogs can render on the server", () => {
    const ServerDialog = CoworkDialog as ComponentType<
      Omit<ComponentProps<typeof CoworkDialog>, "children"> & {
        children?: ReactNode;
      }
    >;
    expect(() =>
      renderToString(
        createElement(
          ServerDialog,
          {
            title: "New project",
            description: "Create a persistent project.",
            onClose: vi.fn(),
          },
          createElement("button", { type: "button" }, "Create"),
        ),
      ),
    ).not.toThrow();
  });
});

describe("NewSessionDialog attachments", () => {
  it("accepts dropped files and submits them with the first prompt", async () => {
    const attachment = new File(["launch"], "launch-notes.md", {
      type: "text/markdown",
    });
    const { dialog, onStart } = await renderNewSession();
    const composer = dialog.querySelector<HTMLElement>(
      ".cowork-session-compose",
    )!;

    act(() => composer.dispatchEvent(fileEvent("dragenter", [attachment])));
    expect(composer.classList.contains("is-dragover")).toBe(true);

    const drop = fileEvent("drop", [attachment]);
    act(() => composer.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(true);
    expect(composer.classList.contains("is-dragover")).toBe(false);
    expect(dialog.textContent).toContain("launch-notes.md");

    setTextareaValue(
      dialog.querySelector<HTMLTextAreaElement>("textarea")!,
      "Prepare the launch",
    );
    act(() =>
      [...dialog.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent?.includes("Start"))
        ?.click(),
    );

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Prepare the launch",
        files: [attachment],
      }),
    );
  });

  it("accepts files pasted into the prompt without inserting clipboard text", async () => {
    const attachment = new File(["brief"], "brief.pdf", {
      type: "application/pdf",
    });
    const { dialog } = await renderNewSession();
    const textarea = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
    const paste = pasteEvent([attachment]);

    act(() => textarea.dispatchEvent(paste));

    expect(paste.defaultPrevented).toBe(true);
    expect(dialog.textContent).toContain("brief.pdf");
  });

  it("rejects empty, oversized, and excess files with an announced error", async () => {
    const { dialog } = await renderNewSession();
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    const selectFiles = (files: File[]) => {
      Object.defineProperty(input, "files", {
        value: files,
        configurable: true,
      });
      act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    };

    selectFiles([new File([], "empty.txt", { type: "text/plain" })]);
    let alert = dialog.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain(
      "Each file must be between 1 byte and 10 MB.",
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);

    const oversized = new File(["x"], "oversized.bin");
    Object.defineProperty(oversized, "size", {
      value: PROJECT_ATTACHMENT_MAX_BYTES + 1,
    });
    selectFiles([oversized]);
    alert = dialog.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain(
      "Each file must be between 1 byte and 10 MB.",
    );

    selectFiles(
      Array.from(
        { length: PROJECT_ATTACHMENT_MAX_FILES + 1 },
        (_, index) => new File(["x"], `file-${index}.txt`),
      ),
    );
    alert = dialog.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain(
      `Attach up to ${PROJECT_ATTACHMENT_MAX_FILES} files.`,
    );
  });
});
