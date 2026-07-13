import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SkillVM } from "@/lib/types";
import { ListView } from "./ListView";

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
    stars: 0,
    starred: false,
    installStatus: "none",
    installedVersion: null,
    requiresCount: 0,
    usedByCount: 0,
    depWarn: false,
    archived: false,
    ...overrides,
  };
}

function render(skills: SkillVM[]) {
  return renderToString(
    React.createElement(ListView, {
      skills,
      library: "org",
      scopeKind: "all",
      breadcrumb: ["All skills"],
      onOpen: vi.fn(),
      onToggleStar: vi.fn(),
      onUpload: vi.fn(),
      actorId: "user-1",
      onPrimaryAction: vi.fn(),
      lastId: null,
      filters: [],
      onToggleFilter: vi.fn(),
      onRemoveFilter: vi.fn(),
      onClearFilters: vi.fn(),
      preferenceStatus: "idle",
      onRetryPreferences: vi.fn(),
      dragSkillId: null,
      onSkillStartDrag: vi.fn(),
    }),
  );
}

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
    expect(html).not.toContain('aria-label="Install skill current"');
    expect(html).toContain('aria-label="Update skill outdated"');
    expect(html).toContain('aria-label="Share to organization personal"');
  });
});
