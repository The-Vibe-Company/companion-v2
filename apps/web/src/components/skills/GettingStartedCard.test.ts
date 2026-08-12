// @vitest-environment happy-dom

/**
 * Product promise:
 * The My Skills checklist is non-blocking, reflects only confirmed server progress, and copies a
 * resumable per-agent prompt without putting credentials in the browser.
 *
 * Regression caught:
 * A stale template, failed dismissal, workspace switch, late refresh, clipboard rejection, or
 * step-one transition could hide the card, regress progress, or block the agent handoff.
 *
 * Why this test is component-level:
 * The risk is React state plus browser clipboard/dismiss interaction; persistence is covered by API
 * integration and full navigation by Playwright.
 *
 * Failure proof:
 * Removing prompt filling, workspace/request fencing, optimistic rollback, manual-copy fallback,
 * or the onboarding-to-resume switch fails these visible and clipboard assertions.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GettingStartedState, LocalSkillRow } from "@companion/contracts";
import { GettingStartedCard } from "./GettingStartedCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const queryMocks = vi.hoisted(() => ({
  dismiss: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  apiBase: () => "https://companion.example/v1",
  dismissGettingStarted: queryMocks.dismiss,
  fetchGettingStarted: queryMocks.fetch,
}));

const emptyState: GettingStartedState = {
  companion_installed_at: null,
  local_reviewed_at: null,
  org_reviewed_at: null,
  completed_at: null,
  dismissed_at: null,
  completed: false,
  first_incomplete_step: "companion_install",
};

const skill: LocalSkillRow = {
  workspaceId: "org-1",
  key: "companion",
  name: "Companion",
  description: "Manage skills locally.",
  status: "none",
  installedVersion: null,
  availableVersion: "1.29.0",
  lastReportedAt: null,
  agentLabel: null,
  notes: "",
  commands: [],
  changes: [],
  integrity: {
    packageChecksum: `sha256:${"a".repeat(64)}`,
    files: { "SKILL.md": `sha256:${"b".repeat(64)}` },
  },
  prompts: {
    install: "install",
    update: "update",
    use: "use",
    onboarding: "onboard {base} {workspaceId} in {tool} as <your assistant> {token}",
    resume: "resume {base} {workspaceId} in {tool}",
  },
};

const roots: Root[] = [];

async function mount(state: GettingStartedState = emptyState) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(GettingStartedCard, {
      initialState: state,
      companionSkill: skill,
      workspaceId: "org-1",
    }));
  });
  return { container, root };
}

describe("GettingStartedCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryMocks.dismiss.mockReset();
    queryMocks.fetch.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("renders all steps with text statuses and copies the selected agent onboarding prompt", async () => {
    const { container } = await mount();
    expect(container.textContent).toContain("Getting started");
    expect(container.textContent?.match(/To do/g)).toHaveLength(3);
    expect(container.querySelectorAll(".gs-step__action")).toHaveLength(3);

    const select = container.querySelector("select");
    await act(async () => {
      if (select) {
        select.value = "codex";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    const firstAction = container.querySelector<HTMLButtonElement>(".gs-step__action");
    await act(async () => {
      firstAction?.click();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "onboard https://companion.example/v1 org-1 in Codex as Codex [PAT intentionally omitted; use Agent Auth]",
    );
    expect(queryMocks.fetch).not.toHaveBeenCalled();
  });

  it("copies a Grok Bot onboarding prompt", async () => {
    const { container } = await mount();
    const select = container.querySelector("select");
    await act(async () => {
      if (select) {
        select.value = "grok-bot";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".gs-step__action")?.click();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "onboard https://companion.example/v1 org-1 in Grok Bot (Cursor) as Grok Bot (Cursor) [PAT intentionally omitted; use Agent Auth]",
    );
  });

  it("switches every remaining action to the short resume prompt after installation", async () => {
    const { container } = await mount({
      ...emptyState,
      companion_installed_at: "2026-07-28T12:00:00.000Z",
      first_incomplete_step: "local_review",
    });
    expect(container.textContent?.match(/Done/g)).toHaveLength(1);
    const action = container.querySelector<HTMLButtonElement>(".gs-step__action");
    await act(async () => {
      action?.click();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "resume https://companion.example/v1 org-1 in Claude Code",
    );
  });

  it("rolls back optimistic hiding when dismissal fails", async () => {
    queryMocks.dismiss.mockRejectedValueOnce(new Error("offline"));
    const { container } = await mount();
    const hide = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Hide");
    await act(async () => {
      hide?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Getting started");
    expect(queryMocks.dismiss).toHaveBeenCalledWith("org-1");
  });

  it("resets hidden state when the active workspace changes", async () => {
    const { container, root } = await mount({
      ...emptyState,
      dismissed_at: "2026-07-28T12:00:00.000Z",
    });
    expect(container.textContent).not.toContain("Getting started");

    await act(async () => {
      root.render(React.createElement(GettingStartedCard, {
        initialState: emptyState,
        companionSkill: skill,
        workspaceId: "org-2",
      }));
    });

    expect(container.textContent).toContain("Getting started");
  });

  it("does not regress confirmed progress from a late same-workspace prop snapshot", async () => {
    const installedState: GettingStartedState = {
      ...emptyState,
      companion_installed_at: "2026-07-28T12:00:00.000Z",
      first_incomplete_step: "local_review",
    };
    const { container, root } = await mount(installedState);
    expect(container.textContent?.match(/Done/g)).toHaveLength(1);

    await act(async () => {
      root.render(React.createElement(GettingStartedCard, {
        initialState: emptyState,
        companionSkill: skill,
        workspaceId: "org-1",
      }));
    });

    expect(container.textContent?.match(/Done/g)).toHaveLength(1);
  });

  it("ignores a delayed dismissal response from the previous workspace", async () => {
    let resolveDismiss: (state: GettingStartedState) => void = () => {};
    queryMocks.dismiss.mockReturnValueOnce(
      new Promise<GettingStartedState>((resolve) => { resolveDismiss = resolve; }),
    );
    const { container, root } = await mount();
    const hide = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Hide",
    );

    await act(async () => {
      hide?.click();
    });
    await act(async () => {
      root.render(React.createElement(GettingStartedCard, {
        initialState: emptyState,
        companionSkill: skill,
        workspaceId: "org-2",
      }));
    });
    expect(container.textContent).toContain("Getting started");

    await act(async () => {
      resolveDismiss({ ...emptyState, dismissed_at: "2026-07-28T12:00:00.000Z" });
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Getting started");
  });

  it("does not let an older refresh restore incomplete progress", async () => {
    let resolveFirst: (state: GettingStartedState) => void = () => {};
    let resolveSecond: (state: GettingStartedState) => void = () => {};
    queryMocks.fetch
      .mockReturnValueOnce(new Promise<GettingStartedState>((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise<GettingStartedState>((resolve) => { resolveSecond = resolve; }));
    const { container } = await mount();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      resolveSecond({
        ...emptyState,
        companion_installed_at: "2026-07-28T12:00:00.000Z",
        local_reviewed_at: "2026-07-28T12:01:00.000Z",
        org_reviewed_at: "2026-07-28T12:02:00.000Z",
        completed_at: "2026-07-28T12:02:00.000Z",
        completed: true,
        first_incomplete_step: null,
      });
      await Promise.resolve();
    });
    expect(queryMocks.fetch).toHaveBeenNthCalledWith(1, "org-1");
    expect(queryMocks.fetch).toHaveBeenNthCalledWith(2, "org-1");
    expect(container.textContent).not.toContain("Getting started");

    await act(async () => {
      resolveFirst(emptyState);
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Getting started");
  });

  it("shows the prompt for manual copy when clipboard access fails", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    const { container } = await mount();
    const firstAction = container.querySelector<HTMLButtonElement>(".gs-step__action");

    await act(async () => {
      firstAction?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Copy failed. Select and copy this prompt manually.");
    expect(container.querySelector<HTMLTextAreaElement>(".gs-copy-fallback__prompt")?.value).toContain(
      "onboard https://companion.example/v1 org-1",
    );
  });
});
