import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import { listSkills, type ActorContext } from "../src/services";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const actor: ActorContext = { id: "user-1", email: "ada@example.test", name: "Ada Lovelace" };
const now = new Date("2026-06-26T10:00:00.000Z");
const avatarUpdatedAt = new Date("2026-06-26T11:00:00.000Z");

function mainRow() {
  return {
    id: "skill-1",
    share_token: "share-1",
    org_id: ORG,
    slug: "seo-helper",
    description: "SEO helper.",
    display_name: null,
    scope: "org",
    validation: "valid",
    validation_error: null,
    creator_id: actor.id,
    creator_name: actor.name,
    creator_initials: "AL",
    creator_email: actor.email,
    creator_avatar_url: null,
    creator_updated_at: now,
    labels: [],
    current_version: "1.0.0",
    license: null,
    frontmatter: "{}",
    checksum: "sha256:" + "a".repeat(64),
    size_bytes: 123,
    tools: [],
    star_count: 0,
    starred: false,
    installed: false,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

function fakeDb(opts: { rows?: ReturnType<typeof mainRow>[] } = {}) {
  const rows = opts.rows ?? [mainRow()];
  let modifierQueries = 0;
  const modifierRows = [
    {
      skill_id: "skill-1",
      user_id: actor.id,
      name: actor.name,
      initials: "AL",
      email: actor.email,
      avatar_url: null,
      profile_updated_at: now,
      last_published_at: now,
    },
    {
      skill_id: "skill-1",
      user_id: "user-2",
      name: "Grace Hopper",
      initials: "GH",
      email: "grace@example.test",
      avatar_url: "/stored/avatar",
      profile_updated_at: avatarUpdatedAt,
      last_published_at: new Date("2026-06-26T09:00:00.000Z"),
    },
    {
      skill_id: "skill-1",
      user_id: "user-2",
      name: "Grace Hopper",
      initials: "GH",
      email: "grace@example.test",
      avatar_url: "/stored/avatar",
      profile_updated_at: avatarUpdatedAt,
      last_published_at: new Date("2026-06-25T09:00:00.000Z"),
    },
    {
      skill_id: "skill-1",
      user_id: "user-3",
      name: "Hedy Lamarr",
      initials: "HL",
      email: "hedy@example.test",
      avatar_url: null,
      profile_updated_at: now,
      last_published_at: new Date("2026-06-24T09:00:00.000Z"),
    },
  ];

  const rowsFor = (table: unknown, cols: Record<string, unknown> | undefined) => {
    if (table === schema.skills && cols && "share_token" in cols) return rows;
    if (table === schema.skills && cols && "currentVersionId" in cols) {
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        scope: r.scope,
        creatorId: r.creator_id,
        archivedAt: r.archived_at,
        currentVersionId: "version-1",
        currentVersion: r.current_version,
      }));
    }
    if (table === schema.skills && cols && "id" in cols) return rows.map((r) => ({ id: r.id }));
    if (table === schema.skillVersions && cols && "user_id" in cols) {
      modifierQueries += 1;
      return modifierRows;
    }
    if (table === schema.skillVersionDependencies) return [];
    if (table === schema.skillInstalls) return [];
    return [];
  };

  const select = (cols?: Record<string, unknown>) => {
    let table: unknown;
    const builder: Record<string, unknown> = {
      from(t: unknown) {
        table = t;
        return builder;
      },
      innerJoin() {
        return builder;
      },
      leftJoin() {
        return builder;
      },
      where() {
        return builder;
      },
      groupBy() {
        return builder;
      },
      orderBy() {
        return Promise.resolve(rowsFor(table, cols));
      },
      limit() {
        return Promise.resolve(rowsFor(table, cols));
      },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(rowsFor(table, cols)).then(resolve);
      },
    };
    return builder;
  };

  return {
    database: {
      query: {
        memberships: { findFirst: async () => ({ orgRole: "developer" }) },
      },
      select,
    } as unknown as Db,
    get modifierQueries() {
      return modifierQueries;
    },
  };
}

describe("listSkills modifier attribution", () => {
  it("returns distinct version publishers after the creator with resolved avatars", async () => {
    const { database } = fakeDb();

    const [row] = await listSkills({ actor, orgId: ORG, database });

    expect(row).toBeDefined();
    expect(row!.modifiers).toEqual([
      {
        user_id: "user-2",
        name: "Grace Hopper",
        initials: "GH",
        avatar_url: `/v1/users/user-2/avatar?v=${avatarUpdatedAt.getTime()}`,
      },
      expect.objectContaining({
        user_id: "user-3",
        name: "Hedy Lamarr",
        initials: "HL",
      }),
    ]);
    expect(row!.modifiers[1]?.avatar_url).toContain("www.gravatar.com/avatar/");
  });

  it("skips the modifier query when the visible list is empty", async () => {
    const fake = fakeDb({ rows: [] });

    await expect(listSkills({ actor, orgId: ORG, database: fake.database })).resolves.toEqual([]);
    expect(fake.modifierQueries).toBe(0);
  });
});
