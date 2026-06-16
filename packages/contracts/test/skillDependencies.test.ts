import { describe, expect, it } from "vitest";
import {
  archiveSkillInputSchema,
  dependencyPlanSchema,
  publishSkillInputSchema,
  skillDependenciesResponseSchema,
  skillFilterSchema,
} from "../src/index";

describe("skill dependency contracts", () => {
  it("parses a dependencies response with the un-versioned status set", () => {
    const parsed = skillDependenciesResponseSchema.parse({
      slug: "incident-summary",
      version: "0.1.8",
      requires: [
        { slug: "log-parser", status: "satisfied", visibility: { everyone: true, teams: [] }, note: null, can_open: true },
        { slug: "html-sanitize", status: "missing", visibility: null, note: "not published to this workspace", can_open: false },
      ],
      used_by: [
        {
          slug: "ops-runbook",
          status: "satisfied",
          visibility: { everyone: false, teams: [{ id: "t1", slug: "platform", name: "Platform" }] },
          archived: false,
          note: null,
          can_open: true,
        },
      ],
      requires_n: 2,
      used_by_n: 1,
    });
    expect(parsed.requires).toHaveLength(2);
    expect(parsed.requires[1]!.status).toBe("missing");
  });

  it("rejects a removed version-based status", () => {
    expect(() =>
      skillDependenciesResponseSchema.parse({
        slug: "x",
        version: null,
        requires: [{ slug: "y", status: "update", visibility: null, note: null, can_open: false }],
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

  it("accepts the deps filter variants and defaults dependencies on publish", () => {
    expect(skillFilterSchema.parse({ type: "deps", value: "has" })).toEqual({ type: "deps", value: "has" });
    expect(skillFilterSchema.parse({ type: "deps", value: "used" })).toEqual({ type: "deps", value: "used" });
    expect(() => skillFilterSchema.parse({ type: "deps", value: "nope" })).toThrow();

    const published = publishSkillInputSchema.parse({
      slug: "incident-summary",
      visibility: { everyone: true, teams: [] },
      version: "1.0.0",
      description: "x",
      checksum: `sha256:${"a".repeat(64)}`,
      storage_path: "skills/o/incident-summary/1.0.0.tar.gz",
      size_bytes: 10,
      frontmatter: "{}",
      tools: [],
    });
    expect(published.dependencies).toEqual([]);
  });

  it("parses an archive input with an optional reason", () => {
    expect(archiveSkillInputSchema.parse({})).toEqual({});
    expect(archiveSkillInputSchema.parse({ reason: "superseded" }).reason).toBe("superseded");
  });
});
