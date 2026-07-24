// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillRunDetail } from "@companion/contracts";
import { ChatTranscript } from "./ChatTranscript";
import type { ChatState } from "./chatStream";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function runDetail(): SkillRunDetail {
  return {
    id: "run-1",
    skill_slug: "demo",
    skill_version: "1.0.0",
    model: "openai/gpt-5",
    prompt_excerpt: "Start",
    prompt: "Start",
    status: "frozen",
    status_detail: null,
    created_at: "2026-07-16T00:00:00.000Z",
    last_active_at: null,
    transcript: [],
    warnings: [],
    transcript_event_sequence: 1,
    activation_revision: 0,
    reactivatable_until: null,
    can_reactivate: false,
    attachments: [],
    pending_prompts: [],
    artifacts: [],
  };
}

function chatState(): ChatState {
  return {
    items: Array.from({ length: 8 }, (_, index) => index % 2 === 0
      ? {
          kind: "user" as const,
          id: `user:${index}`,
          text: `Question ${index}`,
          messageId: `user-${index}`,
          attachments: [],
        }
      : {
          kind: "asst" as const,
          id: `assistant:${index}`,
          messageId: `assistant-${index}`,
          text: `Answer ${index}`,
          streaming: false,
        }),
    busy: false,
    working: { active: false, label: "" },
    sessionId: null,
    error: null,
    warnings: [],
  };
}

describe("ChatTranscript scroller", () => {
  it("marks user turns as anchors and exposes the shadcn jump-to-latest control", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const initialChat = chatState();
    const baseProps = {
      run: runDetail(),
      showPromptBubble: false,
      showWorking: false,
      streamDead: false,
      rowExpanded: () => false,
      onToggleRow: () => undefined,
      onReconnect: () => undefined,
      onOpenFiles: () => undefined,
    };
    await act(async () => {
      root?.render(React.createElement(ChatTranscript, {
        ...baseProps,
        chat: initialChat,
      }));
    });

    const userItems = Array.from(container.querySelectorAll('[data-message-id^="user:"]'));
    expect(userItems).toHaveLength(4);
    expect(userItems.every((item) => item.getAttribute("data-scroll-anchor") === "true")).toBe(true);

    const viewport = container.querySelector<HTMLElement>(".run-transcript__viewport")!;
    expect(viewport.getAttribute("role")).toBe("log");
    expect(viewport.getAttribute("aria-relevant")).toBe("additions");
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, bottom: 200, left: 0, right: 400, width: 400, height: 200, x: 0, y: 0, toJSON: () => ({}) }),
    });
    const items = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]"));
    items.forEach((item, index) => {
      Object.defineProperty(item, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          top: index * 96 - viewport.scrollTop,
          bottom: index * 96 + 80 - viewport.scrollTop,
          left: 0,
          right: 400,
          width: 400,
          height: 80,
          x: 0,
          y: index * 96 - viewport.scrollTop,
          toJSON: () => ({}),
        }),
      });
    });

    await act(async () => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(container.querySelector(".run-chat-jump")?.getAttribute("data-active")).toBe("true");

    viewport.scrollTop = 220;
    await act(async () => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      root?.render(React.createElement(ChatTranscript, {
        ...baseProps,
        chat: {
          ...initialChat,
          items: [
            ...initialChat.items,
            { kind: "asst", id: "assistant:new", messageId: "assistant-new", text: "New streamed answer", streaming: true },
          ],
        },
      }));
      await Promise.resolve();
    });
    expect(viewport.scrollTop).toBe(220);
  });

  it("places each Project file result after its exact turn and opens that version", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onOpenFiles = vi.fn();
    const chat = {
      ...chatState(),
      error: "OpenCode provider diagnostic",
    };

    await act(async () => {
      root?.render(
        React.createElement(ChatTranscript, {
          run: null,
          chat,
          showPromptBubble: false,
          showWorking: false,
          streamDead: false,
          rowExpanded: () => false,
          onToggleRow: () => undefined,
          onReconnect: () => undefined,
          onOpenFiles,
          showChatError: false,
          generatedFileTurns: [
            {
              messageId: "user-0",
              files: [
                {
                  id: "file-1",
                  path: "files/launch.md",
                  name: "launch.md",
                  version: 3,
                  contentType: "text/markdown",
                  byteSize: 320,
                  action: "updated",
                },
                {
                  id: "file-2",
                  path: "files/summary.pdf",
                  name: "summary.pdf",
                  version: 1,
                  contentType: "application/pdf",
                  byteSize: 640,
                  action: "created",
                },
              ],
            },
          ],
        }),
      );
    });

    const messageIds = Array.from(
      container.querySelectorAll<HTMLElement>("[data-message-id]"),
    ).map((item) => item.dataset.messageId);
    expect(messageIds.slice(0, 4)).toEqual([
      "user:0",
      "assistant:1",
      "project:generated-files:user-0",
      "user:2",
    ]);
    const marker = container.querySelector<HTMLElement>(
      ".run-generated-marker--project",
    )!;
    expect(marker.textContent).toContain("Created files · 1");
    expect(marker.textContent).toContain("Updated files · 1");
    expect(marker.textContent).toContain("launch.md");
    expect(marker.textContent).toContain("summary.pdf");
    expect(container.textContent).not.toContain("OpenCode provider diagnostic");
    const fileButtons = Array.from(
      marker.querySelectorAll<HTMLButtonElement>("[data-project-file-id]"),
    );
    expect(fileButtons).toHaveLength(2);
    act(() => fileButtons[0]?.click());
    expect(onOpenFiles).toHaveBeenCalledWith(
      "file-1",
      3,
      expect.objectContaining({
        path: "files/launch.md",
        contentType: "text/markdown",
        byteSize: 320,
      }),
    );
    act(() => fileButtons[1]?.click());
    expect(onOpenFiles).toHaveBeenLastCalledWith(
      "file-2",
      1,
      expect.objectContaining({
        path: "files/summary.pdf",
        contentType: "application/pdf",
        byteSize: 640,
      }),
    );
  });
});
