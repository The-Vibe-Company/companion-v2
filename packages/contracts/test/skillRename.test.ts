import { describe, expect, it } from "vitest";
import { renameSkillInputSchema, renameSkillResultSchema } from "../src/skill";

describe("renameSkillInputSchema", () => {
  it("accepts a kebab-case slug and optional title", () => {
    expect(
      renameSkillInputSchema.parse({
        newSlug: "skill-creator-and-eval",
        title: " Skill Creator and Eval ",
      }),
    ).toEqual({
      newSlug: "skill-creator-and-eval",
      title: "Skill Creator and Eval",
    });
  });

  it("rejects invalid slugs and blank titles", () => {
    expect(() => renameSkillInputSchema.parse({ newSlug: "Skill Creator" })).toThrow();
    expect(() => renameSkillInputSchema.parse({ newSlug: "skill-creator", title: "  " })).toThrow();
  });
});

describe("renameSkillResultSchema", () => {
  it("returns the stable id plus old and new slugs", () => {
    expect(
      renameSkillResultSchema.parse({
        ok: true,
        id: "skill-1",
        old_slug: "skill-creator",
        slug: "skill-creator-and-eval",
        title: null,
      }),
    ).toEqual({
      ok: true,
      id: "skill-1",
      old_slug: "skill-creator",
      slug: "skill-creator-and-eval",
      title: null,
    });
  });
});
