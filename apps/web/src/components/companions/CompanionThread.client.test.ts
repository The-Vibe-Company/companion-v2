// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Companion, CompanionThread as Thread } from "@companion/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionThread } from "./CompanionThread";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionId = "11111111-1111-4111-8111-111111111111";

const companion: Companion = {
  id: companionId,
  name: "Luna",
  persona: "Content marketing assistant",
  owner_id: "user-1",
  access: "owner",
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

const thread: Thread = {
  companion_id: companionId,
  viewer_id: "user-1",
  access: "owner",
  read_only: false,
  can_send: true,
  entries: [],
  pending_count: 0,
  last_message_at: null,
};

const roots: Root[] = [];

async function mount(
  onSend: (content: string) => Promise<boolean>,
  overrides: { companion?: Companion; thread?: Thread; onDesktop?: () => void } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionThread, {
      companion: overrides.companion ?? companion,
      thread: overrides.thread ?? thread,
      error: null,
      busy: false,
      waking: false,
      openingDesktop: false,
      onBack: () => {},
      onSend,
      onWake: () => {},
      onDesktop: overrides.onDesktop ?? (() => {}),
    }));
  });
  return container;
}

/** A mounted thread whose read model can be replaced, the way each poll replaces it in the app. */
async function mountPolling(initial: Thread) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const poll = async (next: Thread, who: Companion = companion) => {
    await act(async () => {
      root.render(React.createElement(CompanionThread, {
        companion: who,
        thread: next,
        error: null,
        busy: false,
        waking: false,
        openingDesktop: false,
        onBack: () => {},
        onSend: async () => true,
        onWake: () => {},
        onDesktop: () => {},
      }));
    });
  };
  await poll(initial);
  return { container, poll };
}

function log(container: HTMLElement) {
  return (container.querySelector(".chat-log") as HTMLElement).textContent ?? "";
}

function boxChip(container: HTMLElement) {
  return container.querySelector(".chat-box") as HTMLElement;
}

function type(container: HTMLElement, value: string) {
  const composer = container.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(composer, value);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return composer;
}

async function send(container: HTMLElement) {
  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("CompanionThread composer", () => {
  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("keeps the typed message when the send fails", async () => {
    const container = await mount(async () => false);
    const composer = type(container, "Draft the launch note");

    await send(container);

    expect(composer.value).toBe("Draft the launch note");
  });

  it("clears the composer once the message is persisted", async () => {
    const container = await mount(async () => true);
    const composer = type(container, "Draft the launch note");

    await send(container);

    expect(composer.value).toBe("");
  });

  it("moves focus into the thread that just opened", async () => {
    const container = await mount(async () => true);

    expect(document.activeElement).toBe(container.querySelector("h1"));
  });

  it("shows the message while the control plane is still saving it", async () => {
    let settle: (saved: boolean) => void = () => {};
    const container = await mount(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    type(container, "Draft the launch note");

    await send(container);

    // The composer clears on send, so the message has to appear in the transcript immediately or the
    // text disappears with nothing to show for it.
    expect(log(container)).toContain("Draft the launch note");

    await act(async () => {
      settle(true);
    });

    // Once the saved thread arrives it owns the message; the sent copy is dropped in the same update.
    expect(container.querySelectorAll(".chat-turn--sending")).toHaveLength(0);
  });

  it("sends one message even when the composer is submitted twice", async () => {
    const sent: string[] = [];
    let settle: (saved: boolean) => void = () => {};
    const container = await mount((content) => {
      sent.push(content);
      return new Promise<boolean>((resolve) => { settle = resolve; });
    });
    type(container, "Draft the launch note");

    await send(container);
    await send(container);
    await act(async () => {
      settle(true);
    });

    expect(sent).toEqual(["Draft the launch note"]);
  });

  it("hands the next Companion an empty composer instead of the previous draft", async () => {
    const atlas: Companion = { ...companion, id: "22222222-2222-4222-8222-222222222222", name: "Atlas" };
    const { container, poll } = await mountPolling(thread);
    type(container, "Draft the launch note");

    await poll(thread, atlas);

    // A draft belongs to the conversation it was written for; carrying it over would put it one
    // Enter away from the wrong Companion.
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the draft when Escape is pressed in the composer", async () => {
    const container = await mount(async () => true);
    const composer = type(container, "Draft the launch note");

    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(composer.value).toBe("Draft the launch note");
  });
});

describe("CompanionThread stream", () => {
  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  const said = {
    event_id: "msg:1",
    ordinal: 0,
    role: "user" as const,
    content: "Draft the launch note",
    author_id: "user-1",
    author_name: null,
    created_at: "2026-08-12T12:01:00.000Z",
  };

  const reply = (content: string) => ({
    event_id: "pi:512",
    ordinal: 1,
    role: "assistant" as const,
    content,
    author_id: null,
    author_name: null,
    created_at: "2026-08-12T12:01:20.000Z",
  });

  it("grows a streamed reply in place instead of appending a second one", async () => {
    const { container, poll } = await mountPolling({ ...thread, entries: [said, reply("Skills Hub")] });
    const before = container.querySelector(".chat-turn--reply");

    await poll({ ...thread, entries: [said, reply("Skills Hub 2.4 is out. The migration is idempotent.")] });

    const after = container.querySelectorAll(".chat-turn--reply");
    expect(after).toHaveLength(1);
    // The same element carries the longer text: the reply is rewritten, never torn down and rebuilt,
    // which is what would make a streamed turn flicker.
    expect(after.item(0)).toBe(before);
    expect(after.item(0).textContent).toContain("The migration is idempotent.");
  });

  it("announces Luna once when a turn arrives as more than one reply", async () => {
    const { container, poll } = await mountPolling({
      ...thread,
      entries: [said, reply("Skills Hub 2.4 is out.")],
    });

    await poll({
      ...thread,
      entries: [
        said,
        reply("Skills Hub 2.4 is out."),
        {
          event_id: "pi:1180",
          ordinal: 2,
          role: "assistant" as const,
          content: "The migration is idempotent.",
          author_id: null,
          author_name: null,
          created_at: "2026-08-12T12:01:24.000Z",
        },
      ],
    });

    expect(container.querySelectorAll(".chat-turn--reply")).toHaveLength(2);
    // Two entries, one passage: the second reply continues the first instead of restating who is
    // talking and when.
    expect(log(container).match(/Luna/g)).toHaveLength(1);
    expect(container.querySelectorAll(".chat-turn--reply.chat-turn--lead")).toHaveLength(1);
  });

  it("shows a turn that only produced reasoning as Luna's reply", async () => {
    // A turn with no text part falls back to its thinking, so it arrives as an ordinary assistant
    // entry and has to read as a reply rather than as a note about the run.
    const { container } = await mountPolling({
      ...thread,
      entries: [said, reply("The note is already accurate, so there is nothing to change.")],
    });

    expect(container.querySelectorAll(".chat-turn--reply")).toHaveLength(1);
    expect(container.querySelectorAll(".chat-note")).toHaveLength(0);
    expect(log(container)).toContain("The note is already accurate");
  });

  it("closes a turn that produced nothing with a note instead of leaving the thread pending", async () => {
    const { container } = await mountPolling({
      ...thread,
      entries: [
        said,
        {
          event_id: "pi:1602",
          ordinal: 1,
          role: "system" as const,
          content: "Pi ended the turn without a visible reply.",
          author_id: null,
          author_name: null,
          created_at: "2026-08-12T12:01:20.000Z",
        },
      ],
    });

    expect(container.querySelectorAll(".chat-note")).toHaveLength(1);
    expect(log(container)).toContain("Pi ended the turn without a visible reply.");
    // The turn is closed, so nothing should still claim Luna is replying.
    expect(container.querySelectorAll(".chat-replying")).toHaveLength(0);
  });
});

describe("CompanionThread Box chip", () => {
  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("hands a runner the Box desktop from the status chip", async () => {
    let opened = 0;
    const container = await mount(async () => true, { onDesktop: () => { opened += 1; } });

    await act(async () => {
      boxChip(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(opened).toBe(1);
  });

  it("leaves a Viewer's chip inert so reading a thread cannot reach Box", async () => {
    let opened = 0;
    const container = await mount(async () => true, {
      companion: { ...companion, access: "viewer", runtime: { ...companion.runtime, box_id: null } },
      thread: { ...thread, access: "viewer", read_only: true, can_send: false },
      onDesktop: () => { opened += 1; },
    });
    const chip = boxChip(container);

    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(chip.tagName).toBe("SPAN");
    expect(opened).toBe(0);
  });
});
