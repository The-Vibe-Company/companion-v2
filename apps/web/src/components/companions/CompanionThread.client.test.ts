// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Companion, CompanionThread as Thread } from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionThread, type CompanionComputerPanel } from "./CompanionThread";
import { CHAT_VIEWPORT_SETTLE_MS } from "./useVisualViewportPin";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionId = "11111111-1111-4111-8111-111111111111";

const companion: Companion = {
  id: companionId,
  name: "Luna",
  persona: "Content marketing assistant",
  model_id: "claude-opus-4-8",
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

/** A closed Computer panel: what a thread opens with, and what most of these cases render. */
function computerPanel(overrides: Partial<CompanionComputerPanel> = {}): CompanionComputerPanel {
  return {
    open: false,
    desktop: null,
    joining: false,
    error: null,
    onToggle: () => {},
    onJoin: () => {},
    ...overrides,
  };
}

async function mount(
  onSend: (content: string, clientMessageId: string) => Promise<boolean>,
  overrides: {
    companion?: Companion;
    thread?: Thread;
    onDesktop?: () => void;
    onWake?: () => void;
    computer?: Partial<CompanionComputerPanel>;
  } = {},
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
      computer: computerPanel(overrides.computer),
      onBack: () => {},
      onSend,
      onWake: overrides.onWake ?? (() => {}),
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
        computer: computerPanel(),
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

function sendButton(container: HTMLElement) {
  return container.querySelector(".chat-send") as HTMLButtonElement;
}

/** A finger landing on a control, which is the moment iOS starts resolving a tap. */
function pressed(target: Element) {
  const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

async function keyDown(target: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
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

  it("reuses the message id when a restored draft is sent again", async () => {
    // THE-341: a send that wakes an asleep Companion persists the turn before the wake it waits on, so
    // a request that dies mid-wake still left it durable. Pressing Enter on the restored draft must
    // name that same turn rather than mint a second one, or the durable message is stored twice.
    const ids: string[] = [];
    let answer = false;
    const container = await mount(async (_content, clientMessageId) => {
      ids.push(clientMessageId);
      return answer;
    });
    const composer = type(container, "Draft the launch note");

    await send(container);
    expect(composer.value).toBe("Draft the launch note");

    answer = true;
    await send(container);

    expect(composer.value).toBe("");
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it("mints a fresh id once a restored draft is edited before resending", async () => {
    // Reuse is only for the identical draft: a message the sender changed before retrying is a
    // different message, so it must name a different turn.
    const ids: string[] = [];
    const container = await mount(async (_content, clientMessageId) => {
      ids.push(clientMessageId);
      return false;
    });
    type(container, "Draft the launch note");
    await send(container);
    type(container, "Draft the changelog entry");
    await send(container);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
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

  it("names each message once, so a resent request can only be the same turn", async () => {
    const ids: string[] = [];
    const container = await mount(async (_content, clientMessageId) => {
      ids.push(clientMessageId);
      return true;
    });

    type(container, "Draft the launch note");
    await send(container);
    type(container, "And the changelog entry");
    await send(container);

    // One id per submission: the control plane stores the turn a resent request names once, and two
    // separate messages are still two turns.
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("shows one message when the saved thread arrives while the send is still in flight", async () => {
    // The message a composer shows carries the id the control plane stores it under, so a thread read
    // that lands mid-send replaces it instead of adding a second copy of the same turn.
    let sentId = "";
    let settle: (saved: boolean) => void = () => {};
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const render = (next: Thread) => React.createElement(CompanionThread, {
      companion,
      thread: next,
      error: null,
      busy: false,
      waking: false,
      openingDesktop: false,
      computer: computerPanel(),
      onBack: () => {},
      onSend: (_content: string, clientMessageId: string) => {
        sentId = clientMessageId;
        return new Promise<boolean>((resolve) => { settle = resolve; });
      },
      onWake: () => {},
      onDesktop: () => {},
    });
    await act(async () => {
      root.render(render(thread));
    });
    type(container, "Draft the launch note");
    await send(container);

    await act(async () => {
      root.render(render({
        ...thread,
        entries: [{
          event_id: `msg:${sentId}`,
          ordinal: 0,
          role: "user",
          content: "Draft the launch note",
          author_id: "user-1",
          author_name: null,
          created_at: "2026-08-12T12:01:00.000Z",
        }],
      }));
    });

    expect(container.querySelectorAll(".chat-turn--said")).toHaveLength(1);

    await act(async () => {
      settle(true);
    });

    expect(container.querySelectorAll(".chat-turn--said")).toHaveLength(1);
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

  it("carries the state word in its own element so a phone header can drop the prefix", async () => {
    // THE-345: `Box · asleep` does not fit beside Back, the name, and Wake at 320px. The phone
    // stylesheet hides the prefix, so the word has to be addressable on its own — and it has to stay,
    // because the dot's colour is not allowed to be the only thing reporting status.
    const container = await mount(async () => true);
    const chip = boxChip(container);

    expect(chip.querySelector(".chat-box__prefix")?.textContent).toBe("Box ·");
    expect(chip.querySelector(".chat-box__state")?.textContent).toBe("online");
    expect(chip.textContent).toContain("Box · online");
  });

  it("hands a runner the Box desktop from the status chip", async () => {
    let opened = 0;
    const container = await mount(async () => true, { onDesktop: () => { opened += 1; } });

    await act(async () => {
      boxChip(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(opened).toBe(1);
  });

  it("keeps the Viewer's chip on the same two halves", async () => {
    const container = await mount(async () => true, {
      companion: { ...companion, access: "viewer" },
      thread: { ...thread, access: "viewer", read_only: true, can_send: false },
    });
    const chip = boxChip(container);

    expect(chip.querySelector(".chat-box__prefix")?.textContent).toBe("Box ·");
    expect(chip.querySelector(".chat-box__state")?.textContent).toBe("online");
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

/**
 * Product promise:
 * A runner watches the Box desktop beside the conversation instead of in another tab, and the tab is
 * still there for the person who wants the full screen. Nothing on the panel starts a Box, and a
 * Viewer — who must never start one — is never offered it.
 *
 * Why this test is component-level:
 * The panel and the conversation share the thread. What has to hold is that the second pane appears
 * beside the assistant-ui transcript rather than in place of it, and that the controls it carries are
 * exactly the ones the open Companion's access allows.
 */
describe("CompanionThread Computer panel", () => {
  const asleep: Companion = {
    ...companion,
    runtime: { ...companion.runtime, state: "stopped", daemon_state: "stopped" },
  };

  function panel(container: HTMLElement) {
    return container.querySelector(".chat-computer") as HTMLElement | null;
  }

  function computerToggle(container: HTMLElement) {
    return container.querySelector(".chat-computer-toggle") as HTMLButtonElement | null;
  }

  function actionNamed(container: HTMLElement, label: string) {
    return [...container.querySelectorAll(".chat-computer__actions button")]
      .find((button) => (button.textContent ?? "").includes(label)) as HTMLButtonElement | undefined;
  }

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("shows a runner the live desktop beside the conversation once the Box is running", async () => {
    const container = await mount(async () => true, {
      computer: {
        open: true,
        desktop: {
          desktop_url: "https://box.ascii.dev/vnc/bx_23456789?token=opaque",
          provisioning: false,
          automation: "lux",
          transport: "vnc",
        },
      },
    });
    const frame = container.querySelector(".chat-computer__frame") as HTMLIFrameElement;

    expect(panel(container)).not.toBeNull();
    expect(frame.getAttribute("src")).toBe("https://box.ascii.dev/vnc/bx_23456789?token=opaque");
    expect(frame.getAttribute("title")).toBe("Luna's screen");
    // The desktop is another origin's document. Framing it must not hand it this app: no navigating
    // the top level away, and no popups opened as us.
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups");
    // The panel is a second pane, not a replacement: the conversation and its composer stay mounted.
    expect(container.querySelector(".chat-thread")).not.toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
    // The stream this join got is named rather than left for the picture to imply.
    expect(container.querySelector(".chat-computer__transport")?.textContent).toBe("vnc");
  });

  it("keeps the desktop tab reachable from the panel", async () => {
    let opened = 0;
    const container = await mount(async () => true, {
      onDesktop: () => { opened += 1; },
      computer: {
        open: true,
        desktop: {
          desktop_url: "https://box.ascii.dev/vnc/bx_23456789?token=opaque",
          provisioning: false,
          automation: "lux",
          transport: "vnc",
        },
      },
    });

    await act(async () => {
      actionNamed(container, "Open desktop")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(opened).toBe(1);
  });

  it("mints another desktop when the runner reconnects the panel", async () => {
    let joins = 0;
    const container = await mount(async () => true, {
      computer: { open: true, onJoin: () => { joins += 1; } },
    });

    await act(async () => {
      actionNamed(container, "Reconnect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Box rotates the stream token on every state change, so reconnecting asks for a URL rather than
    // replaying the last one.
    expect(joins).toBe(1);
  });

  it("offers a sleeping Box the wake control instead of a stream", async () => {
    let woken = 0;
    const container = await mount(async () => true, {
      companion: asleep,
      onWake: () => { woken += 1; },
      computer: {
        open: true,
        // A stream minted before the Box stopped is not a stream: a sleeping Box has no desktop.
        desktop: {
          desktop_url: "https://box.ascii.dev/vnc/bx_23456789?token=stale",
          provisioning: false,
          automation: "lux",
          transport: "vnc",
        },
      },
    });

    expect(container.querySelector(".chat-computer__frame")).toBeNull();
    expect(container.innerHTML).not.toContain("token=stale");
    expect(panel(container)?.textContent).toContain("this Box is not running");
    // Waking is the same control the header offers, so the panel adds no second lifecycle path.
    await act(async () => {
      actionNamed(container, "Wake")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(woken).toBe(1);
  });

  it("says why a join produced no screen without spelling out the URL", async () => {
    const container = await mount(async () => true, {
      computer: {
        open: true,
        desktop: { desktop_url: null, provisioning: true, automation: "lux", transport: null },
        error: "The Box desktop is still starting. Reconnect in a moment.",
      },
    });

    expect(panel(container)?.textContent).toContain("The Box desktop is still starting");
    expect(container.querySelector(".chat-computer__frame")).toBeNull();
  });

  it("never offers a Viewer the panel or its toggle", async () => {
    const container = await mount(async () => true, {
      companion: { ...companion, access: "viewer", runtime: { ...companion.runtime, box_id: null } },
      thread: { ...thread, access: "viewer", read_only: true, can_send: false },
      // Even asked for, the panel is not a Viewer's surface: they must never be handed a control that
      // looks as though it could start a Box.
      computer: { open: true },
    });

    expect(computerToggle(container)).toBeNull();
    expect(panel(container)).toBeNull();
  });

  it("reports whether the panel is open on the control that opens it", async () => {
    let toggles = 0;
    const closed = await mount(async () => true, {
      computer: { open: false, onToggle: () => { toggles += 1; } },
    });

    expect(computerToggle(closed)?.getAttribute("aria-pressed")).toBe("false");
    expect(panel(closed)).toBeNull();

    await act(async () => {
      computerToggle(closed)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(toggles).toBe(1);

    const open = await mount(async () => true, { computer: { open: true } });

    expect(computerToggle(open)?.getAttribute("aria-pressed")).toBe("true");
  });
});

/**
 * Product promise:
 * A message can be sent from a phone: the Send control answers the finger that touched it, and the
 * keyboard's own Send key sends the draft.
 *
 * Regression caught:
 * THE-346 — sending from a phone stopped working. iOS resolves a tap on Send by blurring the composer
 * first, so the keyboard closes, the visual viewport grows, the thread pinned to it is laid out again,
 * and the `click` arrives where the button no longer is.
 *
 * Why this test is component-level:
 * The composer, the runtime it sends through, and the viewport pin all take part in one tap. The
 * failure is in how they are sequenced, which only shows up with all three mounted together.
 *
 * Failure proof:
 * Moving the send back to `click`, dropping the prevented default that keeps the field focused, or
 * letting the growing viewport through mid-tap each fails a case below.
 */
describe("CompanionThread mobile send", () => {
  class FakeVisualViewport extends EventTarget {
    height = 350;
    offsetTop = 24;
  }

  const viewport = new FakeVisualViewport();

  /** The tap iOS actually delivers: finger down, field blurred, keyboard on its way out. */
  function tapWithKeyboardClosing(container: HTMLElement) {
    const composer = container.querySelector("textarea") as HTMLTextAreaElement;
    pressed(sendButton(container));
    composer.dispatchEvent(new Event("focusout", { bubbles: true }));
    viewport.height = 640;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
  }

  beforeEach(() => {
    viewport.height = 350;
    viewport.offsetTop = 24;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("sends the draft on the press that starts the tap", async () => {
    const sent: string[] = [];
    const container = await mount(async (content) => {
      sent.push(content);
      return true;
    });
    const composer = type(container, "Draft the launch note");

    // The click never arrives in this test, which is exactly what the phone does when the shell moves
    // under the finger: if the message still goes out, the tap was never the thing carrying it.
    await act(async () => {
      tapWithKeyboardClosing(container);
    });

    expect(sent).toEqual(["Draft the launch note"]);
    expect(composer.value).toBe("");
  });

  it("refuses the press default so the composer keeps focus and the keyboard stays put", async () => {
    const container = await mount(async () => true);
    type(container, "Draft the launch note");

    let press!: PointerEvent;
    await act(async () => {
      press = pressed(sendButton(container));
    });

    // Letting the default through is what blurs the field, and the blur is what closes the keyboard
    // and moves everything the finger was aiming at.
    expect(press.defaultPrevented).toBe(true);
  });

  it("sends once when the browser follows the press with a click", async () => {
    const sent: string[] = [];
    const container = await mount(async (content) => {
      sent.push(content);
      return true;
    });
    type(container, "Draft the launch note");

    await act(async () => {
      pressed(sendButton(container));
      sendButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(sent).toEqual(["Draft the launch note"]);
  });

  it("leaves a refused draft alone when the click lands after the press that failed", async () => {
    // A refused send hands the text back to the composer. The click belonging to that same press must
    // not pick the restored draft up and send it again behind the sender's back.
    const sent: string[] = [];
    const container = await mount(async (content) => {
      sent.push(content);
      return false;
    });
    const composer = type(container, "Draft the launch note");

    await act(async () => {
      pressed(sendButton(container));
    });
    expect(composer.value).toBe("Draft the launch note");

    await act(async () => {
      sendButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(sent).toEqual(["Draft the launch note"]);
    expect(composer.value).toBe("Draft the launch note");
  });

  it("still sends when a click arrives long after a press whose own click was lost", async () => {
    // A phone that dropped the click leaves nothing to swallow. The next activation of the button is
    // a new message and must not be mistaken for the tail of the old one.
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const container = await mount(async (content) => {
        sent.push(content);
        return true;
      });
      type(container, "Draft the launch note");
      await act(async () => {
        tapWithKeyboardClosing(container);
      });
      expect(sent).toEqual(["Draft the launch note"]);

      type(container, "And the changelog entry");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      await act(async () => {
        sendButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      expect(sent).toEqual(["Draft the launch note", "And the changelog entry"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still sends a click no press came before, so the button stays reachable by keyboard", async () => {
    const sent: string[] = [];
    const container = await mount(async (content) => {
      sent.push(content);
      return true;
    });
    type(container, "Draft the launch note");

    await act(async () => {
      sendButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(sent).toEqual(["Draft the launch note"]);
  });

  it("asks the phone keyboard for a Send key", async () => {
    const container = await mount(async () => true);

    // A textarea offers `return`, which reads as a new line. Enter sends here, so the key has to say
    // so — the hint is the only thing that can tell the keyboard.
    expect(container.querySelector("textarea")?.getAttribute("enterkeyhint")).toBe("send");
  });

  it("sends on Enter and leaves Shift + Enter to the new line", async () => {
    const sent: string[] = [];
    const container = await mount(async (content) => {
      sent.push(content);
      return true;
    });
    const composer = type(container, "Draft the launch note");

    const newline = await keyDown(composer, { key: "Enter", shiftKey: true });

    // The composer does not touch this keystroke, so the browser inserts the line break itself.
    expect(newline.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);

    const submit = await keyDown(composer, { key: "Enter" });

    expect(submit.defaultPrevented).toBe(true);
    expect(sent).toEqual(["Draft the launch note"]);
    expect(composer.value).toBe("");
  });
});

/**
 * Product promise:
 * An open thread is sized on the box the phone keyboard leaves visible, so focusing the composer does
 * not push it behind the keyboard or pan the page.
 *
 * Regression caught:
 * THE-345 — `100dvh` is the layout viewport, which the keyboard does not shrink.
 *
 * Why this test is component-level:
 * The reporting has to start when a thread opens and stop when it closes; that lifecycle is the part
 * a stylesheet cannot state and arithmetic cannot prove.
 *
 * Failure proof:
 * Dropping the resize listener, or leaving the properties behind on unmount, fails a case below.
 */
describe("CompanionThread visual viewport", () => {
  class FakeVisualViewport extends EventTarget {
    height = 640;
    offsetTop = 0;
  }

  const viewport = new FakeVisualViewport();

  function pinned() {
    const root = document.documentElement;
    return {
      height: root.style.getPropertyValue("--chat-viewport-h"),
      top: root.style.getPropertyValue("--chat-viewport-top"),
    };
  }

  beforeEach(() => {
    viewport.height = 640;
    viewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("follows the keyboard shrinking and offsetting the visible box", async () => {
    await mount(async () => true);

    expect(pinned()).toEqual({ height: "640px", top: "0px" });

    await act(async () => {
      viewport.height = 350;
      viewport.offsetTop = 24;
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(pinned()).toEqual({ height: "350px", top: "24px" });
  });

  it("waits out the tap that closed the keyboard before growing back", async () => {
    // THE-346: the growth arrives between the press and the click it would move out from under the
    // finger, so the pin holds the box it was on until that tap has been delivered.
    vi.useFakeTimers();
    try {
      await mount(async () => true);
      await act(async () => {
        viewport.height = 350;
        viewport.offsetTop = 24;
        viewport.dispatchEvent(new Event("resize"));
      });
      expect(pinned()).toEqual({ height: "350px", top: "24px" });

      await act(async () => {
        document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        viewport.height = 640;
        viewport.offsetTop = 0;
        viewport.dispatchEvent(new Event("resize"));
      });

      expect(pinned()).toEqual({ height: "350px", top: "24px" });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHAT_VIEWPORT_SETTLE_MS);
      });

      // Nothing is left holding the thread short: the keyboard is gone and the page is whole again.
      expect(pinned()).toEqual({ height: "640px", top: "0px" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reporting once the thread is closed", async () => {
    await mount(async () => true);
    expect(pinned().height).toBe("640px");

    act(() => roots.splice(0).forEach((root) => root.unmount()));

    // A list page is an ordinary scrolling document; leaving a stale height behind would freeze it at
    // whatever the thread last measured.
    expect(pinned()).toEqual({ height: "", top: "" });
  });
});
