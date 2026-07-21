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

    expect(groups.map((group) => group.label)).toEqual(["Marketing", "Operations"]);
    expect(groups[0]?.rows).toHaveLength(1);
    expect(groups[0]?.rows[0]?.relativePaths).toEqual(["Reporting", "SEO"]);
    expect(groups[1]?.rows[0]?.skill.id).toBe("digest");
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

    expect(groups[0]?.label).toBe("Sales / Marketing");
    expect(groups[0]?.rows[0]?.relativePaths).toEqual(["SEO"]);
  });

  it("places installed and genuinely unfiled rows in separate trailing groups", () => {
    const groups = groupSkillsByRoot([
      skill("filed", { scope: "personal", source: "authored", labels: ["marketing"] }),
      skill("installed", { source: "installed" }),
      skill("loose", { scope: "personal", source: "authored" }),
    ], labels, "mine");

    expect(groups.map((group) => group.key)).toEqual(["folder:marketing", "installed", "unfiled"]);
    expect(groups[1]?.rows[0]?.skill.id).toBe("installed");
    expect(groups[2]?.rows[0]?.skill.id).toBe("loose");
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
