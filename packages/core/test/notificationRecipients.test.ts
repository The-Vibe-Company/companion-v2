import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import { resolveSkillNotificationRecipients, type NotificationRecipient } from "../src/notifications";

/**
 * Unit-tests the pure recipient-resolution logic WITHOUT a live Postgres. The resolver issues a fixed
 * set of selects (owner / installers / starrers / thread authors / muted); the stub below returns
 * canned rows keyed by which schema table each `.from(...)` targets, and is thenable so an awaited
 * `select().from().where()` (or `.limit()`) resolves to those rows.
 */
const ORG = "00000000-0000-0000-0000-0000000000aa";
const SKILL = "00000000-0000-0000-0000-0000000000bb";

function fakeDb(data: {
  ownerId?: string | null;
  installers?: string[];
  starrers?: string[];
  threadAuthors?: string[];
  muted?: string[];
  /** Users to treat as NO LONGER org members (excluded from the membership filter). */
  nonMembers?: string[];
}) {
  // Every user mentioned anywhere is a current org member unless listed in `nonMembers`.
  const allUsers = new Set<string>([
    ...(data.ownerId ? [data.ownerId] : []),
    ...(data.installers ?? []),
    ...(data.starrers ?? []),
    ...(data.threadAuthors ?? []),
  ]);
  const nonMembers = new Set(data.nonMembers ?? []);
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.skills) return data.ownerId === null ? [] : [{ ownerId: data.ownerId ?? "u-owner" }];
    if (table === schema.skillInstalls) return (data.installers ?? []).map((userId) => ({ userId }));
    if (table === schema.skillStars) return (data.starrers ?? []).map((userId) => ({ userId }));
    if (table === schema.skillComments) return (data.threadAuthors ?? []).map((authorId) => ({ authorId }));
    if (table === schema.skillSubscriptions) return (data.muted ?? []).map((userId) => ({ userId }));
    if (table === schema.memberships)
      return [...allUsers].filter((u) => !nonMembers.has(u)).map((userId) => ({ userId }));
    return [];
  };
  const builder = () => {
    let rows: unknown[] = [];
    const b: Record<string, unknown> = {
      from(table: unknown) {
        rows = rowsFor(table);
        return b;
      },
      where: () => b,
      limit: () => b,
      then: (resolve: (value: unknown[]) => void) => resolve(rows),
    };
    return b;
  };
  return { select: () => builder(), selectDistinct: () => builder() } as unknown as Db;
}

function sortRecipients(list: NotificationRecipient[]): NotificationRecipient[] {
  return [...list].sort((a, b) => a.userId.localeCompare(b.userId));
}

describe("resolveSkillNotificationRecipients — version_published", () => {
  it("notifies installers, starrers, and the owner with their relationship reason", async () => {
    const recipients = await resolveSkillNotificationRecipients({
      database: fakeDb({ ownerId: "u-owner", installers: ["u-inst"], starrers: ["u-star"] }),
      orgId: ORG,
      skillId: SKILL,
      eventType: "skill.version_published",
      actorId: "u-actor",
    });
    expect(sortRecipients(recipients)).toEqual([
      { userId: "u-inst", reason: "installer" },
      { userId: "u-owner", reason: "owner" },
      { userId: "u-star", reason: "starrer" },
    ]);
  });

  it("never notifies the actor, even when they installed/own the skill", async () => {
    const recipients = await resolveSkillNotificationRecipients({
      database: fakeDb({ ownerId: "u-actor", installers: ["u-actor", "u-inst"], starrers: ["u-actor"] }),
      orgId: ORG,
      skillId: SKILL,
      eventType: "skill.version_published",
      actorId: "u-actor",
    });
    expect(recipients).toEqual([{ userId: "u-inst", reason: "installer" }]);
  });

  it("removes muted users even when they have a strong relationship", async () => {
    const recipients = await resolveSkillNotificationRecipients({
      database: fakeDb({ ownerId: "u-owner", installers: ["u-inst", "u-muted"], muted: ["u-muted"] }),
      orgId: ORG,
      skillId: SKILL,
      eventType: "skill.version_published",
      actorId: "u-actor",
    });
    expect(sortRecipients(recipients)).toEqual([
      { userId: "u-inst", reason: "installer" },
      { userId: "u-owner", reason: "owner" },
    ]);
  });

  it("keeps the strongest reason when a user qualifies twice (owner > installer)", async () => {
    const recipients = await resolveSkillNotificationRecipients({
      database: fakeDb({ ownerId: "u-both", installers: ["u-both"], starrers: ["u-both"] }),
      orgId: ORG,
      skillId: SKILL,
      eventType: "skill.version_published",
      actorId: "u-actor",
    });
    expect(recipients).toEqual([{ userId: "u-both", reason: "owner" }]);
  });

  it("excludes a recipient who is no longer an org member (stale install/star)", async () => {
    const recipients = await resolveSkillNotificationRecipients({
      database: fakeDb({ ownerId: "u-owner", installers: ["u-inst", "u-removed"], nonMembers: ["u-removed"] }),
      orgId: ORG,
      skillId: SKILL,
      eventType: "skill.version_published",
      actorId: "u-actor",
    });
    expect(sortRecipients(recipients)).toEqual([
      { userId: "u-inst", reason: "installer" },
      { userId: "u-owner", reason: "owner" },
    ]);
  });

  it("returns nothing when the only candidate is the actor", async () => {
    const recipients = await resolveSkillNotificationRecipients({
      database: fakeDb({ ownerId: "u-actor", installers: ["u-actor"] }),
      orgId: ORG,
      skillId: SKILL,
      eventType: "skill.version_published",
      actorId: "u-actor",
    });
    expect(recipients).toEqual([]);
  });
});

describe("resolveSkillNotificationRecipients — comment_reply", () => {
  it("notifies the parent author + thread participants + owner; ignores starrers", async () => {
    const recipients = await resolveSkillNotificationRecipients({
      database: fakeDb({ ownerId: "u-owner", starrers: ["u-star"], threadAuthors: ["u-parent", "u-other"] }),
      orgId: ORG,
      skillId: SKILL,
      eventType: "skill.comment_reply",
      actorId: "u-actor",
      parentCommentAuthorId: "u-parent",
      parentCommentId: "comment-root",
    });
    expect(sortRecipients(recipients)).toEqual([
      { userId: "u-other", reason: "thread_participant" },
      { userId: "u-owner", reason: "owner" },
      { userId: "u-parent", reason: "thread_participant" },
    ]);
  });

  it("thread_participant outranks a weaker relationship on dedupe", async () => {
    // The owner who is also in the thread reads as a thread participant (6 > 5).
    const recipients = await resolveSkillNotificationRecipients({
      database: fakeDb({ ownerId: "u-owner", threadAuthors: ["u-owner"] }),
      orgId: ORG,
      skillId: SKILL,
      eventType: "skill.comment_reply",
      actorId: "u-actor",
      parentCommentAuthorId: "u-owner",
      parentCommentId: "comment-root",
    });
    expect(recipients).toEqual([{ userId: "u-owner", reason: "thread_participant" }]);
  });
});
