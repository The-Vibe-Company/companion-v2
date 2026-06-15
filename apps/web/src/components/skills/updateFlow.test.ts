import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SkillVM, TeamVM } from "@/lib/types";
import { DetailMoreMenuContent, DetailView } from "./DetailView";
import { UploadDialog } from "./UploadDialog";

const teams: TeamVM[] = [{ id: "engineering", name: "Engineering", initial: "EN", role: "editor", dbId: "team-1" }];

const skill: SkillVM = {
  uuid: "skill-1",
  id: "research-agent",
  ownerId: "user-1",
  visibility: { everyone: false, teams: [{ id: "team-1", slug: "engineering", name: "Engineering" }] },
  version: "1.2.3",
  validation: "valid",
  description: "Research helper.",
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
  size: "1 KB",
  license: "MIT",
  checksum: "sha256:abc",
  created: "2026-06-09",
  updated: "just now",
  stars: 0,
  starred: false,
  teams: [{ id: "team-1", slug: "engineering", name: "Engineering" }],
  teamSlugs: ["engineering"],
  compatibility: null,
  metadata: {
    companion_skill_id: "skill-1",
    companion_version: "1.2.3",
  },
};

describe("skill update flow", () => {
  it("removes the visible Update button from the skill detail topbar", () => {
    const html = renderToString(
      React.createElement(DetailView, {
        skill,
        index: 0,
        total: 1,
        me: { id: "user-1", name: "Alice Nardon", email: "alice@example.com", initials: "AN" },
        myRole: "developer",
        onBack: vi.fn(),
        onPrev: vi.fn(),
        onNext: vi.fn(),
        onToggleStar: vi.fn(),
        onChangeVisibility: vi.fn(),
        onInstall: vi.fn(),
        onUpdate: vi.fn(),
        teams,
      }),
    );

    expect(html).not.toContain(">Update<");
    expect(html).toContain('aria-label="More actions"');
  });

  it("shows publish in the More menu only for users who can modify the skill", () => {
    const editable = renderToString(
      React.createElement(DetailMoreMenuContent, {
        canModifySkill: true,
        canDownload: true,
        onUpdate: vi.fn(),
        onDownload: vi.fn(),
      }),
    );
    const readOnly = renderToString(
      React.createElement(DetailMoreMenuContent, {
        canModifySkill: false,
        canDownload: true,
        onUpdate: vi.fn(),
        onDownload: vi.fn(),
      }),
    );

    expect(editable).toContain("Publish new version");
    expect(readOnly).not.toContain("Publish new version");
    expect(readOnly).toContain("Download package");
  });

  it("renders update as assistant/package/browser flows without command-line copy", () => {
    const html = renderToString(
      React.createElement(UploadDialog, {
        mode: "update",
        skill,
        teams,
        onClose: vi.fn(),
        onPublished: vi.fn(),
      }),
    );

    expect(html).toContain("Assistant IA");
    expect(html).toContain("Upload a package");
    expect(html).toContain("Edit in the browser");
    expect(html).toContain("Validation endpoint");
    expect(html).toContain("Publish endpoint");
    expect(html).toContain("action=validate");
    expect(html).toContain("expect_skill_id=skill-1");
    expect(html).toContain("metadata.companion_skill_id");
    expect(html).toContain("do not edit the package and do not publish");
    expect(html).toContain("this appears to be a different skill");
    expect(html).toContain("Never publish after failed validation or ambiguous identity");
    expect(html).not.toContain("Command line");
    expect(html).not.toContain("companion CLI");
  });

  it("renders create prompt with validation before publish", () => {
    const html = renderToString(
      React.createElement(UploadDialog, {
        teams,
        onClose: vi.fn(),
        onPublished: vi.fn(),
      }),
    );

    expect(html).toContain("Validation endpoint");
    expect(html).toContain("Publish endpoint");
    expect(html).toContain("action=validate");
    expect(html).toContain("Validate first");
    expect(html).toContain("Publish only after validation is accepted");
  });
});
