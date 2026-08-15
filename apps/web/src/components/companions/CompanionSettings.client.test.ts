// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Companion, CompanionProvidersResponse } from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionSettings } from "./CompanionSettings";

const {
  updateCompanion,
  deleteCompanion,
  getCompanionRuntime,
  restartCompanionRuntime,
  updateCompanionMemberState,
} = vi.hoisted(() => ({
  updateCompanion: vi.fn(),
  deleteCompanion: vi.fn(),
  getCompanionRuntime: vi.fn(),
  restartCompanionRuntime: vi.fn(),
  updateCompanionMemberState: vi.fn(),
}));

vi.mock("@/lib/companions", () => ({
  updateCompanion,
  deleteCompanion,
  getCompanionRuntime,
  restartCompanionRuntime,
  updateCompanionMemberState,
}));
vi.mock("@/lib/apiClient", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (String(path).includes("/v1/companion-plugins")) {
      return { accounts: [] };
    }
    return [];
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const providers: CompanionProvidersResponse = {
  catalog: [
    {
      id: "anthropic",
      name: "Claude",
      auth_methods: ["api_key"],
      description: "",
      models: [
        { id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ],
    },
    { id: "openai-codex", name: "Codex", auth_methods: ["subscription"], description: "", models: [{ id: "gpt-5.5", name: "GPT-5.5", default: true }] },
  ],
  connections: [
    {
      provider_id: "anthropic",
      auth_method: "api_key",
      connected_by: "user-1",
      created_at: "2026-08-12T12:00:00.000Z",
      updated_at: "2026-08-12T12:00:00.000Z",
    },
    {
      provider_id: "openai-codex",
      auth_method: "subscription",
      connected_by: "user-1",
      created_at: "2026-08-12T12:00:00.000Z",
      updated_at: "2026-08-12T12:00:00.000Z",
    },
  ],
  default_provider_id: "anthropic",
  can_manage: true,
};

function companion(access: Companion["access"] = "owner"): Companion {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Luna",
    persona: "Check every source.",
    model_id: "claude-opus-4-8",
    selected_skill_ids: [],
    can_write_skills: false,
    selected_mcp_account_ids: [],
    owner_id: "user-1",
    access,
    pinned: false,
    hidden: false,
    unread: false,
    last_message: null,
    runtime: {
      state: "stopped",
      daemon_state: "stopped",
      box_id: access === "viewer" ? null : "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 6,
      desktop_available: false,
      last_error: null,
      last_observed_at: null,
      last_started_at: null,
      last_stopped_at: null,
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  };
}

const roots: Root[] = [];

async function mount(
  access: Companion["access"] = "owner",
  providerResponse: CompanionProvidersResponse = providers,
  companionResponse: Companion = companion(access),
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const onSaved = vi.fn();
  const onDeleted = vi.fn();
  await act(async () => {
    root.render(React.createElement(CompanionSettings, {
      orgId: "org-1",
      companion: companionResponse,
      providers: providerResponse,
      onBack: vi.fn(),
      onSaved,
      onDeleted,
    }));
  });
  return { container, root, onSaved, onDeleted };
}

function setControlled(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = control instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CompanionSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateCompanion.mockImplementation(async (
      _orgId: string,
      _companionId: string,
      input: { name: string; persona: string | null; provider_id: string; model_id: string },
    ) => ({
      ...companion(),
      name: input.name,
      persona: input.persona,
      model_id: input.model_id,
      runtime: { ...companion().runtime, provider_ids: [input.provider_id] },
    }));
    deleteCompanion.mockResolvedValue(undefined);
    getCompanionRuntime.mockResolvedValue(companion());
    restartCompanionRuntime.mockResolvedValue({
      ...companion(),
      runtime: {
        ...companion().runtime,
        state: "running",
        daemon_state: "running",
      },
    });
  });

  afterEach(async () => {
    while (roots.length) {
      const root = roots.pop();
      await act(async () => root?.unmount());
    }
    document.body.replaceChildren();
  });

  it("lets an Editor persist name, instructions, and the existing provider picker without delete", async () => {
    const { container, onSaved } = await mount("editor");
    const form = container.querySelector("form")!;
    const name = form.elements.namedItem("name") as HTMLInputElement;
    const instructions = form.elements.namedItem("instructions") as HTMLTextAreaElement;
    const codex = form.querySelector<HTMLInputElement>('input[value="openai-codex"]')!;

    await act(async () => {
      setControlled(name, "Luna research");
      setControlled(instructions, "Challenge every source.");
      codex.click();
    });
    expect(container.textContent).toContain("GPT-5.5");
    expect(container.textContent).not.toContain("Claude Opus 4.8");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(updateCompanion).toHaveBeenCalledWith(
      "org-1",
      companion().id,
      {
        name: "Luna research",
        persona: "Challenge every source.",
        provider_id: "openai-codex",
        model_id: "gpt-5.5",
        selected_skill_ids: [],
        can_write_skills: false,
        selected_mcp_account_ids: [],
      },
    );
    expect(onSaved).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Settings saved.");
    expect(container.textContent).not.toContain("Delete Companion");
  });

  it("renders a Viewer with zero writes", async () => {
    const { container } = await mount("viewer");

    expect(container.querySelector("input:not([type=radio])")).toHaveProperty("disabled", true);
    expect(container.querySelector("textarea")).toHaveProperty("disabled", true);
    expect(Array.from(container.querySelectorAll('input[type="radio"]')).every((input) =>
      input.matches(":disabled")))
      .toBe(true);
    expect(container.textContent).toContain("Claude Opus 4.8");
    expect(container.textContent).toContain("Skills");
    expect(container.textContent).toContain("May create and update skills on my behalf");
    expect(container.textContent).toContain("Plugins");
    const pickers = Array.from(container.querySelectorAll(".companions-skills-picker fieldset"));
    expect(pickers.length).toBeGreaterThanOrEqual(2);
    expect(pickers.every((fieldset) => fieldset.matches(":disabled"))).toBe(true);
    expect(container.querySelector(".companions-skills-picker__write input")).toHaveProperty("disabled", true);
    expect(container.textContent).not.toContain("Save changes");
    expect(container.textContent).not.toContain("Restart Companion");
    expect(container.textContent).not.toContain("Delete Companion");
    expect(updateCompanion).not.toHaveBeenCalled();
  });

  it("shows models only for the selected provider", async () => {
    const { container } = await mount("owner");

    expect(container.textContent).toContain("Claude Opus 4.8");
    expect(container.textContent).toContain("Claude Sonnet 4.6");
    expect(container.textContent).not.toContain("GPT-5.5");
  });

  it("persists a non-default model without changing provider", async () => {
    const { container } = await mount("editor");
    const form = container.querySelector("form")!;
    const sonnet = form.querySelector<HTMLInputElement>('input[value="claude-sonnet-4-6"]')!;

    await act(async () => sonnet.click());
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(updateCompanion).toHaveBeenCalledWith(
      "org-1",
      companion().id,
      expect.objectContaining({
        provider_id: "anthropic",
        model_id: "claude-sonnet-4-6",
      }),
    );
  });

  it("selects the live default when the persisted model has left the catalog", async () => {
    const staleCompanion = { ...companion("editor"), model_id: "claude-retired" };
    const { container } = await mount("editor", providers, staleCompanion);
    const form = container.querySelector("form")!;
    const defaultModel = form.querySelector<HTMLInputElement>(
      'input[value="claude-opus-4-8"]',
    )!;

    expect(defaultModel.checked).toBe(true);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(updateCompanion).toHaveBeenCalledWith(
      "org-1",
      staleCompanion.id,
      expect.objectContaining({ model_id: "claude-opus-4-8" }),
    );
  });

  it("reconciles a stale provider selection when the live catalog replaces it", async () => {
    const { container, root, onSaved, onDeleted } = await mount("owner");
    const refreshed: CompanionProvidersResponse = {
      ...providers,
      connections: [providers.connections[1]!],
      default_provider_id: "openai-codex",
    };

    await act(async () => {
      root.render(React.createElement(CompanionSettings, {
        orgId: "org-1",
        companion: companion(),
        providers: refreshed,
        onBack: vi.fn(),
        onSaved,
        onDeleted,
      }));
    });

    expect(container.querySelector<HTMLInputElement>('input[value="openai-codex"]')?.checked)
      .toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[value="gpt-5.5"]')?.checked).toBe(true);
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(updateCompanion).toHaveBeenCalledWith(
      "org-1",
      companion().id,
      expect.objectContaining({ provider_id: "openai-codex", model_id: "gpt-5.5" }),
    );
  });

  it("shows live z.ai models from the API payload in the two-step settings picker", async () => {
    const apiConnections: CompanionProvidersResponse = {
      catalog: [
        { id: "kimi-coding", name: "Kimi", auth_methods: ["api_key"], description: "", models: [{ id: "kimi-for-coding", name: "Kimi K2.7 Code", default: true }] },
        {
          id: "zai",
          name: "z.ai",
          auth_methods: ["api_key"],
          description: "",
          models: [
            { id: "glm-4.7", name: "GLM-4.7", default: true },
            { id: "glm-5.2", name: "GLM-5.2" },
            { id: "glm-5.3", name: "GLM-5.3" },
          ],
        },
      ],
      connections: [
        { ...providers.connections[0]!, provider_id: "kimi-coding" },
        { ...providers.connections[0]!, provider_id: "zai" },
      ],
      default_provider_id: "zai",
      can_manage: true,
    };
    const { container } = await mount("owner", apiConnections);

    expect(container.querySelectorAll('.companions-settings__form input[type="radio"]')).toHaveLength(5);
    expect(container.textContent).toContain("Kimi");
    expect(container.textContent).toContain("z.ai");
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="zai"]')!.click();
    });
    expect(container.textContent).toContain("1. Provider");
    expect(container.textContent).toContain("2. Model");
    expect(container.textContent).toContain("GLM-5.2");
    expect(container.textContent).toContain("GLM-5.3");
  });

  it("requires Owner confirmation before deletion", async () => {
    const { container, onDeleted } = await mount("owner");
    const buttons = () => Array.from(container.querySelectorAll("button"));

    await act(async () => {
      buttons().find((button) => button.textContent === "Delete Companion")?.click();
    });
    expect(deleteCompanion).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Delete Luna?");

    await act(async () => {
      buttons().filter((button) => button.textContent === "Delete Companion").at(-1)?.click();
    });
    expect(deleteCompanion).toHaveBeenCalledWith("org-1", companion().id);
    expect(onDeleted).toHaveBeenCalledWith(companion().id);
  });

  it("restarts Pi by default for an online Owner or Editor", async () => {
    const online = {
      ...companion("editor"),
      runtime: {
        ...companion("editor").runtime,
        state: "running" as const,
        daemon_state: "running" as const,
      },
    };
    restartCompanionRuntime.mockResolvedValue(online);
    const { container, onSaved } = await mount("editor", providers, online);
    const pi = container.querySelector<HTMLInputElement>('input[name="restart-target"][value="pi"]')!;
    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Restart Pi") as HTMLButtonElement;

    expect(pi.checked).toBe(true);
    await act(async () => button.click());

    expect(restartCompanionRuntime).toHaveBeenCalledWith("org-1", online.id, { target: "pi" });
    expect(onSaved).toHaveBeenCalledWith(online);
    expect(container.textContent).toContain("Pi restarted. The Box stayed online.");
  });

  it("confirms a full Box restart before interrupting the server", async () => {
    const online = {
      ...companion(),
      runtime: {
        ...companion().runtime,
        state: "running" as const,
        daemon_state: "running" as const,
      },
    };
    restartCompanionRuntime.mockResolvedValue(online);
    const { container } = await mount("owner", providers, online);
    const box = container.querySelector<HTMLInputElement>('input[name="restart-target"][value="box"]')!;

    await act(async () => box.click());
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((candidate) => candidate.textContent === "Restart full Box")?.click();
    });

    expect(restartCompanionRuntime).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Restart Luna's full Box?");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .filter((candidate) => candidate.textContent === "Restart full Box")
        .at(-1)?.click();
    });

    expect(restartCompanionRuntime).toHaveBeenCalledWith("org-1", online.id, { target: "box" });
    expect(container.textContent).toContain("The full Box restarted and is online.");
  });

  it("keeps restart busy until Pi answers", async () => {
    let resolveRestart = (_value: Companion) => {};
    const pending = new Promise<Companion>((resolve) => { resolveRestart = resolve; });
    const online = {
      ...companion(),
      runtime: {
        ...companion().runtime,
        state: "running" as const,
        daemon_state: "running" as const,
      },
    };
    restartCompanionRuntime.mockReturnValue(pending);
    const { container } = await mount("owner", providers, online);
    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Restart Pi") as HTMLButtonElement;

    act(() => button.click());

    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Restarting Pi...");

    await act(async () => resolveRestart(online));
    expect(button.disabled).toBe(false);
  });

  it("reconciles and disables runtime controls after restart fails", async () => {
    const online = {
      ...companion(),
      runtime: {
        ...companion().runtime,
        state: "running" as const,
        daemon_state: "running" as const,
      },
    };
    const failed = {
      ...online,
      runtime: {
        ...online.runtime,
        state: "error" as const,
        daemon_state: "error" as const,
        last_error: "Pi did not become ready.",
      },
    };
    restartCompanionRuntime.mockRejectedValue(new Error("Pi did not become ready."));
    getCompanionRuntime.mockResolvedValue(failed);
    const { container, onSaved } = await mount("owner", providers, online);

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((candidate) => candidate.textContent === "Restart Pi")?.click();
    });

    expect(getCompanionRuntime).toHaveBeenCalledWith("org-1", online.id);
    expect(onSaved).toHaveBeenCalledWith(failed);
    expect(container.textContent).toContain("Pi did not become ready.");
    expect([...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Restart Pi"))
      .toHaveProperty("disabled", true);
  });

  it("keeps restart unavailable while offline or while settings are unsaved", async () => {
    const offline = await mount("owner");
    const offlineRestart = [...offline.container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Restart Pi") as HTMLButtonElement;

    expect(offlineRestart.disabled).toBe(true);
    expect(offline.container.textContent).toContain("must be Online");

    const online = {
      ...companion(),
      runtime: {
        ...companion().runtime,
        state: "running" as const,
        daemon_state: "running" as const,
      },
    };
    const unsaved = await mount("owner", providers, online);
    const name = unsaved.container.querySelector('input[name="name"]') as HTMLInputElement;
    await act(async () => setControlled(name, "Luna changed"));
    const unsavedRestart = [...unsaved.container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Restart Pi") as HTMLButtonElement;

    expect(unsavedRestart.disabled).toBe(true);
    expect(unsaved.container.textContent).toContain("Save your changes before restarting.");
    expect(restartCompanionRuntime).not.toHaveBeenCalled();
  });
});
