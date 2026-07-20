// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillVM } from "@/lib/types";
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

function props(skills: SkillVM[], overrides: { onOpen?: (id: string) => void } = {}) {
  return {
    skills,
    library: "org" as const,
    scopeKind: "all" as const,
    breadcrumb: ["All skills"],
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

function render(skills: SkillVM[]) {
  return renderToString(React.createElement(ListView, props(skills)));
}

async function mount(skills: SkillVM[], overrides: { onOpen?: (id: string) => void } = {}) {
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
});

describe("ListView names and discovery", () => {
  it("renders the display title and removes description, version, and dependency metadata", () => {
    const html = render([
      skill({
        id: "incident-summary",
        display: { name: "Incident Summary" },
        description: "Unique description preview",
        version: "9.8.7",
        requiresCount: 37,
      }),
    ]);

    expect(html).toContain('<span class="crow__title">Incident Summary</span>');
    expect(html).toContain('data-skill-slug="incident-summary"');
    expect(html).toContain('aria-label="Open skill Incident Summary"');
    expect(html).toContain('aria-label="Install skill Incident Summary"');
    expect(html).not.toContain('<span class="crow__slug"');
    expect(html).not.toContain("Unique description preview");
    expect(html).not.toContain("9.8.7");
    expect(html).not.toContain(">Version<");
    expect(html).not.toContain(">Deps<");
    expect(html).not.toContain("depspill");
  });

  it("falls back to the slug when a skill has no display title", () => {
    const html = render([
      skill({ id: "seo-helper", display: {} }),
      skill({ id: "blank-title", display: { name: "   " } }),
    ]);

    expect(html).toContain('<span class="crow__title">seo-helper</span>');
    expect(html).toContain('aria-label="Open skill seo-helper"');
    expect(html).toContain('<span class="crow__title">blank-title</span>');
    expect(html).toContain('aria-label="Open skill blank-title"');
  });

  it("disambiguates duplicate display titles with their unique slugs", () => {
    const html = render([
      skill({ id: "incident-summary", display: { name: "Incident Summary" } }),
      skill({ id: "incident-summary-legacy", display: { name: "incident summary" } }),
    ]);

    expect(html).toContain('<span class="crow__slug" title="incident-summary">incident-summary</span>');
    expect(html).toContain(
      '<span class="crow__slug" title="incident-summary-legacy">…nt-summary-legacy</span>',
    );
    expect(html).toContain('aria-label="Open skill Incident Summary (incident-summary)"');
    expect(html).toContain('aria-label="Install skill incident summary (incident-summary-legacy)"');
  });

  it("keeps the distinguishing tail visible for long duplicate slugs", () => {
    const html = render([
      skill({ id: "shared-very-long-prefix-production", display: { name: "Shared title" } }),
      skill({ id: "shared-very-long-prefix-staging", display: { name: "Shared title" } }),
    ]);

    expect(html).toContain(
      '<span class="crow__slug" title="shared-very-long-prefix-production">…prefix-production</span>',
    );
    expect(html).toContain(
      '<span class="crow__slug" title="shared-very-long-prefix-staging">…ng-prefix-staging</span>',
    );
  });

  it("searches hidden slugs and descriptions as well as display titles", async () => {
    const container = await mount([
      skill({ id: "slug-needle", display: { name: "Zebra" }, description: "First description" }),
      skill({ id: "second", display: { name: "Alpha Needle" }, description: "Second description" }),
      skill({ id: "third", display: { name: "Gamma" }, description: "Hidden description needle" }),
    ]);
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;

    setInputValue(input, "slug-needle");
    expect(Array.from(container.querySelectorAll(".crow__title"), (node) => node.textContent)).toEqual(["Zebra"]);

    setInputValue(input, "alpha needle");
    expect(Array.from(container.querySelectorAll(".crow__title"), (node) => node.textContent)).toEqual(["Alpha Needle"]);

    setInputValue(input, "hidden description");
    expect(Array.from(container.querySelectorAll(".crow__title"), (node) => node.textContent)).toEqual(["Gamma"]);
  });

  it("sorts A–Z by display title and still opens the skill by slug", async () => {
    const onOpen = vi.fn();
    const container = await mount(
      [
        skill({ id: "first-slug", display: { name: "Zulu" } }),
        skill({ id: "second-slug", display: { name: "Alpha" } }),
      ],
      { onOpen },
    );
    const select = container.querySelector('select[aria-label="Sort skills"]') as HTMLSelectElement;

    act(() => {
      select.value = "name";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(Array.from(container.querySelectorAll(".crow__title"), (node) => node.textContent)).toEqual(["Alpha", "Zulu"]);

    act(() => (container.querySelector('button[aria-label="Open skill Alpha"]') as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith("second-slug");
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
