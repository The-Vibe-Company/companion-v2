// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunChatEvent, SkillRunDetail } from "@companion/contracts";
import { RunChatView } from "./RunChatView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const queryMocks = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  cancelRunPrompt: vi.fn(),
  fetchRun: vi.fn(),
  runAttachmentHref: vi.fn((runId: string, attachmentId: string, download = false) => `/v1/runs/${runId}/attachments/${attachmentId}${download ? "?download=1" : ""}`),
  runArtifactHref: vi.fn((runId: string, artifactId: string, download = false) => `/v1/runs/${runId}/artifacts/${artifactId}${download ? "?download=1" : ""}`),
  sendRunPrompt: vi.fn(),
}));
const streamMocks = vi.hoisted(() => ({ openRunStream: vi.fn() }));

vi.mock("@/lib/runQueries", () => queryMocks);
vi.mock("./chatStream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatStream")>();
  return { ...actual, openRunStream: streamMocks.openRunStream };
});

const roots: Root[] = [];
let streamListener: ((event: RunChatEvent) => void) | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

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
    pending_prompts: [],
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

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  streamListener = null;
  streamMocks.openRunStream.mockImplementation(async (_runId, onEvent, signal, cursor) => {
    streamListener = onEvent;
    cursor?.onConnected?.();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((file: Blob & { name?: string }) => `blob:${file.name ?? file.type}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("11111111-1111-4111-8111-111111111101")
      ? new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      : "preview text";
    return new Response(body, { status: 200 });
  }));
  queryMocks.fetchRun.mockResolvedValue(runDetail());
  queryMocks.cancelRunPrompt.mockResolvedValue({
    prompt_id: "11111111-1111-4111-8111-111111111111",
    status: "canceled",
    requested: true,
  });
  queryMocks.sendRunPrompt.mockResolvedValue({
    accepted: true,
    prompt_id: "11111111-1111-4111-8111-111111111111",
    message_id: "message-1",
    ordinal: 1,
    status: "processing",
    attachments: [],
    reactivated: false,
  });
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RunChatView attachments", () => {
  it("shows a labeled action and sends a dropped file", async () => {
    const container = await mount();
    const dropzone = container.querySelector(".run-composer")!;
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
    expect(queryMocks.sendRunPrompt).toHaveBeenCalledWith("run-1", "", [file], expect.any(String), expect.any(Function));
  });

  it("previews pasted images and videos before upload", async () => {
    const container = await mount();
    const composer = container.querySelector<HTMLTextAreaElement>("#run-follow-up")!;
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const video = new File(["video"], "demo.mp4", { type: "video/mp4" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      configurable: true,
      value: { files: [image, video], getData: () => "" },
    });

    await act(async () => composer.dispatchEvent(paste));

    expect(container.querySelector('img[src="blob:diagram.png"]')).not.toBeNull();
    expect(container.querySelector('video[src="blob:demo.mp4"][controls]')).not.toBeNull();

    await act(async () => button(container, "Remove diagram.png").click());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:diagram.png");
  });

  it("renders only server-approved persisted video previews", async () => {
    queryMocks.fetchRun.mockResolvedValue({
      ...runDetail(),
      attachments: [{
        id: "attachment-video",
        prompt_id: "11111111-1111-4111-8111-111111111111",
        message_id: "message-video",
        prompt_ordinal: 0,
        file_name: "demo.mp4",
        content_type: "video/mp4",
        preview_content_type: "video/mp4",
        byte_size: 2048,
      }],
    });
    const container = await mount();
    expect(container.querySelector('video[src$="attachment-video"][controls]')).not.toBeNull();
  });

  it("sends on Enter but not Shift Enter or during IME composition", async () => {
    const container = await mount();
    const composer = container.querySelector<HTMLTextAreaElement>("#run-follow-up")!;
    await act(async () => {
      setTextareaValue(composer, "First line");
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
      composer.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      composer.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    expect(queryMocks.sendRunPrompt).not.toHaveBeenCalled();

    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(queryMocks.sendRunPrompt).toHaveBeenCalledWith("run-1", "First line", [], expect.any(String), undefined);
  });
});

describe("RunChatView follow-up queue", () => {
  it("refreshes degraded runtime transitions and pauses the composer while reconnecting", async () => {
    const healthy = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
      runtime_state: "healthy" as const,
      runtime_degraded_at: null,
    };
    const degraded = {
      ...healthy,
      runtime_state: "degraded" as const,
      runtime_degraded_at: "2026-07-16T12:00:00.000Z",
    };
    const recovery = deferred<SkillRunDetail>();
    queryMocks.fetchRun
      .mockResolvedValueOnce(healthy)
      .mockResolvedValueOnce(degraded)
      .mockReturnValueOnce(recovery.promise);
    const container = await mount();

    await act(async () => {
      streamListener?.({ type: "status", state: "retry", attempt: null, message: "Reconnecting to the run recorder" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Reconnecting…");
    expect(container.querySelector<HTMLTextAreaElement>("#run-follow-up")?.disabled).toBe(true);

    await act(async () => {
      streamListener?.({ type: "status", state: "busy", attempt: null, message: null });
      streamListener?.({ type: "text.delta", message_id: "message-1", delta: "Recovered" });
      streamListener?.({ type: "reasoning.delta", part_id: "part-1", delta: "Checking" });
      await Promise.resolve();
    });
    expect(queryMocks.fetchRun).toHaveBeenCalledTimes(3);

    await act(async () => {
      recovery.resolve(healthy);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Reconnecting…");
    expect(container.querySelector<HTMLTextAreaElement>("#run-follow-up")?.disabled).toBe(false);
  });

  it("hides the composer when an interrupted run cannot reactivate", async () => {
    queryMocks.fetchRun.mockResolvedValue({
      ...runDetail(),
      status: "interrupted",
      error_code: "sandbox_expired_during_turn",
      error_message: "The sandbox expired during this turn.",
      reactivatable_until: null,
      can_reactivate: false,
    });
    const container = await mount();

    expect(container.textContent).toContain("Turn interrupted");
    expect(container.textContent).toContain("The sandbox can no longer be reactivated.");
    expect(container.querySelector(".run-composer")).toBeNull();
  });

  it("keeps runtime refresh ownership isolated when navigating between runs", async () => {
    const runA = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
      runtime_state: "healthy" as const,
      runtime_degraded_at: null,
    };
    const runB = { ...runA, id: "run-2" };
    const degradedB = {
      ...runB,
      runtime_state: "degraded" as const,
      runtime_degraded_at: "2026-07-16T12:00:00.000Z",
    };
    const staleRunARefresh = deferred<SkillRunDetail>();
    queryMocks.fetchRun
      .mockResolvedValueOnce(runA)
      .mockReturnValueOnce(staleRunARefresh.promise)
      .mockResolvedValueOnce(runB)
      .mockResolvedValueOnce(degradedB);
    const container = await mount();

    await act(async () => {
      streamListener?.({ type: "status", state: "retry", attempt: null, message: "Reconnecting" });
      await Promise.resolve();
    });
    const runAListener = streamListener;
    const root = roots.at(-1)!;
    await act(async () => {
      root.render(React.createElement(RunChatView, {
        runId: "run-2",
        expectedSkillSlug: "incident-summary",
        onBack: vi.fn(),
        onRunAgain: vi.fn(),
      }));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (let attempt = 0; attempt < 5 && streamListener === runAListener; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(streamListener).not.toBe(runAListener);
    await act(async () => {
      streamListener?.({ type: "status", state: "retry", attempt: null, message: "Reconnecting" });
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(queryMocks.fetchRun).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain("Reconnecting…");

    await act(async () => {
      staleRunARefresh.resolve(runA);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Reconnecting…");
    expect(container.querySelector<HTMLTextAreaElement>("#run-follow-up")?.disabled).toBe(true);
  });

  it("keeps exactly one initial prompt bubble when processing starts", async () => {
    const initial = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
      pending_prompts: [{
        id: "11111111-1111-4111-8111-111111111110",
        message_id: "message-initial",
        ordinal: 0,
        kind: "initial" as const,
        text: "Summarize this incident",
        status: "processing" as const,
        created_at: "2026-07-16T11:59:00.000Z",
        attachments: [],
      }],
    };
    queryMocks.fetchRun.mockResolvedValue(initial);
    const container = await mount();
    expect(container.querySelectorAll(".run-message--user")).toHaveLength(1);

    await act(async () => {
      streamListener?.({
        type: "prompt.status",
        prompt_id: initial.pending_prompts[0]!.id,
        message_id: "message-initial",
        ordinal: 0,
        status: "processing",
      });
      await Promise.resolve();
    });
    expect(container.querySelectorAll(".run-message--user")).toHaveLength(1);
    expect(container.textContent).toContain("Current turn");
    expect(container.querySelector('[aria-label^="Remove queued"]')).toBeNull();
  });

  it("folds ordered prompt retries from processing back to queued and forward again", async () => {
    const snapshot = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
      pending_prompts: [{
        id: "11111111-1111-4111-8111-111111111113",
        message_id: "message-live-status",
        ordinal: 1,
        kind: "follow_up" as const,
        text: "Check live status",
        status: "queued" as const,
        created_at: "2026-07-16T12:00:00.000Z",
        attachments: [],
      }],
    };
    queryMocks.fetchRun
      .mockResolvedValueOnce(snapshot)
      .mockReturnValue(new Promise<SkillRunDetail>(() => undefined));
    const container = await mount();
    const statusEvent = {
      type: "prompt.status" as const,
      prompt_id: snapshot.pending_prompts[0]!.id,
      message_id: "message-live-status",
      ordinal: 1,
      status: "processing" as const,
    };

    await act(async () => streamListener?.(statusEvent));
    expect(button(container, "Stop")).not.toBeNull();
    expect(container.textContent).not.toContain("Queued · 1");

    await act(async () => streamListener?.({ ...statusEvent, status: "queued" }));
    expect(container.querySelector(".run-composer__stop")).toBeNull();
    expect(container.textContent).toContain("Queued · 1");

    await act(async () => streamListener?.(statusEvent));
    expect(button(container, "Stop")).not.toBeNull();
    expect(container.textContent).not.toContain("Queued · 1");
  });

  it("does not let a detail request started before acknowledgement erase the local queue row", async () => {
    const running = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
    };
    const staleDetail = deferred<SkillRunDetail>();
    const freshDetail = deferred<SkillRunDetail>();
    const acknowledgement = deferred<Awaited<ReturnType<typeof queryMocks.sendRunPrompt>>>();
    queryMocks.fetchRun
      .mockResolvedValueOnce(running)
      .mockReturnValueOnce(staleDetail.promise)
      .mockReturnValueOnce(freshDetail.promise);
    queryMocks.sendRunPrompt.mockReturnValueOnce(acknowledgement.promise);
    const container = await mount();
    const composer = container.querySelector<HTMLTextAreaElement>("#run-follow-up")!;
    await act(async () => setTextareaValue(composer, "Keep this queued"));
    await act(async () => button(container, "Send").click());

    await act(async () => streamListener?.({ type: "session.idle", session_id: "session-1" }));
    expect(queryMocks.fetchRun).toHaveBeenCalledTimes(2);
    await act(async () => {
      acknowledgement.resolve({
        accepted: true,
        prompt_id: "11111111-1111-4111-8111-111111111114",
        message_id: "message-race",
        ordinal: 1,
        status: "queued",
        attachments: [{
          id: "attachment-race",
          prompt_id: "11111111-1111-4111-8111-111111111114",
          message_id: "message-race",
          prompt_ordinal: 1,
          file_name: "race.png",
          content_type: "image/png",
          preview_content_type: "image/png",
          byte_size: 128,
        }],
        reactivated: false,
      });
      await Promise.resolve();
    });
    expect(queryMocks.fetchRun).toHaveBeenCalledTimes(3);
    expect(button(container, "Remove queued follow-up 1")).not.toBeNull();

    await act(async () => {
      staleDetail.resolve(running);
      await Promise.resolve();
    });
    expect(button(container, "Remove queued follow-up 1")).not.toBeNull();
    expect(button(container, "Files · 1")).not.toBeNull();

    await act(async () => {
      freshDetail.resolve({
        ...running,
        pending_prompts: [{
          id: "11111111-1111-4111-8111-111111111114",
          message_id: "message-race",
          ordinal: 1,
          kind: "follow_up",
          text: "Keep this queued",
          status: "queued",
          created_at: "2026-07-16T12:00:00.000Z",
          attachments: [{
            id: "attachment-race",
            prompt_id: "11111111-1111-4111-8111-111111111114",
            message_id: "message-race",
            prompt_ordinal: 1,
            file_name: "race.png",
            content_type: "image/png",
            preview_content_type: "image/png",
            byte_size: 128,
          }],
        }],
        attachments: [{
          id: "attachment-race",
          prompt_id: "11111111-1111-4111-8111-111111111114",
          message_id: "message-race",
          prompt_ordinal: 1,
          file_name: "race.png",
          content_type: "image/png",
          preview_content_type: "image/png",
          byte_size: 128,
        }],
      });
      await Promise.resolve();
    });
  });

  it("keeps queued work out of the transcript until processing and removes it without a false bubble", async () => {
    const running = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
    };
    queryMocks.fetchRun
      .mockResolvedValueOnce(running)
      .mockReturnValue(new Promise<SkillRunDetail>(() => undefined));
    queryMocks.sendRunPrompt.mockResolvedValueOnce({
      accepted: true,
      prompt_id: "11111111-1111-4111-8111-111111111112",
      message_id: "message-queued-ack",
      ordinal: 2,
      status: "queued",
      attachments: [],
      reactivated: false,
    });
    const container = await mount();
    const composer = container.querySelector<HTMLTextAreaElement>("#run-follow-up")!;
    await act(async () => setTextareaValue(composer, "Queue this next"));
    await act(async () => {
      button(container, "Send").click();
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[data-message-id="user:message-queued-ack"]')).toHaveLength(0);
    expect(container.textContent).toContain("Queue this next");

    await act(async () => streamListener?.({
      type: "prompt.status",
      prompt_id: "11111111-1111-4111-8111-111111111112",
      message_id: "message-queued-ack",
      ordinal: 2,
      status: "processing",
    }));
    expect(container.querySelectorAll('[data-message-id="user:message-queued-ack"]')).toHaveLength(1);
  });

  it("keeps an SSE processing state when a stale queued acknowledgement arrives later", async () => {
    const running = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
    };
    const acknowledgement = deferred<Awaited<ReturnType<typeof queryMocks.sendRunPrompt>>>();
    queryMocks.fetchRun
      .mockResolvedValueOnce(running)
      .mockReturnValue(new Promise<SkillRunDetail>(() => undefined));
    queryMocks.sendRunPrompt.mockReturnValueOnce(acknowledgement.promise);
    const container = await mount();
    const composer = container.querySelector<HTMLTextAreaElement>("#run-follow-up")!;
    await act(async () => setTextareaValue(composer, "Start after SSE"));
    await act(async () => button(container, "Send").click());

    const event = {
      type: "prompt.status" as const,
      prompt_id: "11111111-1111-4111-8111-111111111119",
      message_id: "message-sse-before-ack",
      ordinal: 1,
      status: "processing" as const,
    };
    await act(async () => streamListener?.(event));
    expect(container.querySelectorAll('[data-message-id="user:message-sse-before-ack"]')).toHaveLength(0);

    await act(async () => {
      acknowledgement.resolve({
        accepted: true,
        prompt_id: event.prompt_id,
        message_id: event.message_id,
        ordinal: event.ordinal,
        status: "queued",
        attachments: [],
        reactivated: false,
      });
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[data-message-id="user:message-sse-before-ack"]')).toHaveLength(1);
    expect(button(container, "Stop")).not.toBeNull();
  });

  it("keeps the user turn when processing and completion both arrive before its HTTP acknowledgement", async () => {
    const running = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
    };
    const acknowledgement = deferred<Awaited<ReturnType<typeof queryMocks.sendRunPrompt>>>();
    queryMocks.fetchRun
      .mockResolvedValueOnce(running)
      .mockReturnValue(new Promise<SkillRunDetail>(() => undefined));
    queryMocks.sendRunPrompt.mockReturnValueOnce(acknowledgement.promise);
    const container = await mount();
    const composer = container.querySelector<HTMLTextAreaElement>("#run-follow-up")!;
    await act(async () => setTextareaValue(composer, "Processed before acknowledgement"));
    await act(async () => button(container, "Send").click());

    const promptId = "11111111-1111-4111-8111-111111111117";
    const messageId = "message-processed-before-ack";
    await act(async () => streamListener?.({
      type: "prompt.status",
      prompt_id: promptId,
      message_id: messageId,
      ordinal: 1,
      status: "processing",
    }));
    await act(async () => streamListener?.({
      type: "prompt.status",
      prompt_id: promptId,
      message_id: messageId,
      ordinal: 1,
      status: "completed",
    }));

    await act(async () => {
      acknowledgement.resolve({
        accepted: true,
        prompt_id: promptId,
        message_id: messageId,
        ordinal: 1,
        status: "queued",
        attachments: [],
        reactivated: false,
      });
      await Promise.resolve();
    });

    expect(container.querySelector(".run-prompt-queue")).toBeNull();
    expect(container.querySelectorAll(`[data-message-id="user:${messageId}"]`)).toHaveLength(1);
  });

  it("keeps a terminal SSE tombstone after its refresh so a late queued acknowledgement cannot resurrect work", async () => {
    const running = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
    };
    const terminalDetail = deferred<SkillRunDetail>();
    const acknowledgement = deferred<Awaited<ReturnType<typeof queryMocks.sendRunPrompt>>>();
    queryMocks.fetchRun
      .mockResolvedValueOnce(running)
      .mockReturnValueOnce(terminalDetail.promise)
      .mockReturnValue(new Promise<SkillRunDetail>(() => undefined));
    queryMocks.sendRunPrompt.mockReturnValueOnce(acknowledgement.promise);
    const container = await mount();
    const composer = container.querySelector<HTMLTextAreaElement>("#run-follow-up")!;
    await act(async () => setTextareaValue(composer, "Do not resurrect"));
    await act(async () => button(container, "Send").click());

    const promptId = "11111111-1111-4111-8111-111111111118";
    await act(async () => streamListener?.({
      type: "prompt.status",
      prompt_id: promptId,
      message_id: "message-terminal-before-ack",
      ordinal: 1,
      status: "canceled",
    }));
    await act(async () => {
      terminalDetail.resolve(running);
      await Promise.resolve();
    });

    await act(async () => {
      acknowledgement.resolve({
        accepted: true,
        prompt_id: promptId,
        message_id: "message-terminal-before-ack",
        ordinal: 1,
        status: "queued",
        attachments: [],
        reactivated: false,
      });
      await Promise.resolve();
    });

    expect(container.querySelector(".run-prompt-queue")).toBeNull();
    expect(container.querySelectorAll('[data-message-id="user:message-terminal-before-ack"]')).toHaveLength(0);
  });

  it("restores queued prompts and removes an exact queued item", async () => {
    const queued: SkillRunDetail = {
      ...runDetail(),
      attachments: [{
        id: "attachment-queued",
        prompt_id: "11111111-1111-4111-8111-111111111111",
        message_id: "message-queued",
        prompt_ordinal: 1,
        file_name: "queued.pdf",
        content_type: "application/pdf",
        preview_content_type: null,
        byte_size: 64,
      }],
      pending_prompts: [{
        id: "11111111-1111-4111-8111-111111111111",
        message_id: "message-queued",
        ordinal: 1,
        kind: "follow_up",
        text: "Check the timeline",
        status: "queued",
        created_at: "2026-07-16T12:00:00.000Z",
        attachments: [{
          id: "attachment-queued",
          prompt_id: "11111111-1111-4111-8111-111111111111",
          message_id: "message-queued",
          prompt_ordinal: 1,
          file_name: "queued.pdf",
          content_type: "application/pdf",
          preview_content_type: null,
          byte_size: 64,
        }],
      }],
    };
    queryMocks.fetchRun
      .mockResolvedValueOnce(queued)
      .mockRejectedValue(new Error("refresh unavailable"));
    const container = await mount();
    expect(container.textContent).toContain("Check the timeline");
    expect(button(container, "Files · 1")).not.toBeNull();

    await act(async () => {
      button(container, "Remove queued follow-up 1").click();
      await Promise.resolve();
    });

    expect(queryMocks.cancelRunPrompt).toHaveBeenCalledWith(
      "run-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(container.querySelectorAll('[data-message-id="user:message-queued"]')).toHaveLength(0);
    expect(button(container, "Files · 0")).not.toBeNull();
  });

  it("shows Stop and keeps a clickable Send action while a turn is running", async () => {
    queryMocks.fetchRun.mockResolvedValue({
      ...runDetail(),
      pending_prompts: [{
        id: "11111111-1111-4111-8111-111111111111",
        message_id: "message-active",
        ordinal: 1,
        kind: "follow_up",
        text: "Build the report",
        status: "processing",
        created_at: "2026-07-16T12:00:00.000Z",
        attachments: [],
      }],
    });
    const container = await mount();
    const composer = container.querySelector<HTMLTextAreaElement>("#run-follow-up")!;
    await act(async () => {
      setTextareaValue(composer, "Then summarize it");
    });

    expect(button(container, "Stop")).not.toBeNull();
    expect(button(container, "Send")).not.toBeNull();
    await act(async () => {
      button(container, "Send").click();
      await Promise.resolve();
    });
    expect(queryMocks.sendRunPrompt).toHaveBeenCalledWith("run-1", "Then summarize it", [], expect.any(String), undefined);
    await act(async () => {
      button(container, "Stop").click();
      await Promise.resolve();
    });
    expect(queryMocks.cancelRunPrompt).toHaveBeenCalledWith(
      "run-1",
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("removes a turn when cancel races with terminal completion", async () => {
    const active = {
      ...runDetail(),
      pending_prompts: [{
        id: "11111111-1111-4111-8111-111111111115",
        message_id: "message-terminal-race",
        ordinal: 1,
        kind: "follow_up" as const,
        text: "Finishing now",
        status: "processing" as const,
        created_at: "2026-07-16T12:00:00.000Z",
        attachments: [],
      }],
    };
    queryMocks.fetchRun
      .mockResolvedValueOnce(active)
      .mockReturnValue(new Promise<SkillRunDetail>(() => undefined));
    queryMocks.cancelRunPrompt.mockResolvedValueOnce({
      prompt_id: active.pending_prompts[0]!.id,
      status: "completed",
      requested: false,
    });
    const container = await mount();

    await act(async () => {
      button(container, "Stop").click();
      await Promise.resolve();
    });
    expect(container.querySelector(".run-prompt-queue")).toBeNull();
    expect(queryMocks.cancelRunPrompt).toHaveBeenCalledWith("run-1", active.pending_prompts[0]!.id);
  });
});

describe("RunChatView generated files", () => {
  it("auto-opens for the first live artifact and never steals selection for later files", async () => {
    const running = { ...runDetail(), status: "running" as const, reactivatable_until: null, can_reactivate: false };
    const first = {
      id: "11111111-1111-4111-8111-111111111101",
      file_name: "todo.txt",
      path: "artifacts/todo.txt",
      content_type: "text/plain; charset=utf-8",
      byte_size: 12,
      previewable: true,
      preview_kind: "text" as const,
      expires_at: "2099-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:00:00.000Z",
    };
    const second = {
      ...first,
      id: "11111111-1111-4111-8111-111111111102",
      file_name: "notes.md",
      path: "artifacts/notes.md",
      preview_kind: "markdown" as const,
      updated_at: "2026-07-16T12:00:01.000Z",
    };
    queryMocks.fetchRun
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ ...running, artifacts: [first] })
      .mockResolvedValueOnce({ ...running, artifacts: [first, second] });
    const container = await mount();

    await act(async () => streamListener?.({ type: "artifacts.collecting" }));
    expect(container.textContent).toContain("Collecting files…");
    await act(async () => {
      streamListener?.({ type: "artifacts.updated", count: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector(".run-artifact-canvas")).not.toBeNull();
    expect(container.querySelector(".run-canvas-file.is-selected")?.textContent).toContain("todo.txt");

    await act(async () => {
      streamListener?.({ type: "artifacts.updated", count: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector(".run-canvas-file.is-selected")?.textContent).toContain("todo.txt");
    expect(container.querySelector(".run-canvas-new")?.textContent).toContain("+1 new");
  });

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
          preview_kind: "image",
          expires_at: "2099-07-16T12:00:00.000Z",
        },
        {
          id: "11111111-1111-4111-8111-111111111102",
          file_name: "notes.txt",
          path: "artifacts/notes.txt",
          content_type: "text/plain; charset=utf-8",
          byte_size: 42,
          previewable: true,
          preview_kind: "text",
          expires_at: "2099-07-16T12:00:00.000Z",
        },
      ],
    });
    const container = await mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector(".run-artifact-canvas")).not.toBeNull();
    const preview = container.querySelector<HTMLImageElement>('.run-canvas-media img[src*="/artifacts/11111111-1111-4111-8111-111111111101"]');
    expect(preview).not.toBeNull();
    expect(container.textContent).toContain("notes.txt");
    expect(container.querySelector('a[href$="11111111-1111-4111-8111-111111111101?download=1"]')).not.toBeNull();

    const notes = Array.from(container.querySelectorAll<HTMLButtonElement>(".run-canvas-file")).find((item) => item.textContent?.includes("notes.txt"));
    await act(async () => { notes?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector(".run-canvas-code")?.textContent).toContain("preview text");
    expect(container.querySelector('a[href$="11111111-1111-4111-8111-111111111102?download=1"]')).not.toBeNull();
  });

  it("forces a verified PDF MIME and sandboxes the preview frame", async () => {
    vi.mocked(URL.createObjectURL).mockReturnValueOnce("about:blank#pdf");
    queryMocks.fetchRun.mockResolvedValue({
      ...runDetail(),
      artifacts: [{
        id: "11111111-1111-4111-8111-111111111101",
        file_name: "report.pdf",
        path: "artifacts/report.pdf",
        content_type: "text/html",
        byte_size: 128,
        previewable: true,
        preview_kind: "pdf",
        expires_at: "2099-07-16T12:00:00.000Z",
      }],
    });
    const container = await mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "application/pdf" }));
    expect(container.querySelector(".run-canvas-pdf")?.getAttribute("sandbox")).toBe("");
    await act(async () => button(container, "Close files").click());
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("about:blank#pdf");
    expect(document.activeElement).toBe(button(container, "Files · 1"));
  });

  it("blocks remote Markdown images and reloads direct media on same-path replacement", async () => {
    const running = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
    };
    const markdown = {
      id: "11111111-1111-4111-8111-111111111103",
      file_name: "report.md",
      path: "artifacts/report.md",
      content_type: "text/markdown; charset=utf-8",
      byte_size: 42,
      previewable: true,
      preview_kind: "markdown" as const,
      expires_at: "2099-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:00:02.000Z",
    };
    const image = {
      ...markdown,
      id: "11111111-1111-4111-8111-111111111104",
      file_name: "chart.png",
      path: "artifacts/chart.png",
      content_type: "image/png",
      preview_kind: "image" as const,
      updated_at: "2026-07-16T12:00:01.000Z",
    };
    queryMocks.fetchRun
      .mockResolvedValueOnce({ ...running, artifacts: [image, markdown] })
      .mockResolvedValue({ ...running, artifacts: [{ ...image, updated_at: "2026-07-16T12:00:03.000Z" }, markdown] });
    vi.mocked(fetch).mockResolvedValue(new Response("![tracking](https://attacker.example/pixel)", { status: 200 }));
    const container = await mount();
    const markdownFile = Array.from(container.querySelectorAll<HTMLButtonElement>(".run-canvas-file"))
      .find((item) => item.textContent?.includes("report.md"));
    await act(async () => { markdownFile?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain("Image not loaded · tracking");
    expect(container.querySelector('img[src*="attacker.example"]')).toBeNull();

    const imageFile = Array.from(container.querySelectorAll<HTMLButtonElement>(".run-canvas-file"))
      .find((item) => item.textContent?.includes("chart.png"));
    await act(async () => imageFile?.click());
    const firstSrc = container.querySelector<HTMLImageElement>(".run-canvas-media img")?.src;
    await act(async () => {
      streamListener?.({ type: "artifacts.updated", count: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });
    const secondSrc = container.querySelector<HTMLImageElement>(".run-canvas-media img")?.src;
    expect(secondSrc).not.toBe(firstSrc);
    expect(container.querySelector('.run-canvas-tree[role="tree"]')).toBeNull();
  });

  it("contains mobile focus, handles Escape, and returns to Files when a selection disappears", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(max-width: 900px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const artifact = {
      id: "11111111-1111-4111-8111-111111111101",
      file_name: "todo.txt",
      path: "artifacts/todo.txt",
      content_type: "text/plain; charset=utf-8",
      byte_size: 12,
      previewable: true,
      preview_kind: "text" as const,
      expires_at: "2099-07-16T12:00:00.000Z",
    };
    const replacement = {
      ...artifact,
      id: "11111111-1111-4111-8111-111111111102",
      file_name: "done.txt",
      path: "artifacts/done.txt",
    };
    const running = {
      ...runDetail(),
      status: "running" as const,
      reactivatable_until: null,
      can_reactivate: false,
    };
    queryMocks.fetchRun
      .mockResolvedValueOnce({ ...running, artifacts: [artifact] })
      .mockResolvedValue({ ...running, artifacts: [replacement] });
    const previous = document.createElement("button");
    document.body.appendChild(previous);
    previous.focus();
    const container = await mount();
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

    const canvas = container.querySelector<HTMLElement>('.run-artifact-canvas[role="dialog"]')!;
    expect(canvas.contains(document.activeElement)).toBe(true);
    await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(canvas.classList.contains("is-preview")).toBe(false);

    await act(async () => {
      streamListener?.({ type: "artifacts.updated", count: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("done.txt");
    expect(canvas.classList.contains("is-preview")).toBe(false);
    await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(container.querySelector(".run-artifact-canvas")).toBeNull();
    expect(button(container, "Back to skill")).not.toBeNull();
    const filesButton = container.querySelector<HTMLButtonElement>(".run-chat-topbar__files")!;
    expect(filesButton.textContent).toContain("Files · 1");
    expect(document.activeElement).toBe(filesButton);

    await act(async () => filesButton.click());
    const replacementButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".run-canvas-file"))
      .find((item) => item.textContent?.includes("done.txt"));
    expect(replacementButton?.classList.contains("is-selected")).toBe(true);
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
          preview_kind: "text",
          expires_at: "2026-07-16T12:00:01.000Z",
          updated_at: "2026-07-16T11:59:59.900Z",
        },
        {
          id: "11111111-1111-4111-8111-111111111102",
          file_name: "second.txt",
          path: "artifacts/second.txt",
          content_type: "text/plain; charset=utf-8",
          byte_size: 6,
          previewable: false,
          preview_kind: "text",
          expires_at: "2026-07-16T12:00:02.000Z",
          updated_at: "2026-07-16T11:59:59.000Z",
        },
      ],
    });
    const container = await mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => vi.advanceTimersByTimeAsync(1_025));
    expect(container.querySelector(".run-canvas-viewer")?.textContent).toContain("expired");

    const second = Array.from(container.querySelectorAll<HTMLButtonElement>(".run-canvas-file")).find((item) => item.textContent?.includes("second.txt"));
    await act(async () => { second?.click(); await Promise.resolve(); });
    expect(container.querySelector(".run-canvas-viewer")?.textContent).not.toContain("has expired");

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(container.querySelector(".run-canvas-viewer")?.textContent).toContain("expired");
  });
});
