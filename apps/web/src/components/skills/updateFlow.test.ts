import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LocalSkillRow } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";
import { DetailMoreMenuContent, DetailView } from "./DetailView";
import { LocalSkillDrawer, LocalSkillsView } from "./LocalSkillsView";
import { InstallDialog, UploadDialog } from "./UploadDialog";
import { SKILL_ACTIONS } from "./skillActions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

const skill: SkillVM = {
  uuid: "skill-1",
  id: "research-agent",
  shareToken: "share-research-agent",
  version: "1.2.3",
  validation: "valid",
  description: "Research helper.",
  notes: null,
  error: null,
  scope: "org",
  source: null,
  labels: [],
  authorId: "user-1",
  authorName: "Alice Nardon",
  authorInitials: "AN",
  authorAvatarUrl: null,
  updaterId: "user-1",
  updaterName: "Alice Nardon",
  updaterInitials: "AN",
  updaterAvatarUrl: null,
  modifiers: [],
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

function localSkill(status: LocalSkillRow["status"], overrides: Partial<LocalSkillRow> = {}): LocalSkillRow {
  return {
    workspaceId: "org-1",
    key: "companion",
    name: "Companion",
    description: "Manage skills locally.",
    status,
    installedVersion: status === "none" ? null : "1.0.0",
    availableVersion: status === "update" ? "1.1.0" : "1.0.0",
    lastReportedAt: null,
    agentLabel: null,
    notes: "A local helper skill.\n\n- Keeps local skills current.",
    commands: [],
    changes: ["Refreshes the bundled helper."],
    integrity: { packageChecksum: `sha256:${"a".repeat(64)}`, files: { "SKILL.md": `sha256:${"b".repeat(64)}` } },
    prompts: {
      install: "install {base} {workspaceId} {token}",
      update: "update {base} {workspaceId} {token}",
      use: "use {base} {workspaceId} {token}",
    },
    ...overrides,
  };
}

describe("skill update flow", () => {
  it("removes the visible Update button from the skill detail topbar", () => {
    const html = renderToString(
      React.createElement(DetailView, {
        skill,
        index: 0,
        total: 1,
        me: { id: "user-1", name: "Alice Nardon", email: "alice@example.com", initials: "AN", avatarUrl: null },
        orgName: "The Vibe Company",
        allLabels: [],
        onBack: vi.fn(),
        onPrev: vi.fn(),
        onNext: vi.fn(),
        onToggleStar: vi.fn(),
        onToggleLabel: vi.fn(),
        onSelectLabel: vi.fn(),
        onAction: vi.fn(),
        onOpenSkill: vi.fn(),
      }),
    );

    expect(html).not.toContain(">Update<");
    expect(html).toContain('aria-label="More actions"');
  });

  it("shows publish in the More menu only for users who can modify the skill", () => {
    const editable = renderToString(
      React.createElement(DetailMoreMenuContent, {
        actions: [SKILL_ACTIONS.download, SKILL_ACTIONS.publishVersion, SKILL_ACTIONS.archive],
        onAction: vi.fn(),
      }),
    );
    const readOnly = renderToString(
      React.createElement(DetailMoreMenuContent, {
        actions: [SKILL_ACTIONS.download],
        onAction: vi.fn(),
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

    expect(html).toContain("Use an AI assistant");
    expect(html).toContain("Upload package");
    expect(html).toContain("Create in browser");
    expect(html).toContain("Publish new version");
    expect(html).not.toContain("Update skill");
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

  it("uses Update skill only for installing the newest registry version", () => {
    const html = renderToString(
      React.createElement(InstallDialog, {
        skill: { ...skill, installStatus: "update", installedVersion: "1.1.0" },
        onClose: vi.fn(),
        onReported: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="Update skill"');
    expect(html).toContain("Use an AI assistant");
    expect(html).toContain("Download package");
    expect(html).not.toContain("Publish new version");
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
        workspaceId: "org-1",
        onClose: vi.fn(),
      }),
    );
    const installed = renderToString(
      React.createElement(LocalSkillDrawer, {
        skill: localSkill("installed"),
        workspaceId: "org-1",
        onClose: vi.fn(),
      }),
    );
    const fresh = renderToString(
      React.createElement(LocalSkillDrawer, {
        skill: localSkill("none"),
        workspaceId: "org-1",
        onClose: vi.fn(),
      }),
    );

    expect(update).toContain("Copy update prompt");
    expect(update).toContain("Reinstall Skill?");
    expect(installed).not.toContain("Reinstall Skill?");
    expect(fresh).toContain("Copy install prompt");
    expect(fresh).not.toContain("Reinstall Skill?");
  });

  it("uses the canonical companion local skill instead of the first row", () => {
    const html = renderToString(
      React.createElement(LocalSkillsView, {
        workspaceId: "org-1",
        workspaceName: "Acme",
        skills: [
          localSkill("none", { key: "other-helper", name: "Other helper", description: "Wrong row." }),
          localSkill("installed"),
        ],
      }),
    );

    expect(html).toContain("Companion");
    expect(html).toContain("companion");
    expect(html).not.toContain("Other helper");
    expect(html).not.toContain("other-helper");
  });
});
