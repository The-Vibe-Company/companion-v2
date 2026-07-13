import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MeVM, SkillVM } from "@/lib/types";
import { DetailView } from "./DetailView";

const me: MeVM = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", initials: "AL", avatarUrl: null };

const skill: SkillVM = {
  uuid: "skill-1",
  id: "linear-demo",
  shareToken: "share-linear-demo",
  version: "1.2.3",
  validation: "valid",
  description: "A focused skill for incident handoffs.",
  notes: null,
  error: null,
  scope: "org",
  source: null,
  labels: ["marketing/seo"],
  authorId: "user-1",
  authorName: "Ada Lovelace",
  authorInitials: "AL",
  authorAvatarUrl: null,
  updaterId: "user-1",
  updaterName: "Ada Lovelace",
  updaterInitials: "AL",
  updaterAvatarUrl: null,
  modifiers: [],
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
  requiresCount: 1,
  usedByCount: 2,
  depWarn: false,
  archived: false,
};

function renderDetailFor(nextSkill: SkillVM) {
  return renderToString(
    React.createElement(DetailView, {
      skill: nextSkill,
      index: 0,
      total: 1,
      me,
      orgName: "The Vibe Company",
      allLabels: ["marketing", "marketing/seo", "growth"],
      onBack: vi.fn(),
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onToggleStar: vi.fn(),
      onToggleLabel: vi.fn(),
      onSelectLabel: vi.fn(),
      onAction: vi.fn(),
      onOpenSkill: vi.fn(),
      onOpenRun: vi.fn(),
    }),
  );
}

function renderDetail() {
  return renderDetailFor(skill);
}

describe("DetailView tabbed detail layout", () => {
  it("renders the head facts, the filed folders, and the tab bar", () => {
    const html = renderDetail();

    expect(html).toContain("linear-demo");
    expect(html).toContain("A focused skill for incident handoffs.");
    expect(html).not.toContain("statuscard");
    // Author provenance byline.
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Filed in");
    expect(html).toContain("marketing/seo");
    expect(html).toContain("Add to folder");
    expect(html).not.toContain("Copy public link");
    expect(html).not.toContain("dsharebtn");
    // Tab bar: Files / Dependencies / Activity / Discussion are tabs; the Overview
    // tab carries the Manifest section and optional notes.
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="dtab-overview"');
    expect(html).toContain('id="dtab-files"');
    expect(html).toContain('id="dtab-dependencies"');
    expect(html).toContain('id="dtab-activity"');
    expect(html).toContain('id="dtab-discussion"');
    expect(html).toContain("Manifest");
    expect(html).not.toContain("What it does");
    // The single-column doc replaces the old rail + slide-in panel chrome.
    expect(html).not.toContain("dsidebar--linear");
    expect(html).not.toContain("dpanel__nav");
    expect(html).not.toContain("More sections");
    // No owner / visibility axis on the detail anymore.
    expect(html).not.toContain("Personal");
  });

  it("shows both 'Created by' and 'Updated by' in the byline when the last updater differs", () => {
    const html = renderDetailFor({
      ...skill,
      authorName: "Ada Lovelace",
      updaterId: "user-2",
      updaterName: "Beth Updater",
      updaterInitials: "BU",
    });

    expect(html).toContain("Created by");
    expect(html).toContain("Ada Lovelace"); // creator
    expect(html).toContain("Beth Updater"); // last updater
    // The byline carries two named people (creator + updater) via `.dbyline__name`.
    expect((html.match(/dbyline__name/g) ?? []).length).toBe(2);
  });

  it("byline names only the creator when the updater is the creator", () => {
    // The shared fixture has updaterId === authorId, so the byline collapses to a single name.
    const html = renderDetail();

    expect(html).toContain("Created by");
    expect((html.match(/dbyline__name/g) ?? []).length).toBe(1);
  });

  it("does not expose a public copy action for personal skills", () => {
    const html = renderDetailFor({ ...skill, scope: "personal" });

    expect(html).not.toContain("Copy public link");
    expect(html).toContain("Share to organization");
  });

  it("hides installation CTAs for current, invalid, validating, and unpublished skills", () => {
    expect(renderDetailFor(skill)).not.toContain("Install skill");
    expect(renderDetailFor({ ...skill, installStatus: "none", installedVersion: null, validation: "invalid" })).not.toContain("Install skill");
    expect(renderDetailFor({ ...skill, installStatus: "none", installedVersion: null, validation: "validating" })).not.toContain("Install skill");
    expect(renderDetailFor({ ...skill, installStatus: "none", installedVersion: null, version: null })).not.toContain("Install skill");
  });

  it("uses a contextual Update label while keeping the explicit accessible name", () => {
    const html = renderDetailFor({ ...skill, installStatus: "update", installedVersion: "1.1.0" });
    expect(html).toContain('aria-label="Update skill"');
    expect(html).toContain('title="Update skill"');
    expect(html).toMatch(/class="btn-primary"[^>]*>[\s\S]*?<\/svg>Update<\/button>/);
    expect(html).not.toMatch(/<\/svg>Update skill<\/button>/);
    expect(html).not.toContain("Install skill");
  });

  it("uses a contextual Install label while keeping the explicit accessible name", () => {
    const html = renderDetailFor({ ...skill, installStatus: "none", installedVersion: null });
    expect(html).toContain('aria-label="Install skill"');
    expect(html).toContain('title="Install skill"');
    expect(html).toMatch(/class="btn-primary"[^>]*>[\s\S]*?<\/svg>Install<\/button>/);
    expect(html).not.toMatch(/<\/svg>Install skill<\/button>/);
  });

  it("prefers Companion title and summary for the detail title and lead", () => {
    const html = renderDetailFor({
      ...skill,
      display: {
        name: "Incident summary",
        summary: "Short listing summary.",
        description: "Long human-readable setup and capability description.",
      },
    });

    expect(html).toContain("Incident summary");
    expect(html).toContain("Short listing summary.");
    expect(html).not.toContain("Long human-readable setup and capability description.");
    expect(html).not.toContain("A focused skill for incident handoffs.");
  });

  it("renders Manifest V2 notes as markdown and strips a redundant opening heading", () => {
    const html = renderDetailFor({
      ...skill,
      description: "Short registry description.",
      notes:
        "## What it does Mega Code Review reviews changes.\n\n## Safety model\n\n- Read-only review by default.\n\nUse `review.md`.",
    });

    expect(html).toContain("Short registry description.");
    expect(html).toContain("Notes");
    expect(html).not.toContain("What it does");
    expect(html).toContain('<p class="md-p">Mega Code Review reviews changes.</p>');
    expect(html).toContain('<h3 id="safety-model" class="md-h md-h2">Safety model</h3>');
    expect(html).toContain('<ul class="md-ul">');
    expect(html).toContain("<code>review.md</code>");
  });

  it("strips only one redundant opening notes heading", () => {
    const html = renderDetailFor({
      ...skill,
      notes: "## What it does\n\n## What it has\n\n- A real inventory section.",
    });

    expect(html).not.toContain("What it does");
    expect(html).toContain("What it has");
    expect(html).toContain("A real inventory section.");
  });

  it("omits the Notes section when notes are absent", () => {
    const html = renderDetailFor({ ...skill, notes: null });
    expect(html).not.toContain("Notes");
  });

  it("shows an empty filed-in state when the skill is in no folders", () => {
    const html = renderDetailFor({ ...skill, labels: [] });
    expect(html).toContain("No folders yet");
    expect(html).toContain("Add to folder");
  });

  it("renders the Setup & secrets section header once when requirements exist", () => {
    const html = renderDetail();

    // The section header provides the only "Setup & secrets" label (no doubled title in the body).
    const matches = html.match(/Setup &amp; secrets/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("omits the Setup & secrets and Dependencies sections when there is nothing to show", () => {
    const html = renderDetailFor({
      ...skill,
      requirements: [],
      requiresCount: 0,
      usedByCount: 0,
    });

    expect(html).not.toContain("Setup &amp; secrets");
    // With no deps the Dependencies tab is dropped; Files stays and the Overview
    // keeps its Manifest section.
    expect(html).not.toContain('id="dtab-dependencies"');
    expect(html).toContain('id="dtab-files"');
    expect(html).toContain("Manifest");
  });

  it("exposes Files as a tab and does not eagerly render the explorer in Overview", () => {
    const html = renderDetail();

    // The file explorer lives behind the Files tab; only the active (Overview)
    // tabpanel is rendered server-side, so the explorer markup is absent here.
    // Every tab points aria-controls at the one stable panel id (the active panel),
    // so no tab references a missing element.
    expect(html).toContain('id="dtab-files"');
    expect(html).toContain('aria-controls="skill-detail-panel"');
    expect(html).toContain('id="skill-detail-panel"');
    expect(html).toContain('aria-labelledby="dtab-overview"');
    expect(html).not.toContain("No files in this package.");
  });
});

describe("Run skill (sandboxed sessions)", () => {
  it("renders the Sessions tab and an enabled Run skill button for a published, valid skill", () => {
    const html = renderDetail();
    expect(html).toContain("dtab-sessions");
    expect(html).toContain("Sessions");
    expect(html).toContain("Run skill");
    // Enabled: no disabled attribute between the button's title and its label.
    expect(html).toContain("Run this skill in a sandboxed session");
  });

  it("disables Run skill when the skill has no published version", () => {
    const html = renderDetailFor({ ...skill, version: null, installStatus: "none", installedVersion: null });
    expect(html).toContain("Run skill");
    expect(html).toContain("No published version yet");
  });

  it("disables Run skill on an invalid skill", () => {
    const html = renderDetailFor({ ...skill, validation: "invalid", error: "bad frontmatter" });
    expect(html).toContain("Run skill");
    expect(html).toContain("Resolve validation errors first");
  });

  it("hides Run skill on an archived skill", () => {
    const html = renderDetailFor({ ...skill, archived: true });
    expect(html).not.toContain("Run skill");
  });

  it("lands on the Sessions tab when initialTab requests it (Back from a run)", () => {
    const html = renderToString(
      React.createElement(DetailView, {
        skill,
        index: 0,
        total: 1,
        me,
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
        onOpenRun: vi.fn(),
        initialTab: "sessions",
      }),
    );
    // SSR renders only the active tabpanel. Data is intentionally unresolved during SSR, so the
    // recoverable private-session loading state proves that Sessions is the active tab.
    expect(html).toContain("Loading your private sessions");
  });
});
