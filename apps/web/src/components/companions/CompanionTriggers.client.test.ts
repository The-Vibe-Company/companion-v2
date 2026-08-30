// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanionTrigger } from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionTriggers, type CompanionTriggersApi } from "./CompanionTriggers";

const companionsApi = {
  createCompanionTrigger: vi.fn<CompanionTriggersApi["createCompanionTrigger"]>(),
  deleteCompanionTrigger: vi.fn<CompanionTriggersApi["deleteCompanionTrigger"]>(),
  updateCompanionTrigger: vi.fn<CompanionTriggersApi["updateCompanionTrigger"]>(),
  rotateCompanionTriggerSecret: vi.fn<CompanionTriggersApi["rotateCompanionTriggerSecret"]>(),
  retryCompanionTriggerRegistration: vi.fn<NonNullable<CompanionTriggersApi["retryCompanionTriggerRegistration"]>>(),
} satisfies CompanionTriggersApi;

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const companionId = "11111111-1111-4111-8111-111111111111";
const triggerId = "22222222-2222-4222-8222-222222222222";
const roots: Root[] = [];

function trigger(overrides: Partial<CompanionTrigger> = {}): CompanionTrigger {
  return {
    id: triggerId,
    companion_id: companionId,
    name: "CI failed",
    prompt: "Summarize the failure.",
    mode: "relay",
    provider: "github",
    provider_account_id: null,
    target: null,
    registration_status: "manual",
    remote_hook_account_id: null,
    remote_hook_id: null,
    last_registration_error: null,
    enabled: true,
    webhook_url: "http://127.0.0.1:3000/v1/hooks/triggers/22222222-2222-4222-8222-222222222222/abc123",
    last_fired_at: null,
    last_error_code: null,
    last_error_message: null,
    last_error_at: null,
    consecutive_failures: 0,
    created_at: "2026-08-14T09:00:00.000Z",
    updated_at: "2026-08-14T09:00:00.000Z",
    ...overrides,
  };
}

async function mount(input: {
  triggers?: CompanionTrigger[];
  canEdit?: boolean;
  memberTimezone?: string | null;
  accountOptions?: Array<{ id: string; provider: string; label: string }>;
  onChange?: (triggers: CompanionTrigger[]) => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionTriggers, {
      orgId: "org-1",
      companionId,
      triggers: input.triggers ?? [],
      memberTimezone: input.memberTimezone,
      canEdit: input.canEdit ?? true,
      accountOptions: input.accountOptions,
      onChange: input.onChange ?? (() => undefined),
      api: companionsApi,
    }));
  });
  return container;
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")]
    .find((button) => button.textContent === name);
}

function requireButton(container: ParentNode, selector: string): HTMLButtonElement {
  const button = container.querySelector(selector);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${selector}`);
  return button;
}

function requireNamedButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = buttonNamed(container, name);
  if (!button) throw new Error(`Missing button: ${name}`);
  return button;
}

function requireInput(container: ParentNode): HTMLInputElement {
  const input = container.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing input");
  return input;
}

function requireTextArea(container: ParentNode): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Missing textarea");
  return textarea;
}

function setControlled(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const proto = element instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Companion triggers panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("lists each trigger with a readable provider and explicit status", async () => {
    const container = await mount({
      triggers: [
        trigger(),
        trigger({
          id: "33333333-3333-4333-8333-333333333333",
          name: "Ticket opened",
          provider: "linear",
          enabled: false,
          last_error_message: "This trigger was disabled after repeated failures.",
        }),
      ],
    });

    expect(container.textContent).toContain("CI failed");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Ticket opened");
    expect(container.textContent).toContain("Linear");
    expect(container.textContent).toContain("Ask the Companion");
    expect(container.textContent).toContain("This trigger was disabled after repeated failures.");
  });

  it("retries failed remote registration and replaces the row with the refreshed result", async () => {
    const failed = trigger({
      registration_status: "failed",
      last_registration_error: "GitHub token is missing hook write scope.",
      webhook_url: null,
    });
    const registered = trigger({
      registration_status: "registered",
      remote_hook_id: "hook-42",
      last_registration_error: null,
      webhook_url: null,
    });
    companionsApi.retryCompanionTriggerRegistration.mockResolvedValue(registered);
    const onChange = vi.fn();
    const container = await mount({ triggers: [failed], onChange });

    expect(container.textContent).toContain("GitHub token is missing hook write scope.");
    await act(async () => {
      requireNamedButton(container, "Retry registration")
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(companionsApi.retryCompanionTriggerRegistration).toHaveBeenCalledWith(
      "org-1",
      companionId,
      triggerId,
    );
    expect(onChange).toHaveBeenCalledWith([registered]);
  });

  it("reuses the sole attached provider account without asking for a key or URL", async () => {
    const created = trigger({ registration_status: "registered", provider_account_id: "account-1" });
    companionsApi.createCompanionTrigger.mockResolvedValue(created);
    const container = await mount({
      accountOptions: [{ id: "account-1", provider: "github", label: "Acme GitHub" }],
    });

    await act(async () => {
      requireButton(container, "[aria-label='Add a trigger']")
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const provider = [...container.querySelectorAll("select")]
      .find((select) => [...select.options].some((option) => option.value === "github"));
    if (!provider) throw new Error("Missing provider picker");
    await act(async () => { setControlled(provider, "github"); });

    expect(container.textContent).toContain("Using the attached GitHub account “Acme GitHub”.");
    expect(container.textContent?.toLowerCase()).not.toContain("paste");
    expect(container.querySelector("input[placeholder*='URL']")).toBeNull();
    expect(container.querySelector("input[placeholder*='key']")).toBeNull();
  });

  it("shows trigger activity in the stored member timezone", async () => {
    const container = await mount({
      triggers: [trigger({ last_fired_at: "2026-08-14T09:00:00.000Z" })],
      memberTimezone: "Pacific/Auckland",
    });

    expect(container.textContent).toContain("Last fired");
    expect(container.textContent).toContain("Pacific/Auckland");
    expect(container.textContent).toContain("9:00 PM");
  });

  it("toggles a trigger off through the update endpoint", async () => {
    const updated = trigger({ enabled: false });
    companionsApi.updateCompanionTrigger.mockResolvedValue(updated);
    const onChange = vi.fn();
    const container = await mount({ triggers: [trigger()], onChange });

    const toggle = requireNamedButton(container, "Turn off");
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(companionsApi.updateCompanionTrigger).toHaveBeenCalledWith(
      "org-1",
      companionId,
      triggerId,
      { enabled: false },
    );
    expect(onChange).toHaveBeenCalledWith([updated]);
  });

  it("deletes a trigger and drops its row", async () => {
    companionsApi.deleteCompanionTrigger.mockResolvedValue(undefined);
    const onChange = vi.fn();
    const container = await mount({ triggers: [trigger()], onChange });

    const remove = requireNamedButton(container, "Delete");
    await act(async () => {
      remove.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(companionsApi.deleteCompanionTrigger).toHaveBeenCalledWith(
      "org-1",
      companionId,
      triggerId,
    );
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("requires a connected provider instead of falling back to a manual webhook", async () => {
    const container = await mount();

    await act(async () => {
      requireButton(container, "[aria-label='Add a trigger']")
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain("Connect a provider first");
    expect(container.textContent).not.toContain("Webhook (legacy)");
    expect(container.textContent).not.toContain("Custom (legacy)");
    expect(requireNamedButton(container, "Create trigger").disabled).toBe(true);
  });

  it("creates a provider-backed trigger with a client-generated id", async () => {
    const created = trigger({
      name: "Deploy finished",
      provider: "github",
      provider_account_id: "account-1",
      registration_status: "registered",
    });
    companionsApi.createCompanionTrigger.mockResolvedValue(created);
    const onChange = vi.fn();
    const container = await mount({
      onChange,
      accountOptions: [{ id: "account-1", provider: "github", label: "Acme GitHub" }],
    });

    const add = requireButton(container, "[aria-label='Add a trigger']");
    await act(async () => {
      add.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await act(async () => {
      setControlled(requireInput(container), "Deploy finished");
      setControlled(requireTextArea(container), "Report the deploy.");
      const repository = container.querySelector<HTMLInputElement>("input[placeholder='owner/repository']");
      if (!repository) throw new Error("Missing repository input");
      setControlled(repository, "acme/app");
    });

    const create = requireNamedButton(container, "Create trigger");
    expect(create.disabled).toBe(false);
    await act(async () => {
      create.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(companionsApi.createCompanionTrigger).toHaveBeenCalledWith(
      "org-1",
      companionId,
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        name: "Deploy finished",
        prompt: "Report the deploy.",
        provider: "github",
        provider_account_id: "account-1",
        target: { repo: "acme/app", events: ["push"] },
        mode: "relay",
        enabled: true,
      }),
    );
    expect(onChange).toHaveBeenCalledWith([created]);
  });

  it("copies the webhook URL and confirms briefly", async () => {
    const container = await mount({ triggers: [trigger()] });

    const copy = requireNamedButton(container, "Copy URL");
    await act(async () => {
      copy.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith(trigger().webhook_url);
    expect(buttonNamed(container, "Copied")).toBeDefined();
  });

  it("rotates the secret and shows the refreshed row", async () => {
    const rotated = trigger({
      webhook_url: "http://127.0.0.1:3000/v1/hooks/triggers/22222222-2222-4222-8222-222222222222/def456",
    });
    companionsApi.rotateCompanionTriggerSecret.mockResolvedValue(rotated);
    const onChange = vi.fn();
    const container = await mount({ triggers: [trigger()], onChange });

    const rotate = requireNamedButton(container, "Rotate secret");
    await act(async () => {
      rotate.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    // The first click only arms the confirmation: rotating silently breaks the external service
    // still posting to the old URL, so nothing is rotated yet.
    expect(companionsApi.rotateCompanionTriggerSecret).not.toHaveBeenCalled();
    const confirm = requireNamedButton(container, "Confirm rotate");
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(companionsApi.rotateCompanionTriggerSecret).toHaveBeenCalledWith(
      "org-1",
      companionId,
      triggerId,
    );
    expect(onChange).toHaveBeenCalledWith([rotated]);
  });

  it("offers a Viewer no copy, rotate, toggle, delete, or create controls", async () => {
    // A Viewer's list read answers webhook_url: null, so there is nothing to copy even if the
    // controls leaked; the panel hides them entirely.
    const container = await mount({
      triggers: [trigger({ webhook_url: null })],
      canEdit: false,
    });

    expect(container.textContent).toContain("CI failed");
    expect(buttonNamed(container, "Copy URL")).toBeUndefined();
    expect(buttonNamed(container, "Rotate secret")).toBeUndefined();
    expect(buttonNamed(container, "Turn on")).toBeUndefined();
    expect(buttonNamed(container, "Turn off")).toBeUndefined();
    expect(buttonNamed(container, "Delete")).toBeUndefined();
    expect(container.querySelector("[aria-label='Add a trigger']")).toBeNull();
  });

  it("hides copy and rotate when the webhook URL was withheld, even for an editor", async () => {
    const container = await mount({ triggers: [trigger({ webhook_url: null })] });

    expect(buttonNamed(container, "Copy URL")).toBeUndefined();
    expect(buttonNamed(container, "Rotate secret")).toBeUndefined();
    expect(buttonNamed(container, "Turn off")).toBeDefined();
    expect(buttonNamed(container, "Delete")).toBeDefined();
  });
});
