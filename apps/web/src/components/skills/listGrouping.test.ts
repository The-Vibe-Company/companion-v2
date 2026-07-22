import { describe, expect, it } from "vitest";
import type { LabelVM } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";
import { groupSkillsByRoot, mostSpecificPaths, resolveSkillListIcon } from "./listGrouping";

function skill(id: string, overrides: Partial<SkillVM> = {}): SkillVM {
  return {
    uuid: `skill-${id}`,
    id,
    shareToken: `share-${id}`,
    version: "1.0.0",
    validation: "valid",
    description: "Test skill",
    display: {},
    icon: null,
    notes: null,
    error: null,
    scope: "org",
    source: null,
    labels: [],
    authorId: "user-1",
    authorName: "Ada",
    authorInitials: "A",
    authorAvatarUrl: null,
    updaterId: "user-1",
    updaterName: "Ada",
    updaterInitials: "A",
    updaterAvatarUrl: null,
    modifiers: [],
    tools: [],
    requirements: [],
    compatibility: null,
    metadata: {},
    size: "1 KB",
    license: null,
    checksum: null,
    created: "Jun 1, 2026",
    updated: "just now",
    installStatus: "none",
    installedVersion: null,
    requiresCount: 0,
    usedByCount: 0,
    depWarn: false,
    archived: false,
    ...overrides,
  };
}

const labels: LabelVM[] = [
  { path: "marketing", displayName: "Marketing", color: "oklch(0.55 0.13 300)", icon: "megaphone" },
  { path: "marketing/reporting", displayName: "Reporting", color: null, icon: "layers" },
  { path: "marketing/reporting/weekly", displayName: "Weekly", color: "oklch(0.54 0.10 168)", icon: "bookmark" },
  { path: "marketing/seo", displayName: "SEO", color: null, icon: "globe" },
  { path: "operations", displayName: "Operations", color: "oklch(0.55 0.13 24)", icon: "rocket" },
];

describe("skill list grouping", () => {
  it("keeps only the most-specific paths within a branch", () => {
    expect(mostSpecificPaths(["marketing", "marketing/reporting", "marketing/reporting/weekly", "operations"]))
      .toEqual(["marketing/reporting/weekly", "operations"]);
  });

  it("deduplicates a skill inside one root and repeats it across distinct roots", () => {
    const groups = groupSkillsByRoot([
      skill("digest", { labels: ["marketing", "marketing/reporting", "marketing/seo", "operations"] }),
    ], labels, "org");

    expect(groups.map((group) => (group.kind === "direct" ? null : group.label))).toEqual([
      "Marketing",
      "Operations",
    ]);
    expect(groups[0]?.rows).toHaveLength(1);
    expect(groups[0]?.rows[0]?.relativePaths).toEqual([
      { path: "marketing/reporting", label: "Reporting" },
      { path: "marketing/seo", label: "SEO" },
    ]);
    expect(groups[1]?.rows[0]?.skill.id).toBe("digest");
  });

  it("follows the preferred root order and appends unknown roots alphabetically", () => {
    const groups = groupSkillsByRoot(
      [
        skill("sales", { labels: ["sales"] }),
        skill("marketing", { labels: ["marketing"] }),
        skill("operations", { labels: ["operations"] }),
      ],
      labels,
      "org",
      null,
      ["operations"],
    );

    expect(groups.map((group) => group.path)).toEqual(["operations", "marketing", "sales"]);
  });

  it("places direct rows first and keeps matching subfolder rows contiguous", () => {
    const groups = groupSkillsByRoot(
      [
        skill("incident-summary", { labels: ["marketing/seo"] }),
        skill("diff-tools", { labels: ["marketing"] }),
        skill("weekly-report", { labels: ["marketing/reporting"] }),
        skill("log-parser", { labels: ["marketing/seo"] }),
      ],
      labels,
      "org",
    );

    expect(groups[0]?.rows.map((row) => row.skill.id)).toEqual([
      "diff-tools",
      "weekly-report",
      "incident-summary",
      "log-parser",
    ]);
  });

  it("keeps direct rows first and clusters descendants in preferred sibling order", () => {
    const groups = groupSkillsByRoot(
      [
        skill("report", { labels: ["marketing/reporting"] }),
        skill("direct", { labels: ["marketing"] }),
        skill("seo-first", { labels: ["marketing/seo"] }),
        skill("seo-second", { labels: ["marketing/seo"] }),
      ],
      labels,
      "org",
      null,
      ["marketing", "marketing/seo", "marketing/reporting"],
    );

    expect(groups[0]?.rows.map((row) => row.skill.id)).toEqual([
      "direct",
      "seo-first",
      "seo-second",
      "report",
    ]);
  });

  it("limits a multi-filed skill to the active sidebar label branch", () => {
    const groups = groupSkillsByRoot(
      [skill("digest", { labels: ["marketing/seo", "operations"] })],
      labels,
      "org",
      "marketing",
    );

    expect(groups.map((group) => (group.kind === "direct" ? null : group.label))).toEqual(["SEO"]);
    expect(groups[0]?.rows).toHaveLength(1);
    expect(groups[0]?.rows[0]?.relativePaths).toEqual([]);
    expect(groups[0]?.rows[0]?.icon).toEqual({ name: "globe", color: null });
  });

  it("groups a filtered view by subfolder and keeps direct skills in a leading headerless block", () => {
    const groups = groupSkillsByRoot(
      [
        skill("campaign", { labels: ["marketing"] }),
        skill("digest", { labels: ["marketing/reporting"] }),
        skill("audit", { labels: ["marketing/seo"] }),
      ],
      labels,
      "org",
      "marketing",
    );

    expect(groups.map((group) => group.kind)).toEqual(["direct", "folder", "folder"]);
    expect(groups.map((group) => group.key)).toEqual([
      "direct:marketing",
      "folder:marketing/reporting",
      "folder:marketing/seo",
    ]);
    expect("label" in groups[0]!).toBe(false);
    expect(groups.every((group) => group.rows.every((row) => row.relativePaths.length === 0))).toBe(true);
    expect(groups[0]?.rows[0]?.skill.id).toBe("campaign");
  });

  it("orders scoped subfolder sections like their sidebar siblings", () => {
    const groups = groupSkillsByRoot(
      [
        skill("report", { labels: ["marketing/reporting"] }),
        skill("audit", { labels: ["marketing/seo"] }),
      ],
      labels,
      "org",
      "marketing",
      ["marketing", "marketing/seo", "marketing/reporting"],
    );

    expect(groups.map((group) => group.path)).toEqual(["marketing/seo", "marketing/reporting"]);
  });

  it("keeps exact-path rows headerless when the selected folder has no visible descendants", () => {
    const groups = groupSkillsByRoot(
      [skill("campaign", { labels: ["marketing"] })],
      labels,
      "org",
      "marketing",
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("direct");
    expect(groups[0]?.key).toBe("direct:marketing");
    expect("label" in groups[0]!).toBe(false);
    expect(groups[0]?.rows[0]?.skill.id).toBe("campaign");
  });

  it("keeps deeper descendants as relative paths below the immediate subfolder group", () => {
    const groups = groupSkillsByRoot(
      [skill("weekly", { labels: ["marketing/reporting/weekly"] })],
      labels,
      "org",
      "marketing",
    );

    expect(groups.map((group) => (group.kind === "direct" ? null : group.label))).toEqual(["Reporting"]);
    expect(groups[0]?.rows[0]?.relativePaths).toEqual([
      { path: "marketing/reporting/weekly", label: "Weekly" },
    ]);
  });

  it("derives relative paths from canonical segments when display names contain separators", () => {
    const groups = groupSkillsByRoot(
      [skill("campaign", { labels: ["sales/seo"] })],
      [
        { path: "sales", displayName: "Sales / Marketing", color: null, icon: null },
        { path: "sales/seo", displayName: "SEO", color: null, icon: null },
      ],
      "org",
    );

    expect(groups[0]?.kind).toBe("folder");
    expect(groups[0]?.kind === "direct" ? null : groups[0]?.label).toBe("Sales / Marketing");
    expect(groups[0]?.rows[0]?.relativePaths).toEqual([{ path: "sales/seo", label: "SEO" }]);
  });

  it("keeps canonical identity when sibling paths share a display alias", () => {
    const groups = groupSkillsByRoot(
      [skill("audit", { labels: ["marketing/seo-content", "marketing/seo-technical"] })],
      [
        ...labels,
        { path: "marketing/seo-content", displayName: "SEO", color: null, icon: null },
        { path: "marketing/seo-technical", displayName: "SEO", color: null, icon: null },
      ],
      "org",
    );

    expect(groups[0]?.rows[0]?.relativePaths).toEqual([
      { path: "marketing/seo-content", label: "SEO" },
      { path: "marketing/seo-technical", label: "SEO" },
    ]);
  });

  it("places installed and genuinely unfiled rows in separate trailing groups", () => {
    const groups = groupSkillsByRoot(
      [
        skill("filed", { scope: "personal", source: "authored", labels: ["marketing"] }),
        skill("operations", { scope: "personal", source: "authored", labels: ["operations"] }),
        skill("installed", { source: "installed" }),
        skill("loose", { scope: "personal", source: "authored" }),
      ],
      labels,
      "mine",
      null,
      ["operations", "marketing"],
    );

    expect(groups.map((group) => group.key)).toEqual([
      "folder:operations",
      "folder:marketing",
      "installed",
      "unfiled",
    ]);
    expect(groups[2]?.rows[0]?.skill.id).toBe("installed");
    expect(groups[3]?.rows[0]?.skill.id).toBe("loose");
  });

  it("prefers a manifest icon, otherwise inherits the deepest custom folder icon", () => {
    expect(resolveSkillListIcon(skill("explicit", { icon: "bot", labels: ["marketing/reporting/weekly"] }), labels))
      .toEqual({ name: "bot", color: null });
    expect(resolveSkillListIcon(skill("inherited", { labels: ["marketing/reporting/weekly"] }), labels))
      .toEqual({ name: "bookmark", color: "oklch(0.54 0.10 168)" });
    expect(resolveSkillListIcon(skill("fallback"), labels)).toEqual({ name: "package", color: null });
  });

  it("breaks equal-depth inherited-icon ties by canonical path", () => {
    const resolved = resolveSkillListIcon(
      skill("tie", { labels: ["marketing/seo", "operations/incidents"] }),
      [...labels, { path: "operations/incidents", displayName: null, color: null, icon: "flame" }],
    );
    expect(resolved.name).toBe("globe");
  });
});
