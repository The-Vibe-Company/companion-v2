// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CompanionPluginAccount,
  CompanionRegistryListResponse,
  CompanionRegistryServer,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionPlugins } from "./CompanionPlugins";

const {
  deleteCompanionPlugin,
  saveCompanionPlugin,
  listCompanionRegistry,
  getCompanionRegistryServer,
} = vi.hoisted(() => ({
  deleteCompanionPlugin: vi.fn(),
  saveCompanionPlugin: vi.fn(),
  listCompanionRegistry: vi.fn(),
  getCompanionRegistryServer: vi.fn(),
}));

vi.mock("@/lib/companions", () => ({
  deleteCompanionPlugin,
  saveCompanionPlugin,
  listCompanionRegistry,
  getCompanionRegistryServer,
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

const linearPin: CompanionRegistryServer = {
  name: "app.linear/linear",
  provider: "linear",
  title: "Linear",
  description: "Linear project management and issue tracking.",
  version: "latest",
  website_url: "https://linear.app",
  repository_url: null,
  pinned: true,
  connect: {
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    credential: { name: "Authorization", description: null, is_secret: true, required: false },
  },
};

const listResponse: CompanionRegistryListResponse = {
  pins: [linearPin],
  servers: [],
  next_cursor: null,
  source: "live",
};

const roots: Root[] = [];

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionPlugins, {
      orgId: "org-1",
      initialAccounts: [],
      onBack: () => {},
    }));
  });
  await flush();
  return container;
}

function setValue(form: HTMLFormElement, name: string, value: string) {
  const input = form.elements.namedItem(name);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${name} input`);
  input.value = value;
}

function setControlled(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openAndSubmit(container: HTMLElement) {
  const add = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("Add custom MCP"));
  await act(async () => add?.click());

  const form = container.querySelector("#companion-plugin-create") as HTMLFormElement;
  setValue(form, "provider", "linear");
  setValue(form, "label", "work");
  setValue(form, "endpoint", "https://mcp.example.test/linear");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("CompanionPlugins", () => {
  beforeEach(() => {
    listCompanionRegistry.mockResolvedValue(listResponse);
    getCompanionRegistryServer.mockResolvedValue({ server: linearPin, source: "live" });
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("submits live custom-MCP form values and adds the labeled account", async () => {
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
    expect(container.textContent).toContain("Connected");
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

  it("renders the pin and connects it with a required label", async () => {
    saveCompanionPlugin.mockResolvedValue(account);
    const container = await mount();

    expect(container.textContent).toContain("Recommended");
    expect(container.textContent).toContain("Linear");

    const connectButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".companions-registry-card button"),
    ).find((button) => button.textContent === "Connect");
    await act(async () => connectButton?.click());
    // A pinned server uses its curated metadata; no detail read is needed.
    expect(getCompanionRegistryServer).not.toHaveBeenCalled();

    const dialog = container.querySelector("#companion-registry-connect") as HTMLFormElement;
    const label = dialog.querySelector("input") as HTMLInputElement;
    await act(async () => setControlled(label, "personal"));
    await act(async () => {
      dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(saveCompanionPlugin).toHaveBeenCalledWith("org-1", {
      provider: "linear",
      label: "personal",
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      args: [],
    });
  });
});
