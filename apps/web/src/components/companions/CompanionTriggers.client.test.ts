// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanionTrigger } from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const companionsApi = vi.hoisted(() => ({
  createCompanionTrigger: vi.fn(),
  deleteCompanionTrigger: vi.fn(),
  updateCompanionTrigger: vi.fn(),
  rotateCompanionTriggerSecret: vi.fn(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- legacy pattern predating the incremental anti-slop gate
vi.mock("@/lib/companions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/companions")>()),
  ...companionsApi,
}));

const { CompanionTriggers } = await import("./CompanionTriggers");

// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- legacy pattern predating the incremental anti-slop gate
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionId = "11111111-1111-4111-8111-111111111111";
const triggerId = "22222222-2222-4222-8222-222222222222";
const roots: Root[] = [];

function trigger(overrides: Partial<CompanionTrigger> = {}): CompanionTrigger {
  return {
    id: triggerId,
    companion_id: companionId,
    name: "CI failed",
    prompt: "Summarize the failure.",
    provider: "github",
    enabled: true,
    target: null,
    registration_status: "manual",
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
      canEdit: input.canEdit ?? true,
      onChange: input.onChange ?? (() => undefined),
    }));
  });
  return container;
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- legacy pattern predating the incremental anti-slop gate
  return [...container.querySelectorAll("button")]
    .find((button) => button.textContent === name) as HTMLButtonElement | undefined;
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

  it("lists each trigger with its provider as a literal machine value", async () => {
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
    expect(container.textContent).toContain("github");
    expect(container.textContent).toContain("Ticket opened");
    expect(container.textContent).toContain("linear");
    expect(container.textContent).toContain("This trigger was disabled after repeated failures.");
  });

  it("toggles a trigger off through the update endpoint", async () => {
    const updated = trigger({ enabled: false });
    companionsApi.updateCompanionTrigger.mockResolvedValue(updated);
    const onChange = vi.fn();
    const container = await mount({ triggers: [trigger()], onChange });

    const toggle = buttonNamed(container, "On");
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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

    const remove = buttonNamed(container, "Delete");
    expect(remove).toBeDefined();
    await act(async () => {
      remove!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(companionsApi.deleteCompanionTrigger).toHaveBeenCalledWith(
      "org-1",
      companionId,
      triggerId,
    );
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("creates a trigger with a client-generated id, mirroring routine creation", async () => {
    const created = trigger({ name: "Deploy finished", provider: "custom" });
    companionsApi.createCompanionTrigger.mockResolvedValue(created);
    const onChange = vi.fn();
    const container = await mount({ onChange });

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- legacy pattern predating the incremental anti-slop gate
    const add = container.querySelector("[aria-label='Add a trigger']") as HTMLButtonElement;
    await act(async () => {
      add.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- legacy pattern predating the incremental anti-slop gate
    setControlled(container.querySelector("input") as HTMLInputElement, "Deploy finished");
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- legacy pattern predating the incremental anti-slop gate
    setControlled(container.querySelector("textarea") as HTMLTextAreaElement, "Report the deploy.");
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- legacy pattern predating the incremental anti-slop gate
    setControlled(container.querySelector("select") as HTMLSelectElement, "custom");
    await act(async () => {});

    const create = buttonNamed(container, "Create");
    expect(create).toBeDefined();
    expect(create!.disabled).toBe(false);
    await act(async () => {
      create!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(companionsApi.createCompanionTrigger).toHaveBeenCalledWith(
      "org-1",
      companionId,
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        name: "Deploy finished",
        prompt: "Report the deploy.",
        provider: "custom",
        enabled: true,
      }),
    );
    expect(onChange).toHaveBeenCalledWith([created]);
  });

  it("copies the webhook URL and confirms briefly", async () => {
    const container = await mount({ triggers: [trigger()] });

    const copy = buttonNamed(container, "Copy URL");
    expect(copy).toBeDefined();
    await act(async () => {
      copy!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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

    const rotate = buttonNamed(container, "Rotate secret");
    expect(rotate).toBeDefined();
    await act(async () => {
      rotate!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    // The first click only arms the confirmation: rotating silently breaks the external service
    // still posting to the old URL, so nothing is rotated yet.
    expect(companionsApi.rotateCompanionTriggerSecret).not.toHaveBeenCalled();
    const confirm = buttonNamed(container, "Confirm rotate");
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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
    expect(buttonNamed(container, "On")).toBeUndefined();
    expect(buttonNamed(container, "Delete")).toBeUndefined();
    expect(container.querySelector("[aria-label='Add a trigger']")).toBeNull();
  });

  it("hides copy and rotate when the webhook URL was withheld, even for an editor", async () => {
    const container = await mount({ triggers: [trigger({ webhook_url: null })] });

    expect(buttonNamed(container, "Copy URL")).toBeUndefined();
    expect(buttonNamed(container, "Rotate secret")).toBeUndefined();
    expect(buttonNamed(container, "On")).toBeDefined();
    expect(buttonNamed(container, "Delete")).toBeDefined();
  });
});
