// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillVM, TeamVM } from "@/lib/types";
import { PropList, Requirements } from "./detailParts";

const teams: TeamVM[] = [
  { id: "engineering", name: "Engineering", initial: "EN", color: null, icon: null, role: "editor", dbId: "team-1" },
];

const skill: SkillVM = {
  uuid: "skill-1",
  id: "manifest-demo",
  ownerId: "user-1",
  visibility: { everyone: false, teams: [{ id: "team-1", slug: "engineering", name: "Engineering", color: null, icon: null }] },
  version: "1.2.3",
  validation: "valid",
  description: "Demo skill.",
  error: null,
  owner: {
    kind: "user",
    id: "user-1",
    userId: "user-1",
    teamId: null,
    name: "Alice Nardon",
    initials: "AN",
    handle: "alice",
    team: null,
  },
  tools: ["read_file"],
  tags: ["automation", "incident response"],
  requirements: [
    {
      key: "AZURE_OPENAI_API_KEY",
      type: "secret",
      required: true,
      note: "Ask your org admin to provision an Azure OpenAI resource.",
    },
    { key: "OPENAI_BASE_URL", type: "env", required: false, note: "" },
  ],
  size: "1 KB",
  license: "MIT",
  checksum: "sha256:abc",
  created: "2026-06-09",
  updated: "just now",
  stars: 0,
  starred: false,
  installStatus: "none",
  installedVersion: null,
  teams: [{ id: "team-1", slug: "engineering", name: "Engineering", color: null, icon: null }],
  teamSlugs: ["engineering"],
  requiresCount: 0,
  usedByCount: 0,
  depWarn: false,
  archived: false,
  compatibility: "Requires Python 3.14+ and uv with network access",
  metadata: {
    companion_skill_id: "skill-1",
    companion_version: "1.2.3",
  },
};

let roots: Root[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  roots = [];
});

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(ui);
  });
  return container;
}

async function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("PropList manifest rendering", () => {
  it("renders Agent Skills manifest fields without treating registry version as manifest data", () => {
    const html = renderToString(
      React.createElement(PropList, {
        skill,
        teams,
        onChangeVisibility: vi.fn(),
        canChangeVisibility: true,
      }),
    );
    expect(html).toContain("Compatibility");
    expect(html).toContain("Requires Python 3.14+ and uv with network access");
    expect(html).toContain("Allowed tools");
    expect(html).toContain("read_file");
    expect(html).toContain("Tags");
    expect(html).toContain("incident response");
    expect(html).toContain("License");
    expect(html).toContain("MIT");
    expect(html).toContain("Metadata");
    expect(html).toContain('title="companion_skill_id"');
    expect(html).toContain("skill id");
    expect(html).toContain('title="companion_version"');
    expect(html).toContain(">version</span>");
    expect(html).toContain("1.2.3");
    // Requirements live in their own tab, not the manifest rail.
    expect(html).not.toContain("AZURE_OPENAI_API_KEY");
  });

  it("lets editors add normalized tags and remove existing tags", async () => {
    const onChangeTags = vi.fn().mockResolvedValue(undefined);
    const container = await mount(
      React.createElement(PropList, {
        skill,
        teams,
        onChangeVisibility: vi.fn(),
        canChangeVisibility: true,
        onChangeTags,
        canChangeTags: true,
      }),
    );

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Add tag"]');
    expect(input).not.toBeNull();
    await changeInput(input!, " QA Tag ");
    await act(async () => {
      input!.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onChangeTags).toHaveBeenCalledWith(["automation", "incident response", "qa tag"]);

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove tag automation"]');
    expect(remove).not.toBeNull();
    await act(async () => {
      remove!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChangeTags).toHaveBeenCalledWith(["incident response"]);
  });

  it("rejects invalid tags and hides edit controls for readers", async () => {
    const onChangeTags = vi.fn().mockResolvedValue(undefined);
    const editable = await mount(
      React.createElement(PropList, {
        skill,
        teams,
        onChangeVisibility: vi.fn(),
        canChangeVisibility: true,
        onChangeTags,
        canChangeTags: true,
      }),
    );

    const input = editable.querySelector<HTMLInputElement>('input[aria-label="Add tag"]');
    await changeInput(input!, "bad_tag");
    await act(async () => {
      input!.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(editable.textContent).toContain("Use letters, numbers, spaces, or hyphens.");
    expect(onChangeTags).not.toHaveBeenCalled();

    const readOnly = await mount(
      React.createElement(PropList, {
        skill,
        teams,
        onChangeVisibility: vi.fn(),
        canChangeVisibility: false,
        onChangeTags,
        canChangeTags: false,
      }),
    );
    expect(readOnly.querySelector('input[aria-label="Add tag"]')).toBeNull();
    expect(readOnly.querySelector('button[aria-label="Remove tag automation"]')).toBeNull();
  });
});

describe("Requirements tab rendering", () => {
  it("lists declared secrets and env vars with their notes and badges", () => {
    const html = renderToString(React.createElement(Requirements, { requirements: skill.requirements }));
    expect(html).toContain("Setup &amp; secrets");
    expect(html).toContain("AZURE_OPENAI_API_KEY");
    expect(html).toContain("secret");
    expect(html).toContain("Ask your org admin to provision an Azure OpenAI resource.");
    expect(html).toContain("OPENAI_BASE_URL");
    expect(html).toContain("optional");
  });

  it("shows an empty state when nothing is declared", () => {
    const html = renderToString(React.createElement(Requirements, { requirements: [] }));
    expect(html).toContain("no required secrets or environment variables");
  });
});
