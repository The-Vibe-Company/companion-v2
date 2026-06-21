import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { NotificationRow, NotificationType, NotificationReason } from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import type { ActorContext } from "./services";
import { getSkillBySlug, visibleSkillPredicate } from "./services";

export type { NotificationReason, NotificationType } from "@companion/contracts";

/** A resolved notification recipient: the user to notify and why (their strongest relationship). */
export interface NotificationRecipient {
  userId: string;
  reason: NotificationReason;
}

/**
 * Reason priority — the strongest relationship wins when a user qualifies for several. A reply in a
 * thread you started should read as "reply to your comment", not "a skill you starred updated".
 */
const REASON_PRIORITY: Record<NotificationReason, number> = {
  thread_participant: 6,
  owner: 5,
  commenter: 4,
  subscriber: 3,
  installer: 2,
  starrer: 1,
};

/** Insert/upgrade a candidate, keeping only the highest-priority reason per user. */
function consider(map: Map<string, NotificationReason>, userId: string | null | undefined, reason: NotificationReason): void {
  // Defensive: a null/empty id (deleted account, malformed row) must never become a recipient.
  if (!userId) return;
  const current = map.get(userId);
  if (!current || REASON_PRIORITY[reason] > REASON_PRIORITY[current]) map.set(userId, reason);
}

/**
 * Derive the audience for a skill event from the actor's relationships to the skill. Subscriptions are
 * *implicit*: installers / starrers / commenters / the owner are notified without any explicit opt-in.
 * The only stored override is a `muted` row, which removes the user. The actor is never notified of
 * their own action. Framework-free + DB-only so it is unit-testable with a fakeDb stub.
 *
 * Recipient sets per event (v1):
 * - `skill.version_published` → installers + starrers + owner.
 * - `skill.comment_reply`     → the parent comment's author + every other author in that thread + owner.
 */
export async function resolveSkillNotificationRecipients(input: {
  database: Db;
  orgId: string;
  skillId: string;
  eventType: NotificationType;
  actorId: string;
  /** comment_reply: the author of the parent (root) comment. */
  parentCommentAuthorId?: string | null;
  /** comment_reply: the root comment whose thread participants should be notified. */
  parentCommentId?: string | null;
}): Promise<NotificationRecipient[]> {
  const { database, orgId, skillId, eventType, actorId } = input;
  const candidates = new Map<string, NotificationReason>();

  // The skill owner is always interested in activity on their skill (usually the actor, then dropped).
  const skillRow = await database
    .select({ ownerId: schema.skills.ownerId })
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, orgId), eq(schema.skills.id, skillId)))
    .limit(1);
  const ownerId = skillRow[0]?.ownerId ?? null;
  if (ownerId) consider(candidates, ownerId, "owner");

  if (eventType === "skill.version_published") {
    const installers = await database
      .select({ userId: schema.skillInstalls.userId })
      .from(schema.skillInstalls)
      .where(and(eq(schema.skillInstalls.orgId, orgId), eq(schema.skillInstalls.skillId, skillId)));
    for (const r of Array.isArray(installers) ? installers : []) consider(candidates, r.userId, "installer");

    const starrers = await database
      .select({ userId: schema.skillStars.userId })
      .from(schema.skillStars)
      .where(and(eq(schema.skillStars.orgId, orgId), eq(schema.skillStars.skillId, skillId)));
    for (const r of Array.isArray(starrers) ? starrers : []) consider(candidates, r.userId, "starrer");
  } else if (eventType === "skill.comment_reply") {
    if (input.parentCommentAuthorId) consider(candidates, input.parentCommentAuthorId, "thread_participant");
    if (input.parentCommentId) {
      // Everyone who has posted in this thread — the root comment itself or any reply to it.
      const thread = await database
        .selectDistinct({ authorId: schema.skillComments.authorId })
        .from(schema.skillComments)
        .where(
          and(
            eq(schema.skillComments.orgId, orgId),
            eq(schema.skillComments.skillId, skillId),
            or(
              eq(schema.skillComments.id, input.parentCommentId),
              eq(schema.skillComments.parentId, input.parentCommentId),
            ),
          ),
        );
      for (const r of Array.isArray(thread) ? thread : []) consider(candidates, r.authorId, "thread_participant");
    }
  }

  // Never notify the actor of their own action.
  candidates.delete(actorId);
  if (candidates.size === 0) return [];

  // Honor explicit mutes: a muted user is removed even if they have a strong relationship.
  const userIds = [...candidates.keys()];
  const muted = await database
    .select({ userId: schema.skillSubscriptions.userId })
    .from(schema.skillSubscriptions)
    .where(
      and(
        eq(schema.skillSubscriptions.orgId, orgId),
        eq(schema.skillSubscriptions.skillId, skillId),
        eq(schema.skillSubscriptions.state, "muted"),
        inArray(schema.skillSubscriptions.userId, userIds),
      ),
    );
  for (const r of Array.isArray(muted) ? muted : []) candidates.delete(r.userId);
  if (candidates.size === 0) return [];

  // Only notify CURRENT org members. Stars/installs/comments are NOT cleaned up when a member is
  // removed (`removeMember` only drops membership/team rows), so without this filter a removed user
  // could still receive in-app rows + emails for a workspace they can no longer access.
  const remaining = [...candidates.keys()];
  const members = await database
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.orgId, orgId), inArray(schema.memberships.userId, remaining)));
  const memberSet = new Set((Array.isArray(members) ? members : []).map((m) => m.userId));
  for (const userId of remaining) if (!memberSet.has(userId)) candidates.delete(userId);

  return [...candidates].map(([userId, reason]) => ({ userId, reason }));
}

/**
 * Resolve recipients and bulk-insert their notification rows (one INSERT). Returns the recipients so
 * the caller (a REST edge) can fire best-effort emails for the high-signal ones. Cardinality is bounded
 * to a single skill's installers/starrers/thread, so one bulk insert is fine.
 */
export async function emitSkillNotifications(input: {
  database: Db;
  orgId: string;
  skillId: string;
  actorId: string;
  type: NotificationType;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  parentCommentAuthorId?: string | null;
  parentCommentId?: string | null;
}): Promise<NotificationRecipient[]> {
  const recipients = await resolveSkillNotificationRecipients({
    database: input.database,
    orgId: input.orgId,
    skillId: input.skillId,
    eventType: input.type,
    actorId: input.actorId,
    parentCommentAuthorId: input.parentCommentAuthorId,
    parentCommentId: input.parentCommentId,
  });
  if (recipients.length === 0) return [];
  await input.database.insert(schema.notifications).values(
    recipients.map((r) => ({
      orgId: input.orgId,
      recipientUserId: r.userId,
      actorId: input.actorId,
      type: input.type,
      reason: r.reason,
      skillId: input.skillId,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata,
    })),
  );
  return recipients;
}

/** Resolve a set of user ids to their email + name, for best-effort notification emails at the edge. */
export async function notificationEmailTargets(input: {
  database: Db;
  userIds: string[];
}): Promise<Array<{ userId: string; email: string; name: string }>> {
  if (input.userIds.length === 0) return [];
  const rows = await input.database
    .select({ id: schema.user.id, email: schema.user.email, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.id, input.userIds));
  return (Array.isArray(rows) ? rows : []).map((r) => ({ userId: r.id, email: r.email, name: r.name }));
}

/**
 * The caller's notification inbox, newest first. RLS scopes only by `org_id`, so the
 * `recipient_user_id = actor.id` filter here is what keeps a user from reading the org's whole inbox.
 */
export async function listNotifications(input: {
  actor: ActorContext;
  orgId: string;
  unreadOnly?: boolean;
  limit?: number;
  before?: string;
  database?: Db;
}): Promise<NotificationRow[]> {
  const database = input.database ?? db;
  // Apply the same skill visibility gate as listSkills: a notification for a skill the actor can no
  // longer see (e.g. its team share was revoked) must not surface its slug/snippet in the inbox.
  const visible = await visibleSkillPredicate(database, input.actor, input.orgId);
  const predicates = [
    eq(schema.notifications.orgId, input.orgId),
    eq(schema.notifications.recipientUserId, input.actor.id),
    visible,
  ];
  if (input.unreadOnly) predicates.push(isNull(schema.notifications.readAt));
  if (input.before) predicates.push(lt(schema.notifications.createdAt, new Date(input.before)));

  const rows = await database
    .select({
      id: schema.notifications.id,
      type: schema.notifications.type,
      reason: schema.notifications.reason,
      skill_id: schema.notifications.skillId,
      skill_slug: schema.skills.slug,
      actor_id: schema.notifications.actorId,
      actor_name: schema.profiles.name,
      actor_initials: schema.profiles.initials,
      target_type: schema.notifications.targetType,
      target_id: schema.notifications.targetId,
      metadata: schema.notifications.metadata,
      read_at: schema.notifications.readAt,
      created_at: schema.notifications.createdAt,
    })
    .from(schema.notifications)
    .innerJoin(schema.skills, eq(schema.skills.id, schema.notifications.skillId))
    .leftJoin(schema.profiles, eq(schema.profiles.id, schema.notifications.actorId))
    .where(and(...predicates))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(input.limit ?? 30);

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    reason: r.reason,
    skill_id: r.skill_id,
    skill_slug: r.skill_slug,
    actor_id: r.actor_id,
    actor_name: r.actor_name,
    actor_initials: r.actor_initials,
    target_type: r.target_type,
    target_id: r.target_id,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    read_at: r.read_at ? r.read_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
  }));
}

/** The caller's unread notification count (powers the bell badge). */
export async function unreadNotificationCount(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<number> {
  const database = input.database ?? db;
  // Join skills + the visibility gate so the badge count matches what listNotifications surfaces
  // (notifications for now-invisible skills are excluded).
  const visible = await visibleSkillPredicate(database, input.actor, input.orgId);
  const rows = await database
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(schema.notifications)
    .innerJoin(schema.skills, eq(schema.skills.id, schema.notifications.skillId))
    .where(
      and(
        eq(schema.notifications.orgId, input.orgId),
        eq(schema.notifications.recipientUserId, input.actor.id),
        isNull(schema.notifications.readAt),
        visible,
      ),
    );
  return rows[0]?.count ?? 0;
}

/** Mark the caller's notifications read — either an explicit `ids` set, or `all` unread rows. */
export async function markNotificationsRead(input: {
  actor: ActorContext;
  orgId: string;
  ids?: string[];
  all?: boolean;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const predicates = [
    eq(schema.notifications.orgId, input.orgId),
    eq(schema.notifications.recipientUserId, input.actor.id),
    isNull(schema.notifications.readAt),
  ];
  if (!input.all) {
    if (!input.ids || input.ids.length === 0) return;
    predicates.push(inArray(schema.notifications.id, input.ids));
  }
  await database
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(...predicates));
}

/**
 * Set or clear the caller's explicit subscription override for a skill. v1 only supports muting; a
 * "default" state deletes the row, reverting to the implicit subscription derived from relationships.
 * Subscribing/muting is personal state (like a star): any member who can see the skill may do it, so
 * there is no capability gate — only the visibility gate via `getSkillBySlug`.
 */
export async function setSkillSubscription(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  state: "muted" | "subscribed" | "default";
  database?: Db;
}): Promise<{ state: "muted" | "subscribed" | null }> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug({ actor: input.actor, orgId: input.orgId, slug: input.slug, database });
  if (!skill) throw new Error("skill not found");

  if (input.state === "default") {
    await database
      .delete(schema.skillSubscriptions)
      .where(
        and(
          eq(schema.skillSubscriptions.orgId, input.orgId),
          eq(schema.skillSubscriptions.skillId, skill.id),
          eq(schema.skillSubscriptions.userId, input.actor.id),
        ),
      );
    return { state: null };
  }

  await database
    .insert(schema.skillSubscriptions)
    .values({ orgId: input.orgId, skillId: skill.id, userId: input.actor.id, state: input.state })
    .onConflictDoUpdate({
      target: [schema.skillSubscriptions.skillId, schema.skillSubscriptions.userId],
      set: { state: input.state, updatedAt: new Date() },
    });
  return { state: input.state };
}

/** The caller's explicit override for a skill, or null when implicit. */
export async function getSkillSubscriptionState(input: {
  actor: ActorContext;
  orgId: string;
  skillId: string;
  database?: Db;
}): Promise<"muted" | "subscribed" | null> {
  const database = input.database ?? db;
  const row = await database.query.skillSubscriptions.findFirst({
    where: and(
      eq(schema.skillSubscriptions.orgId, input.orgId),
      eq(schema.skillSubscriptions.skillId, input.skillId),
      eq(schema.skillSubscriptions.userId, input.actor.id),
    ),
  });
  return row?.state ?? null;
}
