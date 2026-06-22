import { describe, expect, it } from "vitest";
import {
  createSkillInputSchema,
  ownerCovers,
  publishSkillInputSchema,
  setSkillOwnerInputSchema,
  skillFilterSchema,
  skillFrontmatterSchema,
  skillListRowSchema,
  visibilityFilterSchema,
} from "../src";

describe("skill owner contracts", () => {
  it("parses the read shape with an owner (no separate visibility field)", () => {
    const row = skillListRowSchema.parse({
      id: "skill_1",
      org_id: "org_1",
      slug: "incident-summary",
      description: "Summarize incidents.",
      validation: "valid",
      validation_error: null,
      owner_kind: "team",
      owner_id: "user_1",
      owner_user_id: "user_1",
      owner_team_id: "team_1",
      owner_name: "Platform",
      owner_handle: "platform",
      owner_initials: "PL",
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

    expect(row.owner_kind).toBe("team");
    expect(row.owner_team_id).toBe("team_1");
    // The legacy visibility field is gone from the read shape.
    expect("visibility" in row).toBe(false);
    // Install fields are optional on the wire (older API responses omit them) and default safely.
    expect(row.installed).toBe(false);
    expect(row.installed_version).toBeNull();
    expect(row.install_status).toBe("none");
  });

  it("parses create and publish inputs with an owner_team only", () => {
    expect(
      createSkillInputSchema.parse({
        id: "incident-summary",
        description: "Summarize incidents.",
        body: "",
        owner_team: "platform",
      }),
    ).toMatchObject({ owner_team: "platform" });

    // owner_team omitted = Personal.
    expect(createSkillInputSchema.parse({ id: "personal-skill", description: "Mine." }).owner_team).toBeUndefined();

    expect(
      publishSkillInputSchema.parse({
        slug: "incident-summary",
        owner_team: "platform",
        version: "1.0.0",
        description: "Summarize incidents.",
        checksum: `sha256:${"a".repeat(64)}`,
        storage_path: "skills/org/incident-summary/1.0.0.zip",
        size_bytes: 123,
        frontmatter: "---\nname: incident-summary\n---",
        tools: [],
      }),
    ).toMatchObject({ owner_team: "platform" });
  });

  it("parses the set-owner body (null = Personal, slug = Team)", () => {
    expect(setSkillOwnerInputSchema.parse({ owner_team: null })).toEqual({ owner_team: null });
    expect(setSkillOwnerInputSchema.parse({ owner_team: "platform" })).toEqual({ owner_team: "platform" });
    expect(() => setSkillOwnerInputSchema.parse({})).toThrow();
  });

  it("ownerCovers: team targets cover everyone; personal only covers the same owner", () => {
    const team = { ownerKind: "team" as const, ownerUserId: "user_1" };
    const minePersonal = { ownerKind: "user" as const, ownerUserId: "user_1" };
    const theirsPersonal = { ownerKind: "user" as const, ownerUserId: "user_2" };
    expect(ownerCovers(minePersonal, team)).toBe(true); // team dep covers a personal dependent
    expect(ownerCovers(team, team)).toBe(true);
    expect(ownerCovers(minePersonal, minePersonal)).toBe(true); // same owner
    expect(ownerCovers(team, minePersonal)).toBe(false); // public dependent, private dep
    expect(ownerCovers(minePersonal, theirsPersonal)).toBe(false); // different owners
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

  it("owner filters are personal | team and reject the old scope values", () => {
    expect(visibilityFilterSchema.options).toEqual(["personal", "team"]);
    expect(skillFilterSchema.parse({ type: "visibility", value: "team" })).toEqual({
      type: "visibility",
      value: "team",
    });
    expect(() => skillFilterSchema.parse({ type: "visibility", value: "everyone" })).toThrow();
    expect(() => skillFilterSchema.parse({ type: "scope", value: "public" })).toThrow();
  });
});
