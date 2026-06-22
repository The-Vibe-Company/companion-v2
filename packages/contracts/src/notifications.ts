import { z } from "zod";

/**
 * The kind of skill event a notification records. The 4 values exist for extensibility; v1 only ever
 * emits `skill.version_published` and `skill.comment_reply`.
 */
export const notificationTypeSchema = z.enum([
  "skill.version_published",
  "skill.comment_added",
  "skill.comment_reply",
  "skill.archived",
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/**
 * Why the recipient got the notification — i.e. their relationship to the skill at emit time. Drives
 * the relationship-aware copy in the notification panel.
 */
export const notificationReasonSchema = z.enum([
  "owner",
  "installer",
  "starrer",
  "commenter",
  "thread_participant",
  "subscriber",
]);
export type NotificationReason = z.infer<typeof notificationReasonSchema>;

/** One row of the caller's notification inbox (machine-facing snake_case, mirrors the DB). */
export const notificationRowSchema = z.object({
  id: z.string(),
  type: notificationTypeSchema,
  reason: notificationReasonSchema,
  skill_id: z.string(),
  skill_slug: z.string(),
  /** The user whose action produced this; null for system events or a deleted account. */
  actor_id: z.string().nullable(),
  actor_name: z.string().nullable().optional(),
  actor_initials: z.string().nullable().optional(),
  /** Polymorphic deep-link target, e.g. "skill_version" | "skill_comment". */
  target_type: z.string(),
  target_id: z.string(),
  /** Denormalized render payload: { slug, version?, snippet?, comment_id?, parent_comment_id? }. */
  metadata: z.record(z.unknown()).default({}),
  read_at: z.string().nullable(),
  created_at: z.string(),
});
export type NotificationRow = z.infer<typeof notificationRowSchema>;

/** Response of `GET /v1/notifications/unread-count`. */
export const unreadNotificationCountSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type UnreadNotificationCount = z.infer<typeof unreadNotificationCountSchema>;

/**
 * Body of `POST /v1/notifications/read` — mark notifications read. Either pass explicit `ids`
 * (the rows just shown) or `all: true` to clear the whole inbox.
 */
export const markNotificationsReadInputSchema = z
  .object({
    ids: z.array(z.string()).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all === true || (v.ids != null && v.ids.length > 0), {
    message: "provide ids or all",
  });
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadInputSchema>;

/** The two explicit override states a user can set on a skill subscription. */
export const skillSubscriptionStateSchema = z.enum(["subscribed", "muted"]);
export type SkillSubscriptionState = z.infer<typeof skillSubscriptionStateSchema>;

/**
 * Body of `POST /v1/skills/:slug/subscribe`. v1 only supports muting (implicit subscribe + explicit
 * mute); `DELETE` reverts to the implicit default.
 */
export const setSkillSubscriptionInputSchema = z.object({
  state: z.enum(["muted"]).default("muted"),
});
export type SetSkillSubscriptionInput = z.infer<typeof setSkillSubscriptionInputSchema>;

/** Response of the subscribe/unsubscribe endpoints — the caller's resulting override (null = implicit). */
export const skillSubscriptionResultSchema = z.object({
  state: skillSubscriptionStateSchema.nullable(),
});
export type SkillSubscriptionResult = z.infer<typeof skillSubscriptionResultSchema>;
