// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion -- Existing happy-dom harness debt; this change extends it with timezone behavior. */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanionRoutine } from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const companionsApi = vi.hoisted(() => ({
  createCompanionRoutine: vi.fn(),
  deleteCompanionRoutine: vi.fn(),
  updateCompanionRoutine: vi.fn(),
}));
const profileApi = vi.hoisted(() => ({
  updateMyTimezone: vi.fn(),
}));

vi.mock("@/lib/companions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/companions")>()),
  ...companionsApi,
}));

vi.mock("@/lib/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/org")>()),
  ...profileApi,
}));

const { CompanionRoutines } = await import("./CompanionRoutines");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionId = "11111111-1111-4111-8111-111111111111";
const roots: Root[] = [];

async function mount(memberTimezone?: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionRoutines, {
      orgId: "org-1",
      companionId,
      routines: [],
      memberTimezone,
      canEdit: true,
      onChange: () => undefined,
    }));
  });
  return container;
}

function setControlled(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Companion routine editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileApi.updateMyTimezone.mockResolvedValue({
      id: "user-1",
      name: "Member",
      initials: "ME",
      timezone: "UTC",
    });
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("refuses a cadence shorter than five minutes before creating", async () => {
    const container = await mount();
    const add = container.querySelector("[aria-label='Add a routine']") as HTMLButtonElement;
    await act(async () => {
      add.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const cron = [...container.querySelectorAll("input")]
      .find((input) => input.className.includes("mono")) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(cron, "* * * * *");
    await act(async () => {
      cron.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.textContent).toContain("Routines must be at least five minutes apart.");
    const create = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Create") as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(companionsApi.createCompanionRoutine).not.toHaveBeenCalled();
  });

  it("creates new schedules in the stored member timezone", async () => {
    const created: CompanionRoutine = {
      id: "22222222-2222-4222-8222-222222222222",
      companion_id: companionId,
      name: "Morning brief",
      prompt: "Summarize overnight activity.",
      cron: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
      enabled: true,
      next_fire_at: "2026-08-27T16:00:00.000Z",
      last_fired_at: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
      created_at: "2026-08-26T13:42:17.000Z",
      updated_at: "2026-08-26T13:42:17.000Z",
    };
    companionsApi.createCompanionRoutine.mockResolvedValue(created);
    const container = await mount("America/Los_Angeles");
    const add = container.querySelector("[aria-label='Add a routine']") as HTMLButtonElement;
    await act(async () => add.click());

    const inputs = [...container.querySelectorAll("input")];
    await act(async () => {
      setControlled(inputs[0]!, "Morning brief");
      setControlled(container.querySelector("textarea")!, "Summarize overnight activity.");
    });
    expect((container.querySelector("select") as HTMLSelectElement).value)
      .toBe("America/Los_Angeles");

    const create = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Create") as HTMLButtonElement;
    await act(async () => create.click());

    expect(companionsApi.createCompanionRoutine).toHaveBeenCalledWith(
      "org-1",
      companionId,
      expect.objectContaining({ timezone: "America/Los_Angeles", cron: "0 9 * * 1-5" }),
    );
    expect(profileApi.updateMyTimezone).not.toHaveBeenCalled();
  });

  it("persists the browser timezone before creating when the member setting is unset", async () => {
    companionsApi.createCompanionRoutine.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companion_id: companionId,
      name: "Morning brief",
      prompt: "Summarize overnight activity.",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      enabled: true,
      next_fire_at: null,
      last_fired_at: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
      created_at: "2026-08-26T13:42:17.000Z",
      updated_at: "2026-08-26T13:42:17.000Z",
    } satisfies CompanionRoutine);
    const container = await mount(null);
    await act(async () => {
      (container.querySelector("[aria-label='Add a routine']") as HTMLButtonElement).click();
    });
    const inputs = [...container.querySelectorAll("input")];
    await act(async () => {
      setControlled(inputs[0]!, "Morning brief");
      setControlled(container.querySelector("textarea")!, "Summarize overnight activity.");
    });

    const scheduleTimezone = (container.querySelector("select") as HTMLSelectElement).value;
    const create = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Create") as HTMLButtonElement;
    await act(async () => create.click());

    expect(profileApi.updateMyTimezone).toHaveBeenCalledWith(scheduleTimezone);
    expect(profileApi.updateMyTimezone.mock.invocationCallOrder[0])
      .toBeLessThan(companionsApi.createCompanionRoutine.mock.invocationCallOrder[0]!);
    expect(companionsApi.createCompanionRoutine).toHaveBeenCalledWith(
      "org-1",
      companionId,
      expect.objectContaining({ timezone: scheduleTimezone }),
    );
  });
});
