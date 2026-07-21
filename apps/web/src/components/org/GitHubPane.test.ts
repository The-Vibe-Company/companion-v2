// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitHubConnection,
  GitHubIntegrationResponse,
  GitHubSyncDestination,
  SkillListRow,
} from "@companion/contracts";
import { GitHubPane } from "./GitHubPane";
import type { OrgCtx } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const githubMocks = vi.hoisted(() => ({
  beginGitHubConnection: vi.fn(),
  createGitHubDestination: vi.fn(),
  createGitHubRepository: vi.fn(),
  deleteGitHubDestination: vi.fn(),
  disconnectGitHubAccount: vi.fn(),
  fetchGitHubIntegration: vi.fn(),
  fetchGitHubRepositories: vi.fn(),
  syncGitHubDestination: vi.fn(),
  updateGitHubDestination: vi.fn(),
}));
const queryMocks = vi.hoisted(() => ({ fetchSkillLibrary: vi.fn() }));

vi.mock("@/lib/github", () => githubMocks);
vi.mock("@/lib/queries", () => ({ fetchSkillLibrary: queryMocks.fetchSkillLibrary }));

const roots: Root[] = [];
const destinationId = "11111111-1111-4111-8111-111111111111";
const activeSkillId = "22222222-2222-4222-8222-222222222222";
const archivedSkillId = "33333333-3333-4333-8333-333333333333";

const connected: GitHubConnection = {
  configured: true,
  app_slug: "companion",
  app_name: "Companion",
  managed: true,
  connected: true,
  github_login: "octocat",
  github_avatar_url: null,
  connected_at: "2026-07-20T10:00:00.000Z",
};

function destination(overrides: Partial<GitHubSyncDestination> = {}): GitHubSyncDestination {
  return {
    id: destinationId,
    installation_id: "installation-1",
    repository_id: "repository-1",
    owner: "acme",
    name: "companion-skills",
    full_name: "acme/companion-skills",
    html_url: "https://github.com/acme/companion-skills",
    default_branch: "main",
    private: true,
    mode: "all",
    selected_skill_ids: [],
    resolved_skill_count: 0,
    status: "synced",
    desired_revision: 1,
    applied_revision: 1,
    last_synced_at: "2026-07-20T10:00:00.000Z",
    last_commit_sha: "0123456789abcdef",
    last_error: null,
    next_retry_at: null,
    ...overrides,
  };
}

function skill(id: string, slug: string, archived: boolean): SkillListRow {
  return {
    id,
    slug,
    display: { name: slug === "active-skill" ? "Active skill" : "Archived skill" },
    current_version: "1.0.0",
    archived,
  } as SkillListRow;
}

async function mount(integration: GitHubIntegrationResponse) {
  githubMocks.fetchGitHubIntegration.mockResolvedValue(integration);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(React.createElement(GitHubPane, { ctx: {} as OrgCtx }));
    await Promise.resolve();
  });

  return container;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

beforeEach(() => {
  for (const mock of Object.values(githubMocks)) mock.mockReset();
  queryMocks.fetchSkillLibrary.mockReset().mockResolvedValue([]);
  githubMocks.fetchGitHubRepositories.mockResolvedValue({
    repositories: [],
    installations: [],
    install_url: "https://github.com/apps/companion/installations/new",
  });
  githubMocks.deleteGitHubDestination.mockResolvedValue({ ok: true });
  githubMocks.disconnectGitHubAccount.mockResolvedValue({ ok: true });
  githubMocks.syncGitHubDestination.mockResolvedValue({ ok: true });
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitHubPane", () => {
  it("does not expose repository actions when configuration is disabled despite stale connection metadata", async () => {
    const container = await mount({
      connection: { ...connected, configured: false },
      destinations: [destination()],
    });

    expect(container.textContent).toContain("GitHub sync is unavailable");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.includes("Add repository"))).toBe(false);
  });

  it("renders an initial integration failure with an in-place retry", async () => {
    githubMocks.fetchGitHubIntegration.mockRejectedValueOnce(new Error("GitHub integration is unavailable"));
    const container = await mount({ connection: connected, destinations: [] });

    expect(container.textContent).toContain("GitHub synchronization could not be loaded");
    expect(container.textContent).toContain("GitHub integration is unavailable");

    await act(async () => {
      buttonByText(container, "Retry").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Connected with Companion");
    expect(container.textContent).not.toContain("GitHub integration is unavailable");
  });

  it("clears a recovered poll failure without masking a later action failure", async () => {
    vi.useFakeTimers();
    const pending = {
      connection: connected,
      destinations: [destination({ status: "pending" })],
    } satisfies GitHubIntegrationResponse;
    githubMocks.fetchGitHubIntegration
      .mockResolvedValueOnce(pending)
      .mockRejectedValueOnce(new Error("Polling temporarily failed"));
    const container = await mount(pending);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(container.textContent).toContain("Polling temporarily failed");

    githubMocks.syncGitHubDestination.mockRejectedValueOnce(new Error("Manual sync failed"));
    await act(async () => {
      buttonByText(container, "Sync now").click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Manual sync failed");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(container.textContent).toContain("Manual sync failed");
    expect(container.textContent).not.toContain("Polling temporarily failed");
  });

  it("retains an archived selected skill when editing a selected mirror", async () => {
    const activeSkill = skill(activeSkillId, "active-skill", false);
    const archivedSkill = skill(archivedSkillId, "archived-skill", true);
    queryMocks.fetchSkillLibrary.mockImplementation(async (_library: string, archived = false) =>
      archived ? [archivedSkill] : [activeSkill],
    );
    const container = await mount({
      connection: connected,
      destinations: [destination({
        mode: "selected",
        selected_skill_ids: [archivedSkillId],
        resolved_skill_count: 1,
      })],
    });

    await act(async () => {
      buttonByText(container, "Edit selection").click();
      await Promise.resolve();
    });

    expect(queryMocks.fetchSkillLibrary).toHaveBeenCalledWith("org");
    expect(queryMocks.fetchSkillLibrary).toHaveBeenCalledWith("org", true);
    expect(container.textContent).toContain("Active skill");
    expect(container.textContent).toContain("Archived skill");
    expect(container.textContent).toContain("Archived · paused until restored");
    const archivedLabel = Array.from(container.querySelectorAll(".gh-skills label"))
      .find((label) => label.textContent?.includes("Archived skill"));
    expect((archivedLabel?.querySelector("input") as HTMLInputElement | null)?.checked).toBe(true);
  });

  it("requires confirmation before resuming a disconnected mirror", async () => {
    const confirm = vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const container = await mount({
      connection: connected,
      destinations: [destination({ status: "disconnected" })],
    });
    const resume = buttonByText(container, "Resume mirror");

    act(() => resume.click());
    expect(githubMocks.syncGitHubDestination).not.toHaveBeenCalled();

    await act(async () => {
      resume.click();
      await Promise.resolve();
    });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(githubMocks.syncGitHubDestination).toHaveBeenCalledWith(destinationId, true);
  });

  it("replaces a callback failure with the latest actionable failure", async () => {
    window.history.replaceState({}, "", "/settings?view=github&github_error=Old%20authorization%20failure");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    githubMocks.syncGitHubDestination.mockRejectedValueOnce(new Error("Fresh resume failure"));
    const container = await mount({
      connection: connected,
      destinations: [destination({ status: "disconnected" })],
    });
    expect(container.textContent).toContain("Old authorization failure");

    await act(async () => {
      buttonByText(container, "Resume mirror").click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Fresh resume failure");
    expect(container.textContent).not.toContain("Old authorization failure");
  });

  it("announces poll-driven destination status and errors", async () => {
    const container = await mount({
      connection: connected,
      destinations: [destination({ status: "error", last_error: "Branch is protected" })],
    });

    const status = container.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toContain("acme/companion-skills synchronization status: error");
    expect(status?.textContent).toContain("Branch is protected");
    expect(container.querySelector('.gh-row__error[role="alert"]')?.textContent).toContain("Branch is protected");
  });

  it("restores focus to the remounted Add repository button after closing a new editor", async () => {
    const container = await mount({ connection: connected, destinations: [] });
    const initialTrigger = buttonByText(container, "Add repository");

    await act(async () => {
      initialTrigger.click();
      await Promise.resolve();
    });
    expect(container.querySelector("#github-editor-title")).toBe(document.activeElement);

    await act(async () => {
      (container.querySelector('button[aria-label="Close editor"]') as HTMLButtonElement).click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    const remountedTrigger = buttonByText(container, "Add repository");
    expect(remountedTrigger).not.toBe(initialTrigger);
    expect(document.activeElement).toBe(remountedTrigger);
  });

  it("moves focus to the connect action after disconnecting the GitHub account", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const initial = { connection: connected, destinations: [destination()] } satisfies GitHubIntegrationResponse;
    const container = await mount(initial);
    githubMocks.fetchGitHubIntegration.mockResolvedValueOnce({
      connection: { ...connected, connected: false },
      destinations: [destination({ status: "disconnected" })],
    });
    const disconnect = buttonByText(container, "Disconnect");
    disconnect.focus();

    await act(async () => {
      disconnect.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(buttonByText(container, "Install Companion on GitHub"));
  });

  it("moves focus to the surviving repository link after resuming a mirror", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const initialDestination = destination({ status: "disconnected" });
    const container = await mount({ connection: connected, destinations: [initialDestination] });
    githubMocks.fetchGitHubIntegration.mockResolvedValueOnce({
      connection: connected,
      destinations: [destination({ status: "pending" })],
    });
    const resume = buttonByText(container, "Resume mirror");
    resume.focus();

    await act(async () => {
      resume.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(container.querySelector('a[href="https://github.com/acme/companion-skills"]'));
  });

  it("moves focus to the next repository link after deleting a mirror", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const nextDestination = destination({
      id: "44444444-4444-4444-8444-444444444444",
      repository_id: "repository-2",
      name: "shared-skills",
      full_name: "acme/shared-skills",
      html_url: "https://github.com/acme/shared-skills",
    });
    const container = await mount({ connection: connected, destinations: [destination(), nextDestination] });
    githubMocks.fetchGitHubIntegration.mockResolvedValueOnce({
      connection: connected,
      destinations: [nextDestination],
    });
    const remove = container.querySelector('button[aria-label="Disconnect acme/companion-skills"]') as HTMLButtonElement;
    remove.focus();

    await act(async () => {
      remove.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(container.querySelector('a[href="https://github.com/acme/shared-skills"]'));
  });
});
