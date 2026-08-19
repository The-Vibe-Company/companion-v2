// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const companionsApi = vi.hoisted(() => ({
  createCompanionRoutine: vi.fn(),
  deleteCompanionRoutine: vi.fn(),
  updateCompanionRoutine: vi.fn(),
}));

vi.mock("@/lib/companions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/companions")>()),
  ...companionsApi,
}));

const { CompanionRoutines } = await import("./CompanionRoutines");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionId = "11111111-1111-4111-8111-111111111111";
const roots: Root[] = [];

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionRoutines, {
      orgId: "org-1",
      companionId,
      routines: [],
      canEdit: true,
      onChange: () => undefined,
    }));
  });
  return container;
}

describe("Companion routine editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
