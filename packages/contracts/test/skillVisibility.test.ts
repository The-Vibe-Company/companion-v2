import { describe, expect, it } from "vitest";
import {
  createSkillInputSchema,
  publishSkillInputSchema,
  skillFilterSchema,
  skillFrontmatterSchema,
  skillListRowSchema,
  skillVisibilityInputSchema,
  transferSkillOwnershipInputSchema,
  visibilityFilterSchema,
} from "../src";

const visibility = {
  everyone: true,
  teams: [{ id: "team_1", slug: "platform", name: "Platform" }],
};

describe("skill visibility contracts", () => {
  it("parses the read shape as everyone plus team shares", () => {
    const row = skillListRowSchema.parse({
      id: "skill_1",
      org_id: "org_1",
      slug: "incident-summary",
      description: "Summarize incidents.",
      visibility,
      validation: "valid",
      validation_error: null,
      owner_kind: "user",
      owner_id: "user_1",
      owner_user_id: "user_1",
      owner_team_id: null,
      owner_name: "Stan",
      owner_handle: null,
      owner_initials: "SG",
      current_version: "1.0.0",
      license: null,
      compatibility: null,
      metadata: {},
      checksum: null,
      size_bytes: 123,
      tools: [],
      star_count: 0,
      starred: false,
      created_at: "2026-06-09T12:00:00.000Z",
      updated_at: "2026-06-09T12:00:00.000Z",
    });

    expect(row.visibility).toEqual(visibility);
    // Install fields are optional on the wire (older API responses omit them) and default safely.
    expect(row.installed).toBe(false);
    expect(row.installed_version).toBeNull();
    expect(row.install_status).toBe("none");
    expect(() => skillListRowSchema.parse({ ...row, scope: "public", visibility: undefined })).toThrow();
  });

  it("parses create and publish inputs with visibility only", () => {
    expect(skillVisibilityInputSchema.parse({})).toEqual({ everyone: false, teams: [] });
    expect(createSkillInputSchema.parse({
      id: "incident-summary",
      description: "Summarize incidents.",
      body: "",
      owner_team: "platform",
      visibility: { everyone: false, teams: ["platform", "data"] },
    })).toMatchObject({
      owner_team: "platform",
      visibility: { everyone: false, teams: ["platform", "data"] },
    });

    expect(publishSkillInputSchema.parse({
      slug: "incident-summary",
      owner_team: "platform",
      visibility: { everyone: true, teams: ["platform"] },
      version: "1.0.0",
      description: "Summarize incidents.",
      checksum: `sha256:${"a".repeat(64)}`,
      storage_path: "skills/org/incident-summary/1.0.0.zip",
      size_bytes: 123,
      frontmatter: "---\nname: incident-summary\n---",
      tools: [],
    })).toMatchObject({
      owner_team: "platform",
      visibility: { everyone: true, teams: ["platform"] },
    });
  });

  it("rejects visibility fields in SKILL.md frontmatter", () => {
    expect(() =>
      skillFrontmatterSchema.parse({
        name: "incident-summary",
        version: "1.0.0",
        description: "Summarize incidents.",
        scope: "public",
      }),
    ).toThrow(/must not declare visibility/);
    expect(() =>
      skillFrontmatterSchema.parse({
        name: "incident-summary",
        version: "1.0.0",
        description: "Summarize incidents.",
        visibility: "public",
      }),
    ).toThrow(/must not declare visibility/);
  });

  it("accepts derived visibility filters and rejects the old public scope", () => {
    expect(visibilityFilterSchema.options).toEqual(["private", "team", "everyone"]);
    expect(skillFilterSchema.parse({ type: "visibility", value: "everyone" })).toEqual({
      type: "visibility",
      value: "everyone",
    });
    expect(() => skillFilterSchema.parse({ type: "visibility", value: "public" })).toThrow();
    expect(() => skillFilterSchema.parse({ type: "scope", value: "public" })).toThrow();
  });

  it("requires an explicit owner_team for ownership transfer (null = personal)", () => {
    expect(transferSkillOwnershipInputSchema.parse({ owner_team: null })).toEqual({ owner_team: null, cascade: false });
    expect(transferSkillOwnershipInputSchema.parse({ owner_team: "platform", cascade: true })).toEqual({
      owner_team: "platform",
      cascade: true,
    });
    // An omitted destination must be rejected so a malformed body can't silently reassign to the caller.
    expect(() => transferSkillOwnershipInputSchema.parse({})).toThrow();
    expect(() => transferSkillOwnershipInputSchema.parse({ cascade: true })).toThrow();
  });
});
