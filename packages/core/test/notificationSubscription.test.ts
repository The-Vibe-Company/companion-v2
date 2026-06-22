import { describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@companion/db";
import { addComment, setSkillSubscription, type ActorContext } from "../src/services";

/**
 * Covers the subscription mutation (`setSkillSubscription` mute upsert + revert-to-default delete) and
 * the fan-out FAILURE ISOLATION in `addComment` (a notification-emission error must never fail the
 * comment). Uses the same hand-rolled chainable-stub approach as `skillComments.test.ts` so it runs in
 * the standard unit run without a live Postgres.
 */
const ORG = "00000000-0000-0000-0000-0000000000aa";
const SKILL_ID = "00000000-0000-0000-0000-0000000000bb";
const actor: ActorContext = { id: "user-actor", email: "a@example.com", name: "Actor" };

/**
 * A select chain that resolves to `rows` whether awaited at `.orderBy`, a nested `.limit`, or directly.
 * `.from(memberships)` swaps to the member rows so the reply-emission membership filter keeps the
 * (single) thread participant — otherwise the fan-out would resolve to no recipients and the
 * failure-isolation case below could never reach the throwing insert.
 */
const MEMBER_ROWS = [{ userId: "user-parent" }];
function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  let current = rows;
  chain.from = vi.fn((table: unknown) => {
    if (table === schema.memberships) current = MEMBER_ROWS;
    return chain;
  });
  for (const m of ["innerJoin", "leftJoin", "where", "groupBy", "limit"]) chain[m] = vi.fn(() => chain);
  chain.orderBy = vi.fn(async () => current);
  chain.then = (resolve: (value: unknown[]) => void) => resolve(current);
  return chain;
}

interface FakeOptions {
  /** When set, `insert(schema.notifications)` throws — to exercise fan-out failure isolation. */
  throwOnNotificationInsert?: boolean;
  /** Resolved-skill present? false → getSkillBySlug returns null (skill not found). */
  skillExists?: boolean;
  /** Parent comment row for a reply (must be a root: parentId null). */
  parentComment?: Record<string, unknown> | null;
  /** The row `insert(skillComments).returning()` yields. */
  insertedComment?: Record<string, unknown> | null;
}

function fakeDb(opts: FakeOptions = {}) {
  const skillRows =
    opts.skillExists === false
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
            owner_id: "user-owner",
            owner_user_id: "user-owner",
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

  const calls = {
    inserts: [] as Array<{ table: unknown; values?: unknown }>,
    deletes: [] as Array<{ table: unknown }>,
    onConflict: [] as unknown[],
  };

  const database = {
    select: vi.fn(() => selectChain(skillRows)),
    selectDistinct: vi.fn(() => selectChain(skillRows)),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        calls.inserts.push({ table, values });
        if (opts.throwOnNotificationInsert && table === schema.notifications) {
          throw new Error("simulated notifications insert failure");
        }
        return {
          returning: vi.fn(async () => [opts.insertedComment ?? null]),
          onConflictDoUpdate: vi.fn((cfg: unknown) => {
            calls.onConflict.push(cfg);
            return Promise.resolve();
          }),
        };
      }),
    })),
    delete: vi.fn((table: unknown) => {
      calls.deletes.push({ table });
      return { where: vi.fn(async () => undefined) };
    }),
    query: {
      memberships: { findFirst: vi.fn(async () => ({ orgRole: "developer" })) },
      skillVersions: { findFirst: vi.fn(async () => null) },
      skillComments: { findFirst: vi.fn(async () => opts.parentComment ?? null) },
      profiles: { findFirst: vi.fn(async () => null) },
    },
  };
  return { database: database as unknown as Db, calls };
}

describe("setSkillSubscription", () => {
  it("mutes via upsert (insert + onConflictDoUpdate) and returns the new state", async () => {
    const { database, calls } = fakeDb();
    const res = await setSkillSubscription({ actor, orgId: ORG, slug: "demo-skill", state: "muted", database });
    expect(res).toEqual({ state: "muted" });
    const sub = calls.inserts.find((i) => i.table === schema.skillSubscriptions);
    expect(sub).toBeDefined();
    expect(sub!.values).toMatchObject({ orgId: ORG, skillId: SKILL_ID, userId: actor.id, state: "muted" });
    expect(calls.onConflict).toHaveLength(1); // idempotent re-mute updates rather than erroring
  });

  it("reverts to implicit (deletes the row) on state=default", async () => {
    const { database, calls } = fakeDb();
    const res = await setSkillSubscription({ actor, orgId: ORG, slug: "demo-skill", state: "default", database });
    expect(res).toEqual({ state: null });
    expect(calls.deletes.some((d) => d.table === schema.skillSubscriptions)).toBe(true);
    expect(calls.inserts.some((i) => i.table === schema.skillSubscriptions)).toBe(false);
  });

  it("rejects when the skill is not visible/found (visibility gate)", async () => {
    const { database } = fakeDb({ skillExists: false });
    await expect(
      setSkillSubscription({ actor, orgId: ORG, slug: "demo-skill", state: "muted", database }),
    ).rejects.toThrow("skill not found");
  });
});

describe("addComment fan-out failure isolation", () => {
  it("still returns the comment when notification emission throws", async () => {
    const inserted = {
      id: "new-reply",
      skillId: SKILL_ID,
      authorId: actor.id,
      body: "a reply",
      parentId: "root-1",
      versionId: null,
      deprecated: false,
      createdAt: new Date(),
    };
    const { database } = fakeDb({
      throwOnNotificationInsert: true,
      parentComment: { id: "root-1", orgId: ORG, skillId: SKILL_ID, authorId: "user-parent", parentId: null },
      insertedComment: inserted,
    });
    const row = await addComment({
      actor,
      orgId: ORG,
      slug: "demo-skill",
      body: "a reply",
      parentId: "root-1",
      database,
    });
    expect(row.id).toBe("new-reply");
    expect(row.parent_id).toBe("root-1");
    // The fan-out failed and was swallowed — no recipients surfaced, the comment still succeeds.
    expect(row.notified).toEqual([]);
  });
});
