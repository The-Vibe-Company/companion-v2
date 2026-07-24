// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_PROMPT_MAX_QUEUED,
  type RunChatEvent,
} from "@companion/contracts";
import type {
  ProjectDetailVM,
  ProjectFileVM,
  ProjectPromptVM,
  ProjectRuntimeAvailability,
  ProjectSessionVM,
  ProjectWorkspaceStatus,
} from "@/lib/projectsModel";
import {
  ProjectFilesDrawer,
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
  cancelProjectPrompt: vi.fn(),
  fetchProject: vi.fn(),
  fetchProjectFileVersions: vi.fn(),
  fetchProjectFiles: vi.fn(),
  fetchProjectSession: vi.fn(),
  rejectProjectQuestion: vi.fn(),
  replyProjectQuestion: vi.fn(),
  sendProjectPrompt: vi.fn(),
  stopProjectSession: vi.fn(),
}));
const streamRpc = vi.hoisted(() => ({
  openProjectStream: vi.fn(
    (
      _projectId: string,
      _sessionId: string,
      _onEvent: (event: RunChatEvent) => void,
      _signal?: AbortSignal,
      _cursor?: { lastEventId?: string | null },
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
    ChatTranscript: ({
      showWorking,
      workingLabel,
      workingDetail,
      workingVariant,
      renderUserAttachments,
      generatedFileTurns = [],
      onOpenFiles,
      pendingInteraction,
    }: {
      showWorking: boolean;
      workingLabel?: string;
      workingDetail?: string;
      workingVariant?: "default" | "preparing";
      renderUserAttachments?: (
        messageId: string | null,
        text: string,
      ) => React.ReactNode;
      generatedFileTurns?: Array<{
        messageId: string;
        files: Array<{
          id: string;
          path: string;
          name: string;
          version: number;
          contentType: string;
          byteSize: number;
          action: "created" | "updated";
        }>;
      }>;
      onOpenFiles?: (
        fileId?: string,
        version?: number,
        file?: {
          id: string;
          path: string;
          name: string;
          version: number;
          contentType: string;
          byteSize: number;
          action: "created" | "updated";
        },
      ) => void;
      pendingInteraction?: React.ReactNode;
    }) =>
      createElement(
        "div",
        {
          "data-testid": "project-transcript",
          "data-working": String(showWorking),
        },
        "Existing transcript",
        showWorking
          ? createElement(
              "div",
              {
                role: "status",
                "aria-live": "polite",
                "data-working-variant": workingVariant ?? "default",
              },
              workingLabel ?? "Working",
              workingDetail
                ? createElement("small", null, workingDetail)
                : null,
            )
          : null,
        renderUserAttachments?.(
          "message-with-attachment",
          "Review the brief",
        ),
        pendingInteraction,
        ...generatedFileTurns.flatMap((turn) =>
          turn.files.map((file) =>
            createElement(
              "button",
              {
                key: `${turn.messageId}:${file.id}:${file.version}`,
                type: "button",
                "data-generated-file-id": file.id,
                onClick: () => onOpenFiles?.(file.id, file.version, file),
              },
              file.name,
            ),
          ),
        ),
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
    prompts: [],
    pendingPrompts: [],
    questions: [],
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

function prompt(
  overrides: Partial<ProjectPromptVM> = {},
): ProjectPromptVM {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    sequence: 1,
    messageId: "project-message-1",
    text: "Draft the next section",
    status: "queued",
    attachments: [],
    fileChanges: [],
    createdAt: NOW,
    completedAt: null,
    errorCode: null,
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
    activeSessionCount: 1,
    archivedSessionCount: 0,
    unreadSessionCount: 0,
    fileCount: 0,
    secretCount: 2,
    archivedAt: null,
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
    access: {
      secrets: [],
      modelConnections: [],
    },
  };
}

async function renderSessionView(
  projectDetail: ProjectDetailVM,
  {
    onNewSession,
    onRenameSession,
    onArchiveSession,
    onProjectSettings = vi.fn(),
    onRetryWorkspace = vi.fn(),
    runtime = { available: true, message: null },
    onRetryRuntime,
    retryBusy = false,
    retryError = null,
  }: {
    onNewSession?: () => void;
    onRenameSession?: () => void;
    onArchiveSession?: () => Promise<void> | void;
    onProjectSettings?: () => void;
    onRetryWorkspace?: () => void;
    runtime?: ProjectRuntimeAvailability;
    onRetryRuntime?: () => Promise<void> | void;
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
        onNewSession,
        onRenameSession,
        onArchiveSession,
        onProjectSettings,
        onRetryWorkspace,
        runtime,
        onRetryRuntime,
        retryBusy,
        retryError,
        onSessionChange: vi.fn(),
      }),
    );
    await Promise.resolve();
  });
  return { container, onProjectSettings, onRetryWorkspace };
}

function button(scope: ParentNode, text: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(text),
  );
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Button not found: ${text}`);
  return match;
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
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  vi.resetAllMocks();
  streamRpc.openProjectStream.mockImplementation(
    (
      _projectId: string,
      _sessionId: string,
      _onEvent: (event: RunChatEvent) => void,
      _signal?: AbortSignal,
      _cursor?: { lastEventId?: string | null },
    ) => new Promise<void>(() => undefined),
  );
  window.sessionStorage.clear();
  document.body.innerHTML = "";
});

describe("ProjectSessionView workspace state", () => {
  it("shows the real wake and preparation phases inline while a queued Project starts", async () => {
    let resolveProject!: (value: ProjectDetailVM) => void;
    projectRpc.fetchProject.mockReturnValueOnce(
      new Promise<ProjectDetailVM>((resolve) => {
        resolveProject = resolve;
      }),
    );
    const sleeping = project({
      status: "stopped",
      statusDetail: null,
      workspaceDetail: null,
    });
    const { container } = await renderSessionView(sleeping);

    let preparation = container.querySelector<HTMLElement>(
      '[role="status"][data-working-variant="preparing"]',
    );
    expect(preparation?.getAttribute("aria-live")).toBe("polite");
    expect(preparation?.textContent).toContain("Waking up your Project");
    expect(preparation?.textContent).toContain(
      "Restoring the workspace, your files, and synchronized Skills.",
    );
    expect(
      container.querySelector(".cowork-session__top .cds-status")
        ?.textContent,
    ).toContain("Waking up");

    const provisioning = project({
      status: "provisioning",
      statusDetail: null,
      workspaceDetail: null,
    });
    await act(async () => {
      resolveProject(provisioning);
      await Promise.resolve();
      await Promise.resolve();
    });

    preparation = container.querySelector<HTMLElement>(
      '[role="status"][data-working-variant="preparing"]',
    );
    expect(preparation?.textContent).toContain("Preparing your Project");
    expect(preparation?.textContent).toContain(
      "Loading files, Skills, and access before your task starts.",
    );
    expect(
      container.querySelector(".cowork-session__top .cds-status")
        ?.textContent,
    ).toContain("Getting ready");
  });

  it("settles a completed warm turn before the next follow-up starts", async () => {
    const active = project({
      status: "provisioning",
      statusDetail: null,
      workspaceDetail: null,
    });
    active.sessions = [session({ status: "working" })];
    const ready = project({
      status: "ready",
      statusDetail: null,
      workspaceDetail: null,
    });
    ready.sessions = [session({ status: "completed" })];
    projectRpc.fetchProjectSession.mockResolvedValue(
      session({ status: "completed" }),
    );
    projectRpc.fetchProject.mockResolvedValue(ready);
    projectRpc.fetchProjectFiles.mockResolvedValue([]);
    projectRpc.sendProjectPrompt.mockResolvedValue(
      session({ status: "queued" }),
    );

    const { container } = await renderSessionView(active);
    const onEvent = streamRpc.openProjectStream.mock.calls.at(-1)?.[2];
    await act(async () => {
      onEvent?.({ type: "session.idle", session_id: SESSION_ID });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.fetchProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(
      container.querySelector(
        '[role="status"][data-working-variant="preparing"]',
      ),
    ).toBeNull();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    setValue(textarea, "Continue with the same warm Project");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const preparation = container.querySelector<HTMLElement>(
      '[role="status"][data-working-variant="preparing"]',
    );
    expect(preparation?.textContent).toContain("Starting your task");
    expect(preparation?.textContent).not.toContain(
      "Preparing your Project",
    );
  });

  it("does not let an older preparation response hide a durable File refresh", async () => {
    const fileId = "55555555-5555-4555-8555-555555555552";
    const durableFile = {
      id: fileId,
      path: "files/durable.txt",
      name: "durable.txt",
      version: 1,
      contentType: "text/plain",
      byteSize: 18,
      conflictDetected: false,
      modifiedBySessionId: SESSION_ID,
      modifiedByPromptId: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    let resolveOlderProject!: (value: ProjectDetailVM) => void;
    projectRpc.fetchProject.mockReturnValueOnce(
      new Promise<ProjectDetailVM>((resolve) => {
        resolveOlderProject = resolve;
      }),
    );
    projectRpc.fetchProjectFiles.mockResolvedValueOnce([durableFile]);
    const sleeping = project({
      status: "stopped",
      statusDetail: null,
      workspaceDetail: null,
    });
    const { container } = await renderSessionView(sleeping);
    const onEvent = streamRpc.openProjectStream.mock.calls.at(-1)?.[2];

    await act(async () => {
      onEvent?.({ type: "artifacts.updated", count: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button(container, "Files").textContent).toContain("1");

    const olderProjection = project({
      status: "provisioning",
      statusDetail: null,
      workspaceDetail: null,
    });
    olderProjection.files = [];
    await act(async () => {
      resolveOlderProject(olderProjection);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(button(container, "Files").textContent).toContain("1");
  });

  it("acknowledges a cold follow-up immediately and clears preparation if admission fails", async () => {
    let rejectSend!: (cause: Error) => void;
    projectRpc.sendProjectPrompt.mockReturnValueOnce(
      new Promise<ProjectSessionVM>((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    projectRpc.fetchProject.mockReturnValue(
      new Promise<ProjectDetailVM>(() => undefined),
    );
    const sleeping = project({
      status: "stopped",
      statusDetail: null,
      workspaceDetail: null,
    });
    sleeping.sessions = [session({ status: "completed" })];
    const { container } = await renderSessionView(sleeping);
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    setValue(textarea, "Continue with the launch plan");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
        .click();
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[role="status"][data-working-variant="preparing"]',
      )?.textContent,
    ).toContain("Waking up your Project");
    expect(
      container.querySelector(".cowork-session__status .project-status-dot")
        ?.classList,
    ).toContain("is-waiting");
    expect(
      container.querySelector(".cowork-session__status")?.classList,
    ).not.toContain("is-passive");

    await act(async () => {
      rejectSend(new Error("Could not queue the message."));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[role="status"][data-working-variant="preparing"]',
      ),
    ).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not queue the message.",
    );
  });

  it("keeps the conversation title as the mobile header landmark and de-emphasizes passive status", async () => {
    const available = project({
      status: "stopped",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [session({ status: "completed" })];
    const { container } = await renderSessionView(available);

    expect(container.querySelector("h1")?.textContent).toBe(
      "Draft the launch calendar",
    );
    expect(
      container.querySelector(".cowork-session__status")?.classList,
    ).toContain("is-passive");
  });

  it("surfaces a missing model connection instead of promising that a queued task will start", async () => {
    const disconnected = project({
      status: "error",
      workspaceStatus: "error",
      statusDetail: "Reconnect this session's model provider to continue.",
      workspaceDetail: "Reconnect this session's model provider to continue.",
    });
    disconnected.workspace.errorCode = "project_provider_unavailable";
    disconnected.sessions = [session({ status: "queued" })];

    const { container } = await renderSessionView(disconnected);

    expect(
      container.querySelector(
        '[role="status"][data-working-variant="preparing"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(".cowork-session__top .cds-status")
        ?.textContent,
    ).toContain("Connection needed");
    expect(container.textContent).toContain(
      "Reconnect this model to continue",
    );
    expect(
      container.querySelector<HTMLAnchorElement>(
        'a[href="/settings?view=models"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector("textarea")?.disabled).toBe(true);
  });

  it("keeps an OpenCode question inline and continues with the selected answer", async () => {
    const question = {
      requestId: "question-request-1",
      promptId: "33333333-3333-4333-8333-333333333350",
      protocol: "question" as const,
      questions: [
        {
          header: "Format",
          question: "Which format should I create?",
          options: [
            {
              label: "Markdown",
              description: "Easy to review and edit.",
            },
            {
              label: "PDF",
              description: "Ready to share.",
            },
          ],
          multiple: false,
          custom: true,
        },
      ],
      status: "pending" as const,
      responseKind: null,
      answers: null,
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [
      session({
        status: "working",
        questions: [question],
      }),
    ];
    projectRpc.replyProjectQuestion.mockResolvedValue(
      session({
        status: "working",
        questions: [{ ...question, status: "queued", responseKind: "reply" }],
      }),
    );

    const { container } = await renderSessionView(available);
    const card = container.querySelector<HTMLFormElement>(
      'form[aria-label="Question from the agent"]',
    );
    expect(card?.textContent).toContain("The agent needs your input");
    expect(card?.textContent).toContain("Which format should I create?");
    expect(
      container.querySelector('[data-working-variant="default"]'),
    ).toBeNull();

    await act(async () => {
      card
        ?.querySelector<HTMLInputElement>('input[value="Markdown"]')
        ?.click();
      await Promise.resolve();
    });
    const customAnswer = card?.querySelector<HTMLTextAreaElement>("textarea")!;
    setValue(customAnswer, "Email-ready memo");
    expect(
      card?.querySelector<HTMLInputElement>('input[value="Markdown"]')
        ?.checked,
    ).toBe(false);
    await act(async () => {
      button(card!, "Continue").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.replyProjectQuestion).toHaveBeenCalledWith(
      PROJECT_ID,
      SESSION_ID,
      question.requestId,
      [["Email-ready memo"]],
    );
    expect(container.textContent).toContain("Sending your answer");
  });

  it("keeps a custom answer inside OpenCode's maximum response cardinality", async () => {
    const options = Array.from({ length: 12 }, (_, index) => ({
      label: `Choice ${index + 1}`,
      description: "",
    }));
    const question = {
      requestId: "question-request-many",
      promptId: "33333333-3333-4333-8333-333333333354",
      protocol: "question.v2" as const,
      questions: [
        {
          header: "Sections",
          question: "Which sections should I include?",
          options,
          multiple: true,
          custom: true,
        },
      ],
      status: "pending" as const,
      responseKind: null,
      answers: null,
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [
      session({ status: "working", questions: [question] }),
    ];

    const { container } = await renderSessionView(available);
    for (const option of options) {
      await act(async () => {
        container
          .querySelector<HTMLInputElement>(`input[value="${option.label}"]`)
          ?.click();
        await Promise.resolve();
      });
    }

    const custom = container.querySelector<HTMLTextAreaElement>(
      ".cowork-question-card__custom textarea",
    );
    expect(custom?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Remove a choice to add a custom answer.",
    );
  });

  it("fails closed when an answer delivery cannot be confirmed", async () => {
    const failedQuestion = {
      requestId: "question-request-failed",
      promptId: "33333333-3333-4333-8333-333333333351",
      protocol: "question.v2" as const,
      questions: [
        {
          header: "Audience",
          question: "Who should receive this?",
          options: [],
          multiple: false,
          custom: true,
        },
      ],
      status: "failed" as const,
      responseKind: "reply" as const,
      answers: [["Leadership"]],
      errorMessage: "Provider acknowledgement timed out.",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [
      session({ status: "working", questions: [failedQuestion] }),
    ];
    const onNewSession = vi.fn();

    const { container } = await renderSessionView(available, {
      onNewSession,
    });

    const failed = container.querySelector(".cowork-question-card.is-failed");
    expect(failed?.textContent).toContain(
      "Your answer could not be confirmed",
    );
    expect(failed?.textContent).toContain("Your conversation and files are safe");
    expect(failed?.querySelector("form")).toBeNull();
    expect(failed?.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(projectRpc.replyProjectQuestion).not.toHaveBeenCalled();

    act(() => button(failed!, "Continue").click());
    expect(document.activeElement).toBe(
      container.querySelector<HTMLTextAreaElement>("#project-follow-up"),
    );
  });

  it("shows a new pending question ahead of a failed historical question", async () => {
    const failedQuestion = {
      requestId: "question-request-failed-history",
      promptId: "33333333-3333-4333-8333-333333333352",
      protocol: "question.v2" as const,
      questions: [
        {
          header: "Audience",
          question: "Who should receive the previous draft?",
          options: [],
          multiple: false,
          custom: true,
        },
      ],
      status: "failed" as const,
      responseKind: "reply" as const,
      answers: [["Leadership"]],
      errorMessage: "Provider acknowledgement timed out.",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const currentQuestion = {
      requestId: "question-request-current",
      promptId: "33333333-3333-4333-8333-333333333353",
      protocol: "question" as const,
      questions: [
        {
          header: "Format",
          question: "Which format should I create now?",
          options: [{ label: "Markdown", description: "" }],
          multiple: false,
          custom: false,
        },
      ],
      status: "pending" as const,
      responseKind: null,
      answers: null,
      errorMessage: null,
      createdAt: "2026-07-24T05:01:00.000Z",
      updatedAt: "2026-07-24T05:01:00.000Z",
    };
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [
      session({
        status: "working",
        questions: [failedQuestion, currentQuestion],
      }),
    ];

    const { container } = await renderSessionView(available);

    const card = container.querySelector<HTMLFormElement>(
      'form[aria-label="Question from the agent"]',
    );
    expect(card?.textContent).toContain("Which format should I create now?");
    expect(container.querySelector(".cowork-question-card.is-failed")).toBeNull();
  });

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
        "Messages are paused until the project is available again.",
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

  it("keeps an interrupted task recoverable without marking the Project as broken", async () => {
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [
      session({
        status: "error",
        errorMessage:
          "The previous agent turn was interrupted and could not be resumed safely.",
      }),
    ];
    const onNewSession = vi.fn();
    const onArchiveSession = vi.fn().mockResolvedValue(undefined);
    const { container } = await renderSessionView(available, {
      onNewSession,
      onArchiveSession,
    });

    expect(
      container.querySelector(".cowork-session__top .cds-status")
        ?.textContent,
    ).toContain("Task stopped");
    expect(
      container.querySelector(".cowork-session__workspace-alert"),
    ).toBeNull();
    const alert = container.querySelector<HTMLElement>(
      ".cowork-session__turn-alert",
    );
    expect(alert?.getAttribute("role")).toBe("status");
    expect(alert?.textContent).toContain("Your conversation and files are safe");
    expect(alert?.querySelector("details")?.hasAttribute("open")).toBe(false);

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.disabled).toBe(false);
    act(() =>
      [...alert!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Continue")
        ?.click(),
    );
    expect(document.activeElement).toBe(textarea);

    act(() =>
      [...alert!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "New conversation")
        ?.click(),
    );
    expect(onNewSession).toHaveBeenCalledOnce();

    await act(async () => {
      [...alert!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Archive")
        ?.click();
      await Promise.resolve();
    });
    expect(onArchiveSession).toHaveBeenCalledOnce();
  });

  it("keeps a completed conversation open for a follow-up", async () => {
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [session({ status: "completed" })];

    const { container } = await renderSessionView(available);

    expect(
      container.querySelector<HTMLTextAreaElement>("textarea")?.disabled,
    ).toBe(false);
    expect(
      container.querySelector<HTMLTextAreaElement>("textarea")?.placeholder,
    ).toBe("Message the agent…");
  });

  it("pauses messages accessibly while the Projects runtime is unavailable", async () => {
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [session({ status: "completed" })];
    const onRetryRuntime = vi.fn(async () => undefined);

    const { container } = await renderSessionView(available, {
      runtime: {
        available: false,
        message: "Project runtime is starting.",
      },
      onRetryRuntime,
    });

    const textarea =
      container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toBe(
      "Messages are paused while Projects reconnects.",
    );
    const state = container.querySelector<HTMLElement>(
      ".cowork-session__runtime-state[role='status']",
    );
    expect(state?.textContent).toContain("Messages are temporarily paused.");
    expect(state?.textContent).toContain("Project runtime is starting.");

    await act(async () => {
      [...state!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Check again")
        ?.click();
      await Promise.resolve();
    });
    expect(onRetryRuntime).toHaveBeenCalledOnce();
  });

  it("reconciles an idle conversation rename and archive without losing its draft or focus", async () => {
    vi.useFakeTimers();
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    const idle = session({ status: "idle" });
    const renamed = { ...idle, title: "Launch calendar with sources" };
    const archived = { ...renamed, archivedAt: NOW };
    available.sessions = [idle];
    projectRpc.fetchProjectSession
      .mockResolvedValueOnce(renamed)
      .mockResolvedValueOnce(archived);

    const { container } = await renderSessionView(available);
    const textarea =
      container.querySelector<HTMLTextAreaElement>("textarea")!;
    setValue(textarea, "Keep this follow-up draft");
    act(() => textarea.focus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(container.querySelector("h1")?.textContent).toBe(
      "Launch calendar with sources",
    );
    expect(textarea.value).toBe("Keep this follow-up draft");
    expect(document.activeElement).toBe(textarea);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(textarea.value).toBe("Keep this follow-up draft");
    expect(textarea.disabled).toBe(true);
    expect(
      container.querySelector(".cowork-session__top .cds-status")?.textContent,
    ).toContain("Archived");
  });

  it("keeps archived Project conversations readable but not writable", async () => {
    const archived = project({
      status: "stopped",
      statusDetail: null,
      workspaceDetail: null,
    });
    archived.archivedAt = NOW;
    archived.sessions = [session({ status: "completed" })];

    const onNewSession = vi.fn();
    const { container } = await renderSessionView(archived, {
      onNewSession,
    });

    expect(
      container.querySelector(".cowork-session__top .cds-status")
        ?.textContent,
    ).toContain("Archived");
    expect(
      container.querySelector<HTMLTextAreaElement>("textarea")?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLTextAreaElement>("textarea")?.placeholder,
    ).toBe("Restore this project to continue the conversation.");
    expect(
      [...container.querySelectorAll("button")].some(
        (candidate) => candidate.textContent?.trim() === "New conversation",
      ),
    ).toBe(false);
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it.each([
    ["video/mp4", "video"],
    ["application/pdf", "iframe"],
  ])(
    "keeps the %s native preview inside the mobile Files focus loop",
    async (contentType, previewSelector) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      roots.push(root);
      const file: ProjectFileVM = {
        id: "55555555-5555-4555-8555-555555555599",
        path: "files/preview.bin",
        name: "preview.bin",
        version: 1,
        contentType,
        byteSize: 120,
        conflictDetected: false,
        modifiedBySessionId: SESSION_ID,
        modifiedByPromptId: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await act(async () => {
        root.render(
          React.createElement(ProjectFilesDrawer, {
            open: true,
            projectId: PROJECT_ID,
            files: [],
            selection: {
              ...file,
              exactVersion: true,
            },
            attachmentPreview: null,
            returnFocusRef: { current: null },
            onSelectionChange: vi.fn(),
            onClose: vi.fn(),
          }),
        );
        await Promise.resolve();
      });
      const preview = document.body.querySelector<HTMLElement>(
        '.cowork-file-preview[aria-label="Preview preview.bin"]',
      )!;
      const download = preview.querySelector<HTMLAnchorElement>(
        'a[aria-label="Download preview.bin version 1"]',
      )!;
      expect(preview.querySelector(previewSelector)).not.toBeNull();
      act(() => download.focus());
      const tab = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      act(() => document.dispatchEvent(tab));
      expect(tab.defaultPrevented).toBe(false);
    },
  );

  it("filters a long-lived Project file list without closing the workbench", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const makeFile = (id: string, name: string): ProjectFileVM => ({
      id,
      path: `files/${name}`,
      name,
      version: 1,
      contentType: "text/markdown",
      byteSize: 120,
      conflictDetected: false,
      modifiedBySessionId: SESSION_ID,
      modifiedByPromptId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await act(async () => {
      root.render(
        React.createElement(ProjectFilesDrawer, {
          open: true,
          projectId: PROJECT_ID,
          files: [
            makeFile("55555555-5555-4555-8555-555555555591", "brief.md"),
            makeFile("55555555-5555-4555-8555-555555555592", "timeline.md"),
          ],
          selection: null,
          attachmentPreview: null,
          returnFocusRef: { current: null },
          onSelectionChange: vi.fn(),
          onClose: vi.fn(),
        }),
      );
      await Promise.resolve();
    });

    const search =
      document.body.querySelector<HTMLInputElement>(
        'input[placeholder="Search files"]',
      )!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(search, "timeline");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const list = document.body.querySelector(
      ".project-files-drawer__list",
    );
    expect(list?.textContent).toContain("timeline.md");
    expect(list?.textContent).not.toContain("brief.md");
    expect(document.body.textContent).toContain("1 of 2");
  });

  it("previews a durable prompt attachment beside the conversation", async () => {
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [
      session({
        status: "completed",
        prompts: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            sequence: 1,
            messageId: "message-with-attachment",
            text: "Review the brief",
            status: "completed",
            attachments: [
              {
                id: "44444444-4444-4444-8444-444444444444",
                fileName: "brief.png",
                contentType: "image/png",
                byteSize: 42,
                workspacePath: "files/brief.png",
                status: "uploaded",
                createdAt: NOW,
              },
            ],
            fileChanges: [],
            createdAt: NOW,
            completedAt: NOW,
            errorCode: null,
            errorMessage: null,
          },
        ],
      }),
    ];

    const { container } = await renderSessionView(available);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Preview brief.png"]',
        )!
        .click();
      await Promise.resolve();
    });

    const preview = document.body.querySelector<HTMLElement>(
      '.cowork-file-preview[aria-label="Preview brief.png"]',
    );
    expect(preview).not.toBeNull();
    expect(preview?.querySelector("img")?.getAttribute("src")).toContain(
      "/attachments/44444444-4444-4444-8444-444444444444",
    );
    expect(
      document.body.querySelector('a[target="_blank"]'),
    ).toBeNull();
  });

  it("keeps generated file versions independently previewable and switches the controlled target atomically", async () => {
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
    const deletedFileId = "55555555-5555-4555-8555-555555555551";
    const changedFileId = "55555555-5555-4555-8555-555555555552";
    const officeFileId = "55555555-5555-4555-8555-555555555553";
    const currentChangedFile = {
      id: changedFileId,
      path: "files/changed.pdf",
      name: "changed.pdf",
      version: 2,
      contentType: "application/pdf",
      byteSize: 900,
      conflictDetected: false,
      modifiedBySessionId: SESSION_ID,
      modifiedByPromptId: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.files = [currentChangedFile];
    available.sessions = [
      session({
        status: "completed",
        prompts: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            sequence: 1,
            messageId: "generated-files-message",
            text: "Create two images",
            status: "completed",
            attachments: [],
            fileChanges: [
              {
                projectId: PROJECT_ID,
                fileId: deletedFileId,
                path: "files/deleted.png",
                kind: "created",
                version: 1,
                contentType: "image/png",
                byteSize: 120,
                modifiedBySessionId: SESSION_ID,
                modifiedByPromptId:
                  "33333333-3333-4333-8333-333333333333",
                conflictDetected: false,
                createdAt: NOW,
              },
              {
                projectId: PROJECT_ID,
                fileId: changedFileId,
                path: "files/changed.png",
                kind: "updated",
                version: 1,
                contentType: "image/png",
                byteSize: 240,
                modifiedBySessionId: SESSION_ID,
                modifiedByPromptId:
                  "33333333-3333-4333-8333-333333333333",
                conflictDetected: false,
                createdAt: NOW,
              },
              {
                projectId: PROJECT_ID,
                fileId: officeFileId,
                path: "files/deck.pptx",
                kind: "created",
                version: 1,
                contentType:
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                byteSize: 1_024,
                modifiedBySessionId: SESSION_ID,
                modifiedByPromptId:
                  "33333333-3333-4333-8333-333333333333",
                conflictDetected: false,
                createdAt: NOW,
              },
            ],
            createdAt: NOW,
            completedAt: NOW,
            errorCode: null,
            errorMessage: null,
          },
        ],
      }),
    ];
    projectRpc.fetchProjectFiles.mockResolvedValue([currentChangedFile]);
    const { container } = await renderSessionView(available);
    const generatedButton = (fileId: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-generated-file-id="${fileId}"]`,
      )!;

    await act(async () => {
      generatedButton(deletedFileId).click();
      await Promise.resolve();
    });
    let preview = document.body.querySelector<HTMLElement>(
      '.cowork-file-preview[aria-label="Preview deleted.png"]',
    )!;
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(
      `/v1/projects/${PROJECT_ID}/files/${deletedFileId}/versions/1`,
    );

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '.project-files-drawer button[aria-label="Close files"]',
        )!
        .click();
      await Promise.resolve();
      generatedButton(deletedFileId).click();
      await Promise.resolve();
    });
    preview = document.body.querySelector<HTMLElement>(
      '.cowork-file-preview[aria-label="Preview deleted.png"]',
    )!;
    expect(preview.querySelector("img")?.getAttribute("src")).toContain(
      `/${deletedFileId}/versions/1`,
    );

    await act(async () => {
      generatedButton(changedFileId).click();
      await Promise.resolve();
    });
    preview = document.body.querySelector<HTMLElement>(
      '.cowork-file-preview[aria-label="Preview changed.png"]',
    )!;
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(
      `/v1/projects/${PROJECT_ID}/files/${changedFileId}/versions/1`,
    );
    expect(preview.querySelector("iframe")).toBeNull();
    expect(preview.textContent).not.toContain("900 B");
    expect(preview.textContent).toContain("240 B");

    await act(async () => {
      generatedButton(officeFileId).click();
      await Promise.resolve();
    });
    preview = document.body.querySelector<HTMLElement>(
      '.cowork-file-preview[aria-label="Preview deck.pptx"]',
    )!;
    expect(preview.textContent).toContain("Preview not available");
    expect(
      preview
        .querySelector<HTMLAnchorElement>(
          'a[aria-label="Download deck.pptx version 1"]',
        )
        ?.getAttribute("href"),
    ).toBe(
      `/v1/projects/${PROJECT_ID}/files/${officeFileId}/versions/1`,
    );
  });

  it("refreshes a selected current file from the live files projection", async () => {
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
    const fileId = "55555555-5555-4555-8555-555555555554";
    const initialFile = {
      id: fileId,
      path: "files/live.png",
      name: "live.png",
      version: 1,
      contentType: "image/png",
      byteSize: 120,
      conflictDetected: false,
      modifiedBySessionId: SESSION_ID,
      modifiedByPromptId: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const updatedFile = {
      ...initialFile,
      path: "files/live.mp4",
      name: "live.mp4",
      version: 2,
      contentType: "video/mp4",
      byteSize: 900,
      updatedAt: "2026-07-24T06:00:00.000Z",
    };
    const promptId = "33333333-3333-4333-8333-333333333334";
    const reconciledSession = session({
      status: "completed",
      latestEventSequence: 1,
      currentEventSequence: 2,
      prompts: [
        {
          id: promptId,
          sequence: 1,
          messageId: "message-reconciled-file",
          text: "Create the live file",
          status: "completed",
          attachments: [],
          fileChanges: [
            {
              projectId: PROJECT_ID,
              fileId,
              path: updatedFile.path,
              kind: "updated",
              version: updatedFile.version,
              contentType: updatedFile.contentType,
              byteSize: updatedFile.byteSize,
              modifiedBySessionId: SESSION_ID,
              modifiedByPromptId: promptId,
              conflictDetected: false,
              createdAt: updatedFile.updatedAt,
            },
          ],
          createdAt: NOW,
          completedAt: updatedFile.updatedAt,
          errorCode: null,
          errorMessage: null,
        },
      ],
    });
    const available = project({
      status: "ready",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.files = [initialFile];
    available.sessions = [session({ status: "idle" })];
    projectRpc.fetchProjectFiles
      .mockResolvedValueOnce([initialFile])
      .mockResolvedValue([updatedFile]);
    projectRpc.fetchProjectSession.mockResolvedValueOnce(reconciledSession);
    const { container } = await renderSessionView(available);

    await act(async () => {
      button(container, "Files").click();
      await Promise.resolve();
    });
    await act(async () => {
      button(document.body, "Preview").click();
      await Promise.resolve();
    });
    let preview = document.body.querySelector<HTMLElement>(
      '.cowork-file-preview[aria-label="Preview live.png"]',
    )!;
    expect(preview.querySelector("img")).not.toBeNull();
    expect(preview.textContent).toContain("v1");
    const onEvent = streamRpc.openProjectStream.mock.calls.at(-1)?.[2];

    await act(async () => {
      onEvent?.({ type: "artifacts.updated", count: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });

    preview = document.body.querySelector<HTMLElement>(
      '.cowork-file-preview[aria-label="Preview live.mp4"]',
    )!;
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.querySelector("video")).not.toBeNull();
    expect(preview.textContent).toContain("v2");
    expect(
      container.querySelector(
        `[data-generated-file-id="${fileId}"]`,
      ),
    ).not.toBeNull();
    expect(preview.textContent).toContain("900 B");
  });

  it("refreshes Project Files when a turn reaches a terminal event", async () => {
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [session({ status: "working" })];
    projectRpc.fetchProjectSession.mockResolvedValue(
      session({ status: "idle" }),
    );
    projectRpc.fetchProjectFiles.mockResolvedValue([]);
    await renderSessionView(available);
    const onEvent = streamRpc.openProjectStream.mock.calls.at(-1)?.[2];

    await act(async () => {
      onEvent?.({
        type: "prompt.status",
        prompt_id: "33333333-3333-4333-8333-333333333333",
        message_id: "message-terminal",
        ordinal: 1,
        status: "completed",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.fetchProjectFiles).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("reopens a terminal stream when durable reconciliation advances its event cursor", async () => {
    vi.useFakeTimers();
    try {
      const available = project({
        status: "ready",
        statusDetail: null,
        workspaceDetail: null,
      });
      available.sessions = [
        session({
          status: "completed",
          latestEventSequence: 1,
          currentEventSequence: 1,
        }),
      ];
      projectRpc.fetchProjectSession.mockResolvedValue(
        session({
          status: "completed",
          latestEventSequence: 1,
          currentEventSequence: 2,
        }),
      );
      await renderSessionView(available);
      expect(streamRpc.openProjectStream).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await Promise.resolve();
      });

      expect(streamRpc.openProjectStream.mock.calls.length).toBeGreaterThan(1);
      expect(
        streamRpc.openProjectStream.mock.calls.at(-1)?.[4],
      ).toEqual(
        expect.objectContaining({ lastEventId: "1" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances the replay cursor past folded events before reopening for a late barrier", async () => {
    vi.useFakeTimers();
    try {
      const available = project({
        status: "ready",
        statusDetail: null,
        workspaceDetail: null,
      });
      available.sessions = [
        session({
          status: "completed",
          latestEventSequence: 1,
          currentEventSequence: 1,
        }),
      ];
      projectRpc.fetchProjectSession
        .mockResolvedValueOnce(
          session({
            status: "completed",
            latestEventSequence: 2,
            currentEventSequence: 2,
          }),
        )
        .mockResolvedValue(
          session({
            status: "completed",
            latestEventSequence: 2,
            currentEventSequence: 3,
          }),
        );
      await renderSessionView(available);
      expect(streamRpc.openProjectStream).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await Promise.resolve();
      });

      expect(streamRpc.openProjectStream).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await Promise.resolve();
      });

      expect(streamRpc.openProjectStream.mock.calls.length).toBeGreaterThan(1);
      expect(
        streamRpc.openProjectStream.mock.calls.at(-1)?.[4],
      ).toEqual(
        expect.objectContaining({ lastEventId: "2" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a completed turn file visible while another prompt remains queued", async () => {
    const firstPromptId = "33333333-3333-4333-8333-333333333331";
    const secondPromptId = "33333333-3333-4333-8333-333333333332";
    const fileId = "55555555-5555-4555-8555-555555555551";
    const firstPrompt = {
      id: firstPromptId,
      sequence: 1,
      messageId: "message-first",
      text: "Create the first file",
      status: "running" as const,
      attachments: [],
      fileChanges: [],
      createdAt: NOW,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
    };
    const secondPrompt = {
      id: secondPromptId,
      sequence: 2,
      messageId: "message-second",
      text: "Continue with the next task",
      status: "queued" as const,
      attachments: [],
      fileChanges: [],
      createdAt: NOW,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
    };
    const durableFile = {
      id: fileId,
      path: "files/first.txt",
      name: "first.txt",
      version: 1,
      contentType: "text/plain",
      byteSize: 12,
      conflictDetected: false,
      modifiedBySessionId: SESSION_ID,
      modifiedByPromptId: firstPromptId,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [
      session({
        status: "queued",
        prompts: [firstPrompt, secondPrompt],
        pendingPrompts: [firstPrompt, secondPrompt],
      }),
    ];
    projectRpc.fetchProjectSession.mockResolvedValue(
      session({
        status: "queued",
        prompts: [
          {
            ...firstPrompt,
            status: "completed",
            completedAt: NOW,
            fileChanges: [
              {
                projectId: PROJECT_ID,
                fileId,
                path: "files/first.txt",
                kind: "created",
                version: 1,
                contentType: "text/plain",
                byteSize: 12,
                modifiedBySessionId: SESSION_ID,
                modifiedByPromptId: firstPromptId,
                conflictDetected: false,
                createdAt: NOW,
              },
            ],
          },
          secondPrompt,
        ],
        pendingPrompts: [secondPrompt],
      }),
    );
    let resolveStaleFiles!: (value: []) => void;
    projectRpc.fetchProjectFiles
      .mockReturnValueOnce(
        new Promise<[]>((resolve) => {
          resolveStaleFiles = resolve;
        }),
      )
      .mockResolvedValueOnce([durableFile]);
    const { container } = await renderSessionView(available);
    const onEvent = streamRpc.openProjectStream.mock.calls.at(-1)?.[2];

    await act(async () => {
      onEvent?.({
        type: "prompt.status",
        prompt_id: firstPromptId,
        message_id: "message-first",
        ordinal: 1,
        status: "completed",
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.fetchProjectFiles).toHaveBeenCalledTimes(2);
    expect(button(container, "Files").textContent).toContain("1");

    await act(async () => {
      resolveStaleFiles([]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(button(container, "Files").textContent).toContain("1");
  });

  it("restores an exact generated target after selecting another desktop file", async () => {
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
    const generatedId = "55555555-5555-4555-8555-555555555555";
    const otherId = "55555555-5555-4555-8555-555555555556";
    const available = project({
      status: "ready",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.files = [
      {
        id: generatedId,
        path: "files/result.png",
        name: "result.png",
        version: 2,
        contentType: "image/png",
        byteSize: 300,
        conflictDetected: false,
        modifiedBySessionId: SESSION_ID,
        modifiedByPromptId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: otherId,
        path: "files/other.jpg",
        name: "other.jpg",
        version: 1,
        contentType: "image/jpeg",
        byteSize: 500,
        conflictDetected: false,
        modifiedBySessionId: SESSION_ID,
        modifiedByPromptId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    available.sessions = [
      session({
        status: "completed",
        prompts: [
          {
            id: "33333333-3333-4333-8333-333333333334",
            sequence: 1,
            messageId: "desktop-generated-file",
            text: "Create the result",
            status: "completed",
            attachments: [],
            fileChanges: [
              {
                projectId: PROJECT_ID,
                fileId: generatedId,
                path: "files/result.png",
                kind: "created",
                version: 1,
                contentType: "image/png",
                byteSize: 200,
                modifiedBySessionId: SESSION_ID,
                modifiedByPromptId:
                  "33333333-3333-4333-8333-333333333334",
                conflictDetected: false,
                createdAt: NOW,
              },
            ],
            createdAt: NOW,
            completedAt: NOW,
            errorCode: null,
            errorMessage: null,
          },
        ],
      }),
    ];
    projectRpc.fetchProjectFiles.mockResolvedValue(available.files);
    const { container } = await renderSessionView(available);
    const generatedButton = container.querySelector<HTMLButtonElement>(
      `[data-generated-file-id="${generatedId}"]`,
    )!;

    await act(async () => {
      generatedButton.click();
      await Promise.resolve();
    });
    const otherCard = [
      ...document.body.querySelectorAll<HTMLElement>(".project-file-card"),
    ].find((candidate) => candidate.textContent?.includes("other.jpg"))!;
    await act(async () => {
      button(otherCard, "Preview").click();
      await Promise.resolve();
    });
    expect(
      document.body.querySelector(
        '.cowork-file-preview[aria-label="Preview other.jpg"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      generatedButton.click();
      await Promise.resolve();
    });
    const preview = document.body.querySelector<HTMLElement>(
      '.cowork-file-preview[aria-label="Preview result.png"]',
    )!;
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(
      `/v1/projects/${PROJECT_ID}/files/${generatedId}/versions/1`,
    );
    expect(preview.textContent).toContain("200 B");
  });

  it("restores focus after closing the desktop files panel", async () => {
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
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    projectRpc.fetchProjectFiles.mockResolvedValue([]);
    const { container } = await renderSessionView(available);
    const filesButton = container.querySelector<HTMLButtonElement>(
      ".cowork-session__files",
    )!;
    await act(async () => {
      filesButton.click();
      await Promise.resolve();
    });
    const close = container.querySelector<HTMLButtonElement>(
      '.cowork-session-files-panel button[aria-label="Close files"]',
    )!;
    await act(async () => {
      close.focus();
      close.click();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(filesButton);
  });

  it("shows a durable follow-up once and reconciles it after removal", async () => {
    const current = prompt({
      id: "33333333-3333-4333-8333-333333333341",
      messageId: "project-message-current",
      text: "Draft the report",
      status: "running",
    });
    const queued = prompt({
      id: "33333333-3333-4333-8333-333333333342",
      messageId: "project-message-queued",
      text: "Add a concise executive summary",
    });
    const available = project({
      status: "running",
      statusDetail: null,
      workspaceDetail: null,
    });
    available.sessions = [
      session({
        status: "working",
        history: [
          {
            kind: "user",
            message_id: current.messageId,
            text: current.text,
          },
        ],
        prompts: [current, queued],
        pendingPrompts: [current, queued],
      }),
    ];
    projectRpc.cancelProjectPrompt.mockResolvedValue(
      session({
        status: "working",
        history: [
          {
            kind: "user",
            message_id: current.messageId,
            text: current.text,
          },
        ],
        prompts: [current, { ...queued, status: "cancelled" }],
        pendingPrompts: [current],
      }),
    );

    const { container } = await renderSessionView(available);
    expect(container.textContent).toContain("Runs next");
    expect(container.textContent).toContain(
      "Add a concise executive summary",
    );
    expect(
      container.querySelectorAll(
        '[aria-label="Messages that run next"] li',
      ),
    ).toHaveLength(1);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="Remove queued message"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectRpc.cancelProjectPrompt).toHaveBeenCalledWith(
      PROJECT_ID,
      SESSION_ID,
      queued.id,
    );
    expect(
      container.querySelector('[aria-label="Messages that run next"]'),
    ).toBeNull();
  });
});

describe("Project SessionComposer", () => {
  it("keeps the composer available and explains that a follow-up runs next", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onCancelPrompt = vi.fn();
    const queued = prompt({
      id: "33333333-3333-4333-8333-333333333334",
      messageId: "project-message-2",
      text: "Add the sources after the draft",
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        React.createElement(SessionComposer, {
          disabled: false,
          working: true,
          queuedPrompts: [queued],
          onCancelPrompt,
          onSend,
        }),
      );
      await Promise.resolve();
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.disabled).toBe(false);
    expect(textarea.placeholder).toBe("Add a message to run next…");
    expect(container.textContent).toContain("Runs next");
    expect(container.textContent).toContain("Add the sources after the draft");

    setValue(textarea, "Check the final tone");
    const send = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add message to Runs next"]',
    );
    expect(send?.disabled).toBe(false);
    expect(container.textContent).toContain(
      "Your message will start after the current task.",
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="Remove queued message"]',
        )
        ?.click(),
    );
    expect(onCancelPrompt).toHaveBeenCalledWith(queued.id);
  });

  it("keeps the draft editable but explains when Runs next is full", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        React.createElement(SessionComposer, {
          disabled: false,
          working: true,
          queuedPrompts: Array.from(
            { length: PROJECT_PROMPT_MAX_QUEUED },
            (_, index) =>
              prompt({
                id: `33333333-3333-4333-8333-3333333333${60 + index}`,
                messageId: `project-message-full-${index}`,
                text: `Queued follow-up ${index + 1}`,
              }),
          ),
          onSend,
        }),
      );
      await Promise.resolve();
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    setValue(textarea, "Keep drafting another follow-up");
    expect(textarea.disabled).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Runs next is full"]',
      )?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain(
      "Runs next is full · remove a message to add another.",
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("restores a draft for the same conversation", async () => {
    const draftKey = "companion:project-draft:test-session";
    const firstContainer = document.createElement("div");
    document.body.appendChild(firstContainer);
    const firstRoot = createRoot(firstContainer);
    await act(async () => {
      firstRoot.render(
        React.createElement(SessionComposer, {
          draftKey,
          disabled: false,
          working: false,
          onSend: vi.fn(),
        }),
      );
      await Promise.resolve();
    });
    setValue(firstContainer.querySelector("textarea")!, "Keep this draft");
    expect(window.sessionStorage.getItem(draftKey)).toBe("Keep this draft");
    act(() => firstRoot.unmount());

    const secondContainer = document.createElement("div");
    document.body.appendChild(secondContainer);
    const secondRoot = createRoot(secondContainer);
    roots.push(secondRoot);
    await act(async () => {
      secondRoot.render(
        React.createElement(SessionComposer, {
          draftKey,
          disabled: false,
          working: false,
          onSend: vi.fn(),
        }),
      );
      await Promise.resolve();
    });

    expect(
      secondContainer.querySelector<HTMLTextAreaElement>("textarea")?.value,
    ).toBe("Keep this draft");
  });

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
