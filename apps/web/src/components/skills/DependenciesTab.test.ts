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
    { slug: "log-parser", status: "satisfied", note: null, can_open: true },
    { slug: "html-sanitize", status: "missing", note: "not published to this workspace", can_open: false },
    { slug: "screenshot-grab", status: "archived", note: "publisher archived this skill", can_open: true },
    { slug: "granite-recall", status: "cycle", note: "granite-recall already requires web-archiver", can_open: true },
  ],
  used_by: [
    { slug: "ops-runbook", status: "satisfied", archived: false, note: null, can_open: true },
  ],
  requires_n: 4,
  used_by_n: 1,
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

  it("links openable requires and leaves missing ones as plain text", () => {
    const html = render(richGraph);
    expect(html).toContain(">log-parser<"); // openable → rendered inside an anchor
    expect(html).toContain("html-sanitize"); // missing → still shown
    expect(html).toContain("not published to this workspace");
  });

  it("shows an empty state when the skill declares no dependencies", () => {
    const html = render({ slug: "log-parser", version: "1.4.0", requires: [], used_by: [], requires_n: 0, used_by_n: 0 });
    expect(html).toContain("This skill declares no dependencies");
    expect(html).toContain("No other skill depends on this one yet");
  });
});
