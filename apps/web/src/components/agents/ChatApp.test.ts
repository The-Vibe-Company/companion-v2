// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentVM } from "@/lib/types";
import { ChatApp } from "./ChatApp";

const agentQueryMocks = vi.hoisted(() => ({
  wakeAgent: vi.fn(),
  createChatSession: vi.fn(),
  sendChatPrompt: vi.fn(),
}));

vi.mock("@/lib/agentQueries", () => agentQueryMocks);

const chatStreamMocks = vi.hoisted(() => ({
  openChatStream: vi.fn(),
}));

// Keep the pure pieces (reducer, parser) real; only the network stream is mocked.
vi.mock("./chatStream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatStream")>();
  return { ...actual, openChatStream: chatStreamMocks.openChatStream };
});

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: vi.fn(), prefetch: vi.fn() }),
}));

function agentVM(overrides: Partial<AgentVM> = {}): AgentVM {
  return {
    uuid: "agent-mail-digest",
    id: "mail-digest",
    scope: "personal",
    creatorId: "user-1",
    client: "TVC",
    groupLabel: null,
    description: "Summarizes the shared inbox.",
    model: "openai/gpt-5.5",
    region: "cdg1",
    status: "running",
    sandboxName: "sb-01jb2k",
    skills: [
      { skillId: "skill-1", id: "meeting-digest", version: "1.3.0", latest: "1.3.0", outdated: false },
      { skillId: "skill-2", id: "seo-helper", version: "1.0.0", latest: "1.0.0", outdated: false },
    ],
    outdatedCount: 0,
    sessionsCount: 0,
    pendingOp: null,
    lastActive: "just now",
    created: "Jun 1, 2026",
    instructions: "",
    sandboxId: "sb-internal",
    lastResumeMs: null,
    provision: { attempt: 1, steps: [], error: null },
    secrets: [],
    sessions: [],
    ...overrides,
  };
}

let mountedRoots: Root[] = [];

/** Mount inside StrictMode so double-invoked effects catch any non-guarded one-shot RPCs. */
async function mountChatApp(agent: AgentVM) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(React.StrictMode, null, React.createElement(ChatApp, { agent, orgName: "Acme" })),
    );
  });
  await flushEffects();
  return { container, root };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Could not find button: ${label}`);
  return button;
}

function setReactInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  agentQueryMocks.wakeAgent.mockResolvedValue({ ok: true, resume_ms: 2400, status: "running" });
  agentQueryMocks.createChatSession.mockResolvedValue({ session_id: "sess-1" });
  agentQueryMocks.sendChatPrompt.mockResolvedValue({ ok: true });
  chatStreamMocks.openChatStream.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => root.unmount());
  }
  mountedRoots = [];
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("ChatApp", () => {
  it("renders the frame header with the agent name, status word, skill chips, composer and footnote", async () => {
    const { container } = await mountChatApp(agentVM());

    expect(container.querySelector('[data-screen-label="Agent chat"]')).toBeTruthy();
    expect(container.textContent).toContain("end-user surface preview");
    expect(container.textContent).toContain("mail-digest");
    expect(container.textContent).toContain("running");

    const chips = Array.from(container.querySelectorAll(".chip")).map((chip) => chip.textContent?.trim());
    expect(chips).toContain("meeting-digest@1.3.0");
    expect(chips).toContain("seo-helper@1.0.0");

    const input = container.querySelector<HTMLInputElement>('input[placeholder="Message mail-digest"]');
    expect(input).toBeTruthy();
    expect(findButton(container, "Send").disabled).toBe(true);
    expect(container.textContent).toContain(
      "mail-digest runs curated skills in an isolated sandbox. Skill runs are shown inline.",
    );

    // Running agent: no wake, one session (StrictMode double-mount safe), stream opened for it.
    expect(agentQueryMocks.wakeAgent).not.toHaveBeenCalled();
    expect(agentQueryMocks.createChatSession).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("session started · cdg1");
  });

  it("shows the wake banner for a sleeping agent and wakes it exactly once", async () => {
    let resolveWake: (value: { ok: true; resume_ms: number; status: "running" }) => void = () => {};
    agentQueryMocks.wakeAgent.mockImplementation(
      () => new Promise((resolve) => (resolveWake = resolve)),
    );

    const { container } = await mountChatApp(agentVM({ status: "sleeping" }));

    // While the wake RPC is pending: banner copy + sweep track + "waking" status word.
    expect(container.textContent).toContain("Waking your agent");
    expect(container.textContent).toContain("Resuming sandbox from snapshot. Usually a few seconds.");
    expect(container.querySelector(".chat-wake__track")).toBeTruthy();
    expect(container.textContent).toContain("waking");
    expect(findButton(container, "Send").disabled).toBe(true);

    await act(async () => {
      resolveWake({ ok: true, resume_ms: 2400, status: "running" });
      await Promise.resolve();
    });
    await flushEffects();

    expect(agentQueryMocks.wakeAgent).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".chat-wake__track")).toBeFalsy();
    expect(container.textContent).toContain("resumed from snapshot · cdg1 · 2.4s");
    expect(agentQueryMocks.createChatSession).toHaveBeenCalledTimes(1);
  });

  it("appends the user bubble and sends the prompt exactly once", async () => {
    const { container } = await mountChatApp(agentVM());

    const input = container.querySelector<HTMLInputElement>('input[placeholder="Message mail-digest"]');
    if (!input) throw new Error("Could not find the composer input");
    setReactInputValue(input, "Quick check. What did you do on your last run?");
    expect(findButton(container, "Send").disabled).toBe(false);

    click(findButton(container, "Send"));
    await flushEffects();

    expect(container.textContent).toContain("Quick check. What did you do on your last run?");
    expect(agentQueryMocks.sendChatPrompt).toHaveBeenCalledTimes(1);
    expect(agentQueryMocks.sendChatPrompt).toHaveBeenCalledWith(
      "mail-digest",
      "sess-1",
      "Quick check. What did you do on your last run?",
    );

    // Busy until the reply completes over the stream — the composer stays disabled.
    expect(findButton(container, "Send").disabled).toBe(true);
  });
});
