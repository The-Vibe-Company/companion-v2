// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Companion, CompanionProvidersResponse } from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionSettings } from "./CompanionSettings";

const { updateCompanion, deleteCompanion } = vi.hoisted(() => ({
  updateCompanion: vi.fn(),
  deleteCompanion: vi.fn(),
}));

vi.mock("@/lib/companions", () => ({ updateCompanion, deleteCompanion }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const providers: CompanionProvidersResponse = {
  catalog: [
    { id: "anthropic", name: "Claude", auth_methods: ["api_key"], description: "" },
    { id: "openai-codex", name: "Codex", auth_methods: ["subscription"], description: "" },
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
    owner_id: "user-1",
    access,
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
      companion: companion(access),
      providers: providerResponse,
      onBack: vi.fn(),
      onSaved,
      onDeleted,
    }));
  });
  return { container, onSaved, onDeleted };
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
      input: { name: string; persona: string | null; provider_id: string },
    ) => ({
      ...companion(),
      name: input.name,
      persona: input.persona,
      runtime: { ...companion().runtime, provider_ids: [input.provider_id] },
    }));
    deleteCompanion.mockResolvedValue(undefined);
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
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(updateCompanion).toHaveBeenCalledWith(
      "org-1",
      companion().id,
      {
        name: "Luna research",
        persona: "Challenge every source.",
        provider_id: "openai-codex",
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
    expect(container.textContent).not.toContain("Save changes");
    expect(container.textContent).not.toContain("Delete Companion");
    expect(updateCompanion).not.toHaveBeenCalled();
  });

  it("shows both Kimi and z.ai when both workspace connections exist", async () => {
    const apiConnections: CompanionProvidersResponse = {
      catalog: [
        { id: "kimi-coding", name: "Kimi", auth_methods: ["api_key"], description: "" },
        { id: "zai", name: "z.ai", auth_methods: ["api_key"], description: "" },
      ],
      connections: [
        { ...providers.connections[0]!, provider_id: "kimi-coding" },
        { ...providers.connections[0]!, provider_id: "zai" },
      ],
      default_provider_id: "zai",
      can_manage: true,
    };
    const { container } = await mount("owner", apiConnections);

    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(container.textContent).toContain("Kimi");
    expect(container.textContent).toContain("z.ai");
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
});
