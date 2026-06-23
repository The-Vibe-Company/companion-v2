import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LocalSkillRow } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";
import { DetailMoreMenuContent, DetailView } from "./DetailView";
import { LocalSkillDrawer } from "./LocalSkillsView";
import { UploadDialog } from "./UploadDialog";

const skill: SkillVM = {
  uuid: "skill-1",
  id: "research-agent",
  version: "1.2.3",
  validation: "valid",
  description: "Research helper.",
  error: null,
  labels: [],
  authorId: "user-1",
  authorName: "Alice Nardon",
  authorInitials: "AN",
  tools: ["read_file"],
  requirements: [],
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
  compatibility: null,
  metadata: {
    companion_skill_id: "skill-1",
    companion_version: "1.2.3",
  },
};

function localSkill(status: LocalSkillRow["status"]): LocalSkillRow {
  return {
    key: "companion",
    name: "Companion",
    description: "Manage skills locally.",
    status,
    installedVersion: status === "none" ? null : "1.0.0",
    availableVersion: status === "update" ? "1.1.0" : "1.0.0",
    lastReportedAt: null,
    agentLabel: null,
    what: "A local helper skill.",
    uses: "Installs and updates skills.",
    why: ["Keeps local skills current."],
    commands: [],
    changes: ["Refreshes the bundled helper."],
    prompts: {
      install: "install {base} {token}",
      update: "update {base} {token}",
      use: "use {base} {token}",
    },
  };
}

describe("skill update flow", () => {
  it("removes the visible Update button from the skill detail topbar", () => {
    const html = renderToString(
      React.createElement(DetailView, {
        skill,
        index: 0,
        total: 1,
        me: { id: "user-1", name: "Alice Nardon", email: "alice@example.com", initials: "AN" },
        myRole: "developer",
        allLabels: [],
        onBack: vi.fn(),
        onPrev: vi.fn(),
        onNext: vi.fn(),
        onToggleStar: vi.fn(),
        onToggleInstalled: vi.fn(),
        onToggleLabel: vi.fn(),
        onSelectLabel: vi.fn(),
        onInstall: vi.fn(),
        onUpdate: vi.fn(),
        onOpenSkill: vi.fn(),
        onRestore: vi.fn(),
        onArchive: vi.fn(),
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
        canArchive: true,
        installed: false,
        onToggleInstalled: vi.fn(),
        onUpdate: vi.fn(),
        onDownload: vi.fn(),
        onArchive: vi.fn(),
      }),
    );
    const readOnly = renderToString(
      React.createElement(DetailMoreMenuContent, {
        canModifySkill: false,
        canDownload: true,
        canArchive: false,
        installed: false,
        onToggleInstalled: vi.fn(),
        onUpdate: vi.fn(),
        onDownload: vi.fn(),
        onArchive: vi.fn(),
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

  it("shows reinstall only beside the local skill update prompt", () => {
    const update = renderToString(
      React.createElement(LocalSkillDrawer, {
        skill: localSkill("update"),
        onClose: vi.fn(),
      }),
    );
    const installed = renderToString(
      React.createElement(LocalSkillDrawer, {
        skill: localSkill("installed"),
        onClose: vi.fn(),
      }),
    );
    const fresh = renderToString(
      React.createElement(LocalSkillDrawer, {
        skill: localSkill("none"),
        onClose: vi.fn(),
      }),
    );

    expect(update).toContain("Copy update prompt");
    expect(update).toContain("Reinstall Skill?");
    expect(installed).not.toContain("Reinstall Skill?");
    expect(fresh).toContain("Copy install prompt");
    expect(fresh).not.toContain("Reinstall Skill?");
  });
});
