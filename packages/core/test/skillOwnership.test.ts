import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import {
  assertCanPublishSkillVersion,
  assertDependenciesResolvable,
  DependencyPublishError,
  listSkillVersions,
  listSkills,
  setSkillOwner,
  type ActorContext,
} from "../src/services";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const actor: ActorContext = { id: "user-1", email: "user@example.com", name: "User One" };

const createdAt = new Date("2026-06-09T12:00:00.000Z");

/**
 * A denormalized skill row carrying BOTH the snake_case fields `listSkills` reads and the camelCase
 * fields `loadDepGraph` reads. The owner is the single access axis: `teamId` null = Personal (owned
 * by `userId`), set = Team-owned (workspace-visible).
 */
function skillRow(
  id: string,
  slug: string,
  owner: {
    kind?: "user" | "team";
    userId?: string;
    teamId?: string | null;
    name?: string;
    handle?: string | null;
    frontmatter?: string;
    description?: string;
  } = {},
) {
  const ownerKind = owner.kind ?? (owner.teamId ? "team" : "user");
  const ownerUserId = owner.userId ?? actor.id;
  const ownerTeamId = owner.teamId ?? null;
  const ownerName = owner.name ?? (ownerKind === "team" ? "Platform" : "User One");
  return {
    id,
    org_id: ORG,
    slug,
    description: owner.description ?? slug,
    validation: "valid",
    validation_error: null,
    owner_kind: ownerKind,
    owner_id: ownerTeamId ?? ownerUserId,
    owner_user_id: ownerUserId,
    owner_team_id: ownerTeamId,
    owner_name: ownerName,
    owner_handle: owner.handle ?? (ownerKind === "team" ? "platform" : null),
    owner_initials: ownerKind === "team" ? "PL" : "UO",
    current_version: "1.0.0",
    frontmatter:
      owner.frontmatter ??
      JSON.stringify({ name: slug, description: slug, metadata: {} }),
    license: null,
    checksum: null,
    size_bytes: 100,
    tools: [],
    star_count: 0,
    starred: false,
    installed: false,
    created_at: createdAt,
    updated_at: createdAt,
    // camelCase fields read by loadDepGraph (listSkills reads the snake_case ones above).
    archivedAt: null,
    currentVersionId: `${id}-cv`,
    ownerId: ownerUserId,
    ownerTeamId,
  };
}

function skillVersionRow(skillId: string, frontmatter: string) {
  return {
    id: `${skillId}-v1`,
    orgId: ORG,
    skillId,
    version: "1.0.0",
    note: "Initial version",
    frontmatter,
    tools: [],
    license: null,
    sizeBytes: 100,
    checksum: `sha256:${"b".repeat(64)}`,
    storagePath: `skills/org/${skillId}/1.0.0.zip`,
    validation: "valid",
    validationError: null,
    createdBy: actor.id,
    createdAt: createdAt,
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

function whereTouchesColumn(expr: unknown, columnName: string): boolean {
  const seen = new Set<unknown>();
  const walk = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (record.name === columnName && "columnType" in record) return true;
    return Object.values(record).some(walk);
  };
  return walk(expr);
}

function whereMentions(expr: unknown, value: string): boolean {
  const seen = new Set<unknown>();
  const walk = (node: unknown): boolean => {
    if (node === value) return true;
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    return Object.values(node as Record<string, unknown>).some(walk);
  };
  return walk(expr);
}

function fakeDb({
  orgRole = "developer",
  ownerTeamRole = "editor",
  memberOfTeams = true,
  existingSkill = { id: "skill-one-team", ownerId: "other-user", ownerTeamId: null as string | null },
  extraSkills = [] as ReturnType<typeof skillRow>[],
  versions = [] as ReturnType<typeof skillVersionRow>[],
  edges = [] as Array<{ skillId: string; skillVersionId: string; dependsOnSlug: string; dependsOnSkillId: string | null }>,
}: {
  orgRole?: "owner" | "admin" | "developer" | null;
  ownerTeamRole?: "admin" | "editor" | "reader" | null;
  memberOfTeams?: boolean;
  existingSkill?: { id: string; ownerId: string; ownerTeamId: string | null } | null;
  extraSkills?: ReturnType<typeof skillRow>[];
  versions?: ReturnType<typeof skillVersionRow>[];
  edges?: Array<{ skillId: string; skillVersionId: string; dependsOnSlug: string; dependsOnSkillId: string | null }>;
} = {}) {
  const writes = {
    updates: [] as Array<Record<string, unknown>>,
    deletes: [] as unknown[],
    skillListWhere: undefined as unknown,
    mineWheres: [] as unknown[],
  };
  const skills = [
    skillRow("skill-private", "private-skill"),
    skillRow("skill-other", "other-personal-skill", { userId: "other-user", name: "Other User" }),
    skillRow("skill-owner-team", "owner-team-skill", {
      kind: "team",
      userId: "creator-user",
      teamId: "team-platform",
      name: "Platform",
    }),
    ...extraSkills,
  ];

  const database: Record<string, unknown> = {
    __writes: writes,
    query: {
      memberships: {
        findFirst: vi.fn(async () => (orgRole ? { orgRole } : null)),
      },
      skills: {
        findFirst: vi.fn(async () => existingSkill),
      },
      teams: {
        findFirst: vi.fn(async () => ({ id: "team-platform", slug: "platform", name: "Platform" })),
      },
      teamMemberships: {
        findFirst: vi.fn(async () => (ownerTeamRole ? { teamRole: ownerTeamRole } : null)),
      },
    },
    select: vi.fn((cols?: Record<string, unknown>) => {
      if (!cols) return selectChain(versions); // listSkillVersions select()
      // The caller's per-skill install rows (none in these fixtures). Keyed on skill_id + version.
      if ("installed_version" in cols) return selectChain([]);
      // loadDepGraph's current-version dependency edges.
      if ("dependsOnSlug" in cols && "skillVersionId" in cols) return selectChain(edges);
      // The publish monotonic-version check selects exactly {version}.
      if ("version" in cols) return selectChain([]);
      // The `mine` filter's editable-team subquery selects {teamId} from team_memberships.
      if ("teamId" in cols) {
        const chain = selectChain(memberOfTeams ? [{ teamId: "team-platform" }] : []);
        const originalWhere = chain.where as (expr: unknown) => typeof chain;
        chain.where = vi.fn((expr: unknown) => {
          writes.mineWheres.push(expr);
          return originalWhere(expr);
        });
        return chain;
      }
      // listSkills' main grouped select (uniquely carries owner_user_id).
      if ("owner_user_id" in cols) {
        const chain = selectChain(skills);
        const originalWhere = chain.where as (expr: unknown) => typeof chain;
        chain.where = vi.fn((expr: unknown) => {
          writes.skillListWhere = expr;
          return originalWhere(expr);
        });
        return chain;
      }
      // loadDepGraph's skills select (camelCase ownerId/currentVersion).
      if ("ownerId" in cols && "currentVersion" in cols) return selectChain(skills);
      // referencedRows selects {slug} only.
      if ("slug" in cols && !("id" in cols)) return selectChain([]);
      // visibleSkillIds selects {id} only.
      if ("id" in cols) return selectChain(skills);
      return selectChain([]);
    }),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        writes.updates.push(patch);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    delete: vi.fn((table: unknown) => {
      writes.deletes.push(table);
      return { where: vi.fn(async () => undefined) };
    }),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(database)),
  };
  return database as unknown as Db;
}

function publishPayload(slug: string, ownerTeam?: string | null) {
  return {
    slug,
    owner_team: ownerTeam,
    version: "1.1.0",
    note: "",
    description: slug,
    checksum: `sha256:${"a".repeat(64)}`,
    storage_path: `skills/org/${slug}/1.1.0.zip`,
    size_bytes: 123,
    frontmatter: `---\nname: ${slug}\n---`,
    body: "",
    tools: [],
    dependencies: [],
  };
}

describe("listSkills owner assembly", () => {
  it("denies non-members before any visibility is evaluated", async () => {
    await expect(listSkills({ actor, orgId: ORG, database: fakeDb({ orgRole: null }) })).rejects.toThrow(
      "not a member of this organization",
    );
  });

  it("maps each skill's owner kind (personal vs team)", async () => {
    const rows = await listSkills({ actor, orgId: ORG, database: fakeDb() });
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    expect(bySlug.get("private-skill")?.owner_kind).toBe("user");
    expect(bySlug.get("private-skill")?.owner_team_id).toBeNull();
    expect(bySlug.get("owner-team-skill")?.owner_kind).toBe("team");
    expect(bySlug.get("owner-team-skill")?.owner_team_id).toBe("team-platform");
    // The legacy visibility field is gone from the read shape.
    expect("visibility" in bySlug.get("private-skill")!).toBe(false);
  });

  // The owner read predicate (team-owned → all; personal → owner) can't be proven via the WHERE
  // expression — Drizzle column→table back-refs make whereTouchesColumn reach every column. Its
  // shape is exercised behaviorally by the publish/owner authorization tests below; the `mine`
  // subquery (a genuine literal-bearing predicate) is asserted here instead.
  it("the `mine` filter keys off editable team memberships (admin/editor only)", async () => {
    const database = fakeDb() as Db & { __writes: { mineWheres: unknown[] } };
    await listSkills({ actor, orgId: ORG, mine: true, database });
    expect(database.__writes.mineWheres.some((where) => whereTouchesColumn(where, "team_role"))).toBe(true);
    expect(database.__writes.mineWheres.some((where) => whereMentions(where, "admin"))).toBe(true);
    expect(database.__writes.mineWheres.some((where) => whereMentions(where, "editor"))).toBe(true);
  });

  it("normalizes companion display and setup requirements from stored version metadata", async () => {
    const frontmatter = JSON.stringify({
      name: "manifest-skill",
      description: "SKILL.md fallback.",
      metadata: {},
      companion: {
        display: { name: "Manifest skill", summary: "Manifest summary.", description: "Manifest long description." },
        requirements: [{ key: "OPENAI_API_KEY", type: "secret", required: true, note: "Ask an admin." }],
        dependencies: [],
      },
    });
    const rows = await listSkills({
      actor,
      orgId: ORG,
      database: fakeDb({
        extraSkills: [skillRow("skill-manifest", "manifest-skill", { frontmatter, description: "Manifest summary." })],
      }),
    });
    const skill = rows.find((row) => row.slug === "manifest-skill");
    expect(skill?.description).toBe("Manifest summary.");
    expect(skill?.display).toEqual({
      name: "Manifest skill",
      summary: "Manifest summary.",
      description: "Manifest long description.",
    });
    expect(skill?.requirements.map((req) => req.key)).toEqual(["OPENAI_API_KEY"]);
  });

  it("normalizes companion display and setup requirements on version rows", async () => {
    const frontmatter = JSON.stringify({
      name: "versioned-skill",
      description: "SKILL.md long fallback.",
      metadata: {},
      companion: {
        display: { name: "Versioned skill", summary: "Version summary." },
        requirements: [{ key: "API_TOKEN", type: "secret", required: true, note: "Ask an admin." }],
        dependencies: [],
      },
    });
    const rows = await listSkillVersions({
      actor,
      orgId: ORG,
      slug: "versioned-skill",
      database: fakeDb({
        extraSkills: [skillRow("skill-versioned", "versioned-skill", { frontmatter, description: "Version summary." })],
        versions: [skillVersionRow("skill-versioned", frontmatter)],
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.display).toEqual({
      name: "Versioned skill",
      summary: "Version summary.",
      description: "SKILL.md long fallback.",
    });
    expect(rows[0]?.requirements.map((req) => req.key)).toEqual(["API_TOKEN"]);
  });
});

describe("assertCanPublishSkillVersion (publish authorization)", () => {
  it("lets owner-team editors publish new versions of team-owned skills", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({
          ownerTeamRole: "editor",
          existingSkill: { id: "skill-owner-team", ownerId: "creator-user", ownerTeamId: "team-platform" },
        }),
        payload: publishPayload("owner-team-skill", "platform"),
      }),
    ).resolves.toBe(null);
  });

  it("keeps owner-team readers read-only for team-owned skills", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({
          ownerTeamRole: "reader",
          existingSkill: { id: "skill-owner-team", ownerId: "creator-user", ownerTeamId: "team-platform" },
        }),
        // owner_team omitted on a re-publish (the owner is immutable) → the modify gate denies the reader.
        payload: publishPayload("owner-team-skill"),
      }),
    ).rejects.toThrow("not allowed to publish this skill");
  });

  it("does not let a developer publish another user's personal skill", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({
          existingSkill: { id: "skill-other", ownerId: "other-user", ownerTeamId: null },
        }),
        payload: publishPayload("other-personal-skill"),
      }),
    ).rejects.toThrow("not allowed to publish this skill");
  });

  it("rejects changing the owner on publish (owner is immutable; use setSkillOwner)", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({
          ownerTeamRole: "editor",
          existingSkill: { id: "skill-private", ownerId: actor.id, ownerTeamId: null },
        }),
        payload: publishPayload("private-skill", "platform"),
      }),
    ).rejects.toThrow("skill owner cannot be changed by publish");
  });

  it("lets developers create team-owned skills for teams they can edit", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ ownerTeamRole: "editor", existingSkill: null }),
        payload: publishPayload("new-team-skill", "platform"),
      }),
    ).resolves.toEqual({ id: "team-platform", slug: "platform", name: "Platform" });
  });

  it("prevents developers from creating team-owned skills for read-only teams", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ ownerTeamRole: "reader", existingSkill: null }),
        payload: publishPayload("new-team-skill", "platform"),
      }),
    ).rejects.toThrow("not allowed to create skills for this team");
  });

  // Regression: on a re-publish the client omits owner_team (the owner is immutable), so the
  // dependency cover check must model the skill at its ACTUAL existing owner — not as Personal.
  it("blocks a team-owned skill from depending on a Personal skill, even on re-publish", async () => {
    await expect(
      assertDependenciesResolvable({
        actor,
        orgId: ORG,
        slug: "owner-team-skill", // existing team-owned skill
        dependencies: ["private-skill"], // a Personal skill (owned by the actor) — less visible
        ownerTeam: undefined, // re-publish keeps the existing team owner
        database: fakeDb(),
      }),
    ).rejects.toBeInstanceOf(DependencyPublishError);
  });

  it("allows a team-owned skill to depend on another team-owned skill", async () => {
    await expect(
      assertDependenciesResolvable({
        actor,
        orgId: ORG,
        slug: "owner-team-skill",
        dependencies: ["dep-team-skill"],
        ownerTeam: undefined,
        database: fakeDb({
          extraSkills: [skillRow("skill-dep-team", "dep-team-skill", { kind: "team", teamId: "team-data", name: "Data" })],
        }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("setSkillOwner authorization", () => {
  it("lets a personal owner move their skill to a team they can edit", async () => {
    const database = fakeDb({ ownerTeamRole: "editor" }) as Db & { __writes: { updates: Array<Record<string, unknown>> } };
    await setSkillOwner({ actor, orgId: ORG, slug: "private-skill", ownerTeam: "platform", database });
    expect(database.__writes.updates).toEqual([expect.objectContaining({ ownerTeamId: "team-platform" })]);
  });

  it("lets an owner-team editor move a team-owned skill back to Personal, taking ownership", async () => {
    const database = fakeDb({ ownerTeamRole: "editor" }) as Db & { __writes: { updates: Array<Record<string, unknown>> } };
    await setSkillOwner({ actor, orgId: ORG, slug: "owner-team-skill", ownerTeam: null, database });
    // "Personal" = private to the actor: ownership transfers to whoever made the change (here user-1),
    // not the original creator ("creator-user"), so the editor keeps access.
    expect(database.__writes.updates).toEqual([
      expect.objectContaining({ ownerTeamId: null, ownerId: actor.id }),
    ]);
  });

  it("keeps owner-team readers read-only", async () => {
    await expect(
      setSkillOwner({
        actor,
        orgId: ORG,
        slug: "owner-team-skill",
        ownerTeam: null,
        database: fakeDb({ ownerTeamRole: "reader" }),
      }),
    ).rejects.toThrow("not allowed to change this skill");
  });

  it("does not let a developer change another user's personal skill", async () => {
    await expect(
      setSkillOwner({
        actor,
        orgId: ORG,
        slug: "other-personal-skill",
        ownerTeam: "platform",
        database: fakeDb({ ownerTeamRole: "editor" }),
      }),
    ).rejects.toThrow("not allowed to change this skill");
  });

  it("denies non-members before any owner mutation", async () => {
    await expect(
      setSkillOwner({ actor, orgId: ORG, slug: "private-skill", ownerTeam: "platform", database: fakeDb({ orgRole: null }) }),
    ).rejects.toThrow("not a member of this organization");
  });

  it("blocks making a skill Personal when a team-owned skill depends on it", async () => {
    // dependent-skill (team-owned) requires owner-team-skill via its current version.
    const database = fakeDb({
      orgRole: "admin",
      extraSkills: [skillRow("skill-dependent", "dependent-skill", { kind: "team", teamId: "team-data", name: "Data" })],
      edges: [
        {
          skillId: "skill-dependent",
          skillVersionId: "skill-dependent-cv",
          dependsOnSlug: "owner-team-skill",
          dependsOnSkillId: "skill-owner-team",
        },
      ],
    });
    await expect(
      setSkillOwner({ actor, orgId: ORG, slug: "owner-team-skill", ownerTeam: null, database }),
    ).rejects.toThrow("cannot make this skill Personal: dependent-skill depends on it");
  });
});
