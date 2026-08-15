// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { CompanionProvidersResponse } from "@companion/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewCompanionDialog } from "./NewCompanionDialog";

vi.mock("@/lib/companions", () => ({ createCompanion: vi.fn() }));
vi.mock("@/lib/apiClient", () => ({
  apiFetch: vi.fn(async (path: string) => String(path).includes("/v1/companion-plugins")
    ? { accounts: [] }
    : []),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connection = (providerId: string) => ({
  provider_id: providerId,
  auth_method: "api_key" as const,
  connected_by: "user-1",
  created_at: "2026-08-12T12:00:00.000Z",
  updated_at: "2026-08-12T12:00:00.000Z",
});

const staleProviders: CompanionProvidersResponse = {
  catalog: [{
    id: "anthropic",
    name: "Claude",
    auth_methods: ["api_key"],
    description: "",
    models: [{ id: "claude-old", name: "Claude old", default: true }],
  }],
  connections: [connection("anthropic")],
  default_provider_id: "anthropic",
  can_manage: true,
};

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("NewCompanionDialog live provider reconciliation", () => {
  it("selects a valid provider and model after a stale-first catalog refresh", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = {
      orgId: "org-1",
      onCreated: vi.fn(),
      onConnectProvider: vi.fn(),
      onClose: vi.fn(),
    };
    await act(async () => {
      root.render(React.createElement(NewCompanionDialog, {
        ...props,
        providers: staleProviders,
      }));
    });

    const refreshed: CompanionProvidersResponse = {
      catalog: [{
        id: "openai-codex",
        name: "Codex",
        auth_methods: ["subscription"],
        description: "",
        models: [{ id: "gpt-5.5", name: "GPT-5.5", default: true }],
      }],
      connections: [connection("openai-codex")],
      default_provider_id: "openai-codex",
      can_manage: true,
    };
    await act(async () => {
      root.render(React.createElement(NewCompanionDialog, { ...props, providers: refreshed }));
    });

    expect(container.querySelector<HTMLInputElement>('input[value="openai-codex"]')?.checked)
      .toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[value="gpt-5.5"]')?.checked).toBe(true);
    expect(container.textContent).not.toContain("Claude old");

    await act(async () => root.unmount());
  });
});
