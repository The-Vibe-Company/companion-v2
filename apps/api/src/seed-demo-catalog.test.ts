import { describe, expect, it } from "vitest";
import { FREE_ORG_SKILL_LIMIT } from "@companion/core";
import {
  DEMO_ARCHIVED_SLUGS,
  DEMO_EMPTY_ORG_LABELS,
  DEMO_EMPTY_PERSONAL_LABELS,
  DEMO_FORCED_DEPENDENCIES,
  DEMO_INSTALLS,
  DEMO_INVALID_SKILLS,
  DEMO_SKILL_CATALOG,
} from "./seed-demo-catalog";

const bySlug = new Map(DEMO_SKILL_CATALOG.map((skill) => [skill.slug, skill] as const));

/**
 * Product promise: a fresh local workspace exposes the stable skill states needed for manual and
 * browser testing without consuming the full Free catalog quota.
 *
 * Regression caught: dropping a scope, install state, dependency state, rich manifest fixture, or
 * version ordering would silently make an important UI/API path impossible to exercise locally.
 *
 * Why this level: a pure contract gives fast, precise fixture-shape failures, while the dedicated
 * PostgreSQL integration test executes the persistence and repeat-run behavior with storage stubbed.
 *
 * Failure proof: removing any named fixture or reordering a dependency after its dependent fails a
 * focused assertion below, while seedDemoCatalog.integration.test.ts verifies the persistence path.
 */
describe("seed demo catalog contract", () => {
  it("keeps a compact org catalog with personal-library coverage and quota headroom", () => {
    const org = DEMO_SKILL_CATALOG.filter((skill) => skill.scope === "org");
    const personal = DEMO_SKILL_CATALOG.filter((skill) => skill.scope === "personal");
    const slugs = DEMO_SKILL_CATALOG.map((skill) => skill.slug);

    expect(org).toHaveLength(15);
    expect(FREE_ORG_SKILL_LIMIT - org.length).toBe(5);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(org.map((skill) => skill.slug)).toEqual([
      "markdown-report",
      "log-parser",
      "diff-tools",
      "slack-notify",
      "vault-index",
      "granite-recall",
      "screenshot-grab",
      "html-export",
      "incident-summary",
      "email-digest",
      "release-notes",
      "postmortem-review",
      "browser-check",
      "legacy-import",
      "manifest-invalid",
    ]);
    expect(personal.map((skill) => skill.slug)).toEqual(["private-source", "private-brief", "research-draft"]);
    expect(personal.find((skill) => skill.slug === "research-draft")?.labels).toBeUndefined();
    expect(DEMO_EMPTY_ORG_LABELS).toEqual(["growth"]);
    expect(DEMO_EMPTY_PERSONAL_LABELS).toEqual(["ideas"]);
  });

  it("orders publishable dependencies before their dependents and covers every dependency state", () => {
    const positions = new Map(DEMO_SKILL_CATALOG.map((skill, index) => [skill.slug, index] as const));
    for (const skill of DEMO_SKILL_CATALOG) {
      for (const version of skill.versions) {
        for (const dependency of version.dependencies ?? []) {
          expect(positions.get(dependency), `${skill.slug} dependency ${dependency} must exist`).toBeDefined();
          expect(positions.get(dependency)!, `${dependency} must publish before ${skill.slug}`).toBeLessThan(
            positions.get(skill.slug)!,
          );
        }
      }
    }

    expect(bySlug.get("incident-summary")?.versions[0]?.dependencies).toEqual(["log-parser", "markdown-report"]);
    expect(bySlug.get("postmortem-review")?.versions[0]?.dependencies).toEqual(["incident-summary"]);
    expect(DEMO_FORCED_DEPENDENCIES).toContainEqual({
      dependent: "browser-check",
      dependency: "screenshot-grab",
      state: "archived",
    });
    expect(DEMO_ARCHIVED_SLUGS).toContain("screenshot-grab");
    expect(DEMO_FORCED_DEPENDENCIES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependent: "legacy-import", dependency: "html-sanitize", state: "missing" }),
        expect.objectContaining({ dependent: "vault-index", dependency: "granite-recall", state: "cycle" }),
        expect.objectContaining({ dependent: "granite-recall", dependency: "vault-index", state: "cycle" }),
      ]),
    );
    expect(bySlug.get("private-brief")?.versions[0]?.dependencies).toEqual(["private-source"]);
  });

  it("covers current, outdated, and unknown-version installs without preinstalling the smoke skill", () => {
    expect(DEMO_INSTALLS).toEqual([
      { slug: "email-digest", version: "1.2.0", expectedStatus: "installed" },
      { slug: "release-notes", version: "1.0.0", expectedStatus: "update" },
      { slug: "slack-notify", version: null, expectedStatus: "installed" },
    ]);
    expect(DEMO_INSTALLS.map((install) => install.slug)).not.toContain("incident-summary");
    expect(bySlug.get("release-notes")?.versions.map((version) => version.version)).toEqual(["1.0.0", "1.1.0"]);
  });

  it("includes a rich package, setup declarations, multi-label rows, archives, and invalid state", () => {
    const release = bySlug.get("release-notes")?.versions.at(-1);
    expect(release).toMatchObject({ title: "Release notes", icon: "megaphone" });
    expect(release?.notes).toContain("grouped highlights");
    expect(release?.files?.map((file) => file.path)).toEqual([
      "references/template.md",
      "scripts/format.ts",
      "examples/input.json",
    ]);

    const requirements = bySlug.get("slack-notify")?.versions[0]?.requirements;
    expect(requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "SLACK_BOT_TOKEN",
          type: "secret",
          slot_id: "11111111-1111-4111-8111-111111111111",
          required: true,
        }),
        expect.objectContaining({ key: "SLACK_DEFAULT_CHANNEL", type: "env", required: false }),
      ]),
    );
    expect(bySlug.get("incident-summary")?.labels).toHaveLength(2);
    expect(DEMO_ARCHIVED_SLUGS).toEqual(["screenshot-grab", "html-export"]);
    expect(DEMO_INVALID_SKILLS).toEqual([
      expect.objectContaining({ slug: "manifest-invalid", error: expect.stringContaining("intentionally invalid") }),
    ]);
  });
});
