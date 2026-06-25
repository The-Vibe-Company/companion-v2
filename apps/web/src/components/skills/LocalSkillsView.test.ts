// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSkillRow } from "@companion/contracts";
import { LocalSkillsView } from "./LocalSkillsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({
  fetchLocalSkills: vi.fn(),
  issueToken: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/queries", () => ({
  apiBase: () => "http://127.0.0.1:3001",
  fetchLocalSkills: queryMocks.fetchLocalSkills,
  issueToken: queryMocks.issueToken,
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
  prompts: {
    install: "install {base} {workspaceId} {token}",
    update: "update {base} {workspaceId} {token}",
    use: "use {base} {workspaceId} {token}",
  },
};

const mountedRoots: Root[] = [];

async function mount(required = true) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(LocalSkillsView, {
        skills: [baseSkill],
        workspaceId: "org-1",
        workspaceName: "Acme",
        required,
      }),
    );
  });
  return container;
}

describe("LocalSkillsView required setup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    routerMock.replace.mockReset();
    routerMock.refresh.mockReset();
    queryMocks.fetchLocalSkills.mockReset();
    queryMocks.issueToken.mockResolvedValue({ token: "cmp_pat_test" });
  });

  afterEach(() => {
    act(() => {
      for (const root of mountedRoots.splice(0)) root.unmount();
    });
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("redirects to Skills when the out-of-band Companion install is reported", async () => {
    queryMocks.fetchLocalSkills.mockResolvedValueOnce([
      {
        ...baseSkill,
        status: "installed",
        installedVersion: "1.0.0",
        lastReportedAt: "2026-06-25T00:00:00.000Z",
      },
    ]);

    await mount(true);
    expect(routerMock.replace).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(queryMocks.fetchLocalSkills).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).toHaveBeenCalledWith("/skills");
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not poll in the optional Companion skills view", async () => {
    await mount(false);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(queryMocks.fetchLocalSkills).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});
