import { describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@companion/db";
import {
  assertCanPublishSkillVersion,
  listOrgTags,
  listSkillVersions,
  listSkills,
  setSkillTags,
  setSkillVisibility,
  type ActorContext,
} from "../src/services";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const actor: ActorContext = { id: "user-1", email: "user@example.com", name: "User One" };

const createdAt = new Date("2026-06-09T12:00:00.000Z");

function skillRow(
  id: string,
  slug: string,
  everyone: boolean,
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
  const ownerKind = owner.kind ?? "user";
  const ownerUserId = owner.userId ?? actor.id;
  const ownerTeamId = owner.teamId ?? null;
  const ownerName = owner.name ?? (ownerKind === "team" ? "Platform" : "User One");
  return {
    id,
    org_id: ORG,
    slug,
    description: owner.description ?? slug,
    everyone,
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
      JSON.stringify({
        name: slug,
        description: slug,
        metadata: {},
      }),
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
  const values = (node: object) => Reflect.ownKeys(node).map((key) => (node as Record<PropertyKey, unknown>)[key]);
  const walk = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (record.name === columnName && "columnType" in record) return true;
    return values(node).some(walk);
  };
  return walk(expr);
}

function whereMentions(expr: unknown, value: string): boolean {
  const seen = new Set<unknown>();
  const values = (node: object) => Reflect.ownKeys(node).map((key) => (node as Record<PropertyKey, unknown>)[key]);
  const walk = (node: unknown): boolean => {
    if (node === value) return true;
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    return values(node).some(walk);
  };
  return walk(expr);
}

function fakeDb({
  orgRole = "developer",
  sharedTeamRole = "editor",
  ownerTeamRole = "editor",
  memberOfVisibilityTeams = true,
  existingSkill = { id: "skill-one-team", ownerId: "other-user", ownerTeamId: null as string | null },
  extraSkills = [] as ReturnType<typeof skillRow>[],
  versions = [] as ReturnType<typeof skillVersionRow>[],
  tagRows = [] as Array<{ skill_id: string; tag: string }>,
  orgTagRows = [] as Array<{ tag: string; n: number }>,
  edges = [] as Array<{ skillId: string; skillVersionId: string; dependsOnSlug: string; dependsOnSkillId: string | null }>,
}: {
  orgRole?: "owner" | "admin" | "developer" | null;
  sharedTeamRole?: "admin" | "editor" | "reader" | null;
  ownerTeamRole?: "admin" | "editor" | "reader" | null;
  memberOfVisibilityTeams?: boolean;
  existingSkill?: { id: string; ownerId: string; ownerTeamId: string | null } | null;
  extraSkills?: ReturnType<typeof skillRow>[];
  versions?: ReturnType<typeof skillVersionRow>[];
  tagRows?: Array<{ skill_id: string; tag: string }>;
  orgTagRows?: Array<{ tag: string; n: number }>;
  edges?: Array<{ skillId: string; skillVersionId: string; dependsOnSlug: string; dependsOnSkillId: string | null }>;
} = {}) {
  const writes = {
    updates: [] as Array<Record<string, unknown>>,
    deletes: [] as unknown[],
    insertedShares: [] as unknown[],
    insertedTags: [] as unknown[],
    tagFilterQueried: false,
    tagFilterWhere: undefined as unknown,
    skillListWhere: undefined as unknown,
    orgTagsWhere: undefined as unknown,
    teamIdWheres: [] as unknown[],
  };
  const skills = [
    skillRow("skill-private", "private-skill", false),
    skillRow("skill-everyone", "everyone-skill", true),
    skillRow("skill-one-team", "one-team-skill", false, { userId: "other-user", name: "Other User" }),
    skillRow("skill-multi-team", "multi-team-skill", false, { userId: "other-user", name: "Other User" }),
    skillRow("skill-everyone-team", "everyone-team-skill", true, { userId: "other-user", name: "Other User" }),
    skillRow("skill-owner-team", "owner-team-skill", false, {
      kind: "team",
      userId: "creator-user",
      teamId: "team-platform",
      name: "Platform",
    }),
    ...extraSkills,
  ];
  const shares = [
    { skill_id: "skill-one-team", id: "team-platform", slug: "platform", name: "Platform" },
    { skill_id: "skill-multi-team", id: "team-data", slug: "data", name: "Data" },
    { skill_id: "skill-multi-team", id: "team-platform", slug: "platform", name: "Platform" },
    { skill_id: "skill-everyone-team", id: "team-platform", slug: "platform", name: "Platform" },
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
      if (!cols) return selectChain(versions);
      if ("one" in cols) {
        const chain = selectChain([]);
        const originalFrom = chain.from as (table: unknown) => typeof chain;
        chain.from = vi.fn((table: unknown) => {
          if (table === schema.skillTags) writes.tagFilterQueried = true;
          return originalFrom(table);
        });
        const originalWhere = chain.where as (expr: unknown) => typeof chain;
        chain.where = vi.fn((expr: unknown) => {
          writes.tagFilterWhere = expr;
          return originalWhere(expr);
        });
        return chain;
      }
      // The caller's per-skill install rows (none in these visibility fixtures). Must precede the
      // shares branch below, which also keys on skill_id.
      if ("skill_id" in cols && "installed_version" in cols) return selectChain([]);
      if ("skill_id" in cols && "tag" in cols) return selectChain(tagRows);
      if ("tag" in cols && "n" in cols) {
        const chain = selectChain(orgTagRows);
        const originalWhere = chain.where as (expr: unknown) => typeof chain;
        chain.where = vi.fn((expr: unknown) => {
          writes.orgTagsWhere = expr;
          return originalWhere(expr);
        });
        return chain;
      }
      if ("skill_id" in cols) return selectChain(shares);
      // loadDepGraph's current-version dependency edges (distinct from listSkills' referencedRows).
      if ("dependsOnSlug" in cols && "skillVersionId" in cols) return selectChain(edges);
      // loadDepGraph's team-share rows (camelCase {skillId, teamId}); membership query is {teamId} only.
      if ("skillId" in cols && "teamId" in cols) return selectChain([]);
      if ("teamRole" in cols) return selectChain(sharedTeamRole ? [{ teamRole: sharedTeamRole }] : []);
      if ("teamId" in cols) {
        const chain = selectChain(memberOfVisibilityTeams ? [{ teamId: "team-platform" }] : []);
        const originalWhere = chain.where as (expr: unknown) => typeof chain;
        chain.where = vi.fn((expr: unknown) => {
          writes.teamIdWheres.push(expr);
          return originalWhere(expr);
        });
        return chain;
      }
      if ("version" in cols) return selectChain([]);
      if ("id" in cols && "slug" in cols && "name" in cols) {
        return selectChain([{ id: "team-platform", slug: "platform", name: "Platform" }]);
      }
      if ("id" in cols && "slug" in cols && "everyone" in cols) {
        const chain = selectChain(skills);
        const originalWhere = chain.where as (expr: unknown) => typeof chain;
        chain.where = vi.fn((expr: unknown) => {
          writes.skillListWhere = expr;
          return originalWhere(expr);
        });
        return chain;
      }
      return selectChain([]);
    }),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        writes.updates.push(patch);
        return {
          where: vi.fn(async () => undefined),
        };
      }),
    })),
    delete: vi.fn((table: unknown) => {
      writes.deletes.push(table);
      return {
        where: vi.fn(async () => undefined),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async (rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows];
        if (list.some((row) => row && typeof row === "object" && "tag" in row)) {
          writes.insertedTags.push(...list);
        } else {
          writes.insertedShares.push(...list);
        }
      }),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(database)),
  };
  return database as unknown as Db;
}

function publishPayload(
  slug: string,
  visibility: { everyone: boolean; teams: string[] } = { everyone: false, teams: ["platform"] },
  ownerTeam?: string | null,
) {
  return {
    slug,
    owner_team: ownerTeam,
    visibility,
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

  it("includes mutable tags from the batched tag query", async () => {
    const rows = await listSkills({
      actor,
      orgId: ORG,
      database: fakeDb({
        tagRows: [
          { skill_id: "skill-private", tag: "automation" },
          { skill_id: "skill-private", tag: "incident response" },
          { skill_id: "skill-everyone", tag: "shared" },
        ],
      }),
    });

    expect(rows.find((row) => row.slug === "private-skill")?.tags).toEqual([
      "automation",
      "incident response",
    ]);
    expect(rows.find((row) => row.slug === "everyone-skill")?.tags).toEqual(["shared"]);
  });

  it("adds an EXISTS tag predicate when tag filters are supplied", async () => {
    const database = fakeDb() as Db & { __writes: { tagFilterQueried: boolean; tagFilterWhere: unknown } };

    await listSkills({ actor, orgId: ORG, tags: ["Ops", "incident response"], database });

    expect(database.__writes.tagFilterQueried).toBe(true);
    expect(whereTouchesColumn(database.__writes.tagFilterWhere, "org_id")).toBe(true);
    expect(whereTouchesColumn(database.__writes.tagFilterWhere, "skill_id")).toBe(true);
  });

  it("lists visible org tags in service-provided frequency order", async () => {
    const database = fakeDb({
      orgTagRows: [
        { tag: "ops", n: 3 },
        { tag: "automation", n: 2 },
        { tag: "incident response", n: 2 },
      ],
    }) as Db & { __writes: { orgTagsWhere: unknown } };

    await expect(listOrgTags({ actor, orgId: ORG, database })).resolves.toEqual([
      "ops",
      "automation",
      "incident response",
    ]);
    expect(whereTouchesColumn(database.__writes.orgTagsWhere, "org_id")).toBe(true);
  });

  it("normalizes companion display and setup requirements from stored version metadata", async () => {
    const frontmatter = JSON.stringify({
      name: "manifest-skill",
      description: "SKILL.md fallback.",
      metadata: {},
      companion: {
        display: {
          name: "Manifest skill",
          summary: "Manifest summary.",
          description: "Manifest long description.",
        },
        requirements: [{ key: "OPENAI_API_KEY", type: "secret", required: true, note: "Ask an admin." }],
        dependencies: [],
      },
    });
    const rows = await listSkills({
      actor,
      orgId: ORG,
      database: fakeDb({
        extraSkills: [skillRow("skill-manifest", "manifest-skill", false, { frontmatter, description: "Manifest summary." })],
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
        display: {
          name: "Versioned skill",
          summary: "Version summary.",
        },
        requirements: [{ key: "API_TOKEN", type: "secret", required: true, note: "Ask an admin." }],
        dependencies: [],
      },
    });
    const rows = await listSkillVersions({
      actor,
      orgId: ORG,
      slug: "versioned-skill",
      database: fakeDb({
        extraSkills: [
          skillRow("skill-versioned", "versioned-skill", false, {
            frontmatter,
            description: "Version summary.",
          }),
        ],
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

  it("builds owner-team read visibility from editable team memberships only", async () => {
    const database = fakeDb() as Db & { __writes: { teamIdWheres: unknown[] } };

    await listSkills({ actor, orgId: ORG, database });

    expect(database.__writes.teamIdWheres.some((where) => whereTouchesColumn(where, "team_role"))).toBe(true);
    expect(database.__writes.teamIdWheres.some((where) => whereMentions(where, "admin"))).toBe(true);
    expect(database.__writes.teamIdWheres.some((where) => whereMentions(where, "editor"))).toBe(true);
  });

  it("does not let team editors publish existing skills only shared with their team", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ sharedTeamRole: "editor" }),
        payload: publishPayload("one-team-skill"),
      }),
    ).rejects.toThrow("not allowed to publish this skill");
  });

  it("lets owner team editors publish new versions of team-owned skills", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({
          ownerTeamRole: "editor",
          existingSkill: { id: "skill-owner-team", ownerId: "creator-user", ownerTeamId: "team-platform" },
        }),
        payload: publishPayload("owner-team-skill"),
      }),
    ).resolves.toBe(null);
  });

  it("keeps owner team readers read-only for team-owned skills", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({
          ownerTeamRole: "reader",
          existingSkill: { id: "skill-owner-team", ownerId: "creator-user", ownerTeamId: "team-platform" },
        }),
        payload: publishPayload("owner-team-skill"),
      }),
    ).rejects.toThrow("not allowed to publish this skill");
  });

  it("prevents visibility-team editors from broadening someone else's shared skill to everyone", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ sharedTeamRole: "editor" }),
        payload: publishPayload("one-team-skill", { everyone: true, teams: ["platform"] }),
      }),
    ).rejects.toThrow("not allowed to publish this skill");
  });

  it("prevents team editors from publishing someone else's everyone-visible skill through a team share", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ sharedTeamRole: "editor" }),
        payload: publishPayload("everyone-team-skill", { everyone: true, teams: ["platform"] }),
      }),
    ).rejects.toThrow("not allowed to publish this skill");
  });

  it("lets developers create team-owned skills for teams they can edit", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ ownerTeamRole: "editor", existingSkill: null }),
        payload: publishPayload("new-team-skill", { everyone: false, teams: [] }, "platform"),
      }),
    ).resolves.toEqual({ id: "team-platform", slug: "platform", name: "Platform" });
  });

  it("prevents developers from creating team-owned skills for read-only teams", async () => {
    await expect(
      assertCanPublishSkillVersion({
        actor,
        orgId: ORG,
        database: fakeDb({ ownerTeamRole: "reader", existingSkill: null }),
        payload: publishPayload("new-team-skill", { everyone: false, teams: [] }, "platform"),
      }),
    ).rejects.toThrow("not allowed to create skills for this team");
  });
});

describe("setSkillVisibility authorization", () => {
  it("lets a direct user owner update everyone and team shares", async () => {
    const database = fakeDb() as Db & { __writes: { updates: Array<Record<string, unknown>>; insertedShares: unknown[] } };

    await setSkillVisibility({
      actor,
      orgId: ORG,
      slug: "private-skill",
      visibility: { everyone: true, teams: ["platform"] },
      database,
    });

    expect(database.__writes.updates).toEqual([expect.objectContaining({ everyone: true })]);
    expect(database.__writes.insertedShares).toEqual([
      { orgId: ORG, skillId: "skill-private", teamId: "team-platform" },
    ]);
  });

  it("lets owner team editors update team-owned skill visibility", async () => {
    const database = fakeDb({ ownerTeamRole: "editor" }) as Db & { __writes: { updates: Array<Record<string, unknown>>; insertedShares: unknown[] } };

    await setSkillVisibility({
      actor,
      orgId: ORG,
      slug: "owner-team-skill",
      visibility: { everyone: false, teams: [] },
      database,
    });

    expect(database.__writes.updates).toEqual([expect.objectContaining({ everyone: false })]);
    expect(database.__writes.insertedShares).toEqual([]);
  });

  it("keeps owner team readers read-only", async () => {
    await expect(
      setSkillVisibility({
        actor,
        orgId: ORG,
        slug: "owner-team-skill",
        visibility: { everyone: true, teams: [] },
        database: fakeDb({ ownerTeamRole: "reader" }),
      }),
    ).rejects.toThrow("not allowed to change this skill");
  });

  it("does not let visibility-team editors mutate someone else's skill", async () => {
    await expect(
      setSkillVisibility({
        actor,
        orgId: ORG,
        slug: "one-team-skill",
        visibility: { everyone: true, teams: ["platform"] },
        database: fakeDb({ sharedTeamRole: "editor" }),
      }),
    ).rejects.toThrow("not allowed to change this skill");
  });

  it("prevents developers from sharing to teams they do not belong to", async () => {
    await expect(
      setSkillVisibility({
        actor,
        orgId: ORG,
        slug: "private-skill",
        visibility: { everyone: false, teams: ["platform"] },
        database: fakeDb({ memberOfVisibilityTeams: false }),
      }),
    ).rejects.toThrow("not allowed to change this skill");
  });

  it("lets org admins share to any team", async () => {
    const database = fakeDb({ orgRole: "admin", memberOfVisibilityTeams: false }) as Db & { __writes: { insertedShares: unknown[] } };

    await setSkillVisibility({
      actor,
      orgId: ORG,
      slug: "one-team-skill",
      visibility: { everyone: false, teams: ["platform"] },
      database,
    });

    expect(database.__writes.insertedShares).toEqual([
      { orgId: ORG, skillId: "skill-one-team", teamId: "team-platform" },
    ]);
  });

  it("denies non-members before visibility mutation", async () => {
    await expect(
      setSkillVisibility({
        actor,
        orgId: ORG,
        slug: "private-skill",
        visibility: { everyone: true, teams: [] },
        database: fakeDb({ orgRole: null }),
      }),
    ).rejects.toThrow("not a member of this organization");
  });
});

describe("setSkillTags authorization", () => {
  it("lets a direct user owner replace tags with normalized unique values", async () => {
    const database = fakeDb() as Db & { __writes: { insertedTags: unknown[] } };

    await expect(
      setSkillTags({
        actor,
        orgId: ORG,
        slug: "private-skill",
        tags: [" Ops ", "ops", "incident response"],
        database,
      }),
    ).resolves.toEqual({ tags: ["incident response", "ops"] });

    expect(database.__writes.insertedTags).toEqual([
      { orgId: ORG, skillId: "skill-private", tag: "incident response", createdBy: actor.id },
      { orgId: ORG, skillId: "skill-private", tag: "ops", createdBy: actor.id },
    ]);
  });

  it("lets owner-team editors replace tags on team-owned skills", async () => {
    const database = fakeDb({ ownerTeamRole: "editor" }) as Db & { __writes: { insertedTags: unknown[] } };

    await setSkillTags({
      actor,
      orgId: ORG,
      slug: "owner-team-skill",
      tags: ["platform"],
      database,
    });

    expect(database.__writes.insertedTags).toEqual([
      { orgId: ORG, skillId: "skill-owner-team", tag: "platform", createdBy: actor.id },
    ]);
  });

  it("keeps owner-team readers read-only for tags", async () => {
    await expect(
      setSkillTags({
        actor,
        orgId: ORG,
        slug: "owner-team-skill",
        tags: ["platform"],
        database: fakeDb({ ownerTeamRole: "reader" }),
      }),
    ).rejects.toThrow("not allowed to change this skill");
  });

  it("does not let visibility-team editors tag someone else's shared skill", async () => {
    await expect(
      setSkillTags({
        actor,
        orgId: ORG,
        slug: "one-team-skill",
        tags: ["shared"],
        database: fakeDb({ sharedTeamRole: "editor" }),
      }),
    ).rejects.toThrow("not allowed to change this skill");
  });

  it("denies non-members before tag mutation", async () => {
    await expect(
      setSkillTags({
        actor,
        orgId: ORG,
        slug: "private-skill",
        tags: ["ops"],
        database: fakeDb({ orgRole: null }),
      }),
    ).rejects.toThrow("not a member of this organization");
  });

  it("enforces the shared tag count limit in the service layer", async () => {
    await expect(
      setSkillTags({
        actor,
        orgId: ORG,
        slug: "private-skill",
        tags: Array.from({ length: 33 }, (_, i) => `tag ${i}`),
        database: fakeDb(),
      }),
    ).rejects.toThrow();
  });
});

describe("setSkillVisibility dependency cascade", () => {
  // private-skill (owned by the actor) requires dep-skill via its current version.
  const requiresDep = (depOwner: Parameters<typeof skillRow>[3] = {}) => ({
    extraSkills: [skillRow("skill-dep", "dep-skill", false, depOwner)],
    edges: [
      {
        skillId: "skill-private",
        skillVersionId: "skill-private-cv",
        dependsOnSlug: "dep-skill",
        dependsOnSkillId: "skill-dep",
      },
    ],
  });

  it("rejects broadening past a less-visible dependency without cascade", async () => {
    await expect(
      setSkillVisibility({
        actor,
        orgId: ORG,
        slug: "private-skill",
        visibility: { everyone: true, teams: [] },
        database: fakeDb(requiresDep()),
      }),
    ).rejects.toThrow("cannot broaden visibility: dependency dep-skill");
  });

  it("raises the dependency to match when cascade is set", async () => {
    const database = fakeDb(requiresDep()) as Db & {
      __writes: { updates: Array<Record<string, unknown>>; insertedShares: unknown[] };
    };

    const result = await setSkillVisibility({
      actor,
      orgId: ORG,
      slug: "private-skill",
      visibility: { everyone: true, teams: [] },
      cascade: true,
      database,
    });

    expect(result).toEqual({ cascaded: ["dep-skill"] });
    // Both the skill and its dependency are flipped to everyone in the same transaction.
    expect(database.__writes.updates).toEqual([
      expect.objectContaining({ everyone: true }),
      expect.objectContaining({ everyone: true }),
    ]);
  });

  it("rejects the cascade when the actor cannot modify a dependency", async () => {
    await expect(
      setSkillVisibility({
        actor,
        orgId: ORG,
        slug: "private-skill",
        visibility: { everyone: true, teams: [] },
        cascade: true,
        // dep-skill is owned by a team where the actor is only a reader.
        database: fakeDb({
          ownerTeamRole: "reader",
          ...requiresDep({ kind: "team", userId: "creator", teamId: "team-x", name: "X" }),
        }),
      }),
    ).rejects.toThrow("cannot update sub-skill dep-skill");
  });
});

describe("setSkillVisibility dependent (narrowing) cascade", () => {
  // dependent-skill (the dependent) requires everyone-skill (the parent being narrowed).
  const dependedOnBy = (dependent: Parameters<typeof skillRow>[3] = {}, everyone = true) => ({
    extraSkills: [skillRow("skill-dependent", "dependent-skill", everyone, dependent)],
    edges: [
      {
        skillId: "skill-dependent",
        skillVersionId: "skill-dependent-cv",
        dependsOnSlug: "everyone-skill",
        dependsOnSkillId: "skill-everyone",
      },
    ],
  });

  it("rejects narrowing that would strand a dependent without cascade", async () => {
    await expect(
      setSkillVisibility({
        actor,
        orgId: ORG,
        slug: "everyone-skill",
        visibility: { everyone: false, teams: [] },
        database: fakeDb(dependedOnBy()),
      }),
    ).rejects.toThrow("cannot narrow visibility: dependent-skill depends on this skill");
  });

  it("restricts the dependent to match when cascade is set", async () => {
    const database = fakeDb(dependedOnBy()) as Db & {
      __writes: { updates: Array<Record<string, unknown>> };
    };

    const result = await setSkillVisibility({
      actor,
      orgId: ORG,
      slug: "everyone-skill",
      visibility: { everyone: false, teams: [] },
      cascade: true,
      database,
    });

    expect(result).toEqual({ cascaded: ["dependent-skill"] });
    // Both the skill and its dependent are narrowed to private in the same transaction.
    expect(database.__writes.updates).toEqual([
      expect.objectContaining({ everyone: false }),
      expect.objectContaining({ everyone: false }),
    ]);
  });

  it("rejects narrowing when a dependent's owner team is outside the new audience", async () => {
    await expect(
      setSkillVisibility({
        actor,
        orgId: ORG,
        slug: "everyone-skill",
        visibility: { everyone: false, teams: [] },
        cascade: true,
        // dependent-skill is owned by team-x, which is not in the new (private) audience.
        database: fakeDb({
          orgRole: "admin",
          ...dependedOnBy({ kind: "team", userId: "creator", teamId: "team-x", name: "X" }, false),
        }),
      }),
    ).rejects.toThrow("would stay visible to an owner outside the new audience");
  });

  it("rejects narrowing to private when a dependent is owned by another user", async () => {
    await expect(
      setSkillVisibility({
        actor,
        orgId: ORG,
        slug: "everyone-skill",
        visibility: { everyone: false, teams: [] },
        cascade: true,
        // dependent-skill is owned by another user, who would keep seeing it but lose the dependency.
        database: fakeDb({
          orgRole: "admin",
          ...dependedOnBy({ userId: "other-user", name: "Other User" }, true),
        }),
      }),
    ).rejects.toThrow("would stay visible to an owner outside the new audience");
  });

  it("does not silently skip a private dependent owned by another user", async () => {
    // A private dependent reads as "covered" by visibilityCovers, but its owner still can't see the
    // narrowed dependency — the cascade must reject it rather than skip it.
    await expect(
      setSkillVisibility({
        actor,
        orgId: ORG,
        slug: "everyone-skill",
        visibility: { everyone: false, teams: [] },
        cascade: true,
        database: fakeDb({
          orgRole: "admin",
          ...dependedOnBy({ userId: "other-user", name: "Other User" }, false),
        }),
      }),
    ).rejects.toThrow("would stay visible to an owner outside the new audience");
  });
});
