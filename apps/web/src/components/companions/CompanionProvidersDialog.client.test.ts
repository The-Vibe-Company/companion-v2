// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanionProviderConnection, CompanionProvidersResponse } from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionProvidersDialog } from "./CompanionProvidersDialog";

const api = vi.hoisted(() => ({
  completeCompanionProviderOAuth: vi.fn(),
  deleteCompanionProvider: vi.fn(),
  pollCompanionProviderOAuth: vi.fn(),
  saveCompanionProvider: vi.fn(),
  setDefaultCompanionProvider: vi.fn(),
  startCompanionProviderOAuth: vi.fn(),
}));

vi.mock("@/lib/companions", () => api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const connectedAt = "2026-08-14T12:00:00.000Z";
const providers: CompanionProvidersResponse = {
  catalog: [
    { id: "anthropic", name: "Claude", auth_methods: ["api_key", "subscription"], description: "" },
    { id: "openai-codex", name: "Codex", auth_methods: ["subscription"], description: "" },
    { id: "kimi-coding", name: "Kimi", auth_methods: ["api_key"], description: "" },
    { id: "zai", name: "z.ai", auth_methods: ["api_key"], description: "" },
  ],
  connections: [],
  default_provider_id: null,
  can_manage: true,
};

function connection(
  providerId: string,
  authMethod: "api_key" | "subscription",
): CompanionProviderConnection {
  return {
    provider_id: providerId,
    auth_method: authMethod,
    connected_by: "user-1",
    created_at: connectedAt,
    updated_at: connectedAt,
  };
}

async function mount(onProviders = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionProvidersDialog, {
      orgId: "org-1",
      providers,
      onProviders,
      onClose: () => {},
    }));
  });
  return { container, onProviders };
}

function setControlled(
  input: HTMLInputElement | HTMLSelectElement,
  value: string,
  eventName: "input" | "change",
) {
  const prototype = input instanceof HTMLSelectElement
    ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event(eventName, { bubbles: true }));
}

async function chooseProvider(container: HTMLElement, providerId: string) {
  const select = container.querySelector("select")!;
  await act(async () => setControlled(select, providerId, "change"));
}

async function chooseAuthentication(container: HTMLElement, authMethod: string) {
  const selects = container.querySelectorAll<HTMLSelectElement>("select");
  await act(async () => setControlled(selects[1]!, authMethod, "change"));
}

async function submit(container: HTMLElement) {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("CompanionProvidersDialog", () => {
  beforeEach(() => {
    api.setDefaultCompanionProvider.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("connects Pi's Kimi provider with the same one-field API-key path as z.ai", async () => {
    api.saveCompanionProvider.mockResolvedValue(connection("kimi-coding", "api_key"));
    const { container, onProviders } = await mount();
    await chooseProvider(container, "kimi-coding");
    const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => setControlled(key, "kimi-secret", "input"));
    await submit(container);

    expect(api.saveCompanionProvider).toHaveBeenCalledWith("org-1", "kimi-coding", {
      auth_method: "api_key",
      credential: "kimi-secret",
    });
    expect(onProviders).toHaveBeenCalledWith(expect.objectContaining({
      connections: [expect.objectContaining({ provider_id: "kimi-coding" })],
      default_provider_id: "kimi-coding",
    }));
  });

  it("connects Claude through browser authorization without an auth.json textarea", async () => {
    api.startCompanionProviderOAuth.mockResolvedValue({
      flow: "authorization_code",
      provider_id: "anthropic",
      authorization_url: "https://claude.ai/oauth/authorize?state=test",
    });
    api.completeCompanionProviderOAuth.mockResolvedValue(connection("anthropic", "subscription"));
    const { container } = await mount();
    await chooseAuthentication(container, "subscription");
    await submit(container);

    expect(container.textContent).not.toContain("auth.json");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Open Claude sign-in");

    const code = container.querySelector<HTMLInputElement>(
      ".companions-provider-oauth input",
    )!;
    await act(async () => setControlled(code, "one-time-code", "input"));
    const finish = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Finish connection")!;
    await act(async () => finish.click());

    expect(api.completeCompanionProviderOAuth).toHaveBeenCalledWith("org-1", "one-time-code");
  });

  it("connects Codex through device login without browser-submitted tokens", async () => {
    api.startCompanionProviderOAuth.mockResolvedValue({
      flow: "device_code",
      provider_id: "openai-codex",
      verification_url: "https://auth.openai.com/codex/device",
      user_code: "ABCD-EFGH",
      poll_interval_seconds: 2,
      expires_at: "2026-08-14T12:15:00.000Z",
    });
    api.pollCompanionProviderOAuth.mockResolvedValue({
      status: "connected",
      connection: connection("openai-codex", "subscription"),
    });
    const { container } = await mount();
    await chooseProvider(container, "openai-codex");
    await submit(container);

    expect(container.textContent).toContain("ABCD-EFGH");
    expect(container.querySelector("textarea")).toBeNull();
    const check = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Check connection")!;
    await act(async () => check.click());

    expect(api.pollCompanionProviderOAuth).toHaveBeenCalledWith("org-1");
  });
});
