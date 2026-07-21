// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillVM } from "@/lib/types";
import type { LabelVM, SkillGroupBy } from "@companion/contracts";
import { ListView } from "./ListView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function skill(overrides: Partial<SkillVM> = {}): SkillVM {
  return {
    uuid: "skill-1",
    id: "seo-helper",
    shareToken: "share-seo-helper",
    version: "1.0.0",
    validation: "valid",
    description: "Helps with SEO checks.",
    display: {},
    icon: null,
    notes: null,
    error: null,
    scope: "org",
    source: null,
    labels: [],
    authorId: "user-1",
    authorName: "Ada Lovelace",
    authorInitials: "AL",
    authorAvatarUrl: null,
    updaterId: "user-1",
    updaterName: "Ada Lovelace",
    updaterInitials: "AL",
    updaterAvatarUrl: null,
    modifiers: [],
    tools: [],
    requirements: [],
    compatibility: null,
    metadata: {},
    size: "1 KB",
    license: "MIT",
    checksum: null,
    created: "Jun 1, 2026",
    updated: "just now",
    installStatus: "none",
    installedVersion: null,
    requiresCount: 0,
    usedByCount: 0,
    depWarn: false,
    archived: false,
    ...overrides,
  };
}

type ListOverrides = {
  onOpen?: (id: string) => void;
  labels?: LabelVM[];
  groupBy?: SkillGroupBy;
  onGroupByChange?: (groupBy: SkillGroupBy) => void;
  library?: "mine" | "org";
};

function props(skills: SkillVM[], overrides: ListOverrides = {}) {
  return {
    skills,
    labels: overrides.labels ?? [],
    workspaceId: "org-1",
    library: overrides.library ?? ("org" as const),
    scopeKind: "all" as const,
    breadcrumb: ["All skills"],
    groupBy: overrides.groupBy ?? ("none" as const),
    onGroupByChange: overrides.onGroupByChange ?? vi.fn(),
    onOpen: overrides.onOpen ?? vi.fn(),
    onUpload: vi.fn(),
    actorId: "user-1",
    onPrimaryAction: vi.fn(),
    lastId: null,
    filters: [],
    onToggleFilter: vi.fn(),
    onRemoveFilter: vi.fn(),
    onClearFilters: vi.fn(),
    preferenceStatus: "idle" as const,
    onRetryPreferences: vi.fn(),
    dragSkillId: null,
    onSkillStartDrag: vi.fn(),
  };
}

function render(skills: SkillVM[], overrides: ListOverrides = {}) {
  return renderToString(React.createElement(ListView, props(skills, overrides)));
}

async function mount(skills: SkillVM[], overrides: ListOverrides = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(React.createElement(ListView, props(skills, overrides))));
  return container;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("ListView names and discovery", () => {
  it("renders the slug as the only row identity and uses it in accessible actions", () => {
    const html = render([
      skill({
        id: "incident-summary",
        display: { name: "Incident Summary" },
        description: "Unique description preview",
        version: "9.8.7",
        requiresCount: 37,
      }),
    ]);

    expect(html).toContain('<span class="crow__title">incident-summary</span>');
    expect(html).toContain('data-skill-slug="incident-summary"');
    expect(html).toContain('aria-label="Open skill incident-summary"');
    expect(html).toContain('aria-label="Install skill incident-summary"');
    expect(html).not.toContain("Incident Summary");
    expect(html).not.toContain("Unique description preview");
    expect(html).not.toContain("9.8.7");
    expect(html).not.toContain(">Version<");
    expect(html).not.toContain(">Deps<");
    expect(html).not.toContain("depspill");
  });

  it("uses the slug regardless of whether the skill has a display title", () => {
    const html = render([
      skill({ id: "seo-helper", display: {} }),
      skill({ id: "blank-title", display: { name: "   " } }),
    ]);

    expect(html).toContain('<span class="crow__title">seo-helper</span>');
    expect(html).toContain('aria-label="Open skill seo-helper"');
    expect(html).toContain('<span class="crow__title">blank-title</span>');
    expect(html).toContain('aria-label="Open skill blank-title"');
  });

  it("keeps duplicate display titles independently identifiable by slug", () => {
    const html = render([
      skill({ id: "incident-summary", display: { name: "Incident Summary" } }),
      skill({ id: "incident-summary-legacy", display: { name: "incident summary" } }),
    ]);

    expect(html).toContain('<span class="crow__title">incident-summary</span>');
    expect(html).toContain('<span class="crow__title">incident-summary-legacy</span>');
    expect(html).toContain('aria-label="Open skill incident-summary"');
    expect(html).toContain('aria-label="Install skill incident-summary-legacy"');
    expect(html).not.toContain("Incident Summary");
  });

  it("keeps long slugs intact for copying and assistive technology", () => {
    const html = render([
      skill({ id: "shared-very-long-prefix-production", display: { name: "Shared title" } }),
      skill({ id: "shared-very-long-prefix-staging", display: { name: "Shared title" } }),
    ]);

    expect(html).toContain('<span class="crow__title">shared-very-long-prefix-production</span>');
    expect(html).toContain('<span class="crow__title">shared-very-long-prefix-staging</span>');
    expect(html).not.toContain("…");
  });

  it("searches hidden slugs and descriptions as well as display titles", async () => {
    const container = await mount([
      skill({ id: "slug-needle", display: { name: "Zebra" }, description: "First description" }),
      skill({ id: "second", display: { name: "Alpha Needle" }, description: "Second description" }),
      skill({ id: "third", display: { name: "Gamma" }, description: "Hidden description needle" }),
    ]);
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;

    setInputValue(input, "slug-needle");
    expect(Array.from(container.querySelectorAll(".crow__title"), (node) => node.textContent)).toEqual(["slug-needle"]);

    setInputValue(input, "alpha needle");
    expect(Array.from(container.querySelectorAll(".crow__title"), (node) => node.textContent)).toEqual(["second"]);

    setInputValue(input, "hidden description");
    expect(Array.from(container.querySelectorAll(".crow__title"), (node) => node.textContent)).toEqual(["third"]);
  });

  it("sorts A–Z by slug and opens the skill by slug", async () => {
    const onOpen = vi.fn();
    const container = await mount(
      [
        skill({ id: "zulu-slug", display: { name: "Alpha" } }),
        skill({ id: "alpha-slug", display: { name: "Zulu" } }),
      ],
      { onOpen },
    );
    const select = container.querySelector('select[aria-label="Sort skills"]') as HTMLSelectElement;

    act(() => {
      select.value = "name";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(Array.from(container.querySelectorAll(".crow__title"), (node) => node.textContent)).toEqual([
      "alpha-slug",
      "zulu-slug",
    ]);

    act(() => (container.querySelector('button[aria-label="Open skill alpha-slug"]') as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith("alpha-slug");
  });
});

describe("ListView folders", () => {
  it("renders no folder metadata when the skill has no labels", () => {
    const html = render([skill({ labels: [] })]);

    expect(html).not.toContain("crow__labels");
    expect(html).not.toContain("crow__label");
  });

  it("renders one full folder path", () => {
    const html = render([skill({ labels: ["marketing/seo"] })]);

    expect(html).toContain('role="list" aria-label="Folders"');
    expect(html).toContain('role="listitem" aria-label="Folder: marketing/seo"');
    expect(html).toContain('<span class="crow__labeltext">marketing/seo</span>');
    expect(html).not.toContain("crow__label--more");
  });

  it("renders two folder paths in their source order", async () => {
    const container = await mount([skill({ labels: ["engineering/platform", "marketing/seo"] })]);

    expect(Array.from(container.querySelectorAll(".crow__labeltext"), (node) => node.textContent)).toEqual([
      "engineering/platform",
      "marketing/seo",
    ]);
    expect(container.querySelector(".crow__label--more")).toBeNull();
  });

  it("caps visible folders at two and exposes the remaining paths through the overflow badge", async () => {
    const onOpen = vi.fn();
    const container = await mount(
      [skill({ labels: ["engineering/platform", "marketing/seo", "operations", "sales/enterprise"] })],
      { onOpen },
    );

    expect(Array.from(container.querySelectorAll(".crow__labeltext"), (node) => node.textContent)).toEqual([
      "engineering/platform",
      "marketing/seo",
    ]);
    const overflow = container.querySelector(".crow__label--more");
    expect(overflow?.textContent).toBe("+2");
    expect(overflow?.getAttribute("title")).toBeNull();
    expect(overflow?.getAttribute("data-folders")).toBe("operations, sales/enterprise");
    expect(overflow?.getAttribute("aria-label")).toBe("2 more folders: operations, sales/enterprise");
    expect(overflow?.getAttribute("tabindex")).toBe("0");
    act(() => (overflow as HTMLElement).click());
    expect(onOpen).not.toHaveBeenCalled();
    act(() => {
      (overflow as HTMLElement).focus();
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe("operations, sales/enterprise");
    act(() => {
      overflow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.activeElement).toBe(overflow);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe("ListView grouped rhythm", () => {
  const labels: LabelVM[] = [
    { path: "marketing", displayName: "Marketing", color: "oklch(0.55 0.13 300)", icon: "megaphone" },
    { path: "marketing/reporting", displayName: "Reporting", color: null, icon: "layers" },
    { path: "marketing/seo", displayName: "SEO", color: null, icon: "globe" },
    { path: "operations", displayName: "Operations", color: "oklch(0.55 0.13 24)", icon: "rocket" },
  ];

  it("renders flat root sections, deduplicates within a root, and repeats between roots", () => {
    const html = render(
      [skill({ id: "digest", labels: ["marketing", "marketing/reporting", "marketing/seo", "operations"] })],
      { labels, groupBy: "folder" },
    );

    expect(html).toContain('<span class="cgroup__name">Marketing</span>');
    expect(html).toContain('<span class="cgroup__name">Operations</span>');
    expect(html.match(/data-skill-slug="digest"/g)).toHaveLength(2);
    expect(html).toContain('class="crow crow--subfolder"');
    expect(html).toContain('aria-label="Subfolders"');
    expect(html).toContain('aria-label="Subfolder: marketing/reporting"');
    expect(html).toContain('aria-label="Subfolder: marketing/seo"');
    expect(html).toContain('<span class="crow__labeltext">Reporting</span>');
    expect(html).toContain('<span class="crow__labeltext">SEO</span>');
  });

  it("puts installed and unfiled personal skills in dedicated trailing groups", () => {
    const html = render(
      [
        skill({ id: "filed", scope: "personal", source: "authored", labels: ["marketing"] }),
        skill({ id: "installed", source: "installed" }),
        skill({ id: "loose", scope: "personal", source: "authored" }),
      ],
      { labels, groupBy: "folder", library: "mine" },
    );

    expect(html.indexOf(">Marketing<")).toBeLessThan(html.indexOf(">Installed<"));
    expect(html.indexOf(">Installed<")).toBeLessThan(html.indexOf(">Without folder<"));
  });

  it("offers an accessible grouped/flat toggle", async () => {
    const onGroupByChange = vi.fn();
    const container = await mount([skill()], { groupBy: "folder", onGroupByChange });
    const grouped = container.querySelector('button[aria-pressed="true"]') as HTMLButtonElement;
    const flat = Array.from(container.querySelectorAll(".listbar__group button")).find(
      (button) => button.textContent === "Flat",
    ) as HTMLButtonElement;

    expect(grouped.textContent).toBe("Grouped");
    act(() => flat.click());
    expect(onGroupByChange).toHaveBeenCalledWith("none");
  });

  it("persists collapsed roots locally and temporarily reveals matches during search", async () => {
    const container = await mount([skill({ id: "digest", labels: ["marketing/seo"] })], {
      labels,
      groupBy: "folder",
    });
    const toggle = container.querySelector(".cgroup__toggle") as HTMLButtonElement;

    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".cgroup__rows")?.hasAttribute("hidden")).toBe(true);
    expect(window.localStorage.getItem("companion:skills:collapsed-groups:v1:org-1:org")).toBe(
      '["folder:marketing"]',
    );

    setInputValue(container.querySelector('input[type="search"]') as HTMLInputElement, "digest");
    expect(container.querySelector(".cgroup__rows")?.hasAttribute("hidden")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(window.localStorage.getItem("companion:skills:collapsed-groups:v1:org-1:org")).toBe(
      '["folder:marketing"]',
    );
    expect(toggle.disabled).toBe(true);

    act(() => toggle.click());
    expect(window.localStorage.getItem("companion:skills:collapsed-groups:v1:org-1:org")).toBe(
      '["folder:marketing"]',
    );

    setInputValue(container.querySelector('input[type="search"]') as HTMLInputElement, "");
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".cgroup__rows")?.hasAttribute("hidden")).toBe(true);
  });

  it("uses canonical subfolder paths for identity while keeping aliases compact", () => {
    const html = render(
      [skill({ labels: ["marketing/seo-content", "marketing/seo-technical"] })],
      {
        groupBy: "folder",
        labels: [
          { path: "marketing", displayName: "Marketing", color: null, icon: null },
          { path: "marketing/seo-content", displayName: "SEO", color: null, icon: null },
          { path: "marketing/seo-technical", displayName: "SEO", color: null, icon: null },
        ],
      },
    );

    expect(html).toContain('title="marketing/seo-content"');
    expect(html).toContain('title="marketing/seo-technical"');
    expect(html.match(/class="crow__labeltext">SEO/g)).toHaveLength(2);
  });
});

describe("ListView contributors", () => {
  it("renders the creator-first people stack, overflow count, and mobile metadata", () => {
    const html = render([
      skill({
        modifiers: [
          { id: "user-2", name: "Grace Hopper", initials: "GH", avatarUrl: null },
          { id: "user-3", name: "Hedy Lamarr", initials: "HL", avatarUrl: null },
          { id: "user-4", name: "Katherine Johnson", initials: "KJ", avatarUrl: null },
          { id: "user-5", name: "Margaret Hamilton", initials: "MH", avatarUrl: null },
          { id: "user-6", name: "Joan Clarke", initials: "JC", avatarUrl: null },
        ],
      }),
    ]);

    expect(html).toContain("People");
    expect(html).toContain("people__avatar--creator");
    expect(html).toContain("AL");
    expect(html).toContain("people__more");
    expect(html).toContain("2</span>");
    expect(html).toContain(
      "Created by Ada Lovelace. Updated by Grace Hopper, Hedy Lamarr, Katherine Johnson, Margaret Hamilton, Joan Clarke.",
    );
    expect(html).toContain("crow__mobilemeta");
    expect(html).not.toContain("vdot--ok");
    expect(html).not.toContain("Most starred");
    expect(html).not.toContain(">Stars<");
  });

  it("keeps non-valid states explicit", () => {
    const html = render([
      skill({ id: "broken-skill", validation: "invalid" }),
      skill({ id: "pending-skill", validation: "validating" }),
    ]);

    expect(html).toContain("invalid");
    expect(html).toContain("validating");
    expect(html).toContain("invalid-pill--pending");
    expect(html).not.toContain("Install skill broken-skill");
    expect(html).not.toContain("Install skill pending-skill");
  });

  it("uses the contextual action matrix for compact row CTAs", () => {
    const html = render([
      skill({ id: "fresh" }),
      skill({ id: "current", installStatus: "installed", installedVersion: "1.0.0" }),
      skill({ id: "outdated", installStatus: "update", installedVersion: "0.9.0" }),
      skill({ id: "personal", scope: "personal", source: "authored" }),
    ]);

    expect(html).toContain('aria-label="Install skill fresh"');
    expect(html).toContain('<span class="rowact__label">Install</span>');
    expect(html).not.toContain('<span class="rowact__label">Install skill</span>');
    expect(html).not.toContain('aria-label="Install skill current"');
    expect(html).toContain('aria-label="Update skill outdated"');
    expect(html).toContain('title="Update skill"');
    expect(html).toContain('<span class="rowact__label">Update</span>');
    expect(html).not.toContain('<span class="rowact__label">Update skill</span>');
    expect(html).toContain('aria-label="Share to organization personal"');
  });
});
