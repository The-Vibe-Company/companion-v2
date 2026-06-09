import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import { assertCanPublishSkillVersion, listSkills, type ActorContext } from "../src/services";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const actor: ActorContext = { id: "user-1", email: "user@example.com", name: "User One" };

const createdAt = new Date("2026-06-09T12:00:00.000Z");

function skillRow(id: string, slug: string, everyone: boolean) {
  return {
    id,
    org_id: ORG,
    slug,
    description: slug,
    everyone,
    validation: "valid",
    validation_error: null,
    owner_id: actor.id,
    owner_name: "User One",
    owner_handle: null,
    owner_initials: "UO",
    current_version: "1.0.0",
    license: null,
    checksum: null,
    size_bytes: 100,
    tools: [],
    star_count: 0,
    starred: false,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "groupBy"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.orderBy = vi.fn(async () => rows);
  chain.then = (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function fakeDb({
  orgRole = "developer",
  sharedTeamRole = "editor",
}: {
  orgRole?: "owner" | "admin" | "developer" | null;
  sharedTeamRole?: "admin" | "editor" | "reader" | null;
} = {}) {
  const skills = [
    skillRow("skill-private", "private-skill", false),
    skillRow("skill-everyone", "everyone-skill", true),
    skillRow("skill-one-team", "one-team-skill", false),
    skillRow("skill-multi-team", "multi-team-skill", false),
    skillRow("skill-everyone-team", "everyone-team-skill", true),
  ];
  const shares = [
    { skill_id: "skill-one-team", id: "team-platform", slug: "platform", name: "Platform" },
    { skill_id: "skill-multi-team", id: "team-data", slug: "data", name: "Data" },
    { skill_id: "skill-multi-team", id: "team-platform", slug: "platform", name: "Platform" },
    { skill_id: "skill-everyone-team", id: "team-platform", slug: "platform", name: "Platform" },
  ];

  const database = {
    query: {
      memberships: {
        findFirst: vi.fn(async () => (orgRole ? { orgRole } : null)),
      },
      skills: {
        findFirst: vi.fn(async () => ({ id: "skill-one-team", ownerId: "other-user" })),
      },
    },
    select: vi.fn((cols: Record<string, unknown>) => {
      if ("skill_id" in cols) return selectChain(shares);
      if ("teamRole" in cols && "slug" in cols) {
        return selectChain(sharedTeamRole ? [{ teamId: "team-platform", slug: "platform", teamRole: sharedTeamRole }] : []);
      }
      if ("teamRole" in cols) return selectChain(sharedTeamRole ? [{ teamRole: sharedTeamRole }] : []);
      if ("teamId" in cols) return selectChain([{ teamId: "team-platform" }]);
      if ("version" in cols) return selectChain([]);
      if ("id" in cols && "slug" in cols && "name" in cols) {
        return selectChain([{ id: "team-platform", slug: "platform", name: "Platform" }]);
      }
      if ("id" in cols && "slug" in cols && "everyone" in cols) return selectChain(skills);
      return selectChain([]);
    }),
  };
  return database as unknown as Db;
}

describe("listSkills visibility assembly", () => {
  it("denies non-members before everyone/team visibility is evaluated", async () => {
    await expect(listSkills({ actor, orgId: ORG, database: fakeDb({ orgRole: null }) })).rejects.toThrow(
      "not a member of this organization",
    );
  });

  it("returns private, everyone, team, multi-team, and everyone+team visibility", async () => {
    const rows = await listSkills({ actor, orgId: ORG, database: fakeDb() });
    const bySlug = new Map(rows.map((row) => [row.slug, row.visibility]));

    expect(bySlug.get("private-skill")).toEqual({ everyone: false, teams: [] });
    expect(bySlug.get("everyone-skill")).toEqual({ everyone: true, teams: [] });
    expect(bySlug.get("one-team-skill")).toEqual({
      everyone: false,
      teams: [{ id: "team-platform", slug: "platform", name: "Platform" }],
    });
    expect(bySlug.get("multi-team-skill")).toEqual({
      everyone: false,
      teams: [
        { id: "team-data", slug: "data", name: "Data" },
        { id: "team-platform", slug: "platform", name: "Platform" },
      ],
    });
    expect(bySlug.get("everyone-team-skill")).toEqual({
      everyone: true,
      teams: [{ id: "team-platform", slug: "platform", name: "Platform" }],
    });
  });

  it("lets team editors publish new versions of existing skills shared with their team", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ sharedTeamRole: "editor" }),
        payload: {
          slug: "one-team-skill",
          visibility: { everyone: false, teams: ["platform"] },
          version: "1.1.0",
          note: "",
          description: "one-team-skill",
          checksum: `sha256:${"a".repeat(64)}`,
          storage_path: "skills/org/one-team-skill/1.1.0.zip",
          size_bytes: 123,
          frontmatter: "---\nname: one-team-skill\n---",
          tools: [],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps team readers read-only for existing skills shared with their team", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ sharedTeamRole: "reader" }),
        payload: {
          slug: "one-team-skill",
          visibility: { everyone: false, teams: ["platform"] },
          version: "1.1.0",
          note: "",
          description: "one-team-skill",
          checksum: `sha256:${"a".repeat(64)}`,
          storage_path: "skills/org/one-team-skill/1.1.0.zip",
          size_bytes: 123,
          frontmatter: "---\nname: one-team-skill\n---",
          tools: [],
        },
      }),
    ).rejects.toThrow("not allowed to publish this skill");
  });

  it("prevents team editors from broadening someone else's shared skill to everyone", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ sharedTeamRole: "editor" }),
        payload: {
          slug: "one-team-skill",
          visibility: { everyone: true, teams: ["platform"] },
          version: "1.1.0",
          note: "",
          description: "one-team-skill",
          checksum: `sha256:${"a".repeat(64)}`,
          storage_path: "skills/org/one-team-skill/1.1.0.zip",
          size_bytes: 123,
          frontmatter: "---\nname: one-team-skill\n---",
          tools: [],
        },
      }),
    ).rejects.toThrow("not allowed to publish at this visibility");
  });

  it("prevents team editors from making someone else's shared skill private", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ sharedTeamRole: "editor" }),
        payload: {
          slug: "one-team-skill",
          visibility: { everyone: false, teams: [] },
          version: "1.1.0",
          note: "",
          description: "one-team-skill",
          checksum: `sha256:${"a".repeat(64)}`,
          storage_path: "skills/org/one-team-skill/1.1.0.zip",
          size_bytes: 123,
          frontmatter: "---\nname: one-team-skill\n---",
          tools: [],
        },
      }),
    ).rejects.toThrow("not allowed to publish at this visibility");
  });

  it("prevents team editors from publishing someone else's everyone-visible skill through a team share", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ sharedTeamRole: "editor" }),
        payload: {
          slug: "everyone-team-skill",
          visibility: { everyone: true, teams: ["platform"] },
          version: "1.1.0",
          note: "",
          description: "everyone-team-skill",
          checksum: `sha256:${"a".repeat(64)}`,
          storage_path: "skills/org/everyone-team-skill/1.1.0.zip",
          size_bytes: 123,
          frontmatter: "---\nname: everyone-team-skill\n---",
          tools: [],
        },
      }),
    ).rejects.toThrow("not allowed to publish at this visibility");
  });
});
