// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { CompanionProvidersResponse } from "@companion/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanion } from "@/lib/companions";
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

/**
 * Product promise:
 * Skills Hub access is unconditional, so creation never asks about it and never sends a grant.
 *
 * Regression proof:
 * Re-introducing a scope picker, or posting a grant field the API no longer accepts, fails below.
 */
describe("NewCompanionDialog Skills Hub access", () => {
  const create = vi.mocked(createCompanion);

  it("creates a Companion without asking about Skills Hub scopes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(NewCompanionDialog, {
        orgId: "org-1",
        providers: staleProviders,
        onCreated: vi.fn(),
        onConnectProvider: vi.fn(),
        onClose: vi.fn(),
      }));
    });
    const form = container.querySelector<HTMLFormElement>("#companion-create")!;
    const name = form.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
        ?.set?.call(name, "Luna");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("Skills Hub API access");
    expect(container.textContent).not.toContain("grant active");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(create).toHaveBeenCalledWith("org-1", expect.objectContaining({ name: "Luna" }));
    expect(Object.keys(create.mock.calls[0]?.[1] ?? {})).not.toContain("hub_access");
    expect(Object.keys(create.mock.calls[0]?.[1] ?? {})).not.toContain("can_write_skills");
    await act(async () => root.unmount());
  });
});
