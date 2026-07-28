// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRowVM, ProjectSessionVM } from "@/lib/projectsModel";
import type { OrgVM } from "@/lib/types";
import { ProjectsSidebar } from "./ProjectsSidebar";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const roots: Root[] = [];

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

function session(overrides: Partial<ProjectSessionVM> = {}): ProjectSessionVM {
  return {
    id: "22222222-2222-4222-8222-222222222201",
    projectId: PROJECT_ID,
    title: "Draft the launch calendar",
    model: "openai/gpt-5",
    status: "idle",
    isUnread: false,
    archivedAt: null,
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
    lastViewedAt: null,
    prompts: [],
    questions: [],
    transcript: [],
    ...overrides,
  } as ProjectSessionVM;
}

/** Six conversations means the newest five are listed and the oldest is only reachable via the roll-up. */
function project(overrides: Partial<ProjectRowVM> = {}): ProjectRowVM {
  const recentSessions = Array.from({ length: 5 }, (_, index) =>
    session({
      id: `22222222-2222-4222-8222-22222222220${index + 1}`,
      title: `Conversation ${index + 1}`,
      createdAt: `2026-07-2${index + 3}T10:00:00.000Z`,
    }),
  );
  return {
    id: PROJECT_ID,
    name: "Customer research",
    defaultModel: "openai/gpt-5",
    revision: 1,
    status: "running",
    statusDetail: null,
    errorCode: null,
    skillCount: 0,
    sessionCount: 6,
    activeSessionCount: 0,
    archivedSessionCount: 0,
    unreadSessionCount: 0,
    fileCount: 0,
    secretCount: 0,
    archivedAt: null,
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
    recentSessions,
    ...overrides,
  } as ProjectRowVM;
}

/** React tracks the value node, so a plain assignment does not reach onChange. */
function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const ORG: OrgVM = {
  id: "org",
  name: "The Vibe Company",
  slug: "tvc",
  kind: "team",
  myRole: "owner",
  color: null,
  logoUrl: null,
};

async function mount(projects: ProjectRowVM[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      React.createElement(ProjectsSidebar, {
        projects,
        selectedProjectId: PROJECT_ID,
        selectedSessionId: null,
        orgs: [ORG],
        currentOrg: ORG,
        runtimeAvailable: true,
        mobileOpen: false,
        onToggleMobile: vi.fn(),
        onCloseMobile: vi.fn(),
        onSwitchOrg: vi.fn(),
        onOnboard: vi.fn(),
        onNewProject: vi.fn(),
        onNewSession: vi.fn(),
        onProjectSettings: vi.fn(),
        onArchiveProject: vi.fn(),
        onRenameSession: vi.fn(),
        onArchiveSession: vi.fn(),
      }),
    );
    await Promise.resolve();
  });
  return container;
}

describe("ProjectsSidebar background signals", () => {
  /**
   * Conversations keep their canonical creation order and only the newest five are listed, but that
   * list is the only carrier of Working / New result / Failed. Without a roll-up, a conversation
   * working in the background below the fold showed no signal anywhere.
   */
  it("rolls up work happening outside the visible conversations", async () => {
    const container = await mount([
      project({ activeSessionCount: 1, unreadSessionCount: 2 }),
    ]);
    const rollup = container.querySelector(".projects-side__all");
    expect(rollup?.textContent).toContain("All conversations");
    expect(rollup?.textContent).toContain("1 working");
    expect(rollup?.textContent).toContain("2 new");
  });

  it("stays quiet when every signalled conversation is already listed", async () => {
    const listed = Array.from({ length: 5 }, (_, index) =>
      session({
        id: `22222222-2222-4222-8222-22222222220${index + 1}`,
        title: `Conversation ${index + 1}`,
        createdAt: `2026-07-2${index + 3}T10:00:00.000Z`,
        status: index === 0 ? "working" : "idle",
        isUnread: index === 1,
      }),
    );
    const container = await mount([
      project({
        recentSessions: listed,
        activeSessionCount: 1,
        unreadSessionCount: 1,
      }),
    ]);
    const rollup = container.querySelector(".projects-side__all");
    expect(rollup?.textContent).toContain("All conversations");
    expect(rollup?.textContent).not.toContain("working");
    expect(rollup?.textContent).not.toContain("new");
  });

  it("searches Project names only, because conversation titles are capped at five server-side", async () => {
    const container = await mount([
      project(),
      project({
        id: "33333333-3333-4333-8333-333333333333",
        name: "Pricing study",
        recentSessions: [],
        sessionCount: 0,
      }),
    ]);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".side__search")!
        .click();
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>(
      ".projects-side__search input",
    )!;
    // A conversation title that exists in the loaded rows still must not masquerade as a result.
    fill(input, "launch calendar");
    expect(container.textContent).toContain("No matching projects.");

    fill(input, "pricing");
    expect(container.textContent).toContain("Pricing study");
    expect(container.textContent).not.toContain("Customer research");
  });
});
