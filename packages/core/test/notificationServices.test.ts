import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import {
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
  type ActorContext,
} from "../src/services";

/**
 * Guards the single most dangerous property of the notification read path: RLS scopes only by
 * `org_id`, so every read/count/markRead MUST additionally filter `recipient_user_id = actor.id` or it
 * would leak the whole org's inbox. We capture the `.where(...)` predicate each service builds and
 * assert it references the `recipient_user_id` column (by identity, walking the SQL queryChunks).
 */
const ORG = "00000000-0000-0000-0000-0000000000aa";
const actor: ActorContext = { id: "u-me", email: "me@example.com", name: "Me" };

/** True iff `col` appears anywhere in the SQL expression tree (follows queryChunks; Columns are leaves). */
function referencesColumn(node: unknown, col: unknown): boolean {
  if (node === col) return true;
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => referencesColumn(n, col));
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  return Array.isArray(chunks) && chunks.some((n) => referencesColumn(n, col));
}

function fakeDb(rows: unknown[]) {
  const captured: { selectWhere?: unknown; updateSet?: unknown; updateWhere?: unknown } = {};
  const chain = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "orderBy", "limit"]) b[m] = () => b;
    b.where = (pred: unknown) => {
      captured.selectWhere = pred;
      return b;
    };
    b.then = (resolve: (value: unknown[]) => void) => resolve(rows);
    return b;
  };
  const database = {
    select: () => chain(),
    update: () => ({
      set: (set: unknown) => {
        captured.updateSet = set;
        return {
          where: (pred: unknown) => {
            captured.updateWhere = pred;
            return Promise.resolve();
          },
        };
      },
    }),
    // visibleSkillPredicate → getOrgRole: an org admin resolves to a simple `eq(skills.orgId)` gate
    // with no extra subqueries, keeping these read-path tests focused on the recipient filter.
    query: { memberships: { findFirst: async () => ({ orgRole: "owner" }) } },
  } as unknown as Db;
  return { database, captured };
}

describe("listNotifications", () => {
  it("scopes to the caller (recipient_user_id) and maps rows", async () => {
    const { database, captured } = fakeDb([
      {
        id: "n1",
        type: "skill.version_published",
        reason: "installer",
        skill_id: "s1",
        skill_slug: "demo",
        actor_id: "u-other",
        actor_name: "Other",
        actor_initials: "OT",
        target_type: "skill_version",
        target_id: "v1",
        metadata: { slug: "demo", version: "2.0.0" },
        read_at: null,
        created_at: new Date("2026-06-21T10:00:00.000Z"),
      },
    ]);
    const rows = await listNotifications({ actor, orgId: ORG, database });
    expect(referencesColumn(captured.selectWhere, schema.notifications.recipientUserId)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "n1", skill_slug: "demo", read_at: null });
    expect(rows[0]!.created_at).toBe("2026-06-21T10:00:00.000Z");
    expect(rows[0]!.metadata).toEqual({ slug: "demo", version: "2.0.0" });
  });
});

describe("unreadNotificationCount", () => {
  it("scopes to the caller and returns the count", async () => {
    const { database, captured } = fakeDb([{ count: 4 }]);
    const count = await unreadNotificationCount({ actor, orgId: ORG, database });
    expect(count).toBe(4);
    expect(referencesColumn(captured.selectWhere, schema.notifications.recipientUserId)).toBe(true);
  });
});

describe("markNotificationsRead", () => {
  it("marks all unread for the caller (sets read_at, scoped to recipient)", async () => {
    const { database, captured } = fakeDb([]);
    await markNotificationsRead({ actor, orgId: ORG, all: true, database });
    expect((captured.updateSet as { readAt?: unknown }).readAt).toBeInstanceOf(Date);
    expect(referencesColumn(captured.updateWhere, schema.notifications.recipientUserId)).toBe(true);
  });

  it("marks an explicit id set, still scoped to recipient + id", async () => {
    const { database, captured } = fakeDb([]);
    await markNotificationsRead({ actor, orgId: ORG, ids: ["n1", "n2"], database });
    expect(referencesColumn(captured.updateWhere, schema.notifications.recipientUserId)).toBe(true);
    expect(referencesColumn(captured.updateWhere, schema.notifications.id)).toBe(true);
  });

  it("is a no-op when neither ids nor all is given", async () => {
    const { database, captured } = fakeDb([]);
    await markNotificationsRead({ actor, orgId: ORG, database });
    expect(captured.updateSet).toBeUndefined();
  });
});
