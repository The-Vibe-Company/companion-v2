import { describe, expect, it } from "vitest";
import {
  archiveSkillInputSchema,
  dependencyPlanSchema,
  publishSkillInputSchema,
  skillDependenciesResponseSchema,
  skillDependencyStatusSchema,
  skillFilterSchema,
} from "../src/index";

describe("skill dependency contracts", () => {
  it("exposes the flat status set (no owner / visibility axis)", () => {
    expect(skillDependencyStatusSchema.options).toEqual(["satisfied", "missing", "archived", "cycle"]);
    expect(skillDependencyStatusSchema.options).not.toContain("visibility");
  });

  it("parses a dependencies response without an owner_kind field", () => {
    const parsed = skillDependenciesResponseSchema.parse({
      slug: "incident-summary",
      version: "0.1.8",
      requires: [
        { slug: "log-parser", status: "satisfied", note: null, can_open: true },
        { slug: "html-sanitize", status: "missing", note: "not published to this workspace", can_open: false },
      ],
      used_by: [{ slug: "ops-runbook", status: "satisfied", archived: false, note: null, can_open: true }],
      requires_n: 2,
      used_by_n: 1,
    });
    expect(parsed.requires).toHaveLength(2);
    expect(parsed.requires[1]!.status).toBe("missing");
    expect(parsed.requires[0]!).toMatchObject({
      version: null,
      install_status: "none",
      installed_version: null,
      depth: 0,
      via: null,
    });
    expect(parsed.transitive).toEqual([]);
    expect(parsed.transitive_n).toBe(0);
    expect(parsed.updates_n).toBe(0);
    expect("owner_kind" in parsed.requires[0]!).toBe(false);
    expect("owner_kind" in parsed.used_by[0]!).toBe(false);
  });

  it("parses transitive dependencies and dependency install update metadata", () => {
    const parsed = skillDependenciesResponseSchema.parse({
      slug: "web-archiver",
      version: "0.4.2",
      requires: [
        {
          slug: "log-parser",
          status: "satisfied",
          note: null,
          can_open: true,
          version: "2.1.0",
          install_status: "update",
          installed_version: "2.0.0",
          depth: 0,
          via: null,
        },
      ],
      transitive: [
        {
          slug: "html-sanitize",
          status: "satisfied",
          note: null,
          can_open: true,
          version: "1.3.0",
          install_status: "installed",
          installed_version: "1.3.0",
          depth: 2,
          via: "log-parser",
        },
      ],
      used_by: [],
      requires_n: 1,
      transitive_n: 1,
      used_by_n: 0,
      updates_n: 1,
    });

    expect(parsed.requires[0]!.install_status).toBe("update");
    expect(parsed.requires[0]!.installed_version).toBe("2.0.0");
    expect(parsed.transitive[0]!).toMatchObject({
      slug: "html-sanitize",
      version: "1.3.0",
      depth: 2,
      via: "log-parser",
    });
    expect(parsed.transitive_n).toBe(1);
    expect(parsed.updates_n).toBe(1);
  });

  it("rejects an invalid dependency install status", () => {
    expect(() =>
      skillDependenciesResponseSchema.parse({
        slug: "x",
        version: null,
        requires: [{ slug: "y", status: "satisfied", note: null, can_open: true, install_status: "bogus" }],
        used_by: [],
        requires_n: 1,
        used_by_n: 0,
      }),
    ).toThrow();
  });

  it("rejects a removed version-based status", () => {
    expect(() =>
      skillDependenciesResponseSchema.parse({
        slug: "x",
        version: null,
        requires: [{ slug: "y", status: "update", note: null, can_open: false }],
        used_by: [],
        requires_n: 1,
        used_by_n: 0,
      }),
    ).toThrow();
  });

  it("rejects the removed visibility status", () => {
    expect(() =>
      skillDependenciesResponseSchema.parse({
        slug: "x",
        version: null,
        requires: [{ slug: "y", status: "visibility", note: null, can_open: false }],
        used_by: [],
        requires_n: 1,
        used_by_n: 0,
      }),
    ).toThrow();
  });

  it("parses a dependency preflight plan", () => {
    const plan = dependencyPlanSchema.parse({
      declared: ["log-parser", "timeline-fmt"],
      ready: ["log-parser"],
      upload: [{ slug: "timeline-fmt", msg: "declared in the new SKILL.md, not in the registry" }],
      removed: ["csv-export"],
      archive_candidates: [{ slug: "csv-export", reason: "no published skill requires it anymore" }],
      blocked: [],
    });
    expect(plan.declared).toEqual(["log-parser", "timeline-fmt"]);
  });

  it("accepts the deps filter variants and defaults dependencies + labels on publish", () => {
    expect(skillFilterSchema.parse({ type: "deps", value: "has" })).toEqual({ type: "deps", value: "has" });
    expect(skillFilterSchema.parse({ type: "deps", value: "used" })).toEqual({ type: "deps", value: "used" });
    expect(() => skillFilterSchema.parse({ type: "deps", value: "nope" })).toThrow();

    const published = publishSkillInputSchema.parse({
      slug: "incident-summary",
      version: "1.0.0",
      description: "x",
      checksum: `sha256:${"a".repeat(64)}`,
      storage_path: "skills/o/incident-summary/1.0.0.tar.gz",
      size_bytes: 10,
      frontmatter: "{}",
      tools: [],
    });
    expect(published.dependencies).toEqual([]);
    expect(published.labels).toEqual([]);
    // owner_team is gone from the publish input.
    expect("owner_team" in published).toBe(false);
  });

  it("parses an archive input with an optional reason", () => {
    expect(archiveSkillInputSchema.parse({})).toEqual({});
    expect(archiveSkillInputSchema.parse({ reason: "superseded" }).reason).toBe("superseded");
  });
});
