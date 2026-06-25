import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SkillVM } from "@/lib/types";
import { FiledIn, PropList, Requirements } from "./detailParts";

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
