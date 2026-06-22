import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import { addComment, getCommentImageAsset, setCommentDeprecated, type ActorContext } from "../src/services";

/**
 * These suites exercise the comment-thread service layer (RBAC for deprecate/restore and the
 * cross-skill `version_id` rejection in addComment) WITHOUT a live Postgres. We hand-roll a
 * chainable query-builder stub — the same `vi.fn` approach as `filterPreferences.test.ts` — so
 * they run in the standard `pnpm --filter @companion/core test` unit run (no DB harness needed).
 *
 * The stub satisfies exactly the calls these two services make:
 *  - `getSkillBySlug` → `listSkills`: `getOrgRole` (memberships.findFirst) + the select-chain
 *    that returns the visible skill rows.
 *  - `query.skillVersions.findFirst`, `query.skillComments.findFirst`, `query.profiles.findFirst`.
 *  - `insert(...).values(...).returning()` and `update(...).set(...).where(...).returning()`.
 */

const ORG = "00000000-0000-0000-0000-0000000000aa";
const SKILL_ID = "00000000-0000-0000-0000-0000000000bb";
const VERSION_ID = "00000000-0000-0000-0000-0000000000cc";

const author: ActorContext = { id: "user-author", email: "author@example.com", name: "Author" };
const admin: ActorContext = { id: "user-admin", email: "admin@example.com", name: "Admin" };
const owner: ActorContext = { id: "user-owner", email: "owner@example.com", name: "Owner" };
const other: ActorContext = { id: "user-other", email: "other@example.com", name: "Other Dev" };

interface FakeOptions {
  /** orgRole for the acting user (drives both visibility + the admin gate). `null` = not a member. */
  orgRole?: "owner" | "admin" | "developer" | null;
  /** owner_id stamped on the resolved skill (drives the skill-owner gate). */
  skillOwnerId?: string;
  /** The comment row returned by `skillComments.findFirst` (the target of deprecate / a parent). */
  comment?: Record<string, unknown> | null;
  /** The version row returned by `skillVersions.findFirst` (cross-skill validation). */
  version?: Record<string, unknown> | null;
  /** Author profile row returned by `profiles.findFirst` (re-joined into the deprecate result). */
  authorProfile?: Record<string, unknown> | null;
  /** The image row returned by `skillCommentImages.findFirst` (comment-image serve gate). */
  image?: Record<string, unknown> | null;
}

/** A select(...) chain that ignores every intermediate call and resolves to `rows` when awaited. */
function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "leftJoin", "where", "groupBy"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.orderBy = vi.fn(async () => rows);
  // `visibleSkillPredicate` ends its team-subquery on `.where(...)` and passes the builder into
  // `inArray` (never awaited), so a self-returning `where` is sufficient there too.
  return chain;
}

function fakeDb(opts: FakeOptions = {}) {
  const orgRole = opts.orgRole === undefined ? "developer" : opts.orgRole;
  const skillRows =
    orgRole === null
      ? []
      : [
          {
            id: SKILL_ID,
            org_id: ORG,
            slug: "demo-skill",
            description: "",
            everyone: true,
            validation: "valid",
            validation_error: null,
            owner_kind: "user",
            owner_id: opts.skillOwnerId ?? owner.id,
            owner_user_id: opts.skillOwnerId ?? owner.id,
            owner_team_id: null,
            owner_name: "Owner",
            owner_handle: null,
            owner_initials: "OW",
            current_version: "1.0.0",
            license: null,
            checksum: null,
            size_bytes: null,
            tools: [],
            star_count: 0,
            starred: false,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];

  const returning = vi.fn(async () => [opts.comment ?? null]);
  const insertValues = vi.fn(() => ({ returning }));
  const updateWhere = vi.fn(() => ({ returning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));

  const database = {
    select: vi.fn(() => selectChain(skillRows)),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    // addComment wraps its comment + image inserts in a transaction; run the callback inline against
    // this same stub (the real impl nests a savepoint inside the caller's withTenantContext tx).
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(database)),
    query: {
      memberships: {
        findFirst: vi.fn(async () => (orgRole === null ? null : { orgRole })),
      },
      skillVersions: {
        findFirst: vi.fn(async () => opts.version ?? null),
      },
      skillComments: {
        findFirst: vi.fn(async () => opts.comment ?? null),
      },
      skillCommentImages: {
        findFirst: vi.fn(async () => opts.image ?? null),
      },
      profiles: {
        findFirst: vi.fn(async () => opts.authorProfile ?? null),
      },
    },
  };
  return { database: database as unknown as Db, returning, insertValues };
}

describe("setCommentDeprecated — RBAC matrix (author / admin / skill-owner allowed; others denied)", () => {
  const targetComment = {
    id: "comment-1",
    orgId: ORG,
    skillId: SKILL_ID,
    authorId: author.id,
    body: "hello",
    parentId: null,
    versionId: null,
    deprecated: false,
    createdAt: new Date(),
  };

  const allowed: Array<[string, ActorContext, FakeOptions]> = [
    ["the comment author", author, { orgRole: "developer", skillOwnerId: owner.id }],
    ["an org admin", admin, { orgRole: "admin", skillOwnerId: owner.id }],
    ["the skill owner", owner, { orgRole: "developer", skillOwnerId: owner.id }],
  ];

  it.each(allowed)("allows %s", async (_label, actor, base) => {
    const updated = { ...targetComment, deprecated: true };
    const { database } = fakeDb({ ...base, comment: targetComment });
    // The deprecate UPDATE returns the freshly-updated row; profiles re-join is best-effort.
    (database.update as ReturnType<typeof vi.fn>).mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [updated]) })) })),
    });
    const row = await setCommentDeprecated({
      actor,
      orgId: ORG,
      slug: "demo-skill",
      commentId: "comment-1",
      deprecated: true,
      database,
    });
    expect(row.deprecated).toBe(true);
    expect(row.id).toBe("comment-1");
  });

  it("denies an unrelated developer (not author, not admin, not owner)", async () => {
    const { database } = fakeDb({ orgRole: "developer", skillOwnerId: owner.id, comment: targetComment });
    await expect(
      setCommentDeprecated({
        actor: other,
        orgId: ORG,
        slug: "demo-skill",
        commentId: "comment-1",
        deprecated: true,
        database,
      }),
    ).rejects.toThrow("not allowed to change this comment");
  });

  it("denies a cross-tenant actor before skill visibility is evaluated", async () => {
    // orgRole null fails closed before workspace-local Everyone/team visibility is considered.
    const { database } = fakeDb({ orgRole: null, comment: targetComment });
    await expect(
      setCommentDeprecated({
        actor: other,
        orgId: ORG,
        slug: "demo-skill",
        commentId: "comment-1",
        deprecated: true,
        database,
      }),
    ).rejects.toThrow("not a member of this organization");
  });

  it("throws when the comment does not exist under this org+skill", async () => {
    const { database } = fakeDb({ orgRole: "admin", skillOwnerId: owner.id, comment: null });
    await expect(
      setCommentDeprecated({
        actor: admin,
        orgId: ORG,
        slug: "demo-skill",
        commentId: "missing",
        deprecated: true,
        database,
      }),
    ).rejects.toThrow("comment not found");
  });
});

describe("addComment — cross-skill version_id rejection", () => {
  it("rejects a version_id that does not belong to this skill/org", async () => {
    // skillVersions.findFirst is scoped to (id, orgId, skillId); a foreign version returns null.
    const { database } = fakeDb({ orgRole: "developer", version: null });
    await expect(
      addComment({
        actor: author,
        orgId: ORG,
        slug: "demo-skill",
        body: "linked comment",
        versionId: VERSION_ID,
        database,
      }),
    ).rejects.toThrow("version does not belong to this skill");
  });

  it("accepts a version_id that belongs to this skill and returns the joined label", async () => {
    const inserted = {
      id: "comment-2",
      orgId: ORG,
      skillId: SKILL_ID,
      authorId: author.id,
      body: "linked comment",
      parentId: null,
      versionId: VERSION_ID,
      deprecated: false,
      createdAt: new Date(),
    };
    const { database } = fakeDb({
      orgRole: "developer",
      version: { id: VERSION_ID, orgId: ORG, skillId: SKILL_ID, version: "1.2.0" },
      comment: inserted,
    });
    const row = await addComment({
      actor: author,
      orgId: ORG,
      slug: "demo-skill",
      body: "linked comment",
      versionId: VERSION_ID,
      database,
    });
    expect(row.version_id).toBe(VERSION_ID);
    expect(row.version).toBe("1.2.0");
    expect(row.parent_id).toBeNull();
    expect(row.deprecated).toBe(false);
  });

  it("forces version_id to null on a reply (context inherited from the thread)", async () => {
    const parent = { id: "root-1", orgId: ORG, skillId: SKILL_ID, parentId: null };
    const inserted = {
      id: "reply-1",
      orgId: ORG,
      skillId: SKILL_ID,
      authorId: author.id,
      body: "a reply",
      parentId: "root-1",
      versionId: null,
      deprecated: false,
      createdAt: new Date(),
    };
    const { database, insertValues } = fakeDb({ orgRole: "developer", comment: parent });
    // The insert path returns the new reply row; the parent lookup uses the same findFirst stub.
    (database.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: insertValues.mockReturnValue({ returning: vi.fn(async () => [inserted]) }),
    });
    const row = await addComment({
      actor: author,
      orgId: ORG,
      slug: "demo-skill",
      body: "a reply",
      parentId: "root-1",
      versionId: VERSION_ID, // ignored for replies
      database,
    });
    // Inserted row carried versionId: null because it is a reply.
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ versionId: null, parentId: "root-1" }));
    expect(row.version_id).toBeNull();
    expect(row.parent_id).toBe("root-1");
  });

  it("rejects a reply whose parent is itself a reply (single-level nesting)", async () => {
    const nestedParent = { id: "reply-x", orgId: ORG, skillId: SKILL_ID, parentId: "root-1" };
    const { database } = fakeDb({ orgRole: "developer", comment: nestedParent });
    await expect(
      addComment({
        actor: author,
        orgId: ORG,
        slug: "demo-skill",
        body: "nested",
        parentId: "reply-x",
        database,
      }),
    ).rejects.toThrow("invalid parent comment");
  });
});

describe("addComment — image attachments", () => {
  it("persists uploaded images and returns them ordered with built serve urls", async () => {
    const inserted = {
      id: "comment-img",
      orgId: ORG,
      skillId: SKILL_ID,
      authorId: author.id,
      body: "look at this",
      parentId: null,
      versionId: null,
      deprecated: false,
      createdAt: new Date(),
    };
    const { database, insertValues } = fakeDb({ orgRole: "developer", comment: inserted });
    const row = await addComment({
      actor: author,
      orgId: ORG,
      slug: "demo-skill",
      body: "look at this",
      images: [
        { id: "img-1", storageKey: `${ORG}/comments/img-1`, contentType: "image/png", byteSize: 1234 },
        { id: "img-2", storageKey: `${ORG}/comments/img-2`, contentType: "image/jpeg", byteSize: 5678 },
      ],
      database,
    });
    expect(row.images).toHaveLength(2);
    expect(row.images[0]).toMatchObject({ id: "img-1", content_type: "image/png", byte_size: 1234, position: 0 });
    expect(row.images[0]?.url).toBe("/v1/skills/demo-skill/comments/comment-img/images/img-1");
    expect(row.images[1]).toMatchObject({ id: "img-2", position: 1 });
    // The image rows are actually inserted (org/comment/skill scoped, positioned, with the storage key).
    expect(insertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "img-1",
          orgId: ORG,
          commentId: "comment-img",
          skillId: SKILL_ID,
          storageKey: `${ORG}/comments/img-1`,
          contentType: "image/png",
          byteSize: 1234,
          position: 0,
        }),
        expect.objectContaining({ id: "img-2", position: 1, contentType: "image/jpeg" }),
      ]),
    );
  });

  it("enforces the attachment invariants in the service layer (count / type / size)", async () => {
    const img = { id: "i", storageKey: "k", contentType: "image/png", byteSize: 10 };
    const tooMany = Array.from({ length: 7 }, (_, i) => ({ ...img, id: `i${i}`, storageKey: `k${i}` }));
    await expect(
      addComment({ actor: author, orgId: ORG, slug: "demo-skill", body: "x", images: tooMany, database: fakeDb({ orgRole: "developer" }).database }),
    ).rejects.toThrow("at most 6 images");
    await expect(
      addComment({
        actor: author, orgId: ORG, slug: "demo-skill", body: "x",
        images: [{ ...img, contentType: "image/svg+xml" }],
        database: fakeDb({ orgRole: "developer" }).database,
      }),
    ).rejects.toThrow("unsupported comment image type");
    await expect(
      addComment({
        actor: author, orgId: ORG, slug: "demo-skill", body: "x",
        images: [{ ...img, byteSize: 11 * 1024 * 1024 }],
        database: fakeDb({ orgRole: "developer" }).database,
      }),
    ).rejects.toThrow("exceeds the size limit");
  });

  it("returns an empty images array when no attachments are provided", async () => {
    const inserted = {
      id: "comment-plain",
      orgId: ORG,
      skillId: SKILL_ID,
      authorId: author.id,
      body: "text only",
      parentId: null,
      versionId: null,
      deprecated: false,
      createdAt: new Date(),
    };
    const { database } = fakeDb({ orgRole: "developer", comment: inserted });
    const row = await addComment({ actor: author, orgId: ORG, slug: "demo-skill", body: "text only", database });
    expect(row.images).toEqual([]);
  });
});

describe("getCommentImageAsset — visibility gate", () => {
  it("denies a cross-tenant actor before the image is read (fails closed on membership)", async () => {
    const { database } = fakeDb({ orgRole: null });
    await expect(
      getCommentImageAsset({
        actor: other,
        orgId: ORG,
        slug: "demo-skill",
        commentId: "comment-1",
        imageId: "img-1",
        database,
      }),
    ).rejects.toThrow("not a member of this organization");
  });

  it("throws when the image does not exist under this org+skill+comment", async () => {
    const { database } = fakeDb({ orgRole: "developer", image: null });
    await expect(
      getCommentImageAsset({
        actor: author,
        orgId: ORG,
        slug: "demo-skill",
        commentId: "comment-1",
        imageId: "missing",
        database,
      }),
    ).rejects.toThrow("image not found");
  });

  it("returns the storage key + content type for a visible image", async () => {
    const { database } = fakeDb({
      orgRole: "developer",
      image: { storageKey: `${ORG}/comments/img-1`, contentType: "image/webp" },
    });
    const asset = await getCommentImageAsset({
      actor: author,
      orgId: ORG,
      slug: "demo-skill",
      commentId: "comment-1",
      imageId: "img-1",
      database,
    });
    expect(asset).toEqual({ storageKey: `${ORG}/comments/img-1`, contentType: "image/webp" });
  });
});
