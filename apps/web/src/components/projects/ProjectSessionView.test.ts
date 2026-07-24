// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunChatEvent } from "@companion/contracts";
import type {
  ProjectDetailVM,
  ProjectSessionVM,
  ProjectWorkspaceStatus,
} from "@/lib/projectsModel";
import {
  ProjectSessionView,
  SessionComposer,
} from "./ProjectSessionView";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-07-24T05:00:00.000Z";

const projectRpc = vi.hoisted(() => ({
  fetchProjectFileVersions: vi.fn(),
  fetchProjectFiles: vi.fn(),
  fetchProjectSession: vi.fn(),
  sendProjectPrompt: vi.fn(),
  stopProjectSession: vi.fn(),
}));
const streamRpc = vi.hoisted(() => ({
  openProjectStream: vi.fn(
    (
      _projectId: string,
      _sessionId: string,
      _onEvent: (event: RunChatEvent) => void,
    ) => new Promise<void>(() => undefined),
  ),
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      href,
      children,
      ...props
    }: {
      href: string;
      children: React.ReactNode;
    }) => createElement("a", { href, ...props }, children),
  };
});
vi.mock("@/lib/projects", () => ({
  ...projectRpc,
  projectFileHref: (projectId: string, fileId: string) =>
    `/v1/projects/${projectId}/files/${fileId}`,
  projectFileVersionHref: (
    projectId: string,
    fileId: string,
    version: number,
  ) => `/v1/projects/${projectId}/files/${fileId}/versions/${version}`,
}));
vi.mock("../runs/chatStream", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../runs/chatStream")>();
  return {
    ...actual,
    openProjectStream: streamRpc.openProjectStream,
  };
});
vi.mock("../runs/ChatTranscript", async () => {
  const { createElement } = await import("react");
  return {
    ChatTranscript: ({ showWorking }: { showWorking: boolean }) =>
      createElement(
        "div",
        {
          "data-testid": "project-transcript",
          "data-working": String(showWorking),
        },
        "Existing transcript",
      ),
  };
});

function session(
  overrides: Partial<ProjectSessionVM> = {},
): ProjectSessionVM {
  return {
    id: SESSION_ID,
    title: "Draft the launch calendar",
    model: "openai/gpt-5",
    status: "queued",
    history: [],
    pendingPrompts: [],
    latestEventSequence: 0,
    createdAt: NOW,
    lastActiveAt: NOW,
    errorMessage: null,
    ...overrides,
  };
}

function project({
  status,
  workspaceStatus = status,
  statusDetail,
  workspaceDetail,
}: {
  status: ProjectWorkspaceStatus;
  workspaceStatus?: ProjectWorkspaceStatus;
  statusDetail: string | null;
  workspaceDetail: string | null;
}): ProjectDetailVM {
  const activeSession = session();
  return {
    id: PROJECT_ID,
    name: "September launch",
    defaultModel: "openai/gpt-5",
    revision: 1,
    status,
    statusDetail,
    skillCount: 0,
    sessionCount: 1,
    fileCount: 0,
    secretCount: 2,
    createdAt: NOW,
    updatedAt: NOW,
    recentSessions: [activeSession],
    skills: [],
    sessions: [activeSession],
    files: [],
    workspace: {
      status: workspaceStatus,
      statusDetail: workspaceDetail,
      lastActiveAt: NOW,
      sleepAt: null,
    },
    modelConnectionCount: 1,
  };
}

async function renderSessionView(
  projectDetail: ProjectDetailVM,
  {
    onProjectSettings = vi.fn(),
    onRetryWorkspace = vi.fn(),
    retryBusy = false,
    retryError = null,
  }: {
    onProjectSettings?: () => void;
    onRetryWorkspace?: () => void;
    retryBusy?: boolean;
    retryError?: string | null;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      React.createElement(ProjectSessionView, {
        project: projectDetail,
        initialSession: projectDetail.sessions[0]!,
        onOpenNavigation: vi.fn(),
        onProjectSettings,
        onRetryWorkspace,
        retryBusy,
        retryError,
        onSessionChange: vi.fn(),
      }),
    );
    await Promise.resolve();
  });
  return { container, onProjectSettings, onRetryWorkspace };
}

function setValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  vi.clearAllMocks();
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("ProjectSessionView workspace state", () => {
  it.each([
    {
      status: "error" as const,
      workspaceStatus: "error" as const,
      statusDetail: "The synchronized Skill package could not be loaded.",
      workspaceDetail: null,
      expectedDetail: "The synchronized Skill package could not be loaded.",
    },
    {
      status: "running" as const,
      workspaceStatus: "needs_attention" as const,
      statusDetail: null,
      workspaceDetail: "The last workspace checkpoint is missing.",
      expectedDetail: "The last workspace checkpoint is missing.",
    },
  ])(
    "pauses a queued session when the workspace is $workspaceStatus",
    async ({
      status,
      workspaceStatus,
      statusDetail,
      workspaceDetail,
      expectedDetail,
    }) => {
      streamRpc.openProjectStream.mockImplementationOnce(
        (_projectId, _sessionId, onEvent) => {
          onEvent({
            type: "status",
            state: "busy",
            attempt: null,
            message: null,
          });
          return new Promise<void>(() => undefined);
        },
      );
      const { container, onProjectSettings, onRetryWorkspace } =
        await renderSessionView(
          project({
            status,
            workspaceStatus,
            statusDetail,
            workspaceDetail,
          }),
        );

      expect(
        container.querySelector(".cowork-session__top .cds-status")
          ?.textContent,
      ).toContain("Needs attention");
      expect(
        container
          .querySelector('[data-testid="project-transcript"]')
          ?.getAttribute("data-working"),
      ).toBe("false");
      expect(container.textContent).toContain("Existing transcript");
      expect(container.textContent).not.toContain("Working");

      const alert = container.querySelector<HTMLElement>(
        ".cowork-session__workspace-alert",
      );
      expect(alert?.getAttribute("role")).toBe("alert");
      expect(alert?.textContent).toContain(
        "This project needs attention.",
      );
      expect(alert?.textContent).toContain(expectedDetail);
      expect(alert?.textContent).toContain(
        "Messages are paused until the workspace is available again.",
      );

      const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
      expect(textarea?.disabled).toBe(true);
      expect(textarea?.placeholder).toBe(
        "Messages are paused while this project needs attention.",
      );
      expect(
        container.querySelector<HTMLInputElement>('input[type="file"]')
          ?.disabled,
      ).toBe(true);
      expect(
        [...container.querySelectorAll("button")].some(
          (candidate) => candidate.textContent === "Stop",
        ),
      ).toBe(false);

      act(() =>
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((candidate) => candidate.textContent === "Try again")
          ?.click(),
      );
      expect(onRetryWorkspace).toHaveBeenCalledOnce();

      act(() =>
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find(
            (candidate) => candidate.textContent === "Project settings",
          )
          ?.click(),
      );
      expect(onProjectSettings).toHaveBeenCalledOnce();
    },
  );

  it("announces a workspace retry failure", async () => {
    const blocked = project({
      status: "error",
      statusDetail: "The project runtime operation failed.",
      workspaceDetail: null,
    });
    const { container } = await renderSessionView(blocked, {
      retryError: "The retry request could not be saved.",
    });

    const recovery = container.querySelector<HTMLElement>(".cowork-recovery");
    expect(recovery?.getAttribute("aria-busy")).toBe("false");
    expect(recovery?.querySelector('[role="alert"]')?.textContent).toContain(
      "The retry request could not be saved.",
    );
  });

  it("locks only the retry action while keeping Project settings available", async () => {
    const blocked = project({
      status: "error",
      statusDetail: "The project runtime operation failed.",
      workspaceDetail: null,
    });
    const { container } = await renderSessionView(blocked, {
      retryBusy: true,
    });
    const recovery = container.querySelector<HTMLElement>(".cowork-recovery")!;

    expect(recovery.getAttribute("aria-busy")).toBe("true");
    expect(
      [...recovery.querySelectorAll<HTMLButtonElement>("button")].map(
        (candidate) => [candidate.textContent, candidate.disabled],
      ),
    ).toEqual([
      ["Trying…", true],
      ["Project settings", false],
    ]);
  });
});

describe("Project SessionComposer", () => {
  it("reuses the exact prompt idempotency key after a lost response", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce(undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        React.createElement(SessionComposer, {
          disabled: false,
          working: false,
          onSend,
        }),
      );
      await Promise.resolve();
    });

    setValue(container.querySelector("textarea")!, "Keep this exact draft");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Connection lost");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]?.[0].idempotencyKey).toBe(
      onSend.mock.calls[0]?.[0].idempotencyKey,
    );
  });

  it("locks every payload-changing control while a prompt is in flight", async () => {
    let resolveSend!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const onSend = vi.fn(() => pending);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        React.createElement(SessionComposer, {
          disabled: false,
          working: false,
          onSend,
        }),
      );
      await Promise.resolve();
    });

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["brief"], "brief.md", { type: "text/markdown" })],
    });
    act(() => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    setValue(container.querySelector("textarea")!, "Keep this payload stable");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
        .click();
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLTextAreaElement>("textarea")?.disabled,
    ).toBe(true);
    expect(fileInput.disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove brief.md"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      resolveSend();
      await pending;
      await Promise.resolve();
    });
  });
});
