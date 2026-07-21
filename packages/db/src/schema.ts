import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "developer"]);
export const validationStateEnum = pgEnum("validation_state", ["valid", "validating", "invalid"]);
// A skill's library scope. 'org' = the flat org-wide library (default; visible to every member).
// 'personal' = private to `creator_id` (the owner) — the design's "My Skills". Only the owner sees it,
// even admins do not. Share flips 'personal' → 'org'; there is no reverse transition.
export const skillScopeEnum = pgEnum("skill_scope", ["personal", "org"]);
export const orgKindEnum = pgEnum("org_kind", ["personal", "team"]);
export const billingSeatSyncStatusEnum = pgEnum("billing_seat_sync_status", ["synced", "pending", "error"]);
export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export const secretAudienceEnum = pgEnum("secret_audience", ["personal", "restricted", "organization"]);
export const secretBindingSourceEnum = pgEnum("secret_binding_source", ["manual", "suggestion"]);
export const secretSlotStatusEnum = pgEnum("secret_slot_status", [
  "personal",
  "shared",
  "required",
  "optional_missing",
]);
export const modelProviderConnectionScopeEnum = pgEnum("model_provider_connection_scope", [
  "personal",
  "organization",
]);
export const githubSyncModeEnum = pgEnum("github_sync_mode", ["all", "selected"]);
export const githubSyncStatusEnum = pgEnum("github_sync_status", [
  "pending",
  "syncing",
  "synced",
  "error",
  "disconnected",
]);

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const profiles = pgTable("profiles", {
  id: text("id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  initials: text("initials").notNull(),
  handle: text("handle"),
  /**
   * Same-origin serve path for a custom uploaded avatar (`/v1/users/{id}/avatar`), or null to fall
   * back to the user's Gravatar / colored initials. Parallels `organizations.logoUrl`; the binary
   * lives in object storage under `users/{id}/avatar`.
   */
  avatarUrl: text("avatar_url"),
  /** Set when the user finishes onboarding (creates/joins an org) or accepts an invite. Null = needs onboarding. */
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  createdAt: now(),
  updatedAt: updatedAt(),
});

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    kind: orgKindEnum("kind").notNull().default("team"),
    /** Verified email domain that grants membership (e.g. "acme.com"); null for personal/unclaimed orgs. */
    domain: text("domain"),
    /** When true, anyone signing up with a matching verified `domain` is auto-added as a member. */
    domainAutoJoin: boolean("domain_auto_join").notNull().default(false),
    /** Brand color (CSS color string) chosen during onboarding; cosmetic. */
    color: text("color"),
    /** Brand logo URL fetched/uploaded during onboarding; cosmetic. */
    logoUrl: text("logo_url"),
    /**
     * The org's own skill-naming policy: a free-text prompt describing how this organization wants
     * skills named and filed. Read by the triage skill and applied per-org. Companion imposes
     * nothing; null means this org has no policy.
     */
    skillNamingPolicy: text("skill_naming_policy"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
);

export const organizationDomains = pgTable(
  "organization_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgDomain: uniqueIndex("organization_domains_org_domain_uq").on(t.orgId, sql`lower(${t.domain})`),
    byDomain: index("organization_domains_domain_idx").on(sql`lower(${t.domain})`),
  }),
);

export const memberships = pgTable(
  "memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgRole: orgRoleEnum("org_role").notNull().default("developer"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    byUser: index("memberships_user_idx").on(t.userId),
  }),
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    orgRole: orgRoleEnum("org_role").notNull().default("developer"),
    token: text("token").notNull().unique(),
    status: invitationStatusEnum("status").notNull().default("pending"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: now(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    activeInvite: uniqueIndex("invitations_pending_email_uq").on(t.orgId, t.email).where(sql`${t.status} = 'pending'`),
  }),
);

/**
 * Stripe's raw subscription state, kept separate from the effective Free/Pro decision. One row per
 * organization also acts as the durable seat-sync/Checkout outbox for the billing worker.
 */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    stripeSubscriptionItemId: text("stripe_subscription_item_id").unique(),
    stripePriceId: text("stripe_price_id"),
    stripeStatus: text("stripe_status"),
    syncedQuantity: integer("synced_quantity"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
    lastStripeEventId: text("last_stripe_event_id"),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    seatSyncStatus: billingSeatSyncStatusEnum("seat_sync_status").notNull().default("synced"),
    seatSyncRequestedAt: timestamp("seat_sync_requested_at", { withTimezone: true }),
    seatSyncAttempts: integer("seat_sync_attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    checkoutSessionId: text("checkout_session_id").unique(),
    checkoutExpiresAt: timestamp("checkout_expires_at", { withTimezone: true }),
    checkoutGeneration: integer("checkout_generation").notNull().default(0),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pendingSeatSync: index("billing_subscriptions_pending_idx").on(t.seatSyncStatus, t.nextRetryAt),
    reconcileDue: index("billing_subscriptions_reconcile_idx").on(t.lastReconciledAt),
    positiveQuantity: check("billing_subscriptions_quantity_check", sql`${t.syncedQuantity} is null or ${t.syncedQuantity} >= 1`),
    nonnegativeAttempts: check("billing_subscriptions_attempts_check", sql`${t.seatSyncAttempts} >= 0`),
    nonnegativeCheckoutGeneration: check("billing_subscriptions_checkout_generation_check", sql`${t.checkoutGeneration} >= 0`),
  }),
);

/** Processed Stripe event ids. Events are tenant-bound before insertion; unknown events are logged only. */
export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    eventId: text("event_id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    status: text("status", { enum: ["processing", "processed", "failed"] }).notNull().default("processing"),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    byOrg: index("stripe_webhook_events_org_idx").on(t.orgId, t.receivedAt),
    validStatus: check("stripe_webhook_events_status_check", sql`${t.status} in ('processing', 'processed', 'failed')`),
  }),
);

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shareToken: text("share_token")
      .notNull()
      .unique()
      .default(sql`substr(replace(gen_random_uuid()::text,'-',''),1,16)`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    /** Mutable display-title override used by explicit rename; version manifests stay immutable. */
    displayName: text("display_name"),
    // `creator_id` records who first published the skill (provenance/Activity, drives the profile
    // join). It is also the OWNER of a personal skill: when `scope = 'personal'` only this user can
    // read/edit/share it. Org skills (`scope = 'org'`) keep the flat model — every member may edit.
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Library scope. 'org' (default) = flat org-wide library; 'personal' = private to creator_id.
    scope: skillScopeEnum("scope").notNull().default("org"),
    currentVersionId: uuid("current_version_id"),
    validation: validationStateEnum("validation").notNull().default("valid"),
    validationError: text("validation_error"),
    // Archive (soft-hide) lifecycle: archived skills drop out of the normal lists but stay
    // viewable, restorable, and downloadable while a published version still references them.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: text("archived_by").references(() => user.id, { onDelete: "set null" }),
    archiveReason: text("archive_reason"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgSlug: unique("skills_org_slug_uq").on(t.orgId, t.slug),
    uniqueOrgId: unique("skills_org_id_id_uq").on(t.orgId, t.id),
    byArchived: index("skills_archived_idx").on(t.orgId, t.archivedAt),
    // My-Skills authored-list lookups: (org, scope, creator). Org lists use the slug uq / PK.
    byScope: index("skills_org_scope_creator_idx").on(t.orgId, t.scope, t.creatorId),
  }),
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    note: text("note").notNull().default(""),
    frontmatter: text("frontmatter").notNull(),
    // The SKILL.md markdown body (instructions), kept server-side to power full-text search.
    body: text("body").notNull().default(""),
    tools: jsonb("tools").$type<string[]>().notNull().default([]),
    license: text("license"),
    sizeBytes: integer("size_bytes").notNull(),
    checksum: text("checksum").notNull(),
    storagePath: text("storage_path").notNull(),
    validation: validationStateEnum("validation").notNull().default("valid"),
    validationError: text("validation_error"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: now(),
  },
  (t) => ({
    uniqueSkillVersion: unique("skill_versions_skill_version_uq").on(t.skillId, t.version),
    // Supports org-scoped composite FKs from skill_version_dependencies.
    uniqueOrgId: unique("skill_versions_org_id_id_uq").on(t.orgId, t.id),
    // Pins a version to its owning skill for immutable run snapshots.
    uniqueOrgSkillId: unique("skill_versions_org_skill_id_uq").on(t.orgId, t.skillId, t.id),
    byOrg: index("skill_versions_org_idx").on(t.orgId),
    checksumCheck: check("skill_versions_checksum_check", sql`${t.checksum} ~ '^sha256:[0-9a-f]{64}$'`),
  }),
);

/**
 * One required skill→skill dependency edge, declared by a specific source *version*
 * (so each version keeps its exact dependency graph). Dependencies are un-versioned: a row
 * records the declared target *slug* and a resolved target skill id. `dependsOnSkillId` is null
 * when the slug is not published in the workspace (a "missing" dependency). Statuses
 * (satisfied / missing / archived / cycle) are computed live at read time from current skill
 * state — never stored.
 */
export const skillVersionDependencies = pgTable(
  "skill_version_dependencies",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // The dependent version that declares this dependency.
    skillVersionId: uuid("skill_version_id").notNull(),
    // The dependent skill (denormalized so "current-version edges" and "used-by" queries stay simple).
    skillId: uuid("skill_id").notNull(),
    // The declared dependency slug — always present, so a missing dependency is representable.
    dependsOnSlug: text("depends_on_slug").notNull(),
    // The resolved target skill, or null when the slug is not published in the workspace.
    dependsOnSkillId: uuid("depends_on_skill_id").references(() => skills.id, { onDelete: "set null" }),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.skillVersionId, t.dependsOnSlug] }),
    bySkill: index("skill_version_deps_skill_idx").on(t.orgId, t.skillId),
    byTarget: index("skill_version_deps_target_idx").on(t.orgId, t.dependsOnSkillId),
    // Org-scoped composite FKs guarantee the row's org matches the rows it references, so a
    // service/seed/import bug can never persist a cross-tenant dependency edge.
    versionOrgFk: foreignKey({
      columns: [t.orgId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.id],
      name: "skill_version_deps_version_org_fk",
    }).onDelete("cascade"),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_version_deps_skill_org_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * The org-wide shared label ("folder") tree. The canonical set of paths plus their per-path
 * appearance (color + icon). A row here is what lets an **empty** folder exist (a path with no
 * assigned skills). `path` is slash-separated kebab segments (`marketing/seo`); intermediate parents
 * are derived in the service by splitting on `/`, not stored explicitly. Org-scoped + RLS-tenanted;
 * any member may create/rename/recolor/delete. The `(org_id, path)` index uses `text_pattern_ops`
 * so prefix `LIKE path || '/%'` lookups (roll-up counts, rename/delete cascade) stay index-friendly.
 */
export const labels = pgTable(
  "labels",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    /** Human-facing segment name for this exact path; null falls back to the path leaf. */
    displayName: text("display_name"),
    /** Per-path swatch (CSS color string); null = the default/inherited appearance. */
    color: text("color"),
    /** Per-path icon key (lucide glyph name); null = the default folder icon. */
    icon: text("icon"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.path] }),
    byPath: index("labels_org_path_idx").using("btree", t.orgId, t.path.asc().op("text_pattern_ops")),
  }),
);

/**
 * The assignment edge: a skill is "filed in" N label paths. One row per (skill, path). The path
 * string is stored here directly (no FK to a label id) so a rename is a prefix `UPDATE` and a delete
 * is a prefix `DELETE` across both tables, and roll-up counts need no join. Org-scoped composite FK
 * `(org_id, skill_id) → skills(org_id, id)` cascades on skill/org delete and guarantees the edge's
 * org matches the skill's. `text_pattern_ops` index on `(org_id, path)` for the prefix lookups.
 */
export const skillLabels = pgTable(
  "skill_labels",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    path: text("path").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.skillId, t.path] }),
    byPath: index("skill_labels_org_path_idx").using("btree", t.orgId, t.path.asc().op("text_pattern_ops")),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_labels_skill_org_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Per-user personal folder tree — the "My Skills" counterpart to {@link labels}. Same shape, but
 * keyed by `(org_id, owner_id, path)` so each user's personal library has its own private folders. A
 * row lets an empty personal folder exist. RLS is user-scoped (org_id AND owner_id) because these
 * rows are private; the service additionally filters `owner_id = actor.id` on every query.
 */
export const personalLabels = pgTable(
  "personal_labels",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    displayName: text("display_name"),
    color: text("color"),
    icon: text("icon"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.ownerId, t.path] }),
    byPath: index("personal_labels_owner_path_idx").using(
      "btree",
      t.orgId,
      t.ownerId,
      t.path.asc().op("text_pattern_ops"),
    ),
  }),
);

/**
 * The personal assignment edge: an authored personal skill is "filed in" N personal paths. One row
 * per (owner, skill, path). Path stored directly so rename = prefix `UPDATE` and delete = prefix
 * `DELETE`. The org-scoped composite FK `(org_id, skill_id) → skills(org_id, id)` guarantees the
 * edge's org matches the skill's and cascades on skill/org delete (e.g. when a shared skill is reaped).
 */
export const personalSkillLabels = pgTable(
  "personal_skill_labels",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    path: text("path").notNull(),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.ownerId, t.skillId, t.path] }),
    byPath: index("personal_skill_labels_owner_path_idx").using(
      "btree",
      t.orgId,
      t.ownerId,
      t.path.asc().op("text_pattern_ops"),
    ),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "personal_skill_labels_skill_org_fk",
    }).onDelete("cascade"),
  }),
);

export const skillFilterPreferences = pgTable(
  "skill_filter_preferences",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeFilters: jsonb("active_filters").$type<unknown[]>().notNull().default([]),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
  }),
);

export const skillComments = pgTable(
  "skill_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    /** Null = root thread; non-null = a reply to that root comment. Single-level nesting only. */
    parentId: uuid("parent_id").references((): AnyPgColumn => skillComments.id, { onDelete: "cascade" }),
    /** Null = global thread; else the skill_versions row this thread is linked to. */
    versionId: uuid("version_id").references(() => skillVersions.id, { onDelete: "set null" }),
    /** Deprecated threads are greyed/struck-through, never deleted. */
    deprecated: boolean("deprecated").notNull().default(false),
    createdAt: now(),
  },
  (t) => ({
    byOrg: index("skill_comments_org_idx").on(t.orgId),
    bySkillParent: index("skill_comments_skill_parent_idx").on(t.skillId, t.parentId),
  }),
);

/**
 * Image attachments on a comment. One row per image, ordered by `position`. The bytes live in
 * object storage (key = `${orgId}/comments/${id}`); only metadata is kept here. Tenant-scoped and
 * cascade-deleted with the parent comment / skill / org.
 */
export const skillCommentImages = pgTable(
  "skill_comment_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => skillComments.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: now(),
  },
  (t) => ({
    byComment: index("skill_comment_images_comment_idx").on(t.commentId),
    byOrg: index("skill_comment_images_org_idx").on(t.orgId),
  }),
);

/**
 * Personal access tokens for programmatic publish/install over the API. The plaintext
 * `cmp_pat_<hex>` is shown to the caller once; only its sha256 `token_hash` is stored.
 * `scopes` gates capability (`skills:read` / `skills:write` / `secrets:read` / `secrets:write`); tokens expire
 * (90 days by default) and can be revoked.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    byOrgUser: index("api_tokens_org_user_idx").on(t.orgId, t.userId),
  }),
);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: now(),
});

/**
 * Tracks which built-in local helper skills (the "Companion skills" section) a member has installed
 * on their machine, and at which version. The local skill reports here at the end of its install via
 * `POST /v1/local-skills/:key/installed`; the UI compares `installed_version` against the bundled
 * package version to show Not installed / Installed / Update available. One row per member per
 * `skill_key` per workspace.
 */
export const localSkillInstalls = pgTable(
  "local_skill_installs",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Built-in skill key, e.g. `companion`. */
    skillKey: text("skill_key").notNull(),
    /** Semver the agent reported installing. */
    installedVersion: text("installed_version").notNull(),
    /** Optional free-form source label, e.g. "Claude Code". */
    agentLabel: text("agent_label"),
    /** First time this member reported the skill installed. */
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Latest report ("last checked" in the UI). */
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId, t.skillKey] }),
    byOrgUser: index("local_skill_installs_org_user_idx").on(t.orgId, t.userId),
  }),
);

/**
 * Tracks which PUBLISHED Skills Hub skills (the `skills` table) a member has installed, and at which
 * version. The assistant reports a confirmed install via `POST /v1/skills/:slug/install`
 * (source = "agent") at the end of the normal install flow; a member can also mark a skill
 * installed / not-installed by hand from the UI (source = "manual", e.g. installed another way, or
 * correcting a false state). `installed_version` is null when a manual mark didn't supply one. The
 * list view compares `installed_version` against the skill's current published version to show
 * Installed / Update available. One row per member per skill per workspace.
 */
export const skillInstalls = pgTable(
  "skill_installs",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    /** Semver the member/agent reported, or null when a manual mark didn't supply one. */
    installedVersion: text("installed_version"),
    /** Optional free-form source label, e.g. "Claude Code". */
    agentLabel: text("agent_label"),
    /** How the install was recorded: "agent" (reported by the assistant) or "manual" (marked by hand). */
    source: text("source", { enum: ["agent", "manual"] }).notNull().default("manual"),
    /** First time this member recorded the skill installed. */
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Latest report/mark ("last checked"). */
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId, t.skillId] }),
    byOrgUser: index("skill_installs_org_user_idx").on(t.orgId, t.userId),
  }),
);

/** One GitHub App user authorization per workspace. Plaintext OAuth credentials never enter Postgres. */
export const githubConnections = pgTable(
  "github_connections",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    githubUserId: text("github_user_id").notNull(),
    githubLogin: text("github_login").notNull(),
    githubAvatarUrl: text("github_avatar_url"),
    /** Rotated for every OAuth connect or refresh so stale refreshes cannot overwrite a replacement row. */
    credentialGeneration: uuid("credential_generation").notNull().defaultRandom(),
    credentialVersion: integer("credential_version").notNull().default(1),
    accessCiphertext: text("access_ciphertext").notNull(),
    accessIv: text("access_iv").notNull(),
    accessAuthTag: text("access_auth_tag").notNull(),
    accessWrappedDek: text("access_wrapped_dek").notNull(),
    accessWrapIv: text("access_wrap_iv").notNull(),
    accessWrapAuthTag: text("access_wrap_auth_tag").notNull(),
    accessKeyId: text("access_key_id").notNull(),
    refreshCiphertext: text("refresh_ciphertext"),
    refreshIv: text("refresh_iv"),
    refreshAuthTag: text("refresh_auth_tag"),
    refreshWrappedDek: text("refresh_wrapped_dek"),
    refreshWrapIv: text("refresh_wrap_iv"),
    refreshWrapAuthTag: text("refresh_wrap_auth_tag"),
    refreshKeyId: text("refresh_key_id"),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
    connectedBy: text("connected_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    credentialVersionCheck: check("github_connections_credential_version_check", sql`${t.credentialVersion} >= 1`),
  }),
);

/** A desired-state, one-way Companion → GitHub repository mirror. */
export const githubSyncDestinations = pgTable(
  "github_sync_destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    htmlUrl: text("html_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    private: boolean("private").notNull().default(true),
    mode: githubSyncModeEnum("mode").notNull().default("all"),
    status: githubSyncStatusEnum("status").notNull().default("pending"),
    desiredRevision: integer("desired_revision").notNull().default(1),
    appliedRevision: integer("applied_revision").notNull().default(0),
    resolvedSkillCount: integer("resolved_skill_count").notNull().default(0),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    lastCommitSha: text("last_commit_sha"),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /** Monotonic fencing token incremented on every claim, including claims by the same worker. */
    leaseGeneration: integer("lease_generation").notNull().default(0),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgId: unique("github_sync_destinations_org_id_id_uq").on(t.orgId, t.id),
    uniqueRepository: unique("github_sync_destinations_repository_uq").on(t.repositoryId),
    due: index("github_sync_destinations_due_idx").on(t.status, t.nextRetryAt, t.leaseUntil),
    revisionCheck: check(
      "github_sync_destinations_revision_check",
      sql`${t.desiredRevision} >= 1 AND ${t.appliedRevision} >= 0 AND ${t.appliedRevision} <= ${t.desiredRevision}`,
    ),
    attemptsCheck: check("github_sync_destinations_attempts_check", sql`${t.attempts} >= 0`),
    leaseGenerationCheck: check(
      "github_sync_destinations_lease_generation_check",
      sql`${t.leaseGeneration} >= 0`,
    ),
  }),
);

/** Explicit roots for selected-mode mirrors. Dependency closure is derived live by the worker. */
export const githubSyncDestinationSkills = pgTable(
  "github_sync_destination_skills",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.destinationId, t.skillId] }),
    destinationFk: foreignKey({
      columns: [t.orgId, t.destinationId],
      foreignColumns: [githubSyncDestinations.orgId, githubSyncDestinations.id],
      name: "github_sync_destination_skills_destination_org_fk",
    }).onDelete("cascade"),
    skillFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "github_sync_destination_skills_skill_org_fk",
    }).onDelete("cascade"),
    bySkill: index("github_sync_destination_skills_skill_idx").on(t.orgId, t.skillId),
  }),
);

/** Dedicated, write-only model-provider connection. It never references the generic Secrets vault. */
export const modelProviderConnections = pgTable(
  "model_provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scope: modelProviderConnectionScopeEnum("scope").notNull(),
    /** Set only for personal connections; workspace connections have no owner override. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** models.dev provider id, e.g. "anthropic". */
    provider: text("provider").notNull(),
    /** Exact environment key expected by the provider. */
    keyName: text("key_name").notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgId: unique("model_provider_connections_org_id_id_uq").on(t.orgId, t.id),
    personalProvider: uniqueIndex("model_provider_connections_personal_provider_uq")
      .on(t.orgId, t.userId, t.provider)
      .where(sql`${t.scope} = 'personal'`),
    orgProvider: uniqueIndex("model_provider_connections_org_provider_uq")
      .on(t.orgId, t.provider)
      .where(sql`${t.scope} = 'organization'`),
    providerCheck: check("model_provider_connections_provider_check", sql`char_length(${t.provider}) BETWEEN 1 AND 120`),
    keyCheck: check("model_provider_connections_key_check", sql`${t.keyName} ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND ${t.keyName} !~ '^OPENCODE_SERVER_'`),
    scopeOwnerCheck: check(
      "model_provider_connections_scope_owner_check",
      sql`(${t.scope} = 'personal' AND ${t.userId} IS NOT NULL) OR (${t.scope} = 'organization' AND ${t.userId} IS NULL)`,
    ),
    versionCheck: check("model_provider_connections_version_check", sql`${t.currentVersion} >= 1`),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "model_provider_connections_member_org_fk",
    }).onDelete("cascade"),
  }),
);

/** Immutable encrypted versions retained across rotations and erased with their connection. */
export const modelProviderCredentialVersions = pgTable(
  "model_provider_credential_versions",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    version: integer("version").notNull(),
    /** Exact environment key paired with this immutable credential version. */
    keyName: text("key_name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    wrapIv: text("wrap_iv").notNull(),
    wrapAuthTag: text("wrap_auth_tag").notNull(),
    keyId: text("key_id").notNull(),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.connectionId, t.version] }),
    connectionFk: foreignKey({
      columns: [t.orgId, t.connectionId],
      foreignColumns: [modelProviderConnections.orgId, modelProviderConnections.id],
      name: "model_provider_credential_versions_connection_org_fk",
    }).onDelete("cascade"),
    versionCheck: check("model_provider_credential_versions_version_check", sql`${t.version} >= 1`),
    keyCheck: check(
      "model_provider_credential_versions_key_check",
      sql`${t.keyName} ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND ${t.keyName} !~ '^OPENCODE_SERVER_'`,
    ),
  }),
);

/* ----------------------------- saved run configs ----------------------------- */

/** Personal, named launcher defaults. Prompt and attachments are deliberately excluded. */
export const skillRunConfigs = pgTable(
  "skill_run_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    model: text("model").notNull(),
    revision: integer("revision").notNull().default(1),
    isDefault: boolean("is_default").notNull().default(false),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgId: unique("skill_run_configs_org_id_id_uq").on(t.orgId, t.id),
    uniqueIdentity: unique("skill_run_configs_identity_uq").on(t.orgId, t.id, t.creatorId, t.skillId),
    uniqueName: unique("skill_run_configs_name_uq").on(t.orgId, t.creatorId, t.skillId, t.name),
    oneDefault: uniqueIndex("skill_run_configs_default_uq")
      .on(t.orgId, t.creatorId, t.skillId)
      .where(sql`${t.isDefault} = true`),
    byOwnerSkill: index("skill_run_configs_owner_skill_idx").on(t.orgId, t.creatorId, t.skillId, t.updatedAt),
    skillFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_run_configs_skill_org_fk",
    }).onDelete("cascade"),
    revisionCheck: check("skill_run_configs_revision_check", sql`${t.revision} >= 1`),
    nameCheck: check("skill_run_configs_name_check", sql`char_length(btrim(${t.name})) BETWEEN 1 AND 120`),
  }),
);

/** Secret references saved by stable slot; values and versions are resolved only when a run starts. */
export const skillRunConfigSecrets = pgTable(
  "skill_run_config_secrets",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    configId: uuid("config_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    slotId: uuid("slot_id").notNull(),
    secretId: uuid("secret_id").notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.configId, t.skillId, t.slotId] }),
    bySecret: index("skill_run_config_secrets_secret_idx").on(t.orgId, t.secretId),
    configFk: foreignKey({
      columns: [t.orgId, t.configId],
      foreignColumns: [skillRunConfigs.orgId, skillRunConfigs.id],
      name: "skill_run_config_secrets_config_org_fk",
    }).onDelete("cascade"),
    slotFk: foreignKey({
      columns: [t.orgId, t.skillId, t.slotId],
      foreignColumns: [skillSecretSlots.orgId, skillSecretSlots.skillId, skillSecretSlots.slotId],
      name: "skill_run_config_secrets_slot_org_fk",
    }).onDelete("cascade"),
    secretFk: foreignKey({
      columns: [t.orgId, t.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: "skill_run_config_secrets_secret_org_fk",
    }).onDelete("restrict"),
  }),
);

/** Non-sensitive values saved for manifest-declared environment variables. */
export const skillRunConfigVariables = pgTable(
  "skill_run_config_variables",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    configId: uuid("config_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    envKey: text("env_key").notNull(),
    value: text("value").notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.configId, t.skillId, t.envKey] }),
    configFk: foreignKey({
      columns: [t.orgId, t.configId],
      foreignColumns: [skillRunConfigs.orgId, skillRunConfigs.id],
      name: "skill_run_config_variables_config_org_fk",
    }).onDelete("cascade"),
    skillFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_run_config_variables_skill_org_fk",
    }).onDelete("cascade"),
    envKeyCheck: check(
      "skill_run_config_variables_key_check",
      sql`${t.envKey} ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND ${t.envKey} !~ '^OPENCODE_SERVER_'`,
    ),
    valueSizeCheck: check("skill_run_config_variables_value_size_check", sql`octet_length(${t.value}) <= 32768`),
  }),
);

/**
 * A member's ACTIVATED models for the run launcher: the short, personally curated list the model
 * picker shows (the full models.dev catalog lives only in Settings → Models). The effective set a
 * member can run = their personal list ∪ the workspace list ({@link orgModelPreferences}) — enforced
 * hard in `createRun`, not just hidden in the picker. Model ids are OpenCode `provider/model-id`
 * refs, validated against the catalog at write time and pruned against it at read time.
 */
export const userModelPreferences = pgTable(
  "user_model_preferences",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activatedModels: jsonb("activated_models").$type<string[]>().notNull().default([]),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
  }),
);

/**
 * The workspace-shared activated-model list, curated by owners/admins and unioned into every
 * member's effective set. `created_by` is nullable so `pnpm db:seed` (which creates no user) can
 * seed a default list.
 */
export const orgModelPreferences = pgTable(
  "org_model_preferences",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    activatedModels: jsonb("activated_models").$type<string[]>().notNull().default([]),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId] }),
  }),
);

/* ---------------------------------- skill runs ---------------------------------- */

export const skillRunStatusEnum = pgEnum("skill_run_status", [
  "queued",
  "starting",
  "running",
  "frozen",
  "error",
  "canceled",
]);
export const skillRunPhaseEnum = pgEnum("skill_run_phase", [
  "queued",
  "resolve_inputs",
  "fork",
  "push_workspace",
  "start_server",
  "healthcheck",
  "create_session",
  "prompt",
  "record",
  "freeze",
  "cancel",
  "cleanup",
  "complete",
]);
export const skillRunSecretProvenanceEnum = pgEnum("skill_run_secret_provenance", [
  "skill",
  "runtime",
]);
export const skillRunJobStatusEnum = pgEnum("skill_run_job_status", [
  "queued",
  "leased",
  "completed",
  "failed",
  "canceled",
]);
export const skillRunPromptKindEnum = pgEnum("skill_run_prompt_kind", ["initial", "follow_up"]);
export const skillRunPromptStatusEnum = pgEnum("skill_run_prompt_status", [
  "queued",
  "processing",
  "completed",
  "error",
  "canceled",
]);
export const skillRunPrewarmStatusEnum = pgEnum("skill_run_prewarm_status", [
  "queued",
  "warming",
  "ready",
  "failed",
  "canceled",
]);
export const skillRunPrewarmPhaseEnum = pgEnum("skill_run_prewarm_phase", [
  "queued",
  "fork",
  "push_skills",
  "ready",
  "cleanup",
  "complete",
]);
export const sandboxUsageKindEnum = pgEnum("sandbox_usage_kind", ["prewarm", "run"]);

/** Creator-private launcher behavior. Prewarming is opt-out so existing launch latency is preserved. */
export const userRunPreferences = pgTable(
  "user_run_preferences",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    prewarmEnabled: boolean("prewarm_enabled").notNull().default(true),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.orgId, t.userId] }) }),
);

/**
 * One billable provider session. Active rows hold a conservative reservation; settlement replaces
 * it with rounded-up wall-clock minutes once the sandbox is stopped or destroyed.
 */
export const sandboxUsageSessions = pgTable(
  "sandbox_usage_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    creatorId: text("creator_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    kind: sandboxUsageKindEnum("kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    sandboxName: text("sandbox_name").notNull(),
    activationRevision: integer("activation_revision").notNull().default(0),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    reservedMs: integer("reserved_ms").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    settledMs: integer("settled_ms"),
    reservationExpiresAt: timestamp("reservation_expires_at", { withTimezone: true }).notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    sourceActivation: unique("sandbox_usage_sessions_source_activation_uq").on(
      t.orgId,
      t.kind,
      t.sourceId,
      t.activationRevision,
    ),
    sandboxActivation: unique("sandbox_usage_sessions_sandbox_activation_uq").on(
      t.orgId,
      t.sandboxName,
      t.activationRevision,
    ),
    byPeriod: index("sandbox_usage_sessions_period_idx").on(t.orgId, t.periodStart),
    durationCheck: check(
      "sandbox_usage_sessions_duration_check",
      sql`${t.reservedMs} >= 60000 AND (${t.settledMs} IS NULL OR ${t.settledMs} >= 0)`,
    ),
    revisionCheck: check("sandbox_usage_sessions_revision_check", sql`${t.activationRevision} >= 0`),
    lifecycleCheck: check(
      "sandbox_usage_sessions_lifecycle_check",
      sql`(${t.endedAt} IS NULL AND ${t.settledMs} IS NULL) OR (${t.endedAt} IS NOT NULL AND ${t.settledMs} IS NOT NULL)`,
    ),
  }),
);

/**
 * Secretless, creator-private sandbox prepared while the Run Skill launcher is open. It owns only
 * skill-version pins and provider lifecycle state; a committed run atomically adopts it.
 */
export const skillRunPrewarms = pgTable(
  "skill_run_prewarms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    creatorId: text("creator_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id").notNull(),
    status: skillRunPrewarmStatusEnum("status").notNull().default("queued"),
    phase: skillRunPrewarmPhaseEnum("phase").notNull().default("queued"),
    sandboxName: text("sandbox_name").notNull(),
    sandboxId: text("sandbox_id"),
    sandboxDomain: text("sandbox_domain"),
    goldenSnapshotId: text("golden_snapshot_id").notNull(),
    timeoutMs: integer("timeout_ms").notNull().default(300000),
    clientLeaseExpiresAt: timestamp("client_lease_expires_at", { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    adoptedRunId: uuid("adopted_run_id"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    errorCode: text("error_code"),
    sandboxCleanedAt: timestamp("sandbox_cleaned_at", { withTimezone: true }),
    cleanupLeaseOwner: text("cleanup_lease_owner"),
    cleanupLeaseExpiresAt: timestamp("cleanup_lease_expires_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgId: unique("skill_run_prewarms_org_id_id_uq").on(t.orgId, t.id),
    skillFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_run_prewarms_skill_org_fk",
    }).onDelete("cascade"),
    skillVersionFk: foreignKey({
      columns: [t.orgId, t.skillId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.skillId, skillVersions.id],
      name: "skill_run_prewarms_version_org_fk",
    }).onDelete("cascade"),
    byClaim: index("skill_run_prewarms_claim_idx").on(t.status, t.availableAt, t.leaseExpiresAt),
    byCleanup: index("skill_run_prewarms_cleanup_idx").on(t.status, t.clientLeaseExpiresAt, t.absoluteExpiresAt),
    quota: index("skill_run_prewarms_quota_idx").on(t.orgId, t.creatorId, t.createdAt),
    uniqueAdoptedRun: uniqueIndex("skill_run_prewarms_adopted_run_uq")
      .on(t.adoptedRunId)
      .where(sql`${t.adoptedRunId} IS NOT NULL`),
    timeoutCheck: check("skill_run_prewarms_timeout_check", sql`${t.timeoutMs} BETWEEN 10000 AND 3600000`),
    attemptCheck: check("skill_run_prewarms_attempt_check", sql`${t.attempt} >= 0 AND ${t.maxAttempts} BETWEEN 1 AND 10`),
    leaseCheck: check("skill_run_prewarms_lease_check", sql`(${t.leaseOwner} IS NULL) = (${t.leaseExpiresAt} IS NULL)`),
    cleanupLeaseCheck: check("skill_run_prewarms_cleanup_lease_check", sql`(${t.cleanupLeaseOwner} IS NULL) = (${t.cleanupLeaseExpiresAt} IS NULL)`),
  }),
);

/**
 * Structural mirror of the contracts `RunChatHistoryItem` (db stays contracts-free). The transcript
 * is a server-side snapshot: replaced wholesale from the sandbox on every `session.idle`.
 */
export type SkillRunTranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      call_id: string;
      tool: string;
      skill: string | null;
      title: string | null;
      input: string;
      output: string;
      duration_ms: number | null;
    };

/** Durable non-terminal warnings that must survive live-event retention and page reloads. */
export type SkillRunWarning = {
  code: string;
  message: string;
  phase: (typeof skillRunPhaseEnum.enumValues)[number] | null;
};

/**
 * One skill run: a sandboxed session launched from a skill's page. A fresh named sandbox is forked
 * from the golden snapshot, then retained in a stopped state for seven days after freeze/cancel so
 * the same OpenCode conversation can resume. Runs are PRIVATE to their creator: like personal
 * skills, there is no admin override (`canAccessRun`).
 */
export const skillRuns = pgTable(
  "skill_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    /** Who launched the run — the only member who can ever see it. */
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    prewarmId: uuid("prewarm_id").references(() => skillRunPrewarms.id, { onDelete: "set null" }),
    /** Exact root version and its display snapshot at launch. */
    skillVersionId: uuid("skill_version_id").notNull(),
    skillVersion: text("skill_version").notNull(),
    runConfigId: uuid("run_config_id"),
    runConfigNameSnapshot: text("run_config_name_snapshot"),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    /** OpenCode model ref `provider/model-id` (validated against the models.dev catalog). */
    model: text("model").notNull(),
    /** The original launch prompt (list rows show an excerpt). */
    prompt: text("prompt").notNull(),
    status: skillRunStatusEnum("status").notNull().default("queued"),
    phase: skillRunPhaseEnum("phase").notNull().default("queued"),
    errorCode: text("error_code"),
    userMessage: text("user_message"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    /** Deterministic sandbox name: run-<org8>-<run8>. */
    sandboxName: text("sandbox_name"),
    sandboxId: text("sandbox_id"),
    /** Public https URL of port 4096; reached only by the API proxy, never exposed to browsers. */
    sandboxDomain: text("sandbox_domain"),
    /** Provenance: which golden snapshot the run forked, and the OpenCode pin. */
    goldenSnapshotId: text("golden_snapshot_id"),
    opencodeVersion: text("opencode_version"),
    opencodeSessionId: text("opencode_session_id"),
    /** Opaque master-key encrypted OPENCODE_SERVER_PASSWORD. Never returned by ordinary queries. */
    serverPasswordEnc: text("server_password_enc"),
    /** Sandbox inactivity window; also the freeze window for the recorder. */
    timeoutMs: integer("timeout_ms").notNull().default(300000),
    transcript: jsonb("transcript").$type<SkillRunTranscriptItem[]>().notNull().default([]),
    warnings: jsonb("warnings").$type<SkillRunWarning[]>().notNull().default([]),
    /** Highest durable event sequence already represented by the transcript snapshot. */
    transcriptEventSequence: integer("transcript_event_sequence").notNull().default(0),
    transcriptUpdatedAt: timestamp("transcript_updated_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    /** Terminal runs remain resumable while their stopped named sandbox is retained. */
    reactivatableUntil: timestamp("reactivatable_until", { withTimezone: true }),
    /** Monotonic generation for stale-response protection across terminal -> queued transitions. */
    activationRevision: integer("activation_revision").notNull().default(0),
    /** Set once the provider sandbox is confirmed destroyed; NULL = the sweeper still owes a destroy. */
    sandboxCleanedAt: timestamp("sandbox_cleaned_at", { withTimezone: true }),
    /** Short system lease used only to retry terminal sandbox teardown across worker replicas. */
    cleanupLeaseOwner: text("cleanup_lease_owner"),
    cleanupLeaseExpiresAt: timestamp("cleanup_lease_expires_at", { withTimezone: true }),
    cleanupAttempt: integer("cleanup_attempt").notNull().default(0),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgId: unique("skill_runs_org_id_id_uq").on(t.orgId, t.id),
    uniqueOrgIdCreator: unique("skill_runs_org_id_id_creator_uq").on(t.orgId, t.id, t.creatorId),
    uniqueIdempotency: unique("skill_runs_idempotency_uq").on(
      t.orgId,
      t.creatorId,
      t.skillId,
      t.idempotencyKey,
    ),
    uniquePrewarm: uniqueIndex("skill_runs_prewarm_uq")
      .on(t.prewarmId)
      .where(sql`${t.prewarmId} IS NOT NULL`),
    skillFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_runs_skill_org_fk",
    }).onDelete("cascade"),
    skillVersionFk: foreignKey({
      columns: [t.orgId, t.skillId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.skillId, skillVersions.id],
      name: "skill_runs_skill_version_org_fk",
    }).onDelete("restrict"),
    configFk: foreignKey({
      columns: [t.orgId, t.runConfigId, t.creatorId, t.skillId],
      foreignColumns: [
        skillRunConfigs.orgId,
        skillRunConfigs.id,
        skillRunConfigs.creatorId,
        skillRunConfigs.skillId,
      ],
      name: "skill_runs_config_fk",
    }),
    bySessions: index("skill_runs_sessions_idx").on(t.orgId, t.skillId, t.creatorId, t.createdAt),
    byCleanup: index("skill_runs_cleanup_idx")
      .on(t.status, t.cleanupLeaseExpiresAt, t.updatedAt)
      .where(sql`${t.sandboxCleanedAt} IS NULL`),
    timeoutCheck: check("skill_runs_timeout_check", sql`${t.timeoutMs} BETWEEN 10000 AND 3600000`),
    warningsArrayCheck: check("skill_runs_warnings_array_check", sql`jsonb_typeof(${t.warnings}) = 'array'`),
    transcriptEventSequenceCheck: check(
      "skill_runs_transcript_event_sequence_check",
      sql`${t.transcriptEventSequence} >= 0`,
    ),
    activationRevisionCheck: check(
      "skill_runs_activation_revision_check",
      sql`${t.activationRevision} >= 0`,
    ),
    cleanupAttemptCheck: check("skill_runs_cleanup_attempt_check", sql`${t.cleanupAttempt} >= 0`),
    cleanupLeaseCheck: check(
      "skill_runs_cleanup_lease_check",
      sql`(${t.cleanupLeaseOwner} IS NULL) = (${t.cleanupLeaseExpiresAt} IS NULL)`,
    ),
    idempotencyKeyCheck: check(
      "skill_runs_idempotency_key_check",
      sql`char_length(${t.idempotencyKey}) BETWEEN 8 AND 200`,
    ),
    payloadHashCheck: check("skill_runs_payload_hash_check", sql`char_length(${t.payloadHash}) BETWEEN 32 AND 128`),
  }),
);

/** Immutable root + dependency versions loaded into a secretless prewarm sandbox. */
export const skillRunPrewarmSkills = pgTable(
  "skill_run_prewarm_skills",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    prewarmId: uuid("prewarm_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    skillVersionId: uuid("skill_version_id").notNull(),
    isRoot: boolean("is_root").notNull().default(false),
    mountOrder: integer("mount_order").notNull(),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.prewarmId, t.skillId] }),
    uniqueMountOrder: unique("skill_run_prewarm_skills_mount_order_uq").on(t.orgId, t.prewarmId, t.mountOrder),
    prewarmFk: foreignKey({
      columns: [t.orgId, t.prewarmId],
      foreignColumns: [skillRunPrewarms.orgId, skillRunPrewarms.id],
      name: "skill_run_prewarm_skills_prewarm_org_fk",
    }).onDelete("cascade"),
    versionFk: foreignKey({
      columns: [t.orgId, t.skillId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.skillId, skillVersions.id],
      name: "skill_run_prewarm_skills_version_org_fk",
    }).onDelete("cascade"),
    mountOrderCheck: check("skill_run_prewarm_skills_mount_order_check", sql`${t.mountOrder} >= 0`),
  }),
);

/** Immutable root + dependency closure, pinned to exact published version rows. */
export const skillRunSkills = pgTable(
  "skill_run_skills",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    skillVersionId: uuid("skill_version_id").notNull(),
    isRoot: boolean("is_root").notNull().default(false),
    mountOrder: integer("mount_order").notNull(),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.runId, t.skillId] }),
    oneRoot: uniqueIndex("skill_run_skills_root_uq")
      .on(t.orgId, t.runId)
      .where(sql`${t.isRoot} = true`),
    uniqueMountOrder: unique("skill_run_skills_mount_order_uq").on(t.orgId, t.runId, t.mountOrder),
    runFk: foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [skillRuns.orgId, skillRuns.id],
      name: "skill_run_skills_run_org_fk",
    }).onDelete("cascade"),
    versionFk: foreignKey({
      columns: [t.orgId, t.skillId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.skillId, skillVersions.id],
      name: "skill_run_skills_version_org_fk",
    }).onDelete("restrict"),
    mountOrderCheck: check("skill_run_skills_mount_order_check", sql`${t.mountOrder} >= 0`),
  }),
);

/** Immutable references to the exact generic-vault versions selected for a run. */
export const skillRunSecretInputs = pgTable(
  "skill_run_secret_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    skillId: uuid("skill_id"),
    slotId: uuid("slot_id"),
    sourceKey: text("source_key").notNull(),
    envKey: text("env_key").notNull(),
    secretId: uuid("secret_id"),
    secretVersion: integer("secret_version"),
    secretNameSnapshot: text("secret_name_snapshot"),
    provenance: skillRunSecretProvenanceEnum("provenance").notNull(),
    required: boolean("required").notNull().default(true),
    createdAt: now(),
  },
  (t) => ({
    uniqueSource: unique("skill_run_secret_inputs_source_uq").on(
      t.orgId,
      t.runId,
      t.provenance,
      t.sourceKey,
    ),
    byRunEnv: index("skill_run_secret_inputs_run_env_idx").on(t.orgId, t.runId, t.envKey),
    runFk: foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [skillRuns.orgId, skillRuns.id],
      name: "skill_run_secret_inputs_run_org_fk",
    }).onDelete("cascade"),
    skillFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_run_secret_inputs_skill_org_fk",
    }).onDelete("restrict"),
    slotFk: foreignKey({
      columns: [t.orgId, t.skillId, t.slotId],
      foreignColumns: [skillSecretSlots.orgId, skillSecretSlots.skillId, skillSecretSlots.slotId],
      name: "skill_run_secret_inputs_slot_org_fk",
    }).onDelete("restrict"),
    secretVersionFk: foreignKey({
      columns: [t.orgId, t.secretId, t.secretVersion],
      foreignColumns: [secretVersions.orgId, secretVersions.secretId, secretVersions.version],
      name: "skill_run_secret_inputs_secret_version_org_fk",
    }).onDelete("restrict"),
    envKeyCheck: check(
      "skill_run_secret_inputs_key_check",
      sql`${t.envKey} ~ '^[A-Za-z_][A-Za-z0-9_]*$'
        AND (${t.provenance} = 'runtime' OR ${t.envKey} !~ '^OPENCODE_SERVER_')`,
    ),
    provenanceCheck: check(
      "skill_run_secret_inputs_provenance_check",
      sql`((${t.provenance} = 'runtime' AND ${t.secretId} IS NULL AND ${t.secretVersion} IS NULL)
          OR (${t.provenance} = 'skill' AND ${t.secretId} IS NOT NULL AND ${t.secretVersion} IS NOT NULL))
        AND (${t.provenance} <> 'skill' OR (${t.skillId} IS NOT NULL AND ${t.slotId} IS NOT NULL))`,
    ),
  }),
);

/** Immutable dedicated model-provider credential pin, stored outside generic secret inputs. */
export const skillRunModelProviderInputs = pgTable(
  "skill_run_model_provider_inputs",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    provider: text("provider").notNull(),
    envKey: text("env_key").notNull(),
    connectionId: uuid("connection_id").notNull(),
    credentialVersion: integer("credential_version").notNull(),
    connectionScope: modelProviderConnectionScopeEnum("connection_scope").notNull(),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.runId] }),
    runFk: foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [skillRuns.orgId, skillRuns.id],
      name: "skill_run_model_provider_inputs_run_org_fk",
    }).onDelete("cascade"),
    // Deliberately no FK to the credential version: disconnect must remove ciphertext immediately.
    // The redacted run snapshot remains for history while queued/active runs fail closed on lookup.
    envKeyCheck: check(
      "skill_run_model_provider_inputs_key_check",
      sql`${t.envKey} ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND ${t.envKey} !~ '^OPENCODE_SERVER_'`,
    ),
    versionCheck: check(
      "skill_run_model_provider_inputs_version_check",
      sql`${t.credentialVersion} >= 1`,
    ),
  }),
);

/** Immutable non-sensitive environment values actually injected into the sandbox. */
export const skillRunVariableInputs = pgTable(
  "skill_run_variable_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    envKey: text("env_key").notNull(),
    value: text("value").notNull(),
    createdAt: now(),
  },
  (t) => ({
    uniqueDeclaration: unique("skill_run_variable_inputs_declaration_uq").on(
      t.orgId,
      t.runId,
      t.skillId,
      t.envKey,
    ),
    byRunEnv: index("skill_run_variable_inputs_run_env_idx").on(t.orgId, t.runId, t.envKey),
    runFk: foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [skillRuns.orgId, skillRuns.id],
      name: "skill_run_variable_inputs_run_org_fk",
    }).onDelete("cascade"),
    skillFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_run_variable_inputs_skill_org_fk",
    }).onDelete("restrict"),
    envKeyCheck: check(
      "skill_run_variable_inputs_key_check",
      sql`${t.envKey} ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND ${t.envKey} !~ '^OPENCODE_SERVER_'`,
    ),
    valueSizeCheck: check("skill_run_variable_inputs_value_size_check", sql`octet_length(${t.value}) <= 32768`),
  }),
);

/** One durable orchestration row per run, reclaimed through a short PostgreSQL lease. */
export const skillRunJobs = pgTable(
  "skill_run_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    creatorId: text("creator_id").notNull(),
    status: skillRunJobStatusEnum("status").notNull().default("queued"),
    phase: skillRunPhaseEnum("phase").notNull().default("queued"),
    /** Execution failures consume this bounded retry budget; an expired lease reclaim does not. */
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Operational counter only: how often another replica resumed the same execution attempt. */
    leaseReclaimCount: integer("lease_reclaim_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueRun: unique("skill_run_jobs_run_uq").on(t.orgId, t.runId),
    claimable: index("skill_run_jobs_claim_idx").on(t.status, t.availableAt, t.leaseExpiresAt),
    runFk: foreignKey({
      columns: [t.orgId, t.runId, t.creatorId],
      foreignColumns: [skillRuns.orgId, skillRuns.id, skillRuns.creatorId],
      name: "skill_run_jobs_run_creator_fk",
    }).onDelete("cascade"),
    attemptCheck: check(
      "skill_run_jobs_attempt_check",
      sql`${t.attempt} >= 0 AND ${t.maxAttempts} BETWEEN 1 AND 10 AND ${t.attempt} <= ${t.maxAttempts}`,
    ),
    leaseReclaimCheck: check("skill_run_jobs_lease_reclaim_check", sql`${t.leaseReclaimCount} >= 0`),
    leaseCheck: check(
      "skill_run_jobs_lease_check",
      sql`(${t.status} = 'leased') = (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
  }),
);

/**
 * Ephemeral liveness advertised by fully configured run-worker replicas. The API only accepts new
 * work while at least one row has an unexpired lease; a crashed process naturally disappears.
 * This is operational state (not tenant data) and is accessed through narrow SECURITY DEFINER
 * functions rather than ordinary application queries.
 */
export const skillRunWorkerHeartbeats = pgTable(
  "skill_run_worker_heartbeats",
  {
    workerId: text("worker_id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Protocol 1 guarantees follow-up attachments are mounted before OpenCode dispatch. */
    attachmentPromptProtocol: integer("attachment_prompt_protocol").notNull().default(0),
    /** Protocol 2 also persists the send-attempt barrier before contacting OpenCode. */
    turnStopProtocol: integer("turn_stop_protocol").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index("skill_run_worker_heartbeats_expires_idx").on(t.expiresAt),
    workerIdCheck: check(
      "skill_run_worker_heartbeats_worker_id_check",
      sql`length(btrim(${t.workerId})) BETWEEN 1 AND 512`,
    ),
    attachmentProtocolCheck: check(
      "skill_run_worker_heartbeats_attachment_protocol_check",
      sql`${t.attachmentPromptProtocol} BETWEEN 0 AND 1`,
    ),
    turnStopProtocolCheck: check(
      "skill_run_worker_heartbeats_turn_stop_protocol_check",
      sql`${t.turnStopProtocol} BETWEEN 0 AND 2`,
    ),
  }),
);

/** Durable initial/follow-up prompt outbox. Deterministic message ids make retries idempotent. */
export const skillRunPrompts = pgTable(
  "skill_run_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    kind: skillRunPromptKindEnum("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    messageId: text("message_id").notNull(),
    /** Exact user-authored text. May be empty when the message contains attachments only. */
    userText: text("user_text").notNull(),
    /** Runtime prompt enriched with mounted attachment paths and private control instructions. */
    prompt: text("prompt").notNull(),
    status: skillRunPromptStatusEnum("status").notNull().default("queued"),
    /** Prompt dispatch failures consume this budget; lease-only recovery keeps the same attempt. */
    attempt: integer("attempt").notNull().default(0),
    /** Version 2 claims persist sendAttemptedAt before the runtime can observe this message id. */
    dispatchProtocol: integer("dispatch_protocol").notNull().default(0),
    /** Durable external-side-effect barrier, committed immediately before sendPrompt. */
    sendAttemptedAt: timestamp("send_attempted_at", { withTimezone: true }),
    /** False only after a never-dispatched queued prompt has handed its objects to the sweeper. */
    attachmentsRetained: boolean("attachments_retained").notNull().default(true),
    leaseReclaimCount: integer("lease_reclaim_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /** Status remains processing until the owning worker reaches a durable stop barrier. */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    errorCode: text("error_code"),
    userMessage: text("user_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrdinal: unique("skill_run_prompts_ordinal_uq").on(t.orgId, t.runId, t.ordinal),
    uniqueMessage: unique("skill_run_prompts_message_uq").on(t.orgId, t.runId, t.messageId),
    uniqueIdentity: unique("skill_run_prompts_identity_uq").on(t.orgId, t.runId, t.id),
    uniqueIdempotency: unique("skill_run_prompts_idempotency_uq").on(t.orgId, t.runId, t.idempotencyKey),
    onePending: uniqueIndex("skill_run_prompts_pending_uq")
      .on(t.orgId, t.runId)
      .where(sql`${t.status} = 'processing'`),
    byAvailability: index("skill_run_prompts_available_idx").on(t.status, t.availableAt),
    byRunStatusOrdinal: index("skill_run_prompts_run_status_ordinal_idx").on(
      t.orgId,
      t.runId,
      t.status,
      t.ordinal,
    ),
    runFk: foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [skillRuns.orgId, skillRuns.id],
      name: "skill_run_prompts_run_org_fk",
    }).onDelete("cascade"),
    ordinalCheck: check("skill_run_prompts_ordinal_check", sql`${t.ordinal} >= 0`),
    attemptCheck: check("skill_run_prompts_attempt_check", sql`${t.attempt} BETWEEN 0 AND 10`),
    dispatchProtocolCheck: check(
      "skill_run_prompts_dispatch_protocol_check",
      sql`${t.dispatchProtocol} BETWEEN 0 AND 2`,
    ),
    sendMarkerProtocolCheck: check(
      "skill_run_prompts_send_marker_protocol_check",
      sql`${t.sendAttemptedAt} IS NULL OR ${t.dispatchProtocol} >= 2`,
    ),
    attachmentDispositionCheck: check(
      "skill_run_prompts_attachment_disposition_check",
      sql`${t.attachmentsRetained} OR (
        ${t.status} = 'canceled'
        AND ${t.kind} = 'follow_up'
        AND ${t.sendAttemptedAt} IS NULL
        AND (${t.attempt} = 0 OR ${t.dispatchProtocol} >= 2)
      )`,
    ),
    leaseReclaimCheck: check("skill_run_prompts_lease_reclaim_check", sql`${t.leaseReclaimCount} >= 0`),
    idempotencyKeyCheck: check(
      "skill_run_prompts_idempotency_key_check",
      sql`char_length(${t.idempotencyKey}) BETWEEN 8 AND 200`,
    ),
    payloadHashCheck: check(
      "skill_run_prompts_payload_hash_check",
      sql`char_length(${t.payloadHash}) BETWEEN 32 AND 128`,
    ),
    messageIdCheck: check(
      "skill_run_prompts_message_id_check",
      sql`${t.messageId} ~ '^msg_[0-9A-Za-z]{26}$'`,
    ),
  }),
);

/** Redacted, normalized, monotonically sequenced events used for replayable SSE. */
export const skillRunEvents = pgTable(
  "skill_run_events",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.runId, t.sequence] }),
    byRetention: index("skill_run_events_retention_idx").on(t.createdAt),
    runFk: foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [skillRuns.orgId, skillRuns.id],
      name: "skill_run_events_run_org_fk",
    }).onDelete("cascade"),
    sequenceCheck: check("skill_run_events_sequence_check", sql`${t.sequence} > 0`),
    typeCheck: check("skill_run_events_type_check", sql`char_length(${t.type}) BETWEEN 1 AND 100`),
  }),
);

/** A file attached to one durable run prompt (bytes in S3 under run-attachments/, metadata here). */
export const skillRunAttachments = pgTable(
  "skill_run_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    runId: uuid("run_id").notNull(),
    /** Nullable only for rolling compatibility; a deferred DB trigger links legacy inserts at commit. */
    promptId: uuid("prompt_id"),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    /** Server-verified safe inline MIME; null means download-only. */
    previewContentType: text("preview_content_type"),
    byteSize: integer("byte_size").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    createdAt: now(),
  },
  (t) => ({
    runFk: foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [skillRuns.orgId, skillRuns.id],
      name: "skill_run_attachments_run_fk",
    }).onDelete("cascade"),
    promptFk: foreignKey({
      columns: [t.orgId, t.runId, t.promptId],
      foreignColumns: [skillRunPrompts.orgId, skillRunPrompts.runId, skillRunPrompts.id],
      name: "skill_run_attachments_prompt_fk",
    }).onDelete("cascade"),
    byRun: index("skill_run_attachments_run_idx").on(t.orgId, t.runId),
    sizeCheck: check(
      "skill_run_attachments_size_check",
      sql`${t.byteSize} > 0 AND ${t.byteSize} <= 10485760`,
    ),
  }),
);

/** Private, short-lived cached outputs collected from a sandbox before it is frozen. */
export const skillRunArtifacts = pgTable(
  "skill_run_artifacts",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    runId: uuid("run_id").notNull(),
    path: text("path").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    previewable: boolean("previewable").notNull().default(false),
    storageKey: text("storage_key").notNull().unique(),
    /** False between reservation and the successful object upload/finalization. */
    ready: boolean("ready").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    runFk: foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [skillRuns.orgId, skillRuns.id],
      name: "skill_run_artifacts_run_fk",
    }).onDelete("cascade"),
    uniquePath: unique("skill_run_artifacts_run_path_uq").on(t.orgId, t.runId, t.path),
    byRun: index("skill_run_artifacts_run_idx").on(t.orgId, t.runId, t.ready, t.expiresAt),
    byExpiry: index("skill_run_artifacts_expiry_idx").on(t.expiresAt, t.updatedAt),
    pathCheck: check(
      "skill_run_artifacts_path_check",
      sql`char_length(${t.path}) BETWEEN 1 AND 1024 AND ${t.path} !~ '(^|/)\\.\\.?(/|$)'`,
    ),
    fileNameCheck: check(
      "skill_run_artifacts_file_name_check",
      sql`char_length(${t.fileName}) BETWEEN 1 AND 255`,
    ),
    sizeCheck: check(
      "skill_run_artifacts_size_check",
      sql`${t.byteSize} > 0 AND ${t.byteSize} <= 10485760`,
    ),
  }),
);

/** Durable S3 upload reservation; consumed atomically when attachment metadata commits. */
export const skillRunAttachmentUploads = pgTable(
  "skill_run_attachment_uploads",
  {
    storageKey: text("storage_key").primaryKey(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    creatorId: text("creator_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byAge: index("skill_run_attachment_uploads_age_idx").on(t.touchedAt) }),
);

/** Metadata for one owner-controlled secret. Plaintext never lives in this row. */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    key: text("key").notNull(),
    audience: secretAudienceEnum("audience").notNull().default("personal"),
    currentVersion: integer("current_version").notNull().default(1),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgId: unique("secrets_org_id_id_uq").on(t.orgId, t.id),
    uniqueOrgIdOwner: unique("secrets_org_id_id_owner_uq").on(t.orgId, t.id, t.ownerId),
    byOwner: index("secrets_org_owner_idx").on(t.orgId, t.ownerId),
    byAudience: index("secrets_org_audience_idx").on(t.orgId, t.audience),
    keyShape: check("secrets_key_check", sql`${t.key} ~ '^[A-Za-z_][A-Za-z0-9_]*$'`),
  }),
);

/** Envelope-encrypted immutable value version. All binary fields are base64 text. */
export const secretVersions = pgTable(
  "secret_versions",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    secretId: uuid("secret_id").notNull(),
    version: integer("version").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    wrapIv: text("wrap_iv").notNull(),
    wrapAuthTag: text("wrap_auth_tag").notNull(),
    keyId: text("key_id").notNull(),
    createdBy: text("created_by").notNull().references(() => user.id, { onDelete: "cascade" }),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.secretId, t.version] }),
    byOrg: index("secret_versions_org_idx").on(t.orgId),
    positiveVersion: check("secret_versions_positive_check", sql`${t.version} > 0`),
    secretOrgFk: foreignKey({
      columns: [t.orgId, t.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: "secret_versions_secret_org_fk",
    }).onDelete("cascade"),
  }),
);

/** Explicit recipients for a restricted secret. The owner is implicit and never inserted here. */
export const secretRecipients = pgTable(
  "secret_recipients",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    secretId: uuid("secret_id").notNull(),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.secretId, t.userId] }),
    byRecipient: index("secret_recipients_org_user_idx").on(t.orgId, t.userId),
    secretOrgFk: foreignKey({
      columns: [t.orgId, t.secretId, t.ownerId],
      foreignColumns: [secrets.orgId, secrets.id, secrets.ownerId],
      name: "secret_recipients_secret_org_fk",
    }).onDelete("cascade"),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "secret_recipients_member_org_fk",
    }).onDelete("cascade"),
  }),
);

/** Stable slot identity, retained after a slot disappears so bindings can emit tombstones. */
export const skillSecretSlots = pgTable(
  "skill_secret_slots",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    slotId: uuid("slot_id").notNull(),
    firstSeenAt: now(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.skillId, t.slotId] }),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_secret_slots_skill_org_fk",
    }).onDelete("cascade"),
  }),
);

/** Versioned presentation of a stable secret slot. */
export const skillVersionSecretSlots = pgTable(
  "skill_version_secret_slots",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    skillVersionId: uuid("skill_version_id").notNull(),
    slotId: uuid("slot_id").notNull(),
    envKey: text("env_key").notNull(),
    description: text("description").notNull().default(""),
    required: boolean("required").notNull().default(true),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.skillVersionId, t.slotId] }),
    bySkillSlot: index("skill_version_secret_slots_skill_idx").on(t.orgId, t.skillId, t.slotId),
    stableSlotFk: foreignKey({
      columns: [t.orgId, t.skillId, t.slotId],
      foreignColumns: [skillSecretSlots.orgId, skillSecretSlots.skillId, skillSecretSlots.slotId],
      name: "skill_version_secret_slots_stable_fk",
    }).onDelete("cascade"),
    versionOrgFk: foreignKey({
      columns: [t.orgId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.id],
      name: "skill_version_secret_slots_version_org_fk",
    }).onDelete("cascade"),
    envKeyShape: check("skill_version_secret_slots_key_check", sql`${t.envKey} ~ '^[A-Za-z_][A-Za-z0-9_]*$'`),
  }),
);

/** One personal binding per user + skill + stable slot. Rows are soft-revoked for tombstones. */
export const skillSecretBindings = pgTable(
  "skill_secret_bindings",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    slotId: uuid("slot_id").notNull(),
    secretId: uuid("secret_id").notNull(),
    projectionId: uuid("projection_id").notNull().defaultRandom(),
    source: secretBindingSourceEnum("source").notNull().default("manual"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId, t.skillId, t.slotId] }),
    uniqueProjection: unique("skill_secret_bindings_projection_uq").on(t.projectionId),
    bySecret: index("skill_secret_bindings_secret_idx").on(t.orgId, t.secretId),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "skill_secret_bindings_member_org_fk",
    }).onDelete("cascade"),
    stableSlotFk: foreignKey({
      columns: [t.orgId, t.skillId, t.slotId],
      foreignColumns: [skillSecretSlots.orgId, skillSecretSlots.skillId, skillSecretSlots.slotId],
      name: "skill_secret_bindings_slot_fk",
    }).onDelete("cascade"),
    secretOrgFk: foreignKey({
      columns: [t.orgId, t.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: "skill_secret_bindings_secret_org_fk",
    }).onDelete("cascade"),
  }),
);

/** Workspace suggestion for a slot. Access to the suggested secret is still checked per user. */
export const skillSecretSuggestions = pgTable(
  "skill_secret_suggestions",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    slotId: uuid("slot_id").notNull(),
    secretId: uuid("secret_id").notNull(),
    suggestedBy: text("suggested_by").notNull().references(() => user.id, { onDelete: "cascade" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.skillId, t.slotId] }),
    stableSlotFk: foreignKey({
      columns: [t.orgId, t.skillId, t.slotId],
      foreignColumns: [skillSecretSlots.orgId, skillSecretSlots.skillId, skillSecretSlots.slotId],
      name: "skill_secret_suggestions_slot_fk",
    }).onDelete("cascade"),
    secretOrgFk: foreignKey({
      columns: [t.orgId, t.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: "skill_secret_suggestions_secret_org_fk",
    }).onDelete("cascade"),
  }),
);

export const secretRetrievalPlans = pgTable(
  "secret_retrieval_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    uniqueOrgId: unique("secret_retrieval_plans_org_id_id_uq").on(t.orgId, t.id),
    uniqueOperation: unique("secret_retrieval_plans_operation_uq").on(t.orgId, t.userId, t.operationId),
    byRateWindow: index("secret_retrieval_plans_rate_idx").on(t.orgId, t.userId, t.createdAt),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "secret_retrieval_plans_member_org_fk",
    }).onDelete("cascade"),
  }),
);

export const secretRetrievalPlanItems = pgTable(
  "secret_retrieval_plan_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").notNull().references(() => secretRetrievalPlans.id, { onDelete: "cascade" }),
    projectionId: uuid("projection_id").notNull(),
    skill: text("skill").notNull(),
    skillId: uuid("skill_id"),
    skillVersionId: uuid("skill_version_id"),
    skillVersion: text("skill_version"),
    slotId: uuid("slot_id"),
    envKey: text("env_key").notNull(),
    required: boolean("required").notNull().default(true),
    status: secretSlotStatusEnum("status").notNull(),
    secretId: uuid("secret_id"),
    secretVersion: integer("secret_version"),
    secretName: text("secret_name"),
    ownerName: text("owner_name"),
    tombstone: boolean("tombstone").notNull().default(false),
    createdAt: now(),
  },
  (t) => ({
    uniqueProjection: unique("secret_retrieval_plan_items_projection_uq").on(t.planId, t.projectionId),
    byPlan: index("secret_retrieval_plan_items_plan_idx").on(t.orgId, t.planId),
    planOrgFk: foreignKey({
      columns: [t.orgId, t.planId],
      foreignColumns: [secretRetrievalPlans.orgId, secretRetrievalPlans.id],
      name: "secret_retrieval_plan_items_plan_org_fk",
    }).onDelete("cascade"),
    skillVersionOrgFk: foreignKey({
      columns: [t.orgId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.id],
      name: "secret_retrieval_plan_items_skill_version_org_fk",
    }).onDelete("cascade"),
    secretVersionOrgFk: foreignKey({
      columns: [t.orgId, t.secretId, t.secretVersion],
      foreignColumns: [secretVersions.orgId, secretVersions.secretId, secretVersions.version],
      name: "secret_retrieval_plan_items_secret_version_org_fk",
    }).onDelete("cascade"),
  }),
);

export const secretRetrievalGrants = pgTable(
  "secret_retrieval_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").notNull().references(() => secretRetrievalPlans.id, { onDelete: "cascade" }),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    byRateWindow: index("secret_retrieval_grants_rate_idx").on(t.orgId, t.userId, t.createdAt),
    planOrgFk: foreignKey({
      columns: [t.orgId, t.planId],
      foreignColumns: [secretRetrievalPlans.orgId, secretRetrievalPlans.id],
      name: "secret_retrieval_grants_plan_org_fk",
    }).onDelete("cascade"),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "secret_retrieval_grants_member_org_fk",
    }).onDelete("cascade"),
  }),
);
