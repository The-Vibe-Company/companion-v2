import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { renameSkill, SkillPublicReleaseConflictError, type ActorContext } from "../src/services";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const owner: ActorContext = { id: "user-owner", email: "owner@example.test", name: "Owner" };
const other: ActorContext = { id: "user-other", email: "other@example.test", name: "Other" };

interface SkillRow {
  id: string;
  orgId: string;
  slug: string;
  displayName: string | null;
  scope: "personal" | "org";
  creatorId: string;
  shareToken: string;
  publicVersionId: string | null;
}

function skill(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: "skill-1",
    orgId: ORG,
    slug: "skill-creator",
    displayName: null,
    scope: "org",
    creatorId: owner.id,
    shareToken: "share-token-1",
    publicVersionId: null,
    ...overrides,
  };
}

function fakeDb(opts: {
  row: SkillRow | null;
  conflict?: SkillRow | null;
  role?: "owner" | "admin" | "developer" | null;
  updateReturnsNoRows?: boolean;
  rowAfterFailedUpdate?: SkillRow | null;
}) {
  const role = opts.role === undefined ? "developer" : opts.role;
  const row = opts.row ? { ...opts.row } : null;
  const related = {
    labels: row ? [{ orgId: row.orgId, skillId: row.id, path: "dev/tools" }] : [],
    installs: row ? [{ orgId: row.orgId, userId: owner.id, skillId: row.id, installedVersion: "1.0.0" }] : [],
    comments: row ? [{ orgId: row.orgId, skillId: row.id, id: "comment-1" }] : [],
  };
  const captured = {
    audit: null as Record<string, unknown> | null,
    updates: 0,
    relatedBefore: structuredClone(related),
    row,
    updateWhere: null as SQL | null,
  };
  const skillFinds: Array<SkillRow | null | undefined> = [
    row,
    opts.conflict ?? null,
    opts.rowAfterFailedUpdate,
  ];

  const handle = {
    query: {
      memberships: {
        findFirst: async () => (role === null ? null : { orgRole: role }),
      },
      skills: {
        findFirst: async () => skillFinds.shift() ?? undefined,
      },
    },
    update: (table: unknown) => ({
      set(patch: Partial<SkillRow> & { updatedAt?: Date }) {
        return {
          where(clause: SQL) {
            captured.updateWhere = clause;
            return {
              returning: async () => {
                if (table !== schema.skills || !row || opts.updateReturnsNoRows) return [];
                captured.updates += 1;
                if (patch.slug !== undefined) row.slug = patch.slug;
                if (patch.displayName !== undefined) row.displayName = patch.displayName;
                return [{ id: row.id, slug: row.slug, displayName: row.displayName }];
              },
            };
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values: async (value: Record<string, unknown>) => {
        if (table === schema.auditLog) captured.audit = value;
      },
    }),
  };
  const database = {
    ...handle,
    transaction: async <T>(cb: (tx: typeof handle) => Promise<T>) => cb(handle),
  };
  return { database: database as unknown as Db, captured, related };
}

describe("renameSkill", () => {
  it("renames in place, keeps the same id, and preserves id-linked state", async () => {
    const { database, captured, related } = fakeDb({ row: skill() });

    const result = await renameSkill({
      actor: owner,
      orgId: ORG,
      slug: "skill-creator",
      newSlug: "skill-creator-and-eval",
      title: "Skill Creator and Eval",
      database,
    });

    expect(result).toEqual({
      ok: true,
      id: "skill-1",
      old_slug: "skill-creator",
      slug: "skill-creator-and-eval",
      title: "Skill Creator and Eval",
    });
    expect(captured.row).toMatchObject({
      id: "skill-1",
      slug: "skill-creator-and-eval",
      displayName: "Skill Creator and Eval",
      shareToken: "share-token-1",
    });
    expect(related).toEqual(captured.relatedBefore);
    expect(captured.audit).toMatchObject({
      action: "skill.rename",
      targetId: "skill-1",
      metadata: {
        old_slug: "skill-creator",
        slug: "skill-creator-and-eval",
        title: "Skill Creator and Eval",
      },
    });
  });

  it("rejects a slug already used in the workspace", async () => {
    const { database, captured } = fakeDb({
      row: skill(),
      conflict: skill({ id: "skill-2", slug: "skill-creator-and-eval" }),
    });

    await expect(
      renameSkill({
        actor: owner,
        orgId: ORG,
        slug: "skill-creator",
        newSlug: "skill-creator-and-eval",
        database,
      }),
    ).rejects.toThrow("already exists in this workspace");
    expect(captured.updates).toBe(0);
  });

  it("requires explicit withdrawal before renaming a skill with a pinned public release", async () => {
    const { database, captured } = fakeDb({ row: skill({ publicVersionId: "version-1" }) });

    await expect(renameSkill({
      actor: owner,
      orgId: ORG,
      slug: "skill-creator",
      newSlug: "skill-creator-and-eval",
      database,
    })).rejects.toBeInstanceOf(SkillPublicReleaseConflictError);
    expect(captured.updates).toBe(0);
    expect(captured.row?.slug).toBe("skill-creator");
    expect(captured.audit).toBeNull();
  });

  /**
   * Product promise: a rename and promotion cannot both commit and leave a pinned ZIP whose
   * immutable manifest uses the old slug.
   * Regression caught: public-version preflight happened before the rename transaction without a CAS fence.
   * Why unit-level: Core owns both the conditional UPDATE and conflict classification.
   * Failure proof: removing the null predicate fails SQL inspection; removing recheck changes the error class.
   */
  it("returns a public-release conflict when promotion wins after rename preflight", async () => {
    const promoted = skill({ publicVersionId: "version-1" });
    const { database, captured } = fakeDb({
      row: skill(),
      updateReturnsNoRows: true,
      rowAfterFailedUpdate: promoted,
    });

    await expect(renameSkill({
      actor: owner,
      orgId: ORG,
      slug: "skill-creator",
      newSlug: "skill-creator-and-eval",
      database,
    })).rejects.toBeInstanceOf(SkillPublicReleaseConflictError);
    expect(captured.audit).toBeNull();

    const compiled = new PgDialect().sqlToQuery(captured.updateWhere!);
    expect(compiled.sql).toContain('"skills"."public_version_id" is null');
  });

  it("rejects invalid and unchanged slugs", async () => {
    const { database } = fakeDb({ row: skill() });
    await expect(
      renameSkill({ actor: owner, orgId: ORG, slug: "skill-creator", newSlug: "Skill Creator", database }),
    ).rejects.toThrow();

    const second = fakeDb({ row: skill() });
    await expect(
      renameSkill({ actor: owner, orgId: ORG, slug: "skill-creator", newSlug: "skill-creator", database: second.database }),
    ).rejects.toThrow("newSlug must be different");
  });

  it("hides another member's personal skill and does not update it", async () => {
    const { database, captured } = fakeDb({
      row: skill({ scope: "personal", creatorId: owner.id }),
      role: "admin",
    });

    await expect(
      renameSkill({
        actor: other,
        orgId: ORG,
        slug: "skill-creator",
        newSlug: "skill-creator-and-eval",
        database,
      }),
    ).rejects.toThrow("skill not found");
    expect(captured.updates).toBe(0);
  });

  it("rejects stale route slugs when the row changed before the update", async () => {
    const { database, captured } = fakeDb({ row: skill(), updateReturnsNoRows: true });

    await expect(
      renameSkill({
        actor: owner,
        orgId: ORG,
        slug: "skill-creator",
        newSlug: "skill-creator-and-eval",
        database,
      }),
    ).rejects.toThrow("skill not found");
    expect(captured.row).toMatchObject({ id: "skill-1", slug: "skill-creator" });
    expect(captured.audit).toBeNull();
  });
});
