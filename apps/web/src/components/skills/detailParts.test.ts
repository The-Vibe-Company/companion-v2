import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SkillVersionRow } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";
import { Activity, FiledIn, PropList, Requirements, StatusCard } from "./detailParts";

const skill: SkillVM = {
  uuid: "skill-1",
  id: "manifest-demo",
  shareToken: "share-manifest-demo",
  version: "1.2.3",
  validation: "valid",
  description: "Demo skill.",
  notes: null,
  error: null,
  scope: "org",
  source: null,
  labels: ["marketing", "marketing/seo"],
  authorId: "user-1",
  authorName: "Alice Nardon",
  authorInitials: "AN",
  authorAvatarUrl: null,
  updaterId: "user-1",
  updaterName: "Alice Nardon",
  updaterInitials: "AN",
  updaterAvatarUrl: null,
  tools: ["read_file"],
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

describe("PropList manifest rendering", () => {
  it("renders Agent Skills manifest fields without an owner row or registry version", () => {
    const html = renderToString(React.createElement(PropList, { skill }));
    expect(html).toContain("Compatibility");
    expect(html).toContain("Requires Python 3.14+ and uv with network access");
    expect(html).toContain("Allowed tools");
    expect(html).toContain("read_file");
    expect(html).toContain("License");
    expect(html).toContain("MIT");
    expect(html).toContain("Metadata");
    expect(html).toContain('title="companion_skill_id"');
    expect(html).toContain("skill id");
    expect(html).toContain('title="companion_version"');
    expect(html).toContain(">version</span>");
    expect(html).toContain("1.2.3");
    // No owner / visibility axis anymore.
    expect(html).not.toContain("Owner");
    expect(html).not.toContain("Personal");
    // Requirements live in their own tab, not the manifest rail.
    expect(html).not.toContain("AZURE_OPENAI_API_KEY");
  });
});

describe("FiledIn folder chips", () => {
  it("renders a chip per filed folder plus an Add to folder control", () => {
    const html = renderToString(
      React.createElement(FiledIn, {
        skill,
        allLabels: ["marketing", "marketing/seo", "growth"],
        onToggleLabel: vi.fn(),
        onSelectLabel: vi.fn(),
      }),
    );
    expect(html).toContain("Filed in");
    expect(html).toContain("marketing");
    expect(html).toContain("marketing/seo");
    expect(html).toContain("Add to folder");
  });

  it("shows an empty state when the skill is filed nowhere", () => {
    const html = renderToString(
      React.createElement(FiledIn, {
        skill: { ...skill, labels: [] },
        allLabels: ["growth"],
        onToggleLabel: vi.fn(),
        onSelectLabel: vi.fn(),
      }),
    );
    expect(html).toContain("No folders yet");
    expect(html).toContain("Add to folder");
  });
});

describe("StatusCard updated-by row", () => {
  it("renders an 'Updated by' row showing the last updater, distinct from the owner", () => {
    const html = renderToString(
      React.createElement(StatusCard, {
        skill: { ...skill, updaterId: "user-2", updaterName: "Beth Updater", updaterInitials: "BU" },
      }),
    );
    expect(html).toContain("Owner");
    expect(html).toContain("Alice Nardon"); // creator/owner
    expect(html).toContain("Updated by");
    expect(html).toContain("Beth Updater"); // last updater
  });
});

describe("Requirements section rendering", () => {
  it("lists declared secrets and env vars with their notes and badges", () => {
    const html = renderToString(React.createElement(Requirements, { requirements: skill.requirements }));
    // The enclosing collapsible Section now owns the "Setup & secrets" header, so the body itself
    // no longer repeats it.
    expect(html).not.toContain("Setup &amp; secrets");
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

function versionRow(overrides: Partial<SkillVersionRow>): SkillVersionRow {
  return {
    id: "version-1",
    skill_id: "skill-1",
    version: "1.2.0",
    note: "",
    changelog: null,
    frontmatter: "{}",
    tools: [],
    license: null,
    compatibility: null,
    metadata: {},
    display: {},
    requirements: [],
    size_bytes: 100,
    checksum: "sha256:" + "a".repeat(64),
    storage_path: "skill-archives/demo/1.2.0.tar.gz",
    validation: "valid",
    validation_error: null,
    created_by: "user-1",
    created_by_name: null,
    created_by_initials: null,
    created_by_avatar_url: null,
    created_at: "2026-06-25T10:00:00.000Z",
    ...overrides,
  };
}

describe("Activity changelog rendering", () => {
  it("renders the matching version changelog as compact change items", () => {
    const html = renderToString(
      React.createElement(Activity, {
        fallbackAuthor: { name: "Alice Nardon", initials: "AN", avatarUrl: null },
        versions: [
          versionRow({
            changelog: {
              version: "1.2.0",
              date: "2026-06-25",
              changes: ["Add changelog to Activity.", "Keep the timeline compact."],
            },
          }),
        ],
      }),
    );

    expect(html).toContain("Add changelog to Activity.");
    expect(html).toContain("Keep the timeline compact.");
    expect(html).toContain("act__changes");
  });

  it("falls back to the release note when no changelog entry exists", () => {
    const html = renderToString(
      React.createElement(Activity, {
        fallbackAuthor: { name: "Alice Nardon", initials: "AN", avatarUrl: null },
        versions: [versionRow({ id: "version-2", version: "1.1.0", note: "Manual release note." })],
      }),
    );

    expect(html).toContain("Manual release note.");
    expect(html).toContain("act__note");
  });
});
