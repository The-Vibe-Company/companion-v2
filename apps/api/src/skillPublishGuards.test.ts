import { describe, expect, it } from "vitest";
import type { SkillFrontmatter } from "@companion/contracts";
import {
  assertNoCompanionRetarget,
  assertTargetedSkillUpdate,
  assertUpdateIsTargeted,
  parseSkillPublishAction,
} from "./skillPublishGuards";

function fm(input: Partial<SkillFrontmatter> & { name?: string } = {}): SkillFrontmatter {
  return {
    name: input.name ?? "research-agent",
    description: input.description ?? "Research helper.",
    metadata: input.metadata ?? {},
    allowedToolsRaw: input.allowedToolsRaw,
    allowedTools: input.allowedTools ?? [],
    license: input.license,
    compatibility: input.compatibility,
    requirements: input.requirements ?? [],
  };
}

describe("assertTargetedSkillUpdate", () => {
  it("accepts a targeted update with matching slug and Companion metadata", () => {
    expect(() =>
      assertTargetedSkillUpdate({
        frontmatter: fm({ metadata: { companion_skill_id: "skill-1" } }),
        expectSlug: "research-agent",
        expectSkillId: "skill-1",
        expectedSkill: { id: "skill-1", slug: "research-agent" },
      }),
    ).not.toThrow();
  });

  it("rejects a targeted update when the package name differs", () => {
    expect(() =>
      assertTargetedSkillUpdate({
        frontmatter: fm({ name: "other-skill" }),
        expectSlug: "research-agent",
        expectSkillId: "skill-1",
        expectedSkill: { id: "skill-1", slug: "research-agent" },
      }),
    ).toThrow('package name "other-skill" does not match the skill you are updating ("research-agent")');
  });

  it("rejects a targeted update when reserved Companion metadata points to another skill", () => {
    expect(() =>
      assertTargetedSkillUpdate({
        frontmatter: fm({ metadata: { companion_skill_id: "skill-2" } }),
        expectSlug: "research-agent",
        expectSkillId: "skill-1",
        expectedSkill: { id: "skill-1", slug: "research-agent" },
      }),
    ).toThrow('package Companion skill id "skill-2" does not match the skill you are updating ("skill-1")');
  });

  it("accepts old packages without Companion metadata when the targeted skill matches", () => {
    expect(() =>
      assertTargetedSkillUpdate({
        frontmatter: fm(),
        expectSlug: "research-agent",
        expectSkillId: "skill-1",
        expectedSkill: { id: "skill-1", slug: "research-agent" },
      }),
    ).not.toThrow();
  });

  it("does not require targeted-update fields for new publishes", () => {
    expect(() => assertTargetedSkillUpdate({ frontmatter: fm() })).not.toThrow();
  });
});

describe("assertNoCompanionRetarget", () => {
  it("blocks a package whose Companion id belongs to a different-slug skill", () => {
    expect(() =>
      assertNoCompanionRetarget({
        frontmatter: fm({ name: "research-agent", metadata: { companion_skill_id: "skill-1" } }),
        lookup: { slugSkill: null, companionIdSkill: { id: "skill-1", slug: "other-skill" } },
      }),
    ).toThrow('package Companion skill id "skill-1" belongs to skill "other-skill", not "research-agent"; refusing to retarget');
  });

  it("blocks an update whose slug skill has a different id than the package declares", () => {
    expect(() =>
      assertNoCompanionRetarget({
        frontmatter: fm({ name: "research-agent", metadata: { companion_skill_id: "skill-2" } }),
        lookup: { slugSkill: { id: "skill-1", slug: "research-agent" }, companionIdSkill: null },
      }),
    ).toThrow('skill "research-agent" has id "skill-1", but the package declares Companion skill id "skill-2"; refusing to retarget');
  });

  it("accepts a matching update", () => {
    expect(() =>
      assertNoCompanionRetarget({
        frontmatter: fm({ name: "research-agent", metadata: { companion_skill_id: "skill-1" } }),
        lookup: {
          slugSkill: { id: "skill-1", slug: "research-agent" },
          companionIdSkill: { id: "skill-1", slug: "research-agent" },
        },
      }),
    ).not.toThrow();
  });

  it("accepts a fresh create whose Companion id does not resolve to any skill", () => {
    expect(() =>
      assertNoCompanionRetarget({
        frontmatter: fm({ name: "brand-new", metadata: { companion_skill_id: "skill-9" } }),
        lookup: { slugSkill: null, companionIdSkill: null },
      }),
    ).not.toThrow();
  });

  it("ignores identity-less old packages", () => {
    expect(() =>
      assertNoCompanionRetarget({
        frontmatter: fm({ name: "research-agent" }),
        lookup: { slugSkill: { id: "skill-1", slug: "research-agent" }, companionIdSkill: null },
      }),
    ).not.toThrow();
  });
});

describe("assertUpdateIsTargeted", () => {
  it("requires expect_slug and expect_skill_id when the slug already exists", () => {
    expect(() =>
      assertUpdateIsTargeted({
        frontmatter: fm({ name: "research-agent" }),
        slugSkill: { id: "skill-1", slug: "research-agent" },
      }),
    ).toThrow('updating skill "research-agent" requires expect_slug and expect_skill_id');
  });

  it("does not gate a fresh create", () => {
    expect(() =>
      assertUpdateIsTargeted({ frontmatter: fm({ name: "brand-new" }), slugSkill: null }),
    ).not.toThrow();
  });

  it("accepts an update that declares both expect fields", () => {
    expect(() =>
      assertUpdateIsTargeted({
        frontmatter: fm({ name: "research-agent" }),
        slugSkill: { id: "skill-1", slug: "research-agent" },
        expectSlug: "research-agent",
        expectSkillId: "skill-1",
      }),
    ).not.toThrow();
  });
});

describe("parseSkillPublishAction", () => {
  it("defaults empty action values to publish", () => {
    expect(parseSkillPublishAction(undefined)).toBe("publish");
    expect(parseSkillPublishAction("")).toBe("publish");
  });

  it("accepts publish and validate actions", () => {
    expect(parseSkillPublishAction("publish")).toBe("publish");
    expect(parseSkillPublishAction("validate")).toBe("validate");
  });

  it("rejects unknown actions instead of publishing by default", () => {
    expect(() => parseSkillPublishAction("validation")).toThrow("unsupported skill publish action: validation");
  });
});
