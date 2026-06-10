import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SkillVM } from "@/lib/types";
import { PropList } from "./detailParts";

const skill: SkillVM = {
  uuid: "skill-1",
  id: "manifest-demo",
  ownerId: "user-1",
  scope: "team",
  version: "1.2.3",
  validation: "valid",
  description: "Demo skill.",
  error: null,
  owner: { name: "Alice Nardon", initials: "AN", handle: "alice", team: null },
  tools: ["read_file"],
  size: "1 KB",
  license: "MIT",
  checksum: "sha256:abc",
  created: "2026-06-09",
  updated: "just now",
  stars: 0,
  starred: false,
  team: "Engineering",
  teamSlug: "engineering",
  compatibility: "Requires Python 3.14+ and uv with network access",
  metadata: {
    companion_skill_id: "skill-1",
    companion_version: "1.2.3",
  },
};

describe("PropList manifest rendering", () => {
  it("renders Agent Skills manifest fields without treating registry version as manifest data", () => {
    const html = renderToString(
      React.createElement(PropList, {
        skill,
        onChangeVisibility: vi.fn(),
      }),
    );
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
  });
});
