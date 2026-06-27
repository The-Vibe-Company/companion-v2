import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SkillDependenciesResponse } from "@companion/contracts";
import { DependenciesTab } from "./DependenciesTab";

function render(deps: SkillDependenciesResponse | null) {
  return renderToString(
    React.createElement(DependenciesTab, {
      slug: "web-archiver",
      version: "0.4.2",
      deps,
      onOpenSkill: vi.fn(),
    }),
  );
}

const richGraph: SkillDependenciesResponse = {
  slug: "web-archiver",
  version: "0.4.2",
  requires: [
    {
      slug: "log-parser",
      status: "satisfied",
      note: null,
      can_open: true,
      version: "1.2.0",
      install_status: "update",
      installed_version: "1.1.0",
      depth: 0,
      via: null,
    },
    {
      slug: "html-sanitize",
      status: "missing",
      note: "not published to this workspace",
      can_open: false,
      version: null,
      install_status: "none",
      installed_version: null,
      depth: 0,
      via: null,
    },
    {
      slug: "screenshot-grab",
      status: "archived",
      note: "publisher archived this skill",
      can_open: true,
      version: "0.8.0",
      install_status: "installed",
      installed_version: "0.8.0",
      depth: 0,
      via: null,
    },
    {
      slug: "granite-recall",
      status: "cycle",
      note: "granite-recall already requires web-archiver",
      can_open: true,
      version: "2.0.0",
      install_status: "none",
      installed_version: null,
      depth: 0,
      via: null,
    },
  ],
  transitive: [
    {
      slug: "shared-helper",
      status: "satisfied",
      note: null,
      can_open: true,
      version: "3.0.0",
      install_status: "update",
      installed_version: "2.5.0",
      depth: 2,
      via: "log-parser",
    },
  ],
  used_by: [
    { slug: "ops-runbook", status: "satisfied", archived: false, note: null, can_open: true },
  ],
  requires_n: 4,
  transitive_n: 1,
  used_by_n: 1,
  updates_n: 2,
};

describe("DependenciesTab", () => {
  it("renders every dependency status badge", () => {
    const html = render(richGraph);
    expect(html).toContain("Satisfied");
    expect(html).toContain("Missing");
    expect(html).toContain("Archived");
    expect(html).toContain("Cycle blocked");
    // A cycle row is flagged as blocked.
    expect(html).toContain("dprow--blocked");
    // The legend is present.
    expect(html).toContain("deplegend");
  });

  it("shows versions, update signals, and transitive dependency provenance", () => {
    const html = render(richGraph);
    expect(html).toContain("dpver");
    expect(html).toContain("1.2.0");
    expect(html).toContain("Update available");
    expect(html).toContain("dpbehind");
    expect(html).toContain("1.1.0");
    expect(html).toContain('<span class="n">2</span>');
    expect(html).toContain("updates available");
    expect(html).toContain("depbanner--warn");
    expect(html).toContain("Also pulls in");
    expect(html).toContain("shared-helper");
    expect(html).toContain("dprow--via");
    expect(html).toContain("dpvia");
    expect(html).toContain("log-parser");
  });

  it("links openable requires and leaves missing ones as plain text", () => {
    const html = render(richGraph);
    expect(html).toContain(">log-parser<"); // openable → rendered inside an anchor
    expect(html).toContain("html-sanitize"); // missing → still shown
    expect(html).toContain("not published to this workspace");
  });

  it("shows an empty state when the skill declares no dependencies", () => {
    const html = render({
      slug: "log-parser",
      version: "1.4.0",
      requires: [],
      transitive: [],
      used_by: [],
      requires_n: 0,
      transitive_n: 0,
      used_by_n: 0,
      updates_n: 0,
    });
    expect(html).toContain("This skill declares no dependencies");
    expect(html).toContain("This skill&#x27;s dependencies pull in nothing further");
    expect(html).toContain("No other skill depends on this one yet");
  });
});
