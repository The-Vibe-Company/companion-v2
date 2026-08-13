// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanionPluginAccount } from "@companion/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionPlugins } from "./CompanionPlugins";

const { deleteCompanionPlugin, saveCompanionPlugin } = vi.hoisted(() => ({
  deleteCompanionPlugin: vi.fn(),
  saveCompanionPlugin: vi.fn(),
}));

vi.mock("@/lib/companions", () => ({
  deleteCompanionPlugin,
  saveCompanionPlugin,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const account: CompanionPluginAccount = {
  id: "44444444-4444-4444-8444-444444444444",
  provider: "linear",
  label: "work",
  transport: "http",
  endpoint: "https://mcp.example.test/linear",
  connected: true,
  created_at: "2026-08-13T00:00:00.000Z",
  updated_at: "2026-08-13T00:00:00.000Z",
};

const roots: Root[] = [];

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <CompanionPlugins orgId="org-1" initialAccounts={[]} onBack={() => {}} />,
    );
  });
  return container;
}

function setValue(form: HTMLFormElement, name: string, value: string) {
  const input = form.elements.namedItem(name);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${name} input`);
  input.value = value;
}

async function openAndSubmit(container: HTMLElement) {
  const add = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("Add MCP"));
  await act(async () => add?.click());

  const form = container.querySelector("#companion-plugin-create") as HTMLFormElement;
  setValue(form, "provider", "linear");
  setValue(form, "label", "work");
  setValue(form, "endpoint", "https://mcp.example.test/linear");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("CompanionPlugins Add MCP", () => {
  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("submits live form values and adds the labeled account", async () => {
    saveCompanionPlugin.mockResolvedValue(account);
    const container = await mount();

    await openAndSubmit(container);

    expect(saveCompanionPlugin).toHaveBeenCalledWith("org-1", {
      provider: "linear",
      label: "work",
      transport: "http",
      url: "https://mcp.example.test/linear",
      args: [],
    });
    expect(container.textContent).toContain("Linear");
    expect(container.textContent).toContain("work");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("clears the busy state and reports a failed request", async () => {
    saveCompanionPlugin.mockRejectedValue(new Error("Request timed out. Try connecting again."));
    const container = await mount();

    await openAndSubmit(container);

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("Request timed out. Try connecting again.");
    const submit = container.querySelector(
      'button[form="companion-plugin-create"]',
    ) as HTMLButtonElement;
    expect(submit?.textContent).toContain("Connect MCP");
    expect(submit.disabled).toBe(false);
  });
});
