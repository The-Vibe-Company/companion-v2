// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConnectionRow } from "@companion/contracts";
import { ModelsPane, ProviderKeyRow } from "./ModelsPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const queryMocks = vi.hoisted(() => ({ fetchModels: vi.fn() }));
vi.mock("@/lib/runQueries", () => ({ fetchModels: queryMocks.fetchModels }));

const connection: ModelProviderConnectionRow = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "openai",
  key_name: "OPENAI_API_KEY",
  scope: "personal",
  credential_version: 1,
  set: true,
  created_at: "2026-07-13T10:00:00.000Z",
  updated_at: "2026-07-13T10:00:00.000Z",
};

function setReactInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mount(overrides: {
  onConnect?: (provider: string, keyName: string, apiKey: string) => Promise<ModelProviderConnectionRow>;
  onSaved?: (row: ModelProviderConnectionRow) => void;
  onCancel?: () => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const props = {
    providerId: "openai",
    providerName: "OpenAI",
    envKey: "OPENAI_API_KEY",
    scope: "personal" as const,
    onConnect: overrides.onConnect ?? vi.fn().mockResolvedValue(connection),
    onSaved: overrides.onSaved ?? vi.fn(),
    onCancel: overrides.onCancel ?? vi.fn(),
  };
  await act(async () => root.render(React.createElement(ProviderKeyRow, props)));
  return { container, props };
}

async function mountModelsPane(
  connections: ModelProviderConnectionRow[],
  providerConnected: boolean,
  envKeys: string[] = ["OPENAI_API_KEY"],
) {
  queryMocks.fetchModels.mockResolvedValue({
    models: [{
      id: "openai/gpt-5",
      provider: "openai",
      provider_name: "OpenAI",
      name: "GPT-5",
      description: null,
      context: null,
      cost_input: null,
      cost_output: null,
      env_keys: envKeys,
    }],
    providers: [{ id: "openai", name: "OpenAI", env_keys: envKeys, connected: providerConnected }],
    activated: { personal: ["openai/gpt-5"], org: [] },
  });
  const loadConnected = vi.fn().mockResolvedValue(connections);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(ModelsPane, {
      scope: {
        title: "Models",
        desc: "Dedicated provider keys",
        locked: false,
        readiness: "any",
        select: (activated: { personal: string[] }) => activated.personal,
        save: vi.fn().mockResolvedValue({ personal: ["openai/gpt-5"], org: [] }),
        loadConnected,
        connect: vi.fn(),
        connectionScope: "personal",
        disconnect: vi.fn(),
      },
    }));
    await Promise.resolve();
  });
  return { container, loadConnected };
}

beforeEach(() => {
  queryMocks.fetchModels.mockReset();
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("ProviderKeyRow", () => {
  it("uses a dedicated write-only password field and clears plaintext after saving", async () => {
    const onConnect = vi.fn().mockResolvedValue(connection);
    const { container } = await mount({ onConnect });
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(container.textContent).toContain("stored separately from Secrets");
    expect(container.textContent).not.toContain("vault secret");

    setReactInputValue(input, "  sk-private-sentinel  ");
    const connect = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Connect");
    await act(async () => {
      connect?.click();
      await Promise.resolve();
    });

    expect(onConnect).toHaveBeenCalledWith("openai", "OPENAI_API_KEY", "  sk-private-sentinel  ");
    expect(input.value).toBe("");
    expect(container.textContent).not.toContain("sk-private-sentinel");
  });

  it("clears a rejected key and requires explicit re-entry before retrying", async () => {
    const { container } = await mount({
      onConnect: vi.fn().mockRejectedValue(new Error("Connection failed")),
    });
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    setReactInputValue(input, "must-not-linger");

    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Connect")?.click();
      await Promise.resolve();
    });

    expect(input.value).toBe("");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!.split(" ")[1]!)?.textContent).toContain("Enter the key again");
    expect((Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Connect") as HTMLButtonElement).disabled).toBe(true);
  });

  it("discards an unsubmitted key when cancelled", async () => {
    const onCancel = vi.fn();
    const { container } = await mount({ onCancel });
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    setReactInputValue(input, "cancelled-sentinel");

    act(() => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Cancel")?.click());

    expect(onCancel).toHaveBeenCalledOnce();
    expect(input.value).toBe("");
  });
});

describe("ModelsPane", () => {
  it("loads only the model catalog and dedicated provider connections", async () => {
    queryMocks.fetchModels.mockResolvedValue({
      models: [],
      providers: [],
      activated: { personal: [], org: [] },
    });
    const loadConnected = vi.fn().mockResolvedValue([]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(React.createElement(ModelsPane, {
        scope: {
          title: "Models",
          desc: "Dedicated provider keys",
          locked: false,
          readiness: "any",
          select: (activated: { personal: string[] }) => activated.personal,
          save: vi.fn(),
          loadConnected,
          connect: vi.fn(),
          connectionScope: "personal",
          disconnect: vi.fn(),
        },
      }));
      await Promise.resolve();
    });

    expect(queryMocks.fetchModels).toHaveBeenCalledOnce();
    expect(loadConnected).toHaveBeenCalledOnce();
    expect(container.querySelector(".og-lockbar")).toBeNull();
    expect(container.textContent).toContain("The run launcher only shows models you activate");
  });

  it("offers a personal override when readiness comes only from the workspace", async () => {
    const { container } = await mountModelsPane([], true);
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Add personal key")).toBe(true);
  });

  it("groups activated models under one provider credential action", async () => {
    // Product promise: one provider key controls readiness for every active model beneath it.
    // Regression caught: returning to per-model Connect buttons would duplicate the same secret flow.
    queryMocks.fetchModels.mockResolvedValue({
      models: [
        {
          id: "openai/gpt-5",
          provider: "openai",
          provider_name: "OpenAI",
          name: "GPT-5",
          description: null,
          context: 400_000,
          cost_input: 1.75,
          cost_output: null,
          env_keys: ["OPENAI_API_KEY"],
        },
        {
          id: "openai/gpt-4.1",
          provider: "openai",
          provider_name: "OpenAI",
          name: "GPT-4.1",
          description: null,
          context: 1_000_000,
          cost_input: 2,
          cost_output: null,
          env_keys: ["OPENAI_API_KEY"],
        },
      ],
      providers: [{ id: "openai", name: "OpenAI", env_keys: ["OPENAI_API_KEY"], connected: false }],
      activated: { personal: ["openai/gpt-5", "openai/gpt-4.1"], org: [] },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(React.createElement(ModelsPane, {
        scope: {
          title: "Models",
          desc: "Dedicated provider keys",
          locked: false,
          readiness: "any",
          select: (activated: { personal: string[] }) => activated.personal,
          save: vi.fn(),
          loadConnected: vi.fn().mockResolvedValue([]),
          connect: vi.fn(),
          connectionScope: "personal",
          disconnect: vi.fn(),
        },
      }));
      await Promise.resolve();
    });

    expect(container.querySelectorAll(".models-provider")).toHaveLength(1);
    expect(container.querySelectorAll(".models-provider-model")).toHaveLength(2);
    expect(Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === "Connect")).toHaveLength(1);
    expect(container.textContent).toContain("Credentials apply to every active model below them");
  });

  it("keeps workspace provenance visible inside the personal provider group", async () => {
    // A personal launcher must never make an inherited model look personally owned.
    queryMocks.fetchModels.mockResolvedValue({
      models: [{
        id: "openai/gpt-5",
        provider: "openai",
        provider_name: "OpenAI",
        name: "GPT-5",
        description: null,
        context: null,
        cost_input: null,
        cost_output: null,
        env_keys: ["OPENAI_API_KEY"],
      }],
      providers: [{ id: "openai", name: "OpenAI", env_keys: ["OPENAI_API_KEY"], connected: true }],
      activated: { personal: [], org: ["openai/gpt-5"] },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(React.createElement(ModelsPane, {
        scope: {
          title: "Models",
          desc: "Dedicated provider keys",
          locked: false,
          readiness: "any",
          select: (activated: { personal: string[] }) => activated.personal,
          ghost: { label: "From workspace", select: (activated: { org: string[] }) => activated.org },
          save: vi.fn(),
          loadConnected: vi.fn().mockResolvedValue([]),
          connect: vi.fn(),
          connectionScope: "personal",
          disconnect: vi.fn(),
        },
      }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Inherited from workspace");
    expect(container.textContent).toContain("From workspace");
    expect(container.querySelector('.models-provider-model input[type="checkbox"]')).toBeNull();
  });

  it("discards a catalog credential draft when persistent search hides the catalog", async () => {
    const { container } = await mountModelsPane([], false);
    act(() => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Browse all"))?.click());
    const trigger = container.querySelector('[data-provider-key-trigger="browse:openai"]') as HTMLButtonElement;
    act(() => trigger.click());
    const keyInput = container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement;
    setReactInputValue(keyInput, "discard-this-draft");

    const search = container.querySelector('input[aria-label="Search active models or catalog"]') as HTMLInputElement;
    setReactInputValue(search, "gpt");

    expect(container.querySelector('input[autocomplete="new-password"]')).toBeNull();
    setReactInputValue(search, "");
    act(() => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Add model")?.click());
    expect(container.querySelector('[data-provider-key-trigger="browse:openai"]')).toBeTruthy();
    expect(container.textContent).not.toContain("discard-this-draft");
  });

  it("keeps shared-model mutations unavailable in a locked workspace scope", async () => {
    queryMocks.fetchModels.mockResolvedValue({
      models: [{
        id: "openai/gpt-5",
        provider: "openai",
        provider_name: "OpenAI",
        name: "GPT-5",
        description: null,
        context: null,
        cost_input: null,
        cost_output: null,
        env_keys: ["OPENAI_API_KEY"],
      }],
      providers: [{ id: "openai", name: "OpenAI", env_keys: ["OPENAI_API_KEY"], connected: true }],
      activated: { personal: [], org: ["openai/gpt-5"] },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(React.createElement(ModelsPane, {
        scope: {
          title: "Shared models",
          desc: "Workspace provider keys",
          locked: true,
          readiness: "scope",
          select: (activated: { org: string[] }) => activated.org,
          save: vi.fn(),
          loadConnected: vi.fn().mockResolvedValue([{ ...connection, scope: "organization" }]),
          connect: vi.fn(),
          connectionScope: "organization",
          disconnect: vi.fn(),
        },
      }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("All workspace members");
    expect(container.textContent).toContain("Ready");
    expect(container.querySelector('input[aria-label="Search active models or catalog"]')).toBeNull();
    expect((container.querySelector('.models-provider-model input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    expect(Array.from(container.querySelectorAll("button")).some((button) => /Connect|Replace|Disconnect|Remove|Add model/.test(`${button.textContent} ${button.getAttribute("aria-label")}`))).toBe(false);
  });

  it("returns focus to the provider-key trigger after cancellation", async () => {
    const { container } = await mountModelsPane([], true);
    const trigger = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Add personal key") as HTMLButtonElement;
    act(() => trigger.click());
    expect(container.querySelector('input[autocomplete="new-password"]')).toBe(document.activeElement);

    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Cancel")?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(document.activeElement?.textContent).toBe("Add personal key");
    expect((document.activeElement as HTMLElement).dataset.providerKeyTrigger).toBe("deck:openai/gpt-5");
  });

  it("offers write-only replacement without forcing a disconnect first", async () => {
    const { container } = await mountModelsPane([connection], true);
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Replace provider key")).toBe(true);
    expect(container.textContent).toContain("OPENAI_API_KEY · v1");
  });

  it("shows an unavailable state instead of a dead-end key editor when the catalog declares no key field", async () => {
    const { container } = await mountModelsPane([], false, []);
    expect(container.textContent).toContain("Unavailable");
    expect(Array.from(container.querySelectorAll("button")).some((button) => /Connect|Add personal key/.test(button.textContent ?? ""))).toBe(false);
  });
});
