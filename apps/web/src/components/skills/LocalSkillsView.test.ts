// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSkillRow } from "@companion/contracts";
import { LocalSkillsView } from "./LocalSkillsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const queryMocks = vi.hoisted(() => ({
  fetchLocalSkills: vi.fn(),
}));

// The view no longer touches the router (the install is not a hard gate), but keep a stub so any
// transitive import resolves.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/queries", () => ({
  apiBase: () => "http://127.0.0.1:3001",
  fetchLocalSkills: queryMocks.fetchLocalSkills,
}));

const baseSkill: LocalSkillRow = {
  workspaceId: "org-1",
  key: "companion",
  name: "Companion",
  description: "Manage skills locally.",
  status: "none",
  installedVersion: null,
  availableVersion: "1.0.0",
  lastReportedAt: null,
  agentLabel: null,
  notes: "A local helper skill.",
  commands: [],
  changes: [],
  integrity: { packageChecksum: `sha256:${"a".repeat(64)}`, files: { "SKILL.md": `sha256:${"b".repeat(64)}` } },
  prompts: {
    install: 'install {base} {workspaceId} with Agent Auth agent=<your assistant>',
    update: "update {base} {workspaceId} with Agent Auth",
    use: "use {base} {workspaceId} with Agent Auth",
  },
};

const mountedRoots: Root[] = [];

async function mount(skill: LocalSkillRow = baseSkill) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(LocalSkillsView, {
        skills: [skill],
        workspaceId: "org-1",
        workspaceName: "Acme",
      }),
    );
  });
  return container;
}

async function flush() {
  await act(async () => {
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("LocalSkillsView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryMocks.fetchLocalSkills.mockReset();
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    act(() => {
      for (const root of mountedRoots.splice(0)) root.unmount();
    });
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("auto-opens the dismissible connect dialog with an assistant chooser when not installed", async () => {
    const container = await mount();
    expect(container.textContent).toContain("Connect Companion to your assistant");
    // Both assistant tiles are offered; the install is no longer forced ("Maybe later" is available).
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("OpenCode");
    expect(container.textContent).toContain("Maybe later");
  });

  it("reports OpenCode as the installing assistant when selected", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const container = await mount();
    const buttons = Array.from(container.querySelectorAll("button"));
    const openCode = buttons.find((button) => button.textContent?.includes("OpenCode"));
    expect(openCode).toBeTruthy();

    await act(async () => {
      openCode?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const copy = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Copy prompt"),
    );
    expect(copy).toBeTruthy();

    await act(async () => {
      copy?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("agent=OpenCode"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Agent Auth"));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("cmp_pat_"));
  });

  it("flips to the Connected banner when an out-of-band install is reported", async () => {
    queryMocks.fetchLocalSkills.mockResolvedValueOnce([
      {
        ...baseSkill,
        status: "installed",
        installedVersion: "1.0.0",
        lastReportedAt: "2026-06-25T00:00:00.000Z",
      },
    ]);

    const container = await mount();
    expect(queryMocks.fetchLocalSkills).not.toHaveBeenCalled();

    await flush();

    expect(queryMocks.fetchLocalSkills).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Connected.");
    expect(container.textContent).not.toContain("Connect Companion to your assistant");
  });

  it("does not poll once the skill is installed", async () => {
    const container = await mount({
      ...baseSkill,
      status: "installed",
      installedVersion: "1.0.0",
      lastReportedAt: "2026-06-25T00:00:00.000Z",
    });
    expect(container.textContent).toContain("Connected.");

    await flush();

    expect(queryMocks.fetchLocalSkills).not.toHaveBeenCalled();
  });
});
