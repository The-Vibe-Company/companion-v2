// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateRunConfigurationInput, RunConfiguration, RunOptions } from "@companion/contracts";
import { RunLauncherDialog } from "./RunLauncherDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const SLOT_ID = "33333333-3333-4333-8333-333333333333";
const SECRET_ID = "44444444-4444-4444-8444-444444444444";
const PROVIDER_CONNECTION_ID = "55555555-5555-4555-8555-555555555555";
const CONFIG_ID = "66666666-6666-4666-8666-666666666666";

const queryMocks = vi.hoisted(() => ({
  abandonRunPrewarm: vi.fn(),
  createRunConfiguration: vi.fn(),
  deleteRunConfiguration: vi.fn(),
  fetchRunOptions: vi.fn(),
  heartbeatRunPrewarm: vi.fn(),
  launchRun: vi.fn(),
  startRunPrewarm: vi.fn(),
  updateRunConfiguration: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/runQueries", () => queryMocks);

const roots: Root[] = [];

function runOptions(): RunOptions {
  return {
    root: {
      skill_id: ROOT_ID,
      skill_version_id: VERSION_ID,
      slug: "incident-summary",
      version: "1.0.0",
      root: true,
      depth: 0,
      via: null,
    },
    dependencies: [],
    declared_secrets: [],
    declared_variables: [],
    configurations: [],
    models: [{
      model: {
        id: "openai/gpt-5",
        provider: "openai",
        provider_name: "OpenAI",
        name: "GPT-5",
        description: null,
        context: null,
        cost_input: null,
        cost_output: null,
        env_keys: ["OPENAI_API_KEY"],
      },
      readiness: "ready",
      message: null,
      provider_credential_pin: {
        env_key: "OPENAI_API_KEY",
        connection_id: PROVIDER_CONNECTION_ID,
        credential_version: 2,
        scope: "personal",
      },
    }],
    runtime: { available: true, message: null },
  };
}

function configuration(input: Partial<RunConfiguration> = {}): RunConfiguration {
  return {
    id: CONFIG_ID,
    skill_id: ROOT_ID,
    skill_slug: "incident-summary",
    name: "Incident triage",
    model: "openai/gpt-5",
    revision: 1,
    is_default: true,
    status: "ready",
    issues: [],
    inputs: { secrets: [], variables: [] },
    created_at: "2026-07-15T10:00:00.000Z",
    updated_at: "2026-07-15T10:00:00.000Z",
    last_used_at: null,
    ...input,
  };
}

function setReactInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setReactTextareaValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === text);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return match;
}

async function mount(options: RunOptions): Promise<HTMLElement> {
  queryMocks.fetchRunOptions.mockResolvedValue(options);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(RunLauncherDialog, {
      slug: "incident-summary",
      orgId: "77777777-7777-4777-8777-777777777777",
      onLaunched: vi.fn(),
      onClose: vi.fn(),
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMocks.startRunPrewarm.mockResolvedValue(null);
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("RunLauncherDialog", () => {
  it("abandons a secretless prewarm when the launcher unmounts", async () => {
    queryMocks.startRunPrewarm.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      status: "queued",
      expires_at: "2026-07-15T10:05:00.000Z",
    });
    await mount(runOptions());
    await act(async () => { await Promise.resolve(); });
    const root = roots.pop()!;
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    expect(queryMocks.abandonRunPrewarm).toHaveBeenCalledWith("88888888-8888-4888-8888-888888888888");
  });

  it("passes the prewarm to Run and safely cancels any cold-missed ticket after commit", async () => {
    queryMocks.startRunPrewarm.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      status: "queued",
      expires_at: "2026-07-15T10:05:00.000Z",
    });
    queryMocks.launchRun.mockResolvedValue({ id: "run-1" });
    const container = await mount(runOptions());
    await act(async () => { await Promise.resolve(); });
    setReactTextareaValue(container.querySelector("textarea")!, "Summarize this incident");
    await act(async () => {
      button(container, "Run").click();
      await Promise.resolve();
    });
    expect(queryMocks.launchRun).toHaveBeenCalledWith(
      "incident-summary",
      expect.objectContaining({ prewarmId: "88888888-8888-4888-8888-888888888888" }),
    );
    const root = roots.pop()!;
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    expect(queryMocks.abandonRunPrewarm).toHaveBeenCalledWith("88888888-8888-4888-8888-888888888888");
  });

  it("cancels a prewarm ticket that arrives after a cold launch commits", async () => {
    let resolvePrewarm!: (value: { id: string; status: "queued"; expires_at: string }) => void;
    queryMocks.startRunPrewarm.mockReturnValue(new Promise((resolve) => { resolvePrewarm = resolve; }));
    queryMocks.launchRun.mockResolvedValue({ id: "run-1" });
    const container = await mount(runOptions());
    setReactTextareaValue(container.querySelector("textarea")!, "Summarize this incident");
    await act(async () => {
      button(container, "Run").click();
      await Promise.resolve();
    });
    await act(async () => {
      resolvePrewarm({
        id: "99999999-9999-4999-8999-999999999999",
        status: "queued",
        expires_at: "2026-07-15T10:05:00.000Z",
      });
      await Promise.resolve();
    });

    expect(queryMocks.abandonRunPrewarm).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999");
  });

  it("does not present the dedicated model-provider key as a manifest-declared skill input", async () => {
    const container = await mount(runOptions());

    expect(container.textContent).not.toContain("OPENAI_API_KEY");
    expect(container.textContent).not.toContain("provider key");
  });

  it("keeps a manifest-declared secret selectable without an exposure summary", async () => {
    const options = runOptions();
    options.declared_secrets = [{
      skill_id: ROOT_ID,
      skill_version_id: VERSION_ID,
      skill_slug: "incident-summary",
      slot_id: SLOT_ID,
      env_key: "SERVICE_TOKEN",
      description: "Service credential",
      required: true,
      candidates: [{
        id: SECRET_ID,
        name: "Production service",
        key: "SERVICE_TOKEN",
        audience: "personal",
        personal: true,
        owner: { id: ROOT_ID, name: "Ada", initials: "AD", avatar_url: null },
      }],
      prefill_secret_id: SECRET_ID,
    }];

    const container = await mount(options);
    const secretSelect = container.querySelector<HTMLSelectElement>(".vault-field__select");

    expect(secretSelect?.value).toBe(SECRET_ID);
    expect(secretSelect?.textContent).toContain("Production service · Personal · Ada");
    expect(container.textContent).not.toMatch(/\b\d+ exposed\b/);
    expect(container.textContent).not.toContain("Credentials exposed to sandbox code");
    expect(container.textContent).not.toContain("malicious skill");
  });

  it("creates and renames a configuration from the primary configuration controls", async () => {
    queryMocks.createRunConfiguration.mockImplementation(async (_slug: string, input: CreateRunConfigurationInput) =>
      configuration({ name: input.name }),
    );
    queryMocks.updateRunConfiguration.mockResolvedValue(configuration({ name: "Incident review", revision: 2 }));
    const container = await mount(runOptions());

    act(() => button(container, "Save configuration").click());
    const createName = container.querySelector<HTMLInputElement>("#run-config-name");
    expect(createName?.getAttribute("aria-label") ?? createName?.labels?.[0]?.textContent).toBe("Configuration name");
    setReactInputValue(createName!, "Incident triage");
    await act(async () => {
      button(container, "Save").click();
      await Promise.resolve();
    });

    expect(queryMocks.createRunConfiguration).toHaveBeenCalledWith(
      "incident-summary",
      expect.objectContaining({ name: "Incident triage" }),
    );
    expect(button(container, "Save as")).toBeTruthy();
    const rename = button(container, "Rename");
    expect(rename.closest(".run-config__select-actions")).toBeTruthy();

    act(() => rename.click());
    const renameInput = container.querySelector<HTMLInputElement>("#run-config-name");
    expect(renameInput?.value).toBe("Incident triage");
    setReactInputValue(renameInput!, "Incident review");
    await act(async () => {
      button(container, "Save").click();
      await Promise.resolve();
    });

    expect(queryMocks.updateRunConfiguration).toHaveBeenCalledWith(CONFIG_ID, {
      revision: 1,
      name: "Incident review",
    });
    expect(container.querySelector<HTMLSelectElement>("#run-configuration")?.selectedOptions[0]?.textContent).toContain("Incident review");

    act(() => button(container, "Rename").click());
    act(() => {
      const select = container.querySelector<HTMLSelectElement>("#run-configuration")!;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("#run-config-name")).toBeNull();
    expect(button(container, "Save configuration")).toBeTruthy();
  });

  it("launches with an attachment and no text prompt", async () => {
    queryMocks.launchRun.mockResolvedValue({ id: "run-file-only" });
    const container = await mount(runOptions());
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    const file = new File(["brief"], "brief.pdf", { type: "application/pdf" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(button(container, "Run").disabled).toBe(false);
    await act(async () => {
      button(container, "Run").click();
      await Promise.resolve();
    });
    expect(queryMocks.launchRun).toHaveBeenCalledWith(
      "incident-summary",
      expect.objectContaining({ prompt: "", files: [file] }),
    );
  });
});
