// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentModelsResponse } from "@companion/contracts";
import { CreateView } from "./CreateView";
import type { SkillVM } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  setProviderConnection: vi.fn(),
}));

vi.mock("@/lib/agentQueries", () => mocks);

function models(connected: Record<string, boolean>): AgentModelsResponse {
  return {
    models: [
      {
        id: "openai/gpt-5.5",
        provider: "openai",
        provider_name: "OpenAI",
        name: "GPT-5.5",
        description: null,
        context: null,
        cost_input: null,
        cost_output: null,
        env_keys: ["OPENAI_API_KEY"],
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        provider_name: "Anthropic",
        name: "Claude Sonnet 4.5",
        description: null,
        context: null,
        cost_input: null,
        cost_output: null,
        env_keys: ["ANTHROPIC_API_KEY"],
      },
    ],
    providers: [
      { id: "openai", name: "OpenAI", env_keys: ["OPENAI_API_KEY"], connected: connected.openai ?? false },
      { id: "anthropic", name: "Anthropic", env_keys: ["ANTHROPIC_API_KEY"], connected: connected.anthropic ?? false },
    ],
  };
}

function skill(id: string, scope: SkillVM["scope"]): SkillVM {
  return { id, description: `${id} desc`, version: "1.0.0", scope, requirements: [] } as unknown as SkillVM;
}

let mountedRoots: Root[] = [];

async function mount(props: Partial<React.ComponentProps<typeof CreateView>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(CreateView, {
        lib: "mine",
        models: models({}),
        registry: [],
        appOrigin: "http://test.local",
        onBack: vi.fn(),
        onCreated: vi.fn(),
        ...props,
      }),
    );
  });
  await flushEffects();
  return container;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function modelButton(container: HTMLElement, id: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(id));
  if (!btn) throw new Error(`No model button for ${id}`);
  return btn;
}

// React tracks the input value via the native setter; bypassing it (plain `.value =`) makes the
// synthetic onChange ignore the update. Use the prototype setter so onChange fires.
function setReactInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of mountedRoots) await act(async () => root.unmount());
  mountedRoots = [];
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("CreateView grouped model picker", () => {
  it("disables models of unconnected providers and preselects the connected one", async () => {
    const container = await mount({ models: models({ anthropic: true }) });

    // The connected provider's model is a selectable radio; the unconnected one is disabled.
    const claude = modelButton(container, "anthropic/claude-sonnet-4-5");
    const gpt = modelButton(container, "openai/gpt-5.5");
    expect(gpt.disabled).toBe(true);
    expect(container.textContent).toContain("connect OpenAI to use");
    // Preselection landed on the connected provider's first model.
    expect(claude.getAttribute("aria-checked")).toBe("true");
  });

  it("Connect saves the key and enables that provider's models", async () => {
    mocks.setProviderConnection.mockResolvedValue({
      connection: { provider: "anthropic", key_name: "ANTHROPIC_API_KEY", set: true, created_at: "now" },
    });
    const container = await mount({ models: models({}) });

    // No provider connected → provisioning is gated with the connect hint.
    expect(container.textContent).toContain("Connect at least one model provider");
    // Both provider models are disabled up front.
    expect(modelButton(container, "anthropic/claude-sonnet-4-5").disabled).toBe(true);

    // Groups sort alphabetically when none is connected, so Anthropic is first. Reveal + fill its key.
    const connect = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Connect")!;
    await act(async () => connect.click());
    const keyInput = container.querySelector<HTMLInputElement>('input[aria-label="API key for Anthropic"]');
    expect(keyInput).toBeTruthy();
    setReactInputValue(keyInput!, "sk-ant-123");
    const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Save")!;
    await act(async () => save.click());
    await flushEffects();

    expect(mocks.setProviderConnection).toHaveBeenCalledWith({
      provider: "anthropic",
      key_name: "ANTHROPIC_API_KEY",
      key: "sk-ant-123",
    });
    // The Anthropic model is now selectable (no longer disabled).
    expect(modelButton(container, "anthropic/claude-sonnet-4-5").disabled).toBe(false);
  });

  it("hides personal skills for an org-scoped agent", async () => {
    const container = await mount({
      lib: "org",
      registry: [skill("org-skill", "org"), skill("mine-skill", "personal")],
    });
    expect(container.textContent).toContain("org-skill");
    expect(container.textContent).not.toContain("mine-skill");
  });
});
