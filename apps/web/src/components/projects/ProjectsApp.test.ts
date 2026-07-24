// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectDetailVM,
  ProjectRowVM,
  ProjectSessionVM,
} from "@/lib/projectsModel";
import { ProjectsApp } from "./ProjectsApp";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const projectRpc = vi.hoisted(() => ({
  createProject: vi.fn(),
  createProjectSession: vi.fn(),
  fetchProject: vi.fn(),
  fetchProjects: vi.fn(),
  replaceProjectSkills: vi.fn(),
  retryProjectWorkspace: vi.fn(),
  updateProject: vi.fn(),
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
vi.mock("./ProjectSessionView", () => ({
  ProjectSessionView: ({
    initialSession,
  }: {
    initialSession: ProjectSessionVM;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "project-session" },
      initialSession.title,
    ),
}));

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
    pendingPrompts: [],
    latestEventSequence: 0,
    createdAt: NOW,
    lastActiveAt: NOW,
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
    fileCount: 1,
    secretCount: 2,
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
});

afterEach(() => {
  vi.useRealTimers();
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
    expect(document.body.textContent).toContain("New session");
    expect(router.replace).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}?newSession=1`,
    );
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
    expect(
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="New session unavailable in September launch"]`,
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

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Project settings for Customer research"]',
        )!
        .click();
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
          'button[aria-label="New session in Customer research"]',
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
    expect(dialog.textContent).toContain("New session");
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
