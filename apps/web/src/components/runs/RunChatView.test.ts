// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillRunDetail } from "@companion/contracts";
import { RunChatView } from "./RunChatView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const queryMocks = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  fetchRun: vi.fn(),
  runAttachmentHref: vi.fn((runId: string, attachmentId: string) => `/v1/runs/${runId}/attachments/${attachmentId}`),
  runArtifactHref: vi.fn((runId: string, artifactId: string, download = false) => `/v1/runs/${runId}/artifacts/${artifactId}${download ? "?download=1" : ""}`),
  sendRunPrompt: vi.fn(),
}));

vi.mock("@/lib/runQueries", () => queryMocks);

const roots: Root[] = [];

function runDetail(): SkillRunDetail {
  return {
    id: "run-1",
    skill_slug: "incident-summary",
    skill_version: "1.0.0",
    model: "openai/gpt-5",
    prompt_excerpt: "Summarize this incident",
    prompt: "Summarize this incident",
    status: "frozen",
    status_detail: null,
    created_at: "2026-07-15T00:00:00.000Z",
    last_active_at: null,
    transcript: [],
    warnings: [],
    transcript_event_sequence: 1,
    activation_revision: 0,
    reactivatable_until: "2099-07-22T00:00:00.000Z",
    can_reactivate: true,
    attachments: [],
    artifacts: [],
  };
}

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(RunChatView, {
      runId: "run-1",
      expectedSkillSlug: "incident-summary",
      onBack: vi.fn(),
      onRunAgain: vi.fn(),
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return match;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMocks.fetchRun.mockResolvedValue(runDetail());
  queryMocks.sendRunPrompt.mockResolvedValue({
    accepted: true,
    prompt_id: "11111111-1111-4111-8111-111111111111",
    message_id: "message-1",
    attachments: [],
    reactivated: false,
  });
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("RunChatView attachments", () => {
  it("shows a labeled action and sends a dropped file", async () => {
    const container = await mount();
    const dropzone = container.querySelector(".run-chat__composer")!;
    const file = new File(["brief"], "brief.pdf", { type: "application/pdf" });
    const dataTransfer = { files: [file], types: ["Files"], dropEffect: "none" };
    const dragEnter = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(dragEnter, "dataTransfer", { configurable: true, value: dataTransfer });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { configurable: true, value: dataTransfer });

    expect(button(container, "Add files").disabled).toBe(false);
    await act(async () => dropzone.dispatchEvent(dragEnter));
    expect(container.textContent).toContain("Drop files here");
    await act(async () => dropzone.dispatchEvent(drop));
    expect(container.textContent).toContain("brief.pdf");

    await act(async () => {
      button(container, "Send").click();
      await Promise.resolve();
    });
    expect(queryMocks.sendRunPrompt).toHaveBeenCalledWith("run-1", "", [file], expect.any(String));
  });
});

describe("RunChatView generated files", () => {
  it("renders safe raster previews and download-only file cards", async () => {
    queryMocks.fetchRun.mockResolvedValue({
      ...runDetail(),
      artifacts: [
        {
          id: "11111111-1111-4111-8111-111111111101",
          file_name: "cat.png",
          path: "artifacts/cat.png",
          content_type: "image/png",
          byte_size: 128,
          previewable: true,
          expires_at: "2099-07-16T12:00:00.000Z",
        },
        {
          id: "11111111-1111-4111-8111-111111111102",
          file_name: "notes.txt",
          path: "artifacts/notes.txt",
          content_type: "text/plain; charset=utf-8",
          byte_size: 42,
          previewable: false,
          expires_at: "2099-07-16T12:00:00.000Z",
        },
      ],
    });
    const container = await mount();
    expect(container.querySelector('img[alt="cat.png"]')).not.toBeNull();
    expect(container.textContent).toContain("notes.txt");
    expect(container.querySelector('a[href$="11111111-1111-4111-8111-111111111102?download=1"]')).not.toBeNull();
  });

  it("expires each generated file at its own deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    queryMocks.fetchRun.mockResolvedValue({
      ...runDetail(),
      artifacts: [
        {
          id: "11111111-1111-4111-8111-111111111101",
          file_name: "first.txt",
          path: "artifacts/first.txt",
          content_type: "text/plain; charset=utf-8",
          byte_size: 5,
          previewable: false,
          expires_at: "2026-07-16T12:00:01.000Z",
        },
        {
          id: "11111111-1111-4111-8111-111111111102",
          file_name: "second.txt",
          path: "artifacts/second.txt",
          content_type: "text/plain; charset=utf-8",
          byte_size: 6,
          previewable: false,
          expires_at: "2026-07-16T12:00:02.000Z",
        },
      ],
    });
    const container = await mount();

    await act(async () => vi.advanceTimersByTimeAsync(1_025));
    expect(container.textContent).toContain("first.txtExpired");
    expect(container.textContent).not.toContain("second.txtExpired");

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(container.textContent).toContain("second.txtExpired");
  });
});
