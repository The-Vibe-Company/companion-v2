import { describe, expect, it } from "vitest";
import {
  githubSkillInclusionSchema,
  githubSkillSyncResponseSchema,
} from "../src/github";

describe("GitHub skill synchronization contracts", () => {
  it.each(["all", "selected", "dependency", "none"] as const)("accepts the %s inclusion state", (inclusion) => {
    expect(githubSkillInclusionSchema.parse(inclusion)).toBe(inclusion);
  });

  it("parses the active-skill synchronization matrix", () => {
    expect(githubSkillSyncResponseSchema.parse({
      skills: [{
        skill_id: "11111111-1111-4111-8111-111111111111",
        slug: "release-notes",
        display_name: "Release notes",
        current_version: "1.2.0",
        destinations: [
          { destination_id: "22222222-2222-4222-8222-222222222222", inclusion: "selected" },
          { destination_id: "33333333-3333-4333-8333-333333333333", inclusion: "dependency" },
        ],
      }],
    })).toMatchObject({ skills: [{ slug: "release-notes" }] });
  });

  it("rejects unknown inclusion states", () => {
    expect(githubSkillInclusionSchema.safeParse("excluded").success).toBe(false);
  });
});
