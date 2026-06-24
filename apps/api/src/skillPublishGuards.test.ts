import { describe, expect, it } from "vitest";
import type { SkillFrontmatter } from "@companion/contracts";
import { assertTargetedSkillUpdate, parseSkillPublishAction } from "./skillPublishGuards";

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
