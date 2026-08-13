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

  it("keeps the draft when Escape is pressed in the composer", async () => {
    const container = await mount(async () => true);
    const composer = type(container, "Draft the launch note");

    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(composer.value).toBe("Draft the launch note");
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
