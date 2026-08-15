// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OptionMultiSelect, type MultiSelectOption } from "./OptionMultiSelect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options: MultiSelectOption[] = [
  { id: "a", title: "Agent Governance", mono: "agent-governance · v1.0.3", meta: "Organization", filterKey: "org" },
  { id: "b", title: "Audit Linear", mono: "audit-linear-tickets · v1.0.0", meta: "Organization", filterKey: "org" },
  { id: "c", title: "Personal Notes", mono: "personal-notes · v0.1.0", meta: "Personal", filterKey: "personal" },
];

const roots: Root[] = [];

function mount(props: Partial<Parameters<typeof OptionMultiSelect>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const onChange = vi.fn();
  act(() => {
    root.render(React.createElement(OptionMultiSelect, {
      legend: "Skills",
      hint: "Choose skills.",
      options,
      selectedIds: [],
      searchPlaceholder: "Search skills…",
      filters: [
        { key: "org", label: "Organization" },
        { key: "personal", label: "Personal" },
      ],
      emptyText: "No skills yet.",
      missingLabel: "Not in your library",
      onChange,
      ...props,
    }));
  });
  return { container, onChange };
}

function search(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>("input[type=search]")!;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function rowTitles(container: HTMLElement) {
  return Array.from(container.querySelectorAll(".companions-skills-picker__list label strong"))
    .map((node) => node.textContent);
}

describe("OptionMultiSelect", () => {
  afterEach(() => {
    while (roots.length) {
      const root = roots.pop();
      act(() => root?.unmount());
    }
    document.body.replaceChildren();
  });

  it("filters rows by title and mono text and reports the shown count", () => {
    const { container } = mount();

    search(container, "audit");
    expect(rowTitles(container)).toEqual(["Audit Linear"]);
    expect(container.textContent).toContain("0 selected · 1 shown");

    search(container, "personal-notes");
    expect(rowTitles(container)).toEqual(["Personal Notes"]);

    search(container, "zzz");
    expect(rowTitles(container)).toEqual([]);
    expect(container.textContent).toContain('No skills match "zzz".');
  });

  it("narrows available rows with filter chips but keeps the selection visible", () => {
    const { container } = mount({ selectedIds: ["c"] });

    const personalChip = Array.from(container.querySelectorAll(".companions-skills-picker__chips button"))
      .find((button) => button.textContent === "Organization")!;
    act(() => {
      (personalChip as HTMLButtonElement).click();
    });

    // Selected personal skill stays pinned; available narrows to org rows.
    expect(rowTitles(container)).toEqual(["Personal Notes", "Agent Governance", "Audit Linear"]);
    expect(container.textContent).toContain("Selected (1)");
  });

  it("pins selected rows above available ones and clears them all at once", () => {
    const { container, onChange } = mount({ selectedIds: ["b"] });

    expect(rowTitles(container)).toEqual(["Audit Linear", "Agent Governance", "Personal Notes"]);
    expect(container.textContent).toContain("Selected (1)");
    expect(container.textContent).toContain("Available");

    const clear = container.querySelector<HTMLButtonElement>(".companions-skills-picker__clear")!;
    act(() => {
      clear.click();
    });
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("renders unknown selected ids as removable missing rows", () => {
    const { container, onChange } = mount({ selectedIds: ["b", "ghost-id"] });

    const missing = container.querySelector(".companions-skills-picker__missing")!;
    expect(missing.textContent).toContain("Not in your library");
    expect(missing.textContent).toContain("ghost-id");

    act(() => {
      missing.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(onChange).toHaveBeenCalledWith(["b"]);
  });

  it("hides the list on a fetch error instead of rendering selections as missing", () => {
    const { container } = mount({ selectedIds: ["b"], options: [], error: "Skills could not be loaded." });

    expect(container.textContent).toContain("Skills could not be loaded.");
    expect(container.querySelector(".companions-skills-picker__missing")).toBeNull();
    expect(container.querySelector(".companions-skills-picker__list")).toBeNull();
    expect(container.querySelector("input[type=search]")).toBeNull();
  });

  it("toggles selection through the checkboxes", () => {
    const { container, onChange } = mount({ selectedIds: ["a"] });

    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    const unchecked = checkboxes.find((input) => !input.checked)!;
    act(() => {
      unchecked.click();
    });
    expect(onChange).toHaveBeenCalledWith(["a", "b"]);

    const checked = checkboxes.find((input) => input.checked)!;
    act(() => {
      checked.click();
    });
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
