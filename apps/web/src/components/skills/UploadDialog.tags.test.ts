// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadDialog } from "./UploadDialog";

const queryMocks = vi.hoisted(() => ({
  archiveSkill: vi.fn(),
  createSkillInline: vi.fn(),
  fetchSkillDependencies: vi.fn(),
  issueToken: vi.fn(),
  publishSkillPackage: vi.fn(),
  setSkillTags: vi.fn(),
  validateSkillPackage: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  apiBase: () => "http://127.0.0.1:3001",
  versionPackageUrl: (slug: string, version: string) => `/v1/skills/${slug}/versions/${version}/package`,
  ...queryMocks,
}));

let roots: Root[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  roots = [];
  queryMocks.archiveSkill.mockResolvedValue(undefined);
  queryMocks.createSkillInline.mockResolvedValue({ slug: "incident-summary", version: "1.0.0" });
  queryMocks.fetchSkillDependencies.mockResolvedValue(null);
  queryMocks.issueToken.mockResolvedValue({ token: "cmp_pat_test", id: "token-1", name: "Test" });
  queryMocks.publishSkillPackage.mockResolvedValue({ slug: "incident-summary", version: "1.0.0" });
  queryMocks.setSkillTags.mockResolvedValue(["incident response"]);
  queryMocks.validateSkillPackage.mockResolvedValue({ result: { ok: true }, dependencyPlan: null });
});

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(UploadDialog, { teams: [], onClose: vi.fn(), onPublished: vi.fn() }));
  });
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.includes(label),
  );
  if (!match) throw new Error(`button not found: ${label}`);
  return match as HTMLButtonElement;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function change(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  if (input instanceof HTMLInputElement && !input.getAttribute("type")) input.setAttribute("type", "text");
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function fillCreateForm(container: HTMLElement) {
  await click(button(container, "Create in the browser"));
  await change(container.querySelector<HTMLInputElement>("#up-create-id")!, "incident-summary");
  await change(container.querySelector<HTMLInputElement>("#up-create-desc")!, "Summarize incidents.");
}

async function addTag(container: HTMLElement, tag: string) {
  const input = container.querySelector<HTMLInputElement>("#up-tags")!;
  await change(input, tag);
  await act(async () => {
    input.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("UploadDialog tag publishing", () => {
  it("writes tags after a browser-created skill publishes", async () => {
    const container = await mount();
    await fillCreateForm(container);
    await addTag(container, " Incident Response ");

    await click(button(container, "Create skill"));

    expect(queryMocks.createSkillInline).toHaveBeenCalledWith(expect.objectContaining({
      id: "incident-summary",
      description: "Summarize incidents.",
    }));
    expect(queryMocks.setSkillTags).toHaveBeenCalledWith("incident-summary", ["incident response"]);
  });

  it("surfaces a non-fatal warning when the post-publish tag write fails", async () => {
    queryMocks.setSkillTags.mockRejectedValue(new Error("tag update failed"));
    const container = await mount();
    await fillCreateForm(container);
    await addTag(container, "ops");

    await click(button(container, "Create skill"));

    expect(container.textContent).toContain("Published, but could not update tags");
  });
});
