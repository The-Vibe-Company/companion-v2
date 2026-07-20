import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SkillVM } from "@/lib/types";
import { ArchivedListView } from "./ArchivedListView";

const archivedSkill: SkillVM = {
  uuid: "skill-1",
  id: "archived-demo",
  shareToken: "share-archived-demo",
  version: "1.0.0",
  validation: "valid",
  description: "Archived demo.",
  notes: null,
  error: null,
  scope: "org",
  source: null,
  labels: [],
  authorId: "user-1",
  authorName: "Ada",
  authorInitials: "A",
  authorAvatarUrl: null,
  updaterId: "user-1",
  updaterName: "Ada",
  updaterInitials: "A",
  updaterAvatarUrl: null,
  modifiers: [],
  tools: [],
  requirements: [],
  compatibility: null,
  metadata: {},
  size: "1 KB",
  license: null,
  checksum: null,
  created: "Jun 1, 2026",
  updated: "just now",
  installStatus: "none",
  installedVersion: null,
  requiresCount: 0,
  usedByCount: 0,
  depWarn: false,
  archived: true,
};

describe("ArchivedListView", () => {
  it("uses a contextual Restore label while keeping the explicit row action name", () => {
    const html = renderToString(
      React.createElement(ArchivedListView, {
        skills: [archivedSkill],
        onOpen: vi.fn(),
        onUpload: vi.fn(),
        actorId: "user-1",
        onPrimaryAction: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="Restore skill archived-demo"');
    expect(html).toContain('title="Restore skill"');
    expect(html).toMatch(/aria-label="Restore skill archived-demo"[\s\S]*?<\/svg>Restore<\/button>/);
    expect(html).not.toMatch(/<\/svg>Restore skill<\/button>/);
  });
});
