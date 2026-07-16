// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
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
});
