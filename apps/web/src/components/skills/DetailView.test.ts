import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MeVM, SkillVM, TeamVM } from "@/lib/types";
import { DetailView } from "./DetailView";

const me: MeVM = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", initials: "AL" };
const teams: TeamVM[] = [
  { id: "engineering", dbId: "team-1", name: "Engineering", initial: "E", color: null, icon: null, role: "editor" },
];

const skill: SkillVM = {
  uuid: "skill-1",
  id: "linear-demo",
  ownerId: "user-1",
  visibility: { everyone: true, teams: [] },
  version: "1.2.3",
  validation: "valid",
  description: "A focused skill for incident handoffs.",
  error: null,
  owner: {
    kind: "user",
    id: "user-1",
    userId: "user-1",
    teamId: null,
    name: "Ada Lovelace",
    initials: "AL",
    handle: "ada",
    team: null,
  },
  tools: ["read_file"],
  requirements: [{ key: "OPENAI_API_KEY", type: "secret", required: true, note: "Required for model calls." }],
  compatibility: "Requires Node.js 22+",
  metadata: { companion_version: "1.2.3" },
  size: "4 KB",
  license: "MIT",
  checksum: "sha256:abc",
  created: "Jun 1, 2026",
  updated: "just now",
  stars: 2,
  starred: true,
  installStatus: "installed",
  installedVersion: "1.2.3",
  teams: [],
  teamSlugs: [],
  requiresCount: 1,
  usedByCount: 2,
  depWarn: false,
  archived: false,
};

function renderDetail(initialPanel?: React.ComponentProps<typeof DetailView>["initialPanel"]) {
  return renderToString(
    React.createElement(DetailView, {
      skill,
      index: 0,
      total: 1,
      me,
      myRole: "owner",
      teams,
      onBack: vi.fn(),
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onToggleStar: vi.fn(),
      onToggleInstalled: vi.fn(),
      onChangeVisibility: vi.fn(),
      onChangeOwner: vi.fn(),
      onInstall: vi.fn(),
      onUpdate: vi.fn(),
      onOpenSkill: vi.fn(),
      onRestore: vi.fn(),
      onArchive: vi.fn(),
      initialPanel,
    }),
  );
}

function renderDetailFor(nextSkill: SkillVM) {
  return renderToString(
    React.createElement(DetailView, {
      skill: nextSkill,
      index: 0,
      total: 1,
      me,
      myRole: "owner",
      teams,
      onBack: vi.fn(),
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onToggleStar: vi.fn(),
      onToggleInstalled: vi.fn(),
      onChangeVisibility: vi.fn(),
      onChangeOwner: vi.fn(),
      onInstall: vi.fn(),
      onUpdate: vi.fn(),
      onOpenSkill: vi.fn(),
      onRestore: vi.fn(),
      onArchive: vi.fn(),
    }),
  );
}

describe("DetailView linear dense layout", () => {
  it("renders the essential skill facts and discussion by default", () => {
    const html = renderDetail();

    expect(html).toContain("linear-demo");
    expect(html).toContain("A focused skill for incident handoffs.");
    expect(html).toContain("Everyone");
    expect(html).toContain("1.2.3");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Dependencies: 1 required, 2 used by");
    expect(html).toContain("just now");
    expect(html).toContain("More");
    expect(html).toContain("Discussion");
    expect(html).toContain("dsidebar--linear");
    expect(html).toContain("lin-more--mobile");
  });

  it("prefers Companion display copy for the detail title and lead", () => {
    const html = renderDetailFor({
      ...skill,
      display: {
        name: "Incident summary",
        summary: "Short listing summary.",
        description: "Long human-readable setup and capability description.",
      },
    });

    expect(html).toContain("Incident summary");
    expect(html).toContain("Long human-readable setup and capability description.");
    expect(html).not.toContain("A focused skill for incident handoffs.");
  });

  it("keeps advanced sections behind rail entries instead of first-level tabs", () => {
    const html = renderDetail();

    expect(html).toContain("More");
    expect(html).toContain("Files");
    expect(html).toContain("Setup &amp; secrets");
    expect(html).toContain("Activity");
    expect(html).toContain("Manifest");
    expect(html).toContain("Checksum");
    expect(html).not.toContain("Skill detail sections");
    expect(html).not.toContain("Package contents");
    expect(html).not.toContain("Allowed tools");
    expect(html).not.toContain("OPENAI_API_KEY");
  });

  it("renders drawer navigation and marks the active More panel", () => {
    const html = renderDetail("files");

    expect(html).toContain('aria-label="Files"');
    expect(html).toContain('aria-label="More sections"');
    expect(html).toContain("dpanel__navitem is-active");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Dependencies");
    expect(html).toContain("Setup &amp; secrets");
    expect(html).toContain("Manifest");
    expect(html).toContain("Checksum");
  });

  it("shows the shared drawer navigation when Dependencies is open", () => {
    const html = renderDetail("dependencies");

    expect(html).toContain('aria-label="Dependencies"');
    expect(html).toContain('aria-label="More sections"');
    expect(html).toContain("dpanel__navitem is-active");
    expect(html).toContain("Files");
    expect(html).toContain("Checksum");
  });

  it("renders the Files panel through the drawer-aware file explorer", () => {
    const html = renderDetail("files");

    expect(html).toContain("fx fx--panel");
    expect(html).toContain("No files in this package.");
  });
});
