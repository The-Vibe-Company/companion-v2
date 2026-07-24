// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRowVM } from "@/lib/projectsModel";
import { ProjectRunPicker } from "./ProjectRunPicker";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const projectRpc = vi.hoisted(() => ({
  ensureProjectSkill: vi.fn(),
  fetchProjects: vi.fn(),
}));
const router = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("@/lib/projects", () => projectRpc);
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-07-23T10:00:00.000Z";
const roots: Root[] = [];

function project(overrides: Partial<ProjectRowVM> = {}): ProjectRowVM {
  return {
    id: PROJECT_ID,
    name: "Customer research",
    defaultModel: "openai/gpt-5",
    revision: 1,
    status: "stopped",
    statusDetail: null,
    skillCount: 0,
    sessionCount: 2,
    activeSessionCount: 0,
    archivedSessionCount: 0,
    unreadSessionCount: 0,
    fileCount: 1,
    secretCount: 0,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    recentSessions: [],
    ...overrides,
  };
}

async function mount(onClose = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      React.createElement(ProjectRunPicker, {
        skillSlug: "research",
        skillName: "Research",
        onClose,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, onClose };
}

function button(scope: ParentNode, text: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(text),
  );
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Button not found: ${text}`);
  return match;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("ProjectRunPicker", () => {
  it("shows a retryable load failure instead of a false empty state", async () => {
    projectRpc.fetchProjects
      .mockRejectedValueOnce(new Error("Projects request failed"))
      .mockResolvedValueOnce({
        projects: [project()],
        runtime: { available: true, message: null },
      });
    await mount();

    let dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Projects could not be loaded");
    expect(dialog.textContent).not.toContain("Create a project first");
    expect(button(dialog, "New project").disabled).toBe(true);

    await act(async () => {
      button(dialog, "Retry").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Customer research");
    expect(dialog.textContent).toContain("Sleeping");
    expect(button(dialog, "New project").disabled).toBe(false);
  });

  it("keeps the picker open while attaching the skill, then completes the handoff", async () => {
    let resolveAttach!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveAttach = resolve;
    });
    projectRpc.fetchProjects.mockResolvedValue({
      projects: [project()],
      runtime: { available: true, message: null },
    });
    projectRpc.ensureProjectSkill.mockReturnValue(pending);
    const onClose = vi.fn();
    await mount(onClose);

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => button(dialog, "Customer research").click());
    expect(button(dialog, "New project").disabled).toBe(true);
    expect(button(dialog, "Cancel").disabled).toBe(true);
    expect(
      dialog.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')
        ?.disabled,
    ).toBe(true);
    act(() => button(dialog, "Cancel").click());
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveAttach();
      await pending;
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}?newSession=1&skill=research`,
    );
  });
});
