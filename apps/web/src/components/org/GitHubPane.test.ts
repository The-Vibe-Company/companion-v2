// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitHubConnection,
  GitHubIntegrationResponse,
  GitHubSkillSyncResponse,
  GitHubSyncDestination,
  SkillListRow,
} from "@companion/contracts";
import { GitHubPane } from "./GitHubPane";
import { ApiFetchError } from "@/lib/apiClient";
import type { OrgCtx } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const githubMocks = vi.hoisted(() => ({
  beginGitHubConnection: vi.fn(),
  createGitHubDestination: vi.fn(),
  createGitHubRepository: vi.fn(),
  deleteGitHubDestination: vi.fn(),
  disconnectGitHubAccount: vi.fn(),
  fetchGitHubIntegration: vi.fn(),
  fetchGitHubSkillSync: vi.fn(),
  fetchGitHubRepositories: vi.fn(),
  selectGitHubDestinationSkill: vi.fn(),
  syncGitHubDestination: vi.fn(),
  unselectGitHubDestinationSkill: vi.fn(),
  updateGitHubDestination: vi.fn(),
}));
const queryMocks = vi.hoisted(() => ({ fetchSkillLibrary: vi.fn() }));

vi.mock("@/lib/github", () => githubMocks);
vi.mock("@/lib/queries", () => ({ fetchSkillLibrary: queryMocks.fetchSkillLibrary }));

const roots: Root[] = [];
const destinationId = "11111111-1111-4111-8111-111111111111";
const activeSkillId = "22222222-2222-4222-8222-222222222222";
const archivedSkillId = "33333333-3333-4333-8333-333333333333";
const secondDestinationId = "44444444-4444-4444-8444-444444444444";
const thirdDestinationId = "55555555-5555-4555-8555-555555555555";

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

function skillSyncOverview(destinations: GitHubSkillSyncResponse["skills"][number]["destinations"]): GitHubSkillSyncResponse {
  return {
    skills: [{
      skill_id: activeSkillId,
      slug: "active-skill",
      display_name: "Active skill",
      current_version: "1.0.0",
      destinations,
    }],
  };
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  for (const mock of Object.values(githubMocks)) mock.mockReset();
  queryMocks.fetchSkillLibrary.mockReset().mockResolvedValue([]);
  githubMocks.fetchGitHubRepositories.mockResolvedValue({
    repositories: [],
    installations: [],
    install_url: "https://github.com/apps/companion/installations/new",
  });
  githubMocks.fetchGitHubSkillSync.mockResolvedValue({ skills: [] });
  githubMocks.deleteGitHubDestination.mockResolvedValue({ ok: true });
  githubMocks.disconnectGitHubAccount.mockResolvedValue({ ok: true });
  githubMocks.syncGitHubDestination.mockResolvedValue({ ok: true });
  githubMocks.selectGitHubDestinationSkill.mockResolvedValue({ ok: true, changed: true });
  githubMocks.unselectGitHubDestinationSkill.mockResolvedValue({ ok: true, changed: true });
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitHubPane", () => {
  it("opens the Skills tab with complete automatic, selected, and dependency states", async () => {
    const destinations = [
      destination(),
      destination({ id: secondDestinationId, repository_id: "repository-2", name: "selected-skills", full_name: "acme/selected-skills", html_url: "https://github.com/acme/selected-skills", mode: "selected", selected_skill_ids: [activeSkillId], status: "pending" }),
      destination({ id: thirdDestinationId, repository_id: "repository-3", name: "dependency-skills", full_name: "acme/dependency-skills", html_url: "https://github.com/acme/dependency-skills", mode: "selected", selected_skill_ids: [archivedSkillId], status: "error", last_error: "Branch protection rejected the update" }),
    ];
    githubMocks.fetchGitHubSkillSync.mockResolvedValue(skillSyncOverview([
      { destination_id: destinationId, inclusion: "all" },
      { destination_id: secondDestinationId, inclusion: "selected" },
      { destination_id: thirdDestinationId, inclusion: "dependency" },
    ]));
    const container = await mount({ connection: connected, destinations });

    await act(async () => {
      buttonByText(container, "Skills").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Organization skills");
    expect(container.textContent).toContain("3 of 3 repositories");
    expect(container.textContent).toContain("error");

    await act(async () => { buttonByText(container, "Active skill").click(); });
    expect(container.textContent).toContain("Automatic");
    expect(container.textContent).toContain("Selected");
    expect(container.textContent).toContain("Required dependency");
    const toggles = Array.from(container.querySelectorAll<HTMLInputElement>('.gh-skill-switch input'));
    expect(toggles.map((toggle) => [toggle.checked, toggle.disabled])).toEqual([
      [true, true],
      [true, false],
      [true, true],
    ]);
  });

  it("filters skills and supports arrow-key tab navigation", async () => {
    githubMocks.fetchGitHubSkillSync.mockResolvedValue({
      skills: [
        ...skillSyncOverview([]).skills,
        { skill_id: archivedSkillId, slug: "release-helper", display_name: "Release helper", current_version: "2.0.0", destinations: [] },
      ],
    });
    const container = await mount({ connection: connected, destinations: [] });
    const repositoriesTab = buttonByText(container, "Repositories");

    await act(async () => {
      repositoriesTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(buttonByText(container, "Skills").getAttribute("aria-selected")).toBe("true");
    const search = container.querySelector<HTMLInputElement>('.gh-skill-search input')!;
    setInputValue(search, "release");
    expect(container.textContent).toContain("Release helper");
    expect(container.textContent).not.toContain("Active skill");

    await act(async () => {
      buttonByText(container, "Skills").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(repositoriesTab.getAttribute("aria-selected")).toBe("true");
  });

  it("blocks the last-skill removal inline and returns to the matching repository", async () => {
    const selected = destination({ mode: "selected", selected_skill_ids: [activeSkillId] });
    githubMocks.fetchGitHubSkillSync.mockResolvedValue(skillSyncOverview([
      { destination_id: destinationId, inclusion: "selected" },
    ]));
    githubMocks.unselectGitHubDestinationSkill.mockRejectedValue(new ApiFetchError("a selected-skills mirror must keep at least one skill", 409));
    const container = await mount({ connection: connected, destinations: [selected] });

    await act(async () => {
      buttonByText(container, "Skills").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { buttonByText(container, "Active skill").click(); });
    const toggle = container.querySelector<HTMLInputElement>('.gh-skill-switch input')!;
    await act(async () => {
      toggle.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(githubMocks.unselectGitHubDestinationSkill).toHaveBeenCalledWith(destinationId, activeSkillId);
    expect(container.textContent).toContain("must keep at least one skill");

    await act(async () => { buttonByText(container, "Manage repository").click(); });
    expect(buttonByText(container, "Repositories").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.textContent).toContain("acme/companion-skills");
  });

  it("adds a skill atomically, refreshes both views, and announces the pending sync", async () => {
    const selected = destination({ mode: "selected", selected_skill_ids: [archivedSkillId] });
    githubMocks.fetchGitHubSkillSync
      .mockResolvedValueOnce(skillSyncOverview([{ destination_id: destinationId, inclusion: "none" }]))
      .mockResolvedValue(skillSyncOverview([{ destination_id: destinationId, inclusion: "selected" }]));
    const container = await mount({ connection: connected, destinations: [selected] });
    await act(async () => {
      buttonByText(container, "Skills").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { buttonByText(container, "Active skill").click(); });

    const toggle = container.querySelector<HTMLInputElement>('.gh-skill-switch input')!;
    expect(toggle.checked).toBe(false);
    await act(async () => {
      toggle.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(githubMocks.selectGitHubDestinationSkill).toHaveBeenCalledWith(destinationId, activeSkillId);
    expect(githubMocks.fetchGitHubSkillSync).toHaveBeenCalledTimes(2);
    expect(githubMocks.fetchGitHubIntegration).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Synchronization is pending");
    expect(container.querySelector<HTMLInputElement>('.gh-skill-switch input')?.checked).toBe(true);
  });

  it("reports a saved selection whose refreshed state failed and retries locally", async () => {
    const selected = destination({ mode: "selected", selected_skill_ids: [archivedSkillId] });
    githubMocks.fetchGitHubSkillSync
      .mockResolvedValueOnce(skillSyncOverview([{ destination_id: destinationId, inclusion: "none" }]))
      .mockRejectedValueOnce(new Error("Skill matrix refresh failed"))
      .mockResolvedValueOnce(skillSyncOverview([{ destination_id: destinationId, inclusion: "selected" }]));
    const container = await mount({ connection: connected, destinations: [selected] });
    await act(async () => {
      buttonByText(container, "Skills").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { buttonByText(container, "Active skill").click(); });

    await act(async () => {
      container.querySelector<HTMLInputElement>('.gh-skill-switch input')!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("The selection was saved, but the refreshed synchronization state could not be loaded.");
    expect(container.textContent).not.toContain("Synchronization is pending");
    expect(container.querySelector<HTMLInputElement>('.gh-skill-switch input')?.checked).toBe(false);

    await act(async () => {
      buttonByText(container, "Retry refresh").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("refreshed synchronization state could not be loaded");
    expect(container.querySelector<HTMLInputElement>('.gh-skill-switch input')?.checked).toBe(true);
  });

  it("serializes skill selection changes in the panel", async () => {
    const destinations = [
      destination({ mode: "selected", selected_skill_ids: [archivedSkillId] }),
      destination({
        id: secondDestinationId,
        repository_id: "repository-2",
        name: "selected-skills",
        full_name: "acme/selected-skills",
        html_url: "https://github.com/acme/selected-skills",
        mode: "selected",
        selected_skill_ids: [archivedSkillId],
      }),
    ];
    githubMocks.fetchGitHubSkillSync
      .mockResolvedValueOnce(skillSyncOverview([
        { destination_id: destinationId, inclusion: "none" },
        { destination_id: secondDestinationId, inclusion: "none" },
      ]))
      .mockResolvedValue(skillSyncOverview([
        { destination_id: destinationId, inclusion: "selected" },
        { destination_id: secondDestinationId, inclusion: "none" },
      ]));
    let releaseMutation!: () => void;
    githubMocks.selectGitHubDestinationSkill.mockImplementationOnce(() =>
      new Promise((resolve) => { releaseMutation = () => resolve({ ok: true, changed: true }); }),
    );
    const container = await mount({ connection: connected, destinations });
    await act(async () => {
      buttonByText(container, "Skills").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { buttonByText(container, "Active skill").click(); });
    const toggles = Array.from(container.querySelectorAll<HTMLInputElement>('.gh-skill-switch input'));

    act(() => { toggles[0]!.click(); });
    expect(toggles.every((toggle) => toggle.disabled)).toBe(true);
    act(() => { toggles[1]!.click(); });
    expect(githubMocks.selectGitHubDestinationSkill).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseMutation();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(githubMocks.selectGitHubDestinationSkill).toHaveBeenCalledWith(destinationId, activeSkillId);
  });

  it("returns keyboard focus to the skill row after leaving its detail", async () => {
    githubMocks.fetchGitHubSkillSync.mockResolvedValue(skillSyncOverview([]));
    const container = await mount({ connection: connected, destinations: [] });
    await act(async () => {
      buttonByText(container, "Skills").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { buttonByText(container, "Active skill").click(); });

    await act(async () => {
      (container.querySelector(".gh-skill-detail__head button") as HTMLButtonElement).click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(document.activeElement).toBe(container.querySelector(".gh-skill-row"));
    expect(document.activeElement?.textContent).toContain("Active skill");
  });

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

  it("preserves an unsaved repository editor while switching tabs", async () => {
    const activeSkill = skill(activeSkillId, "active-skill", false);
    queryMocks.fetchSkillLibrary.mockImplementation(async (_library: string, archived = false) =>
      archived ? [] : [activeSkill],
    );
    const container = await mount({
      connection: connected,
      destinations: [destination({
        mode: "selected",
        selected_skill_ids: [activeSkillId],
        resolved_skill_count: 1,
      })],
    });

    await act(async () => {
      buttonByText(container, "Edit selection").click();
      await Promise.resolve();
    });
    const skillLabel = Array.from(container.querySelectorAll(".gh-skills label"))
      .find((label) => label.textContent?.includes("Active skill"));
    const checkbox = skillLabel?.querySelector("input") as HTMLInputElement;
    act(() => { checkbox.click(); });
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      buttonByText(container, "Skills").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { buttonByText(container, "Repositories").click(); });

    expect(container.textContent).toContain("Edit acme/companion-skills");
    const remountedSkillLabel = Array.from(container.querySelectorAll(".gh-skills label"))
      .find((label) => label.textContent?.includes("Active skill"));
    expect((remountedSkillLabel?.querySelector("input") as HTMLInputElement | null)?.checked).toBe(false);
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
