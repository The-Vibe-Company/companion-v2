import {
  type AnyPgColumn,
  bigint,
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
export const companionRuntimeStateEnum = pgEnum("companion_runtime_state", [
  "not_created",
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "error",
]);
export const companionDaemonStateEnum = pgEnum("companion_daemon_state", [
  "unknown",
  "starting",
  "running",
  "stopped",
  "error",
]);
// A shared Box runtime pool is scoped to a workspace: 'personal' is one Box for a user in their
// personal workspace (keyed by owner); 'org' is one Box shared by every member of a team workspace.
export const companionRuntimePoolScopeEnum = pgEnum("companion_runtime_pool_scope", [
  "personal",
  "org",
]);
export const companionProviderAuthMethodEnum = pgEnum("companion_provider_auth_method", [
  "api_key",
  "subscription",
]);
export const companionShareRoleEnum = pgEnum("companion_share_role", ["editor", "viewer"]);
export const companionTranscriptRoleEnum = pgEnum("companion_transcript_role", [
  "user",
  "assistant",
  "system",
  "tool",
  "decision",
]);
export const billingSeatSyncStatusEnum = pgEnum("billing_seat_sync_status", ["synced", "pending", "error"]);
export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export const secretAudienceEnum = pgEnum("secret_audience", ["personal", "restricted", "organization"]);
export const skillDatabaseAudienceEnum = pgEnum("skill_database_audience", ["organization", "personal"]);
export const secretBindingSourceEnum = pgEnum("secret_binding_source", ["manual", "suggestion"]);
export const secretSlotStatusEnum = pgEnum("secret_slot_status", [
  "personal",
  "shared",
  "required",
  "optional_missing",
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

// Global Agent Auth identity data. These tables intentionally do not carry org_id: a delegated
// agent/host belongs to a Better Auth user and may hold separately constrained grants for multiple
// workspaces. Every business operation still re-enters Core with an exact workspace constraint.
export const agentHost = pgTable(
  "agent_host",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    defaultCapabilities: text("default_capabilities"),
    publicKey: text("public_key"),
    kid: text("kid"),
    jwksUrl: text("jwks_url"),
    enrollmentTokenHash: text("enrollment_token_hash"),
    enrollmentTokenExpiresAt: timestamp("enrollment_token_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    remoteJwksDisabled: check("agent_host_remote_jwks_disabled", sql`${t.jwksUrl} is null`),
    byUser: index("agent_host_user_id_idx").on(t.userId),
    byKid: index("agent_host_kid_idx").on(t.kid),
    byEnrollmentTokenHash: index("agent_host_enrollment_token_hash_idx").on(t.enrollmentTokenHash),
    byStatus: index("agent_host_status_idx").on(t.status),
  }),
);

export const agent = pgTable(
  "agent",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHost.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("delegated"),
    publicKey: text("public_key").notNull(),
    kid: text("kid"),
    jwksUrl: text("jwks_url"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    remoteJwksDisabled: check("agent_remote_jwks_disabled", sql`${t.jwksUrl} is null`),
    byUser: index("agent_user_id_idx").on(t.userId),
    byHost: index("agent_host_id_idx").on(t.hostId),
    byStatus: index("agent_status_idx").on(t.status),
    byKid: index("agent_kid_idx").on(t.kid),
  }),
);

export const agentCapabilityGrant = pgTable(
  "agent_capability_grant",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    deniedBy: text("denied_by").references(() => user.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("active"),
    reason: text("reason"),
    constraints: text("constraints"),
  },
  (t) => ({
    byAgent: index("agent_capability_grant_agent_id_idx").on(t.agentId),
    byCapability: index("agent_capability_grant_capability_idx").on(t.capability),
    byGrantedBy: index("agent_capability_grant_granted_by_idx").on(t.grantedBy),
    byStatus: index("agent_capability_grant_status_idx").on(t.status),
    onePendingCapability: uniqueIndex("agent_capability_grant_one_pending_capability_idx")
      .on(t.agentId, t.capability)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export const approvalRequest = pgTable(
  "approval_request",
  {
    id: text("id").primaryKey(),
    method: text("method").notNull(),
    agentId: text("agent_id").references(() => agent.id, { onDelete: "cascade" }),
    hostId: text("host_id").references(() => agentHost.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    capabilities: text("capabilities"),
    status: text("status").notNull().default("pending"),
    userCodeHash: text("user_code_hash"),
    loginHint: text("login_hint"),
    bindingMessage: text("binding_message"),
    clientNotificationToken: text("client_notification_token"),
    clientNotificationEndpoint: text("client_notification_endpoint"),
    deliveryMode: text("delivery_mode"),
    interval: integer("interval").notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAgent: index("approval_request_agent_id_idx").on(t.agentId),
    byHost: index("approval_request_host_id_idx").on(t.hostId),
    byUser: index("approval_request_user_id_idx").on(t.userId),
    byStatus: index("approval_request_status_idx").on(t.status),
  }),
);

// Shared PostgreSQL secondary storage used by Agent Auth for atomic rate limits, JTI replay
// protection, and short-lived JWKS/approval values. Raw keys and values are plugin-internal.
export const agentAuthEphemeral = pgTable(
  "agent_auth_ephemeral",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byExpiry: index("agent_auth_ephemeral_expires_at_idx").on(t.expiresAt) }),
);

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
    /** Pi provider selected when a new Companion does not explicitly choose one. */
    defaultCompanionProviderId: text("default_companion_provider_id"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    defaultCompanionProviderIdShape: check(
      "organizations_default_companion_provider_id_check",
      sql`${t.defaultCompanionProviderId} is null or ${t.defaultCompanionProviderId} ~ '^[a-z][a-z0-9-]{0,62}$'`,
    ),
  }),
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

/**
 * Durable control-plane projection for one Companion. Runtime sessions and transcripts stay on
 * the Box disk; this row contains only enough metadata to list/open without contacting or waking
 * the Box. Provider credentials and desktop URLs must never be stored here.
 */
export const companions = pgTable(
  "companions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    name: text("name").notNull(),
    /** One short operator-authored line describing the Companion; never a system prompt. */
    persona: text("persona"),
    /** Pi model id selected from the provider's pinned Companion catalog. */
    modelId: text("model_id"),
    /**
     * Exact Skills Hub skill ids this Companion may stage onto its Box. Empty means no library
     * skills; the bundled Companion agent skill may still be injected separately for hub access.
     */
    selectedSkillIds: jsonb("selected_skill_ids").$type<string[]>().notNull().default([]),
    /**
     * When true, the Box may publish and update Skills Hub packages on the Companion owner's
     * behalf. Off by default; Viewer never writes this flag.
     */
    canWriteSkills: boolean("can_write_skills").notNull().default(false),
    /**
     * Exact companion_mcp_accounts ids this Companion may stage onto its Box. Empty means no
     * member MCP pins beyond whatever the Pi runtime itself requires (the adapter binary only).
     */
    selectedMcpAccountIds: jsonb("selected_mcp_account_ids").$type<string[]>().notNull().default([]),
    boxId: text("box_id"),
    runtimeState: companionRuntimeStateEnum("runtime_state").notNull().default("not_created"),
    daemonState: companionDaemonStateEnum("daemon_state").notNull().default("unknown"),
    providerIds: jsonb("provider_ids").$type<string[]>().notNull().default([]),
    /** Encrypted provider credential generation last applied to the Box Pi auth file. */
    providerCredentialGeneration: uuid("provider_credential_generation"),
    /**
     * Monotonic desired skill-set revision; bumped when the selection changes and when a selected
     * skill is republished, archived, restored, or renamed. Compared against skillsAppliedRevision
     * to answer "is the saved skill list effective on the Box yet".
     */
    skillsRevision: integer("skills_revision").notNull().default(1),
    /** Last skills revision successfully staged onto the Box Pi runtime. */
    skillsAppliedRevision: integer("skills_applied_revision").notNull().default(0),
    skillsAppliedAt: timestamp("skills_applied_at", { withTimezone: true }),
    /**
     * Why the last skill restage failed, as one sanitized operator line; cleared on the next bump
     * and on a successful apply. Credential material must never reach it.
     */
    skillsLastError: text("skills_last_error"),
    diskLayoutVersion: integer("disk_layout_version").notNull().default(1),
    desktopAvailable: boolean("desktop_available").notNull().default(false),
    /**
     * Why the last lifecycle attempt failed, as one sanitized operator line. It exists so a
     * refreshed `error` state still explains itself; credential material and provider payloads
     * must never reach it.
     */
    lastError: text("last_error"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastStoppedAt: timestamp("last_stopped_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgId: unique("companions_org_id_id_uq").on(t.orgId, t.id),
    uniqueOwnerIdentity: unique("companions_org_id_id_owner_id_uq").on(t.orgId, t.id, t.ownerId),
    byOrgUpdated: index("companions_org_updated_idx").on(t.orgId, t.updatedAt),
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companions_owner_membership_fk",
    }),
    positiveDiskLayout: check("companions_disk_layout_version_check", sql`${t.diskLayoutVersion} >= 1`),
    personaLength: check(
      "companions_persona_check",
      sql`${t.persona} is null or char_length(${t.persona}) <= 280`,
    ),
    boxIdShape: check(
      "companions_box_id_check",
      sql`${t.boxId} is null or ${t.boxId} ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'`,
    ),
    lastErrorLength: check(
      "companions_last_error_check",
      sql`${t.lastError} is null or char_length(${t.lastError}) <= 500`,
    ),
    skillsRevisionBounds: check(
      "companions_skills_revision_check",
      sql`${t.skillsRevision} >= 1 and ${t.skillsAppliedRevision} >= 0 and ${t.skillsAppliedRevision} <= ${t.skillsRevision}`,
    ),
    skillsLastErrorLength: check(
      "companions_skills_last_error_check",
      sql`${t.skillsLastError} is null or char_length(${t.skillsLastError}) <= 500`,
    ),
  }),
);

/**
 * Retained-but-unused shared Box pool from THE-330. THE-332 reverts Box cardinality to one Box per
 * Companion (1 Companion = 1 Box = 1 Pi): the runtime chip lives on the `companions` row again, and
 * no code reads or writes this table. It is kept only so migrations 0074 and 0075 stay a
 * non-destructive clean cut — leftover pool rows are left in place, unreferenced, rather than
 * dropped, and 0075 reads them to find the Companion rows 0074 handed a shared Box id.
 */
export const companionRuntimePools = pgTable(
  "companion_runtime_pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scope: companionRuntimePoolScopeEnum("scope").notNull(),
    /** The member for a `personal` pool (keyed by owner); null for an `org` pool shared by all. */
    ownerId: text("owner_id"),
    boxId: text("box_id"),
    runtimeState: companionRuntimeStateEnum("runtime_state").notNull().default("not_created"),
    daemonState: companionDaemonStateEnum("daemon_state").notNull().default("unknown"),
    /** Encrypted provider credential generation last applied to the shared Box Pi auth file. */
    providerCredentialGeneration: uuid("provider_credential_generation"),
    diskLayoutVersion: integer("disk_layout_version").notNull().default(1),
    desktopAvailable: boolean("desktop_available").notNull().default(false),
    /**
     * Why the last lifecycle attempt failed, as one sanitized operator line. It exists so a
     * refreshed `error` state still explains itself; credential material and provider payloads
     * must never reach it.
     */
    lastError: text("last_error"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastStoppedAt: timestamp("last_stopped_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // One shared pool per personal workspace (org + owner) and one per team organization.
    personalPoolUq: uniqueIndex("companion_runtime_pools_personal_uq")
      .on(t.orgId, t.ownerId)
      .where(sql`${t.scope} = 'personal' and ${t.ownerId} is not null`),
    orgPoolUq: uniqueIndex("companion_runtime_pools_org_uq")
      .on(t.orgId)
      .where(sql`${t.scope} = 'org' and ${t.ownerId} is null`),
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_runtime_pools_owner_membership_fk",
    }).onDelete("cascade"),
    scopeOwner: check(
      "companion_runtime_pools_scope_owner_check",
      sql`(${t.scope} = 'personal' and ${t.ownerId} is not null) or (${t.scope} = 'org' and ${t.ownerId} is null)`,
    ),
    positiveDiskLayout: check(
      "companion_runtime_pools_disk_layout_version_check",
      sql`${t.diskLayoutVersion} >= 1`,
    ),
    boxIdShape: check(
      "companion_runtime_pools_box_id_check",
      sql`${t.boxId} is null or ${t.boxId} ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'`,
    ),
    lastErrorLength: check(
      "companion_runtime_pools_last_error_check",
      sql`${t.lastError} is null or char_length(${t.lastError}) <= 500`,
    ),
  }),
);

/** Optional default access granted to every current member of the Companion's workspace. */
export const companionWorkspaceAccess = pgTable(
  "companion_workspace_access",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id")
      .primaryKey()
      .references(() => companions.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    role: companionShareRoleEnum("role").notNull(),
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId, t.ownerId],
      foreignColumns: [companions.orgId, companions.id, companions.ownerId],
      name: "companion_workspace_access_companion_fk",
    }),
  }),
);

/**
 * Per-member Companions list preferences (THE-351). Pin, hide, and unread watermarks are private to
 * the member who set them: Viewer and Owner each keep their own roster order and badges. Hide never
 * archives the Companion or its Box; delete remains Owner-only on the Companion row itself.
 */
export const companionMemberState = pgTable(
  "companion_member_state",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id")
      .notNull()
      .references(() => companions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** When set, the Companion is pinned for this member; earlier pins sort above later ones. */
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    /** When true, the Companion is removed from the member's main list without deleting it. */
    hidden: boolean("hidden").notNull().default(false),
    /**
     * Highest transcript ordinal this member has read. Null means never opened; unread when the
     * thread's highest ordinal is greater than this watermark (treating null as -1).
     */
    lastReadOrdinal: integer("last_read_ordinal"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.companionId, t.userId] }),
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_member_state_companion_fk",
    }),
    membershipFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_member_state_membership_fk",
    }).onDelete("cascade"),
    byMember: index("companion_member_state_member_idx").on(t.orgId, t.userId),
    nonnegativeLastRead: check(
      "companion_member_state_last_read_ordinal_check",
      sql`${t.lastReadOrdinal} is null or ${t.lastReadOrdinal} >= 0`,
    ),
  }),
);

/**
 * One chat thread per Companion. The primary key is the Companion id, so a Companion can never own
 * a second thread and a thread can never span Companions. The row also carries the two watermarks
 * that make Pi exchange idempotent: the highest message ordinal Pi has received and the byte offset
 * already projected from the Box RPC log.
 */
export const companionThreads = pgTable(
  "companion_threads",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id")
      .primaryKey()
      .references(() => companions.id, { onDelete: "cascade" }),
    /** Next transcript ordinal to hand out; monotonic, so concurrent sends cannot collide. */
    nextOrdinal: integer("next_ordinal").notNull().default(0),
    /**
     * Highest user-message ordinal already delivered to Pi. Timeout settlement may move it behind
     * an unanswered post-tool tail so a recycled Pi receives those stranded messages again.
     */
    deliveredOrdinal: integer("delivered_ordinal"),
    /** Highest timed-out tool whose unanswered tail has been assessed for one-time re-delivery. */
    timeoutRecoveryOrdinal: integer("timeout_recovery_ordinal"),
    /** Bytes of `~/.companion/runtime/logs/pi.rpc.ndjson` already projected into the transcript. */
    piLogOffset: bigint("pi_log_offset", { mode: "number" }).notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_threads_companion_fk",
    }),
    nonnegativeNextOrdinal: check("companion_threads_next_ordinal_check", sql`${t.nextOrdinal} >= 0`),
    nonnegativeDeliveredOrdinal: check(
      "companion_threads_delivered_ordinal_check",
      sql`${t.deliveredOrdinal} is null or ${t.deliveredOrdinal} >= 0`,
    ),
    nonnegativeTimeoutRecoveryOrdinal: check(
      "companion_threads_timeout_recovery_ordinal_check",
      sql`${t.timeoutRecoveryOrdinal} is null or ${t.timeoutRecoveryOrdinal} >= 0`,
    ),
    nonnegativeLogOffset: check("companion_threads_pi_log_offset_check", sql`${t.piLogOffset} >= 0`),
  }),
);

/**
 * One tool run as it is stored, field for field the `companion_tool_run` contract the thread read
 * model returns. Storing the wire shape verbatim means the projection and the reader share it with
 * no translation, and the shape is restated here so the schema keeps no dependency on contracts.
 */
export interface CompanionStoredToolRun {
  call_id: string | null;
  kind: "shell" | "file" | "browse" | "computer" | "tool";
  name: string;
  title: string;
  status: "running" | "ok" | "error" | "timeout";
  detail: string | null;
  /** One downscaled Box desktop frame as a `data:` image URL, or null when none was captured. */
  screenshot: string | null;
}

/**
 * One permission card as stored, field for field the `companion_decision` contract. Wire shape is
 * kept verbatim so projection and readers share it with no translation, and restated here so the
 * schema keeps no dependency on contracts.
 */
export interface CompanionStoredDecision {
  request_id: string;
  kind: "shell" | "file" | "question";
  name: string;
  title: string;
  detail: string | null;
  status: "pending" | "allowed" | "denied" | "answered" | "expired";
  answer: string | null;
  decided_by_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  expires_at: string;
}

/**
 * Durable, append-oriented transcript projection. Pi remains authoritative while active; browser
 * reads, especially Viewer reads, use this table and therefore never contact or wake Box.
 */
export const companionTranscriptEntries = pgTable(
  "companion_transcript_entries",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id")
      .notNull()
      .references(() => companions.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    role: companionTranscriptRoleEnum("role").notNull(),
    content: text("content").notNull(),
    /**
     * What Pi thought before the reply this row carries. It is a column on the reply rather than a
     * row of its own so the thinking keeps that reply's ordinal, is read by exactly the readers who
     * may read it, and is removed with the Companion. Null on every other role, and on a reply whose
     * thinking is already its content because the turn produced no text.
     */
    reasoning: text("reasoning"),
    /**
     * The tool run a `tool` entry reports: what Pi ran, how it ended, and — for a run that moved the
     * Box desktop — one frame of that desktop. It lives on the entry rather than in its own table so
     * a run keeps the transcript ordinal that places it between the turns it happened between, and is
     * removed with the Companion the row already cascades from. Null for every other role.
     */
    tool: jsonb("tool").$type<CompanionStoredToolRun>(),
    /**
     * The permission card a `decision` entry reports: what Pi asked to do, whether it was allowed,
     * denied, answered, or expired, and who decided. Null for every other role.
     */
    decision: jsonb("decision").$type<CompanionStoredDecision>(),
    /** Member who sent a user message; null for Pi output and for entries written before sharing. */
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.companionId, t.eventId] }),
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_transcript_entries_companion_fk",
    }),
    ordered: unique("companion_transcript_entries_ordinal_uq").on(t.companionId, t.ordinal),
    nonnegativeOrdinal: check(
      "companion_transcript_entries_ordinal_check",
      sql`${t.ordinal} >= 0`,
    ),
    boundedContent: check(
      "companion_transcript_entries_content_check",
      sql`octet_length(${t.content}) <= 1048576`,
    ),
    // A tool run is a tool entry and nothing else, so no reader has to decide what a `system` row
    // carrying a tool payload — or a `tool` row carrying none — was supposed to mean. The role is
    // compared as text because the migration that adds this check also adds the label it names.
    toolRoleOnly: check(
      "companion_transcript_entries_tool_role_check",
      sql`(${t.role}::text = 'tool') = (${t.tool} is not null)`,
    ),
    // One downscaled frame plus its run detail. The cap is the transcript's, not the capture's: a
    // payload larger than this never reached a row, so a stored one is a bug, not a big screenshot.
    boundedTool: check(
      "companion_transcript_entries_tool_size_check",
      sql`${t.tool} is null or octet_length(${t.tool}::text) <= 262144`,
    ),
    decisionRoleOnly: check(
      "companion_transcript_entries_decision_role_check",
      sql`(${t.role}::text = 'decision') = (${t.decision} is not null)`,
    ),
    // Reasoning belongs to a reply and to nothing else, so no reader has to decide what thinking
    // attached to a member's message or a tool run was supposed to mean.
    reasoningRoleOnly: check(
      "companion_transcript_entries_reasoning_role_check",
      sql`${t.reasoning} is null or ${t.role}::text = 'assistant'`,
    ),
    // The contract caps reasoning at 16 000 UTF-16 units, which cannot encode to more than 48 000
    // UTF-8 bytes. Bounding the column there is what makes it a real backstop: a projection that
    // stopped truncating cannot quietly turn every poll into a large read.
    boundedReasoning: check(
      "companion_transcript_entries_reasoning_size_check",
      sql`${t.reasoning} is null or octet_length(${t.reasoning}) <= 48000`,
    ),
    boundedDecision: check(
      "companion_transcript_entries_decision_size_check",
      sql`${t.decision} is null or octet_length(${t.decision}::text) <= 262144`,
    ),
  }),
);
/**
 * Workspace-level Pi provider credentials. Ciphertext is envelope-encrypted and only decrypted
 * immediately before it is delivered to the selected Companion's Box.
 */
export const companionProviderConnections = pgTable(
  "companion_provider_connections",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    authMethod: companionProviderAuthMethodEnum("auth_method").notNull(),
    credentialGeneration: uuid("credential_generation").notNull().defaultRandom(),
    credentialVersion: integer("credential_version").notNull().default(1),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    wrapIv: text("wrap_iv").notNull(),
    wrapAuthTag: text("wrap_auth_tag").notNull(),
    keyId: text("key_id").notNull(),
    connectedBy: text("connected_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.providerId] }),
    providerIdShape: check(
      "companion_provider_connections_provider_id_check",
      sql`${t.providerId} ~ '^[a-z][a-z0-9-]{0,62}$'`,
    ),
    credentialVersionCheck: check(
      "companion_provider_connections_credential_version_check",
      sql`${t.credentialVersion} >= 1`,
    ),
  }),
);

/**
 * Reconciler bookkeeping: one lease row per Companion the worker is treating or backing off from.
 * Kept beside `companions` because that table's `updated_at` is the CAS token of every lifecycle
 * finalizer and reconciler housekeeping must never move it. Under FORCE RLS only the SECURITY
 * DEFINER claim/settle functions' owner touches rows; runtime roles have no direct row access.
 */
export const companionReconcileLeases = pgTable(
  "companion_reconcile_leases",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id")
      .primaryKey()
      .references(() => companions.id, { onDelete: "cascade" }),
    /** Worker instance currently holding the lease; null when free. */
    claimedBy: text("claimed_by"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Why the reconciler last claimed this Companion. */
    reason: text("reason").notNull(),
    /** Consecutive failed attempts for the current condition; reset by a successful settle. */
    attempts: integer("attempts").notNull().default(0),
    /** Backoff gate: the claim function skips this Companion until the moment passes. */
    nextAttentionAt: timestamp("next_attention_at", { withTimezone: true }),
    lastOutcome: text("last_outcome"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_reconcile_leases_companion_fk",
    }),
    nonnegativeAttempts: check(
      "companion_reconcile_leases_attempts_check",
      sql`${t.attempts} >= 0`,
    ),
  }),
);

/**
 * Member-owned MCP accounts used by web and mobile-web Companions. Transport metadata persists so
 * the Plugins screen is useful without waking Box. Credential payloads are envelope-encrypted and
 * are only decrypted after the Companion runtime authorization guard.
 */
export const companionMcpAccounts = pgTable(
  "companion_mcp_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    transport: text("transport").notNull(),
    accountConfig: jsonb("account_config").$type<Record<string, unknown>>().notNull(),
    credentialGeneration: uuid("credential_generation").notNull().defaultRandom(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    wrapIv: text("wrap_iv").notNull(),
    wrapAuthTag: text("wrap_auth_tag").notNull(),
    keyId: text("key_id").notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_mcp_accounts_owner_membership_fk",
    }).onDelete("cascade"),
    uniqueProviderLabel: uniqueIndex("companion_mcp_accounts_provider_label_uq").on(
      t.orgId,
      t.ownerId,
      t.provider,
      sql`lower(${t.label})`,
    ),
    byOwner: index("companion_mcp_accounts_owner_idx").on(t.orgId, t.ownerId, t.updatedAt),
    providerShape: check(
      "companion_mcp_accounts_provider_check",
      sql`${t.provider} ~ '^[a-z][a-z0-9-]{0,62}$'`,
    ),
    labelLength: check(
      "companion_mcp_accounts_label_check",
      sql`char_length(${t.label}) between 1 and 40`,
    ),
    transportShape: check(
      "companion_mcp_accounts_transport_check",
      sql`${t.transport} in ('http', 'stdio')`,
    ),
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
    /**
     * Immutable version currently exposed by the stable public share link. Null means that the
     * metadata page still exists, but no package may be installed. The database migration adds a
     * composite (org, skill, version) FK so this pointer can never target another skill/tenant.
     */
    publicVersionId: uuid("public_version_id"),
    /** SHA-256 over the exact deterministic ZIP bytes served by the public package route. */
    publicPackageChecksum: text("public_package_checksum"),
    /** Byte length of those exact ZIP transport bytes (not the stored tar.gz size). */
    publicPackageSizeBytes: integer("public_package_size_bytes"),
    /** Time this version/ZIP tuple was explicitly promoted. */
    publicReleasedAt: timestamp("public_released_at", { withTimezone: true }),
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
    publicReleaseComplete: check(
      "skills_public_release_complete_check",
      sql`(
        ${t.publicVersionId} is null
        and ${t.publicPackageChecksum} is null
        and ${t.publicPackageSizeBytes} is null
        and ${t.publicReleasedAt} is null
      ) or (
        ${t.publicVersionId} is not null
        and ${t.publicPackageChecksum} is not null
        and ${t.publicPackageSizeBytes} is not null
        and ${t.publicReleasedAt} is not null
      )`,
    ),
    publicChecksum: check(
      "skills_public_package_checksum_check",
      sql`${t.publicPackageChecksum} is null or ${t.publicPackageChecksum} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    publicSize: check(
      "skills_public_package_size_check",
      sql`${t.publicPackageSizeBytes} is null or ${t.publicPackageSizeBytes} >= 0`,
    ),
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
 * Short-lived bearer tickets used for Agent Auth binary package transfers. Plaintext tickets are
 * returned once and never persisted: only their SHA-256 hash lives here.
 * Rows are tenant-owned even though consumption happens through a narrowly-scoped SECURITY
 * DEFINER function before an organization context is known.
 */
export const agentTransferTickets = pgTable(
  "agent_transfer_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Agent Auth agent id. Deliberately not FK-bound to global identity/plugin tables. */
    agentId: text("agent_id").notNull(),
    /** Capability grant id when supplied by Agent Auth; no FK so identity tables stay global. */
    agentGrantId: text("agent_grant_id"),
    action: text("action").notNull(),
    /** Existing target, when one exists. A fresh upload deliberately has no skill id yet. */
    skillId: uuid("skill_id"),
    /** Exact immutable source version for downloads; uploads target a not-yet-created version. */
    skillVersionId: uuid("skill_version_id"),
    /** Stable public token only for public-release downloads. */
    shareToken: text("share_token"),
    /** Path/body binding kept separately so upload tickets can precede creation of the skill row. */
    skillSlug: text("skill_slug").notNull(),
    version: text("version").notNull(),
    /** Exact normalized archive path for a single-file download; null for every package action. */
    filePath: text("file_path"),
    checksum: text("checksum").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    byExpiry: index("agent_transfer_tickets_expiry_idx").on(t.expiresAt),
    byAgent: index("agent_transfer_tickets_agent_idx").on(t.orgId, t.userId, t.agentId, t.createdAt),
    validAction: check(
      "agent_transfer_tickets_action_check",
      sql`${t.action} in ('public_skill_package.download', 'skill_package.download', 'skill_file.download', 'skill_package.upload', 'local_skill.download')`,
    ),
    completeBinding: check(
      "agent_transfer_tickets_binding_check",
      sql`(
        ${t.action} = 'public_skill_package.download'
        and ${t.skillId} is not null
        and ${t.skillVersionId} is not null
        and ${t.shareToken} is not null
        and ${t.filePath} is null
      ) or (
        ${t.action} = 'skill_package.download'
        and ${t.skillId} is not null
        and ${t.skillVersionId} is not null
        and ${t.shareToken} is null
        and ${t.filePath} is null
      ) or (
        ${t.action} = 'skill_file.download'
        and ${t.skillId} is not null
        and ${t.skillVersionId} is not null
        and ${t.shareToken} is null
        and ${t.filePath} is not null
        and btrim(${t.filePath}) <> ''
      ) or (
        ${t.action} = 'skill_package.upload'
        and ${t.skillVersionId} is null
        and ${t.shareToken} is null
        and ${t.filePath} is null
      ) or (
        ${t.action} = 'local_skill.download'
        and ${t.skillId} is null
        and ${t.skillVersionId} is null
        and ${t.shareToken} is null
        and ${t.filePath} is null
      )`,
    ),
    nonnegativeSize: check("agent_transfer_tickets_size_check", sql`${t.sizeBytes} >= 0`),
    checksumCheck: check("agent_transfer_tickets_checksum_check", sql`${t.checksum} ~ '^sha256:[0-9a-f]{64}$'`),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "agent_transfer_tickets_skill_org_fk",
    }).onDelete("cascade"),
    versionOrgSkillFk: foreignKey({
      columns: [t.orgId, t.skillId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.skillId, skillVersions.id],
      name: "agent_transfer_tickets_version_org_skill_fk",
    }).onDelete("cascade"),
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
    groupBy: text("group_by").notNull().default("folder"),
    sidebarOrder: jsonb("sidebar_order")
      .$type<{ mine: string[]; org: string[] }>()
      .notNull()
      .default({ mine: [], org: [] }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    groupByCheck: check("skill_filter_preferences_group_by_check", sql`${t.groupBy} in ('folder', 'none')`),
  }),
);

/**
 * Per-workspace, per-member progress for the dismissible My Skills getting-started checklist.
 * Step timestamps and completion are first-write-wins; dismissal is the only reversible field.
 */
export const gettingStartedStates = pgTable(
  "getting_started_states",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    companionInstalledAt: timestamp("companion_installed_at", { withTimezone: true }),
    localReviewedAt: timestamp("local_reviewed_at", { withTimezone: true }),
    orgReviewedAt: timestamp("org_reviewed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
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
 * `scopes` gates capability; tokens expire and can be revoked. Agent-derived rows keep only
 * value-free provenance plus an optional explicit runtime target binding.
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
    sourceType: text("source_type").notNull().default("human"),
    sourceAgentId: text("source_agent_id"),
    targetWorkspaceId: text("target_workspace_id"),
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
  /** Creator-private audit visibility for resources whose admins have no override. */
  privateToUserId: text("private_to_user_id").references(() => user.id, {
    onDelete: "cascade",
  }),
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

/** Current database declaration generation for one skill manifest. */
export const skillDatabaseSchemas = pgTable(
  "skill_database_schemas",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    generation: integer("generation").notNull().default(1),
    declarationsChecksum: text("declarations_checksum").notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.skillId] }),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_database_schemas_skill_org_fk",
    }).onDelete("cascade"),
    positiveGeneration: check("skill_database_schemas_generation_check", sql`${t.generation} >= 1`),
  }),
);

export interface SkillDatabaseStoredColumn {
  name: string;
  type: "text" | "integer" | "real" | "boolean" | "json" | "timestamp";
  nullable: boolean;
  default?: string | number | boolean | null;
  retiredAt?: string;
}

/** Projection of the current manifest tables. Retired declarations are retained for lazy files. */
export const skillDatabaseTables = pgTable(
  "skill_database_tables",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    tableName: text("table_name").notNull(),
    audience: skillDatabaseAudienceEnum("audience").notNull(),
    columns: jsonb("columns").$type<SkillDatabaseStoredColumn[]>().notNull(),
    primaryKey: jsonb("primary_key").$type<string[]>().notNull().default([]),
    uniqueConstraints: jsonb("unique_constraints").$type<string[][]>().notNull().default([]),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.skillId, t.tableName] }),
    schemaFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skillDatabaseSchemas.orgId, skillDatabaseSchemas.skillId],
      name: "skill_database_tables_schema_fk",
    }).onDelete("cascade"),
    validName: check(
      "skill_database_tables_name_check",
      sql`${t.tableName} ~ '^[a-z][a-z0-9_]{0,62}$' and ${t.tableName} !~ '^sqlite_'`,
    ),
  }),
);

/** Registry entry for one immutable-addressed SQLite file in object storage. */
export const skillDatabaseRealms = pgTable(
  "skill_database_realms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    audience: skillDatabaseAudienceEnum("audience").notNull(),
    ownerId: text("owner_id"),
    storageKey: text("storage_key").notNull().unique(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    etag: text("etag"),
    schemaGeneration: integer("schema_generation").notNull().default(0),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgRealm: uniqueIndex("skill_database_realms_org_uq")
      .on(t.orgId, t.skillId)
      .where(sql`${t.audience} = 'organization' and ${t.ownerId} is null`),
    uniquePersonalRealm: uniqueIndex("skill_database_realms_personal_uq")
      .on(t.orgId, t.skillId, t.ownerId)
      .where(sql`${t.audience} = 'personal' and ${t.ownerId} is not null`),
    uniqueRealmOwner: unique("skill_database_realms_org_id_id_owner_id_uq")
      .on(t.orgId, t.id, t.ownerId),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_database_realms_skill_org_fk",
    }).onDelete("cascade"),
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "skill_database_realms_owner_membership_fk",
    }).onDelete("cascade"),
    audienceOwner: check(
      "skill_database_realms_audience_owner_check",
      sql`(${t.audience} = 'organization' and ${t.ownerId} is null) or (${t.audience} = 'personal' and ${t.ownerId} is not null)`,
    ),
    nonnegativeSize: check("skill_database_realms_size_check", sql`${t.sizeBytes} >= 0`),
    nonnegativeGeneration: check("skill_database_realms_generation_check", sql`${t.schemaGeneration} >= 0`),
  }),
);

/** Member grants for a complete personal SQLite realm. Owner/Admin roles never override these rows. */
export const skillDatabaseRealmShares = pgTable(
  "skill_database_realm_shares",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    realmId: uuid("realm_id").notNull(),
    ownerId: text("owner_id").notNull(),
    granteeId: text("grantee_id").notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.realmId, t.granteeId] }),
    realmOwnerFk: foreignKey({
      columns: [t.orgId, t.realmId, t.ownerId],
      foreignColumns: [skillDatabaseRealms.orgId, skillDatabaseRealms.id, skillDatabaseRealms.ownerId],
      name: "skill_database_realm_shares_realm_owner_fk",
    }).onDelete("cascade"),
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "skill_database_realm_shares_owner_membership_fk",
    }).onDelete("cascade"),
    granteeMembershipFk: foreignKey({
      columns: [t.orgId, t.granteeId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "skill_database_realm_shares_grantee_membership_fk",
    }).onDelete("cascade"),
    differentMembers: check(
      "skill_database_realm_shares_different_members_check",
      sql`${t.ownerId} <> ${t.granteeId}`,
    ),
  }),
);

/** Fixed one-minute counters avoid one audit row per SQL statement. */
export const skillDatabaseRateWindows = pgTable(
  "skill_database_rate_windows",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    queryCount: integer("query_count").notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId, t.windowStart] }),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "skill_database_rate_windows_member_org_fk",
    }).onDelete("cascade"),
    positiveCount: check("skill_database_rate_windows_count_check", sql`${t.queryCount} >= 1`),
  }),
);

/**
 * Durable object-deletion outbox populated by the realm delete trigger. It intentionally has no
 * organization FK: an organization cascade must leave its object cleanup work behind.
 */
export const skillDatabaseObjectDeletions = pgTable(
  "skill_database_object_deletions",
  {
    storageKey: text("storage_key").primaryKey(),
    orgId: uuid("org_id").notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    byAvailability: index("skill_database_object_deletions_available_idx").on(
      t.availableAt,
      t.claimExpiresAt,
    ),
    nonnegativeAttempts: check(
      "skill_database_object_deletions_attempts_check",
      sql`${t.attempts} >= 0`,
    ),
    completeClaim: check(
      "skill_database_object_deletions_claim_check",
      sql`(${t.claimToken} is null and ${t.claimExpiresAt} is null)
        or (${t.claimToken} is not null and ${t.claimExpiresAt} is not null)`,
    ),
  }),
);
