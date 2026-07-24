// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectDetailVM,
  ProjectRowVM,
  ProjectRuntimeAvailability,
  ProjectSessionVM,
} from "@/lib/projectsModel";
import { ProjectsApp } from "./ProjectsApp";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const projectRpc = vi.hoisted(() => ({
  createProject: vi.fn(),
  createProjectSession: vi.fn(),
  deleteProject: vi.fn(),
  fetchProject: vi.fn(),
  fetchProjectFileVersions: vi.fn(),
  fetchProjectSessions: vi.fn(),
  fetchProjects: vi.fn(),
  projectFileHref: vi.fn(
    (projectId: string, fileId: string, download = false) =>
      `/v1/projects/${projectId}/files/${fileId}${download ? "?download=1" : ""}`,
  ),
  projectFileVersionHref: vi.fn(
    (
      projectId: string,
      fileId: string,
      version: number,
      download = false,
    ) =>
      `/v1/projects/${projectId}/files/${fileId}/versions/${version}${
        download ? "?download=1" : ""
      }`,
  ),
  replaceProjectSkills: vi.fn(),
  retryProjectWorkspace: vi.fn(),
  updateProject: vi.fn(),
  updateProjectSession: vi.fn(),
  uploadProjectFiles: vi.fn(),
}));
const orgRpc = vi.hoisted(() => ({ setCurrentOrg: vi.fn() }));
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => React.createElement("a", { href, ...props }, children),
}));
vi.mock("@/lib/projects", () => projectRpc);
vi.mock("@/lib/org", () => orgRpc);
vi.mock("../org/OrgSwitcher", () => ({
  OrgSwitcher: ({ onSwitch }: { onSwitch: (id: string) => void }) =>
    React.createElement(
      "button",
      { type: "button", onClick: () => onSwitch("org-2") },
      "Switch workspace",
    ),
}));
vi.mock("../org/Onboarding", () => ({ Onboarding: () => null }));
vi.mock("../org/useOrgActions", () => ({
  useOrgActions: () => ({
    onboarding: null,
    setOnboarding: vi.fn(),
    busy: false,
    error: null,
    setError: vi.fn(),
    createOrg: vi.fn(),
    joinOrg: vi.fn(),
  }),
}));
vi.mock("./ProjectSessionView", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./ProjectSessionView")>();
  return {
    ...actual,
    ProjectSessionView: ({
      initialSession,
      runtime,
    }: {
      initialSession: ProjectSessionVM;
      runtime: ProjectRuntimeAvailability;
    }) =>
      React.createElement(
        "div",
        {
          "data-testid": "project-session",
          "data-runtime-available": String(runtime.available),
        },
        initialSession.title,
      ),
  };
});

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-23T10:00:00.000Z";

function session(overrides: Partial<ProjectSessionVM> = {}): ProjectSessionVM {
  return {
    id: SESSION_ID,
    title: "Draft the launch calendar",
    model: "openai/gpt-5",
    status: "working",
    history: [],
    prompts: [],
    pendingPrompts: [],
    latestEventSequence: 0,
    currentEventSequence: 0,
    createdAt: NOW,
    updatedAt: NOW,
    lastActiveAt: NOW,
    archivedAt: null,
    lastViewedAt: NOW,
    isUnread: false,
    errorMessage: null,
    ...overrides,
  };
}

function projectRow(overrides: Partial<ProjectRowVM> = {}): ProjectRowVM {
  return {
    id: PROJECT_ID,
    name: "September launch",
    defaultModel: "openai/gpt-5",
    revision: 1,
    status: "running",
    statusDetail: null,
    skillCount: 1,
    sessionCount: 1,
    activeSessionCount: 1,
    archivedSessionCount: 0,
    unreadSessionCount: 0,
    fileCount: 1,
    secretCount: 2,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    recentSessions: [session()],
    ...overrides,
  };
}

function projectDetail(
  overrides: Partial<ProjectDetailVM> = {},
): ProjectDetailVM {
  return {
    ...projectRow(),
    skills: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        slug: "campaign-planner",
        displayName: "Campaign planner",
        summary: "Plan a launch campaign.",
        version: "1.0.0",
        archived: false,
      },
    ],
    sessions: [session()],
    files: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        path: "files/calendar.md",
        name: "calendar.md",
        version: 1,
        contentType: "text/markdown",
        byteSize: 1200,
        conflictDetected: false,
        modifiedBySessionId: SESSION_ID,
        modifiedByPromptId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    workspace: {
      status: "running",
      statusDetail: null,
      lastActiveAt: NOW,
      sleepAt: null,
    },
    modelConnectionCount: 1,
    access: {
      secrets: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "CRM_API_KEY",
          source: "personal",
          ownerName: "Alex",
        },
      ],
      modelConnections: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          provider: "OpenAI",
          source: "personal",
        },
      ],
    },
    ...overrides,
  };
}

const orgs = [
  {
    id: "org-1",
    name: "Acme",
    slug: "acme",
    kind: "team" as const,
    myRole: "owner" as const,
    color: null,
    logoUrl: null,
  },
  {
    id: "org-2",
    name: "Other",
    slug: "other",
    kind: "team" as const,
    myRole: "owner" as const,
    color: null,
    logoUrl: null,
  },
];
const availableSkills = [
  {
    slug: "campaign-planner",
    name: "Campaign planner",
    summary: "Plan a launch campaign.",
    source: "My Skills",
    version: "1.0.0",
  },
];
const availableModels = [
  { id: "openai/gpt-5", name: "GPT-5", providerName: "OpenAI" },
];
const roots: Root[] = [];

async function mount(
  input: {
    projects?: ProjectRowVM[];
    project?: ProjectDetailVM | null;
    activeSession?: ProjectSessionVM | null;
    runtimeAvailable?: boolean;
    skills?: typeof availableSkills;
    models?: typeof availableModels;
    choiceErrors?: { skills: string | null; models: string | null };
    dialog?:
      | { kind: "new-project"; initialSkillSlug: string | null }
      | {
          kind: "new-session";
          projectId: string;
          initialSkillSlug: string | null;
        }
      | { kind: "settings"; projectId: string }
      | null;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      React.createElement(ProjectsApp, {
        initialProjects: input.projects ?? [projectRow()],
        initialProject: input.project ?? null,
        initialSession: input.activeSession ?? null,
        availableSkills: input.skills ?? availableSkills,
        availableModels: input.models ?? availableModels,
        runtime: {
          available: input.runtimeAvailable ?? true,
          message:
            input.runtimeAvailable === false
              ? "Configure the Projects worker."
              : null,
        },
        orgs,
        currentOrg: orgs[0]!,
        initialDialog: input.dialog ?? null,
        choiceErrors: input.choiceErrors,
      }),
    );
    await Promise.resolve();
  });
  return container;
}

function button(scope: ParentNode, text: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(text),
  );
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Button not found: ${text}`);
  return match;
}

function setValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  orgRpc.setCurrentOrg.mockResolvedValue(undefined);
  projectRpc.fetchProjects.mockResolvedValue({
    projects: [],
    runtime: { available: true, message: null },
  });
  projectRpc.fetchProjectSessions.mockResolvedValue({
    sessions: [],
    nextCursor: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("ProjectsApp", () => {
  it("keeps all projects and bounded recent sessions in the shared sidebar", async () => {
    const container = await mount({
      projects: [
        projectRow(),
        projectRow({
          id: SECOND_PROJECT_ID,
          name: "Customer research",
          status: "stopped",
          recentSessions: [],
        }),
      ],
      project: projectDetail(),
    });

    const primary = container.querySelector<HTMLElement>(
      'nav[aria-label="Primary"]',
    )!;
    expect(primary.textContent).toContain("September launch");
    expect(primary.textContent).toContain("Customer research");
    expect(primary.textContent).toContain("Draft the launch calendar");
    expect(
      primary.querySelector(".projects-side__session-status")?.textContent,
    ).toContain("Working");
    expect(
      primary
        .querySelector<HTMLAnchorElement>('a[aria-current="page"]')
        ?.getAttribute("href"),
    ).toBe(`/projects/${PROJECT_ID}`);
    expect(
      container.querySelector<HTMLAnchorElement>(
        '.space-switch a[href="/skills"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain("calendar.md");
    expect(container.textContent).not.toContain("Approve deliverable");
  });

  it("keeps branded model and provider labels when the model catalog is unavailable", async () => {
    const container = await mount({
      models: [],
      projects: [
        projectRow(),
        projectRow({
          id: SECOND_PROJECT_ID,
          name: "Research workspace",
          defaultModel: "zai/glm-5.2",
          recentSessions: [],
        }),
      ],
    });

    expect(container.textContent).toContain("GPT-5 · OpenAI");
    expect(container.textContent).toContain("GLM 5.2 · Z.ai");
    expect(container.textContent).not.toContain("GPT 5 · Openai");
    expect(container.textContent).not.toContain("GLM 5 2 · Zai");
  });

  it("keeps conversations ordered by creation and only surfaces actionable states", async () => {
    const olderUnread = session({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Older result",
      status: "idle",
      createdAt: "2026-07-22T10:00:00.000Z",
      isUnread: true,
    });
    const newestIdle = session({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "Newest idle",
      status: "idle",
      createdAt: "2026-07-24T10:00:00.000Z",
    });
    const container = await mount({
      project: projectDetail({
        sessions: [olderUnread, newestIdle],
        recentSessions: [olderUnread, newestIdle],
        sessionCount: 2,
        unreadSessionCount: 1,
      }),
    });

    const titles = [
      ...container.querySelectorAll(".cowork-session-row__copy strong"),
    ].map((node) => node.textContent);
    expect(titles).toEqual(["Newest idle", "Older result"]);
    expect(container.textContent).toContain("New result");
    expect(container.textContent).not.toContain("Ready");
    expect(container.textContent).not.toContain("Idle");
  });

  it("queues every simultaneous background result until each toast is opened or dismissed", async () => {
    vi.useFakeTimers();
    const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const firstBefore = session({
      id: firstId,
      title: "Launch brief",
      status: "working",
      isUnread: false,
      updatedAt: "2026-07-23T10:00:00.000Z",
    });
    const secondBefore = session({
      id: secondId,
      title: "Research summary",
      status: "working",
      isUnread: false,
      updatedAt: "2026-07-23T10:00:00.000Z",
    });
    const initial = projectRow({
      recentSessions: [firstBefore, secondBefore],
      sessionCount: 2,
      activeSessionCount: 2,
      unreadSessionCount: 0,
    });
    const firstAfter = {
      ...firstBefore,
      status: "completed" as const,
      isUnread: true,
      updatedAt: "2026-07-24T10:00:00.000Z",
    };
    const secondAfter = {
      ...secondBefore,
      status: "error" as const,
      isUnread: true,
      updatedAt: "2026-07-24T10:00:01.000Z",
    };
    const refreshed = {
      ...initial,
      recentSessions: [firstAfter, secondAfter],
      activeSessionCount: 0,
      unreadSessionCount: 2,
    };
    projectRpc.fetchProjects.mockImplementation(async (view?: string) => ({
      projects: view === "archived" ? [] : [refreshed],
      runtime: { available: true, message: null },
    }));
    const container = await mount({ projects: [initial] });

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Launch brief has a new result.");
    expect(container.textContent).not.toContain("Research summary failed.");

    await act(async () => {
      button(container, "Open").click();
      await Promise.resolve();
    });
    expect(router.push).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/sessions/${firstId}`,
    );
    expect(container.textContent).toContain("Research summary failed.");

    await act(async () => {
      button(container, "Open").click();
      await Promise.resolve();
    });
    expect(router.push).toHaveBeenLastCalledWith(
      `/projects/${PROJECT_ID}/sessions/${secondId}`,
    );
    expect(container.querySelector(".project-toast")).toBeNull();
  });

  it("rolls back a failed read acknowledgement and retries it only three times", async () => {
    vi.useFakeTimers();
    const unread = session({
      status: "completed",
      isUnread: true,
      lastViewedAt: undefined,
    });
    projectRpc.updateProjectSession.mockRejectedValue(
      new Error("Could not mark the conversation as viewed."),
    );
    const container = await mount({
      project: projectDetail({
        status: "stopped",
        activeSessionCount: 0,
        unreadSessionCount: 1,
        sessions: [unread],
        recentSessions: [unread],
      }),
      activeSession: unread,
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(projectRpc.updateProjectSession).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("New result");

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(projectRpc.updateProjectSession).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("New result");

    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(projectRpc.updateProjectSession).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("New result");

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(projectRpc.updateProjectSession).toHaveBeenCalledTimes(3);
  });

  it("keeps archived Projects durably discoverable and restorable", async () => {
    const archived = projectRow({
      archivedAt: NOW,
      status: "stopped",
      recentSessions: [],
    });
    let restored = false;
    projectRpc.fetchProjects.mockImplementation(async (view?: string) => ({
      projects: view === "archived" && !restored ? [archived] : [],
      runtime: { available: true, message: null },
    }));
    projectRpc.updateProject.mockImplementation(async () => {
      restored = true;
      return projectDetail({ archivedAt: null, status: "stopped" });
    });
    const container = await mount();

    await act(async () => {
      button(container, "Archived").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.fetchProjects).toHaveBeenCalledWith("archived");
    expect(container.textContent).toContain("September launch");
    expect(container.textContent).toContain("Archived");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Restore September launch"]',
        )!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.updateProject).toHaveBeenCalledWith(PROJECT_ID, {
      revision: 1,
      archived: false,
    });
    expect(container.textContent).toContain("No archived Projects");
  });

  it("does not let an archived background load hide the active empty state", async () => {
    let resolveArchived!: (value: {
      projects: ProjectRowVM[];
      runtime: ProjectRuntimeAvailability;
    }) => void;
    const archivedPending = new Promise<{
      projects: ProjectRowVM[];
      runtime: ProjectRuntimeAvailability;
    }>((resolve) => {
      resolveArchived = resolve;
    });
    projectRpc.fetchProjects.mockImplementation(async (view?: string) =>
      view === "archived"
        ? archivedPending
        : { projects: [], runtime: { available: true, message: null } });

    const container = await mount({ projects: [] });

    expect(container.textContent).toContain("Create your first project");
    expect(container.textContent).not.toContain("Loading archived Projects");

    act(() => button(container, "Archived").click());
    expect(container.textContent).toContain("Loading archived Projects");

    await act(async () => {
      resolveArchived({
        projects: [],
        runtime: { available: true, message: null },
      });
      await archivedPending;
      await Promise.resolve();
    });
    expect(container.textContent).toContain("No archived Projects");
  });

  it("refetches the open Archived view after a Project is archived from the sidebar", async () => {
    const inactive = session({ status: "completed" });
    const activeRow = projectRow({
      status: "stopped",
      activeSessionCount: 0,
      recentSessions: [inactive],
    });
    const archivedRow = {
      ...activeRow,
      archivedAt: NOW,
      recentSessions: [],
    };
    let archived = false;
    let archivedFetches = 0;
    projectRpc.fetchProjects.mockImplementation(async (view?: string) => {
      if (view === "archived") {
        archivedFetches += 1;
        return {
          projects: archived ? [archivedRow] : [],
          runtime: { available: true, message: null },
        };
      }
      return {
        projects: archived ? [] : [activeRow],
        runtime: { available: true, message: null },
      };
    });
    projectRpc.updateProject.mockImplementation(async () => {
      archived = true;
      return projectDetail({
        ...archivedRow,
        status: "stopped",
        sessions: [],
      });
    });
    const container = await mount({ projects: [activeRow] });

    await act(async () => {
      button(container, "Archived").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("No archived Projects");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '.projects-side__project button[aria-label="Actions for September launch"]',
        )!
        .click();
      await Promise.resolve();
      [
        ...document.body.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]',
        ),
      ]
        .find((candidate) => candidate.textContent?.includes("Archive project"))!
        .click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(archivedFetches).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("September launch");
    expect(container.textContent).toContain("Archived");
  });

  it("adds durable files directly to a Project without creating a conversation", async () => {
    const uploaded = {
      ...projectDetail().files[0]!,
      id: "99999999-9999-4999-8999-999999999999",
      path: "files/brief.md",
      name: "brief.md",
      byteSize: 42,
    };
    projectRpc.uploadProjectFiles.mockResolvedValue([uploaded]);
    const container = await mount({ project: projectDetail() });
    const input = container.querySelector<HTMLInputElement>(
      ".cowork-context-panel__upload input",
    )!;
    const file = new File(["Launch brief"], "brief.md", {
      type: "text/markdown",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.uploadProjectFiles).toHaveBeenCalledWith(PROJECT_ID, [
      file,
    ]);
    expect(container.textContent).toContain("brief.md");
    expect(container.textContent).toContain("added to the Project");
    expect(projectRpc.createProjectSession).not.toHaveBeenCalled();
  });

  it("previews Project files in place on desktop and restores focus on close", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        media: "(min-width: 1024px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    const previewFile = {
      ...projectDetail().files[0]!,
      path: "files/calendar.png",
      name: "calendar.png",
      contentType: "image/png",
    };
    const container = await mount({
      project: projectDetail({ files: [previewFile] }),
    });
    const preview = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview calendar.png"]',
    )!;

    await act(async () => {
      preview.click();
      await Promise.resolve();
    });

    const panel = container.querySelector<HTMLElement>(
      ".cowork-session-files-panel",
    );
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('[role="dialog"]')).toBeNull();
    expect(
      panel
        ?.querySelector<HTMLImageElement>('img[alt="Preview of calendar.png"]')
        ?.getAttribute("src"),
    ).toContain(`/v1/projects/${PROJECT_ID}/files/`);

    await act(async () => {
      panel
        ?.querySelector<HTMLButtonElement>('button[aria-label="Close files"]')
        ?.click();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(preview);
  });

  it("opens Project files in an accessible mobile drawer and restores focus with Escape", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(min-width: 1024px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    const previewFile = {
      ...projectDetail().files[0]!,
      path: "files/calendar.png",
      name: "calendar.png",
      contentType: "image/png",
    };
    const container = await mount({
      project: projectDetail({ files: [previewFile] }),
    });
    const preview = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview calendar.png"]',
    )!;

    await act(async () => {
      preview.click();
      await Promise.resolve();
    });

    const drawer = document.body.querySelector<HTMLElement>(
      ".project-files-drawer",
    );
    expect(drawer).not.toBeNull();
    expect(drawer?.getAttribute("role")).toBe("dialog");
    expect(drawer?.getAttribute("aria-modal")).toBe("true");
    expect(container.inert).toBe(true);
    expect(document.activeElement).toBe(
      drawer?.querySelector<HTMLButtonElement>(
        'button[aria-label="Close files"]',
      ),
    );

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(document.body.querySelector(".project-files-drawer")).toBeNull();
    expect(container.inert).toBe(false);
    expect(document.activeElement).toBe(preview);
  });

  it("uses the exact active-conversation count for Project archiving", async () => {
    const completed = session({ status: "completed" });
    const container = await mount({
      project: projectDetail({
        status: "running",
        activeSessionCount: 0,
        sessions: [completed],
        recentSessions: [completed],
      }),
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '.cowork-project__head button[aria-label="Actions for September launch"]',
        )!
        .click();
      await Promise.resolve();
    });

    const archive = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((candidate) => candidate.textContent?.includes("Archive project"));
    expect(archive?.disabled).toBe(false);
    expect(container.textContent).toContain("Ready");
  });

  it("stops and archives an active conversation without offering an unsafe Undo", async () => {
    const active = session();
    const archived = {
      ...active,
      status: "stopped" as const,
      archivedAt: NOW,
    };
    projectRpc.updateProjectSession.mockResolvedValueOnce(archived);
    const container = await mount({ project: projectDetail() });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".cowork-session-row__action")!
        .click();
      await Promise.resolve();
      [
        ...document.body.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]',
        ),
      ]
        .find((candidate) =>
          candidate.textContent?.includes("Stop and archive"),
        )!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.updateProjectSession).toHaveBeenCalledWith(
      PROJECT_ID,
      SESSION_ID,
      { archived: true, stopActive: true },
    );
    expect(container.textContent).not.toContain("Draft the launch calendar");
    expect(container.textContent).toContain(
      "Conversation stopped and archived.",
    );
    expect(container.textContent).not.toContain("Undo");
    expect(projectRpc.updateProjectSession).toHaveBeenCalledTimes(1);
  });

  it("archives an inactive conversation immediately and restores it from Undo", async () => {
    const inactive = session({ status: "completed" });
    const archived = { ...inactive, archivedAt: NOW };
    const restored = { ...archived, archivedAt: null };
    projectRpc.updateProjectSession
      .mockResolvedValueOnce(archived)
      .mockResolvedValueOnce(restored);
    const container = await mount({
      project: projectDetail({
        status: "stopped",
        activeSessionCount: 0,
        sessions: [inactive],
        recentSessions: [inactive],
      }),
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".cowork-session-row__action")!
        .click();
      await Promise.resolve();
      [
        ...document.body.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]',
        ),
      ]
        .find((candidate) => candidate.textContent?.trim() === "Archive")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.updateProjectSession).toHaveBeenCalledWith(
      PROJECT_ID,
      SESSION_ID,
      { archived: true, stopActive: false },
    );
    expect(container.textContent).toContain("Conversation archived.");

    await act(async () => {
      button(container, "Undo").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(projectRpc.updateProjectSession).toHaveBeenLastCalledWith(
      PROJECT_ID,
      SESSION_ID,
      { archived: false },
    );
    expect(container.textContent).toContain("Draft the launch calendar");
  });

  it("retries a blocked workspace in place and refreshes its visible state", async () => {
    const blocked = projectDetail({
      status: "error",
      statusDetail: "The project runtime operation failed.",
      workspace: {
        status: "error",
        statusDetail: "The project runtime operation failed.",
        lastActiveAt: NOW,
        sleepAt: null,
      },
    });
    const queued = projectDetail({
      status: "queued",
      statusDetail: null,
      workspace: {
        status: "queued",
        statusDetail: null,
        lastActiveAt: NOW,
        sleepAt: null,
      },
    });
    let rejectRetry!: (cause: Error) => void;
    const pending = new Promise<ProjectDetailVM>((_resolve, reject) => {
      rejectRetry = reject;
    });
    projectRpc.retryProjectWorkspace
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(queued);
    const container = await mount({ project: blocked });

    act(() => button(container, "Try again").click());
    expect(
      container.querySelector(".cowork-recovery")?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(button(container, "Trying…").disabled).toBe(true);
    expect(button(container, "Project settings").disabled).toBe(false);

    await act(async () => {
      rejectRetry(new Error("Could not save the retry request."));
      await pending.catch(() => undefined);
      await Promise.resolve();
    });
    expect(
      container.querySelector(".cowork-recovery [role='alert']")?.textContent,
    ).toContain("Could not save the retry request.");
    expect(button(container, "Try again").disabled).toBe(false);

    await act(async () => {
      button(container, "Try again").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(projectRpc.retryProjectWorkspace).toHaveBeenCalledTimes(2);
    expect(projectRpc.retryProjectWorkspace).toHaveBeenLastCalledWith(
      PROJECT_ID,
    );
    expect(container.querySelector(".cowork-project-alert")).toBeNull();
    expect(container.textContent).toContain("Getting ready");
  });

  it("creates a named project with an explicit model and no arbitrary preselected skills", async () => {
    const created = projectDetail({
      sessions: [],
      recentSessions: [],
      sessionCount: 0,
    });
    projectRpc.createProject.mockResolvedValue(created);
    await mount({
      projects: [],
      dialog: { kind: "new-project", initialSkillSlug: null },
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("New project");
    expect(dialog.querySelector('[aria-pressed="true"]')).toBeNull();
    setValue(
      dialog.querySelector<HTMLInputElement>(
        'input[placeholder="e.g. Q4 planning"]',
      )!,
      "Q4 planning",
    );
    await act(async () => {
      button(dialog, "Create project").click();
      await Promise.resolve();
    });

    expect(projectRpc.createProject).toHaveBeenCalledWith({
      name: "Q4 planning",
      defaultModel: "openai/gpt-5",
      skillSlugs: [],
      idempotencyKey: expect.any(String),
    });
    expect(document.body.textContent).toContain("New conversation");
    expect(
      document.body
        .querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')
        ?.getAttribute("aria-label"),
    ).toBe("What should this conversation do?");
    expect(router.replace).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}?newSession=1`,
    );
  });

  it("does not open a direct new-conversation dialog for an archived Project", async () => {
    const archived = projectDetail({
      archivedAt: NOW,
      status: "stopped",
      activeSessionCount: 0,
      sessions: [session({ status: "completed" })],
    });
    await mount({
      project: archived,
      dialog: {
        kind: "new-session",
        projectId: PROJECT_ID,
        initialSkillSlug: null,
      },
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(projectRpc.createProjectSession).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith(`/projects/${PROJECT_ID}`);
  });

  it("reuses a project creation key until its payload changes", async () => {
    projectRpc.createProject.mockRejectedValue(new Error("Connection lost"));
    await mount({
      projects: [],
      dialog: { kind: "new-project", initialSkillSlug: null },
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const name = dialog.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Q4 planning"]',
    )!;
    setValue(name, "Q4 planning");
    await act(async () => {
      button(dialog, "Create project").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      button(dialog, "Create project").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.createProject).toHaveBeenCalledTimes(2);
    expect(projectRpc.createProject.mock.calls[1]?.[0].idempotencyKey).toBe(
      projectRpc.createProject.mock.calls[0]?.[0].idempotencyKey,
    );

    setValue(name, "Q4 launch planning");
    await act(async () => {
      button(dialog, "Create project").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.createProject.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ name: "Q4 launch planning" }),
    );
    expect(projectRpc.createProject.mock.calls[2]?.[0].idempotencyKey).not.toBe(
      projectRpc.createProject.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("distinguishes catalog load failures from genuinely empty choices", async () => {
    await mount({
      projects: [],
      skills: [],
      models: [],
      choiceErrors: {
        skills: "Skills could not be loaded.",
        models: "Models could not be loaded.",
      },
      dialog: { kind: "new-project", initialSkillSlug: null },
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Skills could not be loaded.");
    expect(dialog.textContent).toContain("Models could not be loaded.");
    act(() => button(dialog, "Retry").click());
    expect(router.refresh).toHaveBeenCalled();
  });

  it("sends the first prompt directly into a model-fixed session", async () => {
    const createdSession = session({
      status: "queued",
      history: [
        { kind: "user", text: "Prepare the calendar", message_id: "prompt-1" },
      ],
    });
    projectRpc.createProjectSession.mockResolvedValue(createdSession);
    await mount({
      project: projectDetail({
        sessions: [],
        recentSessions: [],
        sessionCount: 0,
      }),
      dialog: {
        kind: "new-session",
        projectId: PROJECT_ID,
        initialSkillSlug: "campaign-planner",
      },
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Using Campaign planner");
    const start = button(dialog, "Start");
    expect(start.disabled).toBe(true);
    setValue(dialog.querySelector("textarea")!, "Prepare the calendar");
    await act(async () => {
      start.click();
      await Promise.resolve();
    });

    expect(projectRpc.createProjectSession).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        prompt: "Prepare the calendar",
        model: "openai/gpt-5",
        files: [],
        idempotencyKey: expect.any(String),
      }),
    );
    expect(
      projectRpc.createProjectSession.mock.calls[0]?.[1],
    ).not.toHaveProperty("skillSlug");
    expect(router.push).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}`,
    );
  });

  it("reuses the first-session idempotency key after a lost response", async () => {
    projectRpc.createProjectSession
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce(session({ status: "queued" }));
    await mount({
      project: projectDetail({
        sessions: [],
        recentSessions: [],
        sessionCount: 0,
      }),
      dialog: {
        kind: "new-session",
        projectId: PROJECT_ID,
        initialSkillSlug: null,
      },
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    setValue(dialog.querySelector("textarea")!, "Prepare the calendar");
    await act(async () => {
      button(dialog, "Start").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dialog.textContent).toContain("Connection lost");

    await act(async () => {
      button(dialog, "Start").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.createProjectSession).toHaveBeenCalledTimes(2);
    expect(
      projectRpc.createProjectSession.mock.calls[1]?.[1].idempotencyKey,
    ).toBe(projectRpc.createProjectSession.mock.calls[0]?.[1].idempotencyKey);
  });

  it("locks the first-session payload while its idempotent request is in flight", async () => {
    let resolveSession!: (value: ProjectSessionVM) => void;
    const pending = new Promise<ProjectSessionVM>((resolve) => {
      resolveSession = resolve;
    });
    projectRpc.createProjectSession.mockReturnValue(pending);
    await mount({
      project: projectDetail({
        sessions: [],
        recentSessions: [],
        sessionCount: 0,
      }),
      dialog: {
        kind: "new-session",
        projectId: PROJECT_ID,
        initialSkillSlug: null,
      },
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    setValue(dialog.querySelector("textarea")!, "Prepare the calendar");
    await act(async () => {
      button(dialog, "Start").click();
      await Promise.resolve();
    });

    expect(
      dialog.querySelector<HTMLTextAreaElement>("textarea")?.disabled,
    ).toBe(true);
    expect(dialog.querySelector<HTMLSelectElement>("select")?.disabled).toBe(
      true,
    );
    expect(button(dialog, "Cancel").disabled).toBe(true);

    await act(async () => {
      resolveSession(session({ status: "queued" }));
      await pending;
      await Promise.resolve();
    });
  });

  it("blocks a new Session until an unavailable Project default model is replaced", async () => {
    await mount({
      project: projectDetail({
        defaultModel: "legacy/model",
        sessions: [],
        recentSessions: [],
        sessionCount: 0,
      }),
      dialog: {
        kind: "new-session",
        projectId: PROJECT_ID,
        initialSkillSlug: null,
      },
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    setValue(dialog.querySelector("textarea")!, "Prepare the calendar");
    expect(dialog.textContent).toContain("This model is unavailable");
    expect(button(dialog, "Start").disabled).toBe(true);
  });

  it("shows server runtime readiness separately from the feature flag", async () => {
    const container = await mount({ runtimeAvailable: false });

    expect(container.textContent).toContain("Projects are not available yet.");
    expect(container.textContent).toContain("Configure the Projects worker.");
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .filter(
          (candidate) =>
            candidate.textContent?.includes("New project") ||
            candidate.title === "Projects runtime unavailable",
        )
        .every((candidate) => candidate.disabled),
    ).toBe(true);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Actions for September launch"]',
        )!
        .click();
      await Promise.resolve();
    });
    expect(
      [
        ...document.body.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]',
        ),
      ].find((candidate) =>
        candidate.textContent?.includes("New conversation"),
      )?.disabled,
    ).toBe(true);
  });

  it("keeps a failed sidebar settings load inside a closable error dialog", async () => {
    let rejectLoad!: (cause: Error) => void;
    const pending = new Promise<ProjectDetailVM>((_resolve, reject) => {
      rejectLoad = reject;
    });
    projectRpc.fetchProject.mockReturnValueOnce(pending);
    const container = await mount({
      projects: [
        projectRow(),
        projectRow({
          id: SECOND_PROJECT_ID,
          name: "Customer research",
          recentSessions: [],
        }),
      ],
      project: projectDetail(),
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Actions for Customer research"]',
        )!
        .click();
      await Promise.resolve();
      button(document.body, "Project settings").click();
    });
    expect(
      document.body.querySelector('[role="dialog"]')?.textContent,
    ).toContain("Loading project");
    expect(container.querySelector("main")?.hasAttribute("inert")).toBe(true);

    await act(async () => {
      rejectLoad(new Error("Connection lost"));
      await pending.catch(() => undefined);
      await Promise.resolve();
    });
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Connection lost");
    expect(dialog.textContent).toContain("Retry");

    act(() => button(dialog, "Close").click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("main")?.hasAttribute("inert")).toBe(false);
  });

  it("retries a failed sidebar new-session target load", async () => {
    const second = projectDetail({
      id: SECOND_PROJECT_ID,
      name: "Customer research",
      sessions: [],
      recentSessions: [],
      sessionCount: 0,
    });
    projectRpc.fetchProject
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce(second);
    const container = await mount({
      projects: [
        projectRow(),
        projectRow({
          id: SECOND_PROJECT_ID,
          name: "Customer research",
          status: "stopped",
          recentSessions: [],
        }),
      ],
      project: projectDetail(),
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Actions for Customer research"]',
        )!
        .click();
      await Promise.resolve();
      [
        ...document.body.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]',
        ),
      ]
        .find((candidate) =>
          candidate.textContent?.includes("New conversation"),
        )!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    let dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Temporary failure");

    await act(async () => {
      button(dialog, "Retry").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("New conversation");
    expect(dialog.querySelector("textarea")).not.toBeNull();
  });

  it("refreshes settings after a partial save and sends only changed details", async () => {
    const updated = projectDetail({
      name: "Renamed project",
      defaultModel: "legacy/model",
      revision: 2,
    });
    projectRpc.updateProject.mockResolvedValue(updated);
    projectRpc.replaceProjectSkills.mockRejectedValue(
      new Error("Skill sync rejected"),
    );
    projectRpc.fetchProject.mockResolvedValue(updated);
    await mount({
      project: projectDetail({ defaultModel: "legacy/model" }),
      dialog: { kind: "settings", projectId: PROJECT_ID },
    });

    let dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    setValue(
      dialog.querySelector<HTMLInputElement>("input[data-autofocus]")!,
      "Renamed project",
    );
    act(() =>
      dialog.querySelector<HTMLButtonElement>(".cowork-skill-option")!.click(),
    );
    await act(async () => {
      button(dialog, "Save changes").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(projectRpc.updateProject).toHaveBeenCalledWith(PROJECT_ID, {
      revision: 1,
      name: "Renamed project",
    });
    expect(projectRpc.replaceProjectSkills).toHaveBeenCalledWith(
      PROJECT_ID,
      2,
      [],
    );
    expect(projectRpc.fetchProject).toHaveBeenCalledWith(PROJECT_ID);
    dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Current settings were refreshed");
    expect(
      dialog.querySelector<HTMLInputElement>("input[data-autofocus]")?.value,
    ).toBe("Renamed project");
  });

  it("shows and allows removing an attached archived skill", async () => {
    const archivedProject = projectDetail({
      skills: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          slug: "legacy-research",
          displayName: "Legacy research",
          summary: "Old research workflow.",
          version: "0.9.0",
          archived: true,
        },
      ],
    });
    projectRpc.replaceProjectSkills.mockResolvedValue(
      projectDetail({
        revision: 2,
        skills: [],
        skillCount: 0,
      }),
    );
    await mount({
      project: archivedProject,
      dialog: { kind: "settings", projectId: PROJECT_ID },
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const archived = [
      ...dialog.querySelectorAll<HTMLButtonElement>(".cowork-skill-option"),
    ].find((candidate) => candidate.textContent?.includes("Legacy research"))!;
    expect(archived.textContent).toContain("Attached · archived");
    expect(archived.getAttribute("aria-pressed")).toBe("true");
    expect(archived.disabled).toBe(false);
    act(() => archived.click());
    expect(archived.getAttribute("aria-pressed")).toBe("false");
    expect(archived.disabled).toBe(true);

    await act(async () => {
      button(dialog, "Save changes").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(projectRpc.replaceProjectSkills).toHaveBeenCalledWith(
      PROJECT_ID,
      1,
      [],
    );
  });

  it("refreshes lifecycle state while the Projects list remains open", async () => {
    vi.useFakeTimers();
    projectRpc.fetchProjects.mockResolvedValue({
      projects: [projectRow({ status: "stopped" })],
      runtime: { available: true, message: null },
    });
    const container = await mount();
    expect(container.textContent).toContain("Working");

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.fetchProjects).toHaveBeenCalled();
    expect(container.textContent).toContain("Sleeping");
  });

  it("portals dialogs, focuses their first field, and makes background content inert", async () => {
    const container = await mount({
      dialog: { kind: "new-project", initialSkillSlug: null },
    });
    await act(async () => {
      await Promise.resolve();
    });

    const layer = document.body.querySelector(".cowork-dialog-layer");
    const name = layer?.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Q4 planning"]',
    );
    expect(layer?.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(name);
    expect(container.inert).toBe(true);
    expect(container.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders a durable session route instead of the legacy one-shot run chat", async () => {
    const activeSession = session();
    const container = await mount({
      project: projectDetail(),
      activeSession,
    });

    expect(
      container.querySelector('[data-testid="project-session"]')?.textContent,
    ).toBe(activeSession.title);
  });

  it("passes live runtime admission to an open conversation", async () => {
    const activeSession = session({ status: "completed" });
    const container = await mount({
      project: projectDetail({ sessions: [activeSession] }),
      activeSession,
      runtimeAvailable: false,
    });

    expect(
      container
        .querySelector('[data-testid="project-session"]')
        ?.getAttribute("data-runtime-available"),
    ).toBe("false");
  });

  it("refreshes Project detail while an idle conversation remains selected", async () => {
    vi.useFakeTimers();
    const idle = session({ status: "idle" });
    projectRpc.fetchProjects.mockResolvedValue({
      projects: [projectRow({ recentSessions: [idle] })],
      runtime: { available: true, message: null },
    });
    projectRpc.fetchProject.mockResolvedValue(
      projectDetail({
        name: "Externally renamed Project",
        sessions: [{ ...idle, title: "Externally renamed conversation" }],
      }),
    );

    await mount({
      project: projectDetail({ sessions: [idle] }),
      activeSession: idle,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(projectRpc.fetchProject).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("leaves a Project deleted in another tab once both list and detail confirm it is gone", async () => {
    vi.useFakeTimers();
    const activeSession = session({ status: "idle" });
    projectRpc.fetchProjects.mockResolvedValue({
      projects: [],
      runtime: { available: true, message: null },
    });
    projectRpc.fetchProject.mockRejectedValue(
      Object.assign(new Error("Project not found"), { status: 404 }),
    );
    const container = await mount({
      project: projectDetail({ sessions: [activeSession] }),
      activeSession,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(projectRpc.fetchProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(router.replace).toHaveBeenCalledWith("/projects");
    expect(
      container.querySelector('[data-testid="project-session"]'),
    ).toBeNull();
    expect(container.textContent).toContain("This Project was deleted.");
  });

  it("closes an open Project dialog when another tab permanently deletes its Project", async () => {
    vi.useFakeTimers();
    const activeSession = session({ status: "idle" });
    projectRpc.fetchProjects.mockResolvedValue({
      projects: [],
      runtime: { available: true, message: null },
    });
    projectRpc.fetchProject.mockRejectedValue(
      Object.assign(new Error("Project not found"), { status: 404 }),
    );
    const container = await mount({
      project: projectDetail({ sessions: [activeSession] }),
      activeSession,
      dialog: { kind: "settings", projectId: PROJECT_ID },
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(projectRpc.fetchProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="project-session"]'),
    ).toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/projects");
  });

  it("ignores a late conversation creation after another tab permanently deletes its Project", async () => {
    vi.useFakeTimers();
    let resolveSession!: (value: ProjectSessionVM) => void;
    const pending = new Promise<ProjectSessionVM>((resolve) => {
      resolveSession = resolve;
    });
    projectRpc.createProjectSession.mockReturnValue(pending);
    projectRpc.fetchProjects.mockResolvedValue({
      projects: [],
      runtime: { available: true, message: null },
    });
    projectRpc.fetchProject.mockRejectedValue(
      Object.assign(new Error("Project not found"), { status: 404 }),
    );
    const container = await mount({
      project: projectDetail({
        sessions: [],
        recentSessions: [],
        sessionCount: 0,
        activeSessionCount: 0,
      }),
      dialog: {
        kind: "new-session",
        projectId: PROJECT_ID,
        initialSkillSlug: null,
      },
    });
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    setValue(dialog.querySelector("textarea")!, "Prepare the calendar");

    await act(async () => {
      button(dialog, "Start").click();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      resolveSession(session({ status: "queued" }));
      await pending;
      await Promise.resolve();
    });

    expect(router.push).not.toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}`,
    );
    expect(
      container.querySelector('[data-testid="project-session"]'),
    ).toBeNull();
    expect(container.textContent).toContain("This Project was deleted.");
  });

  it("ignores a late settings save after another tab permanently deletes its Project", async () => {
    vi.useFakeTimers();
    let resolveUpdate!: (value: ProjectDetailVM) => void;
    const pending = new Promise<ProjectDetailVM>((resolve) => {
      resolveUpdate = resolve;
    });
    projectRpc.updateProject.mockReturnValue(pending);
    projectRpc.fetchProjects.mockResolvedValue({
      projects: [],
      runtime: { available: true, message: null },
    });
    projectRpc.fetchProject.mockRejectedValue(
      Object.assign(new Error("Project not found"), { status: 404 }),
    );
    const container = await mount({
      project: projectDetail(),
      dialog: { kind: "settings", projectId: PROJECT_ID },
    });
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    setValue(
      dialog.querySelector<HTMLInputElement>("input[data-autofocus]")!,
      "Renamed project",
    );

    await act(async () => {
      button(dialog, "Save changes").click();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      resolveUpdate(projectDetail({ name: "Renamed project", revision: 2 }));
      await pending;
      await Promise.resolve();
    });

    expect(projectRpc.replaceProjectSkills).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Renamed project");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/projects");
  });

  it("does not leak a late settings recovery error into a new dialog after deletion", async () => {
    vi.useFakeTimers();
    let rejectRecovery!: (cause: Error) => void;
    const pendingRecovery = new Promise<ProjectDetailVM>((_resolve, reject) => {
      rejectRecovery = reject;
    });
    projectRpc.updateProject.mockRejectedValue(new Error("Save rejected"));
    projectRpc.fetchProjects.mockResolvedValue({
      projects: [
        projectRow({
          id: SECOND_PROJECT_ID,
          name: "Customer research",
          recentSessions: [],
        }),
      ],
      runtime: { available: true, message: null },
    });
    projectRpc.fetchProject
      .mockReturnValueOnce(pendingRecovery)
      .mockRejectedValueOnce(
        Object.assign(new Error("Project not found"), { status: 404 }),
      );
    const container = await mount({
      projects: [
        projectRow(),
        projectRow({
          id: SECOND_PROJECT_ID,
          name: "Customer research",
          recentSessions: [],
        }),
      ],
      project: projectDetail(),
      dialog: { kind: "settings", projectId: PROJECT_ID },
    });
    const settings = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    setValue(
      settings.querySelector<HTMLInputElement>("input[data-autofocus]")!,
      "Renamed project",
    );

    await act(async () => {
      button(settings, "Save changes").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(projectRpc.fetchProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    act(() => button(container, "New project").click());
    let dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("New project");

    await act(async () => {
      rejectRecovery(new Error("Recovery failed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("New project");
    expect(dialog.textContent).not.toContain(
      "Close and reopen settings before retrying",
    );
    expect(dialog.textContent).not.toContain("Save rejected");
  });

  it("keeps an unlisted selected Project through a transient error or archival", async () => {
    vi.useFakeTimers();
    const activeSession = session({ status: "idle" });
    const archived = projectDetail({
      archivedAt: NOW,
      status: "stopped",
      sessions: [activeSession],
    });
    projectRpc.fetchProjects.mockResolvedValue({
      projects: [],
      runtime: { available: true, message: null },
    });
    projectRpc.fetchProject
      .mockRejectedValueOnce(
        Object.assign(new Error("Connection interrupted"), { status: 503 }),
      )
      .mockResolvedValueOnce(archived);
    const container = await mount({
      project: projectDetail({ sessions: [activeSession] }),
      activeSession,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(
      container.querySelector('[data-testid="project-session"]'),
    ).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalledWith("/projects");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(projectRpc.fetchProject).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="project-session"]'),
    ).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalledWith("/projects");
  });

  it("makes project content inert while the mobile navigation is open", async () => {
    const container = await mount({ project: projectDetail() });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Open navigation"]',
        )!
        .click(),
    );

    const main = container.querySelector("main");
    expect(main?.hasAttribute("inert")).toBe(true);
    expect(main?.getAttribute("aria-hidden")).toBe("true");
  });

  it("closes mobile navigation with Escape and restores focus to its toggle", async () => {
    const container = await mount({ project: projectDetail() });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Open navigation"]',
        )!
        .click(),
    );

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await Promise.resolve();
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand navigation"]',
    );
    expect(container.querySelector("main")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps mobile navigation focus stable during background refreshes", async () => {
    vi.useFakeTimers();
    projectRpc.fetchProjects.mockResolvedValue({
      projects: [projectRow()],
      runtime: { available: true, message: null },
    });
    projectRpc.fetchProject.mockResolvedValue(projectDetail());
    const container = await mount({ project: projectDetail() });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Open navigation"]',
        )!
        .click(),
    );
    await act(async () => {
      await Promise.resolve();
    });

    const searchToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Search projects"]',
    )!;
    act(() => searchToggle.focus());
    expect(document.activeElement).toBe(searchToggle);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.fetchProjects).toHaveBeenCalled();
    expect(document.activeElement).toBe(searchToggle);
  });

  it("returns focus to the project-search toggle when Escape closes search", async () => {
    const container = await mount({ project: projectDetail() });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Search projects"]',
        )!
        .click(),
    );
    const search = container.querySelector<HTMLInputElement>(
      'input[placeholder="Find a project…"]',
    )!;
    expect(document.activeElement).toBe(search);

    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('input[placeholder="Find a project…"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Search projects"]',
      ),
    );
  });

  it("uses semantic table rows with a real project link", async () => {
    const container = await mount();
    const rows = container.querySelectorAll<HTMLElement>(
      '[role="table"] [role="row"]',
    );
    const projectRowElement = rows.item(1);

    expect(projectRowElement.tagName).toBe("DIV");
    expect(
      projectRowElement.querySelector<HTMLAnchorElement>(
        `a[href="/projects/${PROJECT_ID}"]`,
      ),
    ).not.toBeNull();
    expect(projectRowElement.querySelectorAll('[role="cell"]')).toHaveLength(4);
  });

  it("returns to Projects before refreshing a newly selected workspace", async () => {
    const container = await mount({ project: projectDetail() });
    await act(async () => {
      button(container, "Switch workspace").click();
      await Promise.resolve();
    });
    expect(orgRpc.setCurrentOrg).toHaveBeenCalledWith("org-2");
    expect(router.replace).toHaveBeenCalledWith("/projects");
    expect(router.refresh).toHaveBeenCalled();
  });
});
