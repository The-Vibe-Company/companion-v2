import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, exists, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type {
  CreateSecretGrantResult,
  CreateSecretInput,
  RedeemedSecretGrant,
  SecretAudience,
  SecretRetrievalPreflight,
  SecretRetrievalPreflightInput,
  SecretRow,
  SkillSecretConfiguration,
  UpdateSecretInput,
} from "@companion/contracts";
import { companionManifestSchema } from "@companion/contracts";
import { db, schema, withTenantContext, type Db } from "@companion/db";
import { deterministicSecretSlotId } from "@companion/skills";
import { canAccessSecret, canManageSecret } from "./authz";
import { decryptSecretValue, encryptSecretValue, type SecretCiphertext } from "./secretsCrypto";

export interface SecretActorContext {
  id: string;
  email: string;
  name: string;
}

const PLAN_TTL_MS = 5 * 60 * 1000;
const GRANT_TTL_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const PREFLIGHT_RATE_LIMIT = 30;
const GRANT_RATE_LIMIT = 10;

async function assertSecretMember(database: Db, actor: SecretActorContext, orgId: string): Promise<void> {
  const membership = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, actor.id)),
  });
  if (!membership) throw new Error("not a member of this organization");
}

function accessibleSecretWhere(actorId: string, orgId: string) {
  return and(
    eq(schema.secrets.orgId, orgId),
    isNull(schema.secrets.disabledAt),
    isNull(schema.secrets.deletedAt),
    or(
      eq(schema.secrets.ownerId, actorId),
      eq(schema.secrets.audience, "organization"),
      exists(
        db
          .select({ one: sql`1` })
          .from(schema.secretRecipients)
          .where(
            and(
              eq(schema.secretRecipients.orgId, orgId),
              eq(schema.secretRecipients.secretId, schema.secrets.id),
              eq(schema.secretRecipients.userId, actorId),
            ),
          ),
      ),
    ),
  );
}

type SecretRecord = typeof schema.secrets.$inferSelect & {
  recipientIds: string[];
  ownerName: string;
  ownerInitials: string;
  ownerAvatarUrl: string | null;
};

async function loadSecretRecord(database: Db, orgId: string, secretId: string): Promise<SecretRecord | null> {
  const [row] = await database
    .select({
      secret: schema.secrets,
      ownerName: schema.profiles.name,
      ownerInitials: schema.profiles.initials,
      ownerAvatarUrl: schema.profiles.avatarUrl,
    })
    .from(schema.secrets)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.secrets.ownerId))
    .where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.id, secretId)))
    .limit(1);
  if (!row) return null;
  const recipients = await database
    .select({ userId: schema.secretRecipients.userId })
    .from(schema.secretRecipients)
    .where(and(eq(schema.secretRecipients.orgId, orgId), eq(schema.secretRecipients.secretId, secretId)));
  return {
    ...row.secret,
    recipientIds: recipients.map((recipient) => recipient.userId),
    ownerName: row.ownerName,
    ownerInitials: row.ownerInitials,
    ownerAvatarUrl: row.ownerAvatarUrl,
  };
}

async function assertSecretAccess(
  database: Db,
  actor: SecretActorContext,
  orgId: string,
  secretId: string,
): Promise<SecretRecord> {
  await assertSecretMember(database, actor, orgId);
  const secret = await loadSecretRecord(database, orgId, secretId);
  if (!secret || !canAccessSecret(actor.id, {
    ownerId: secret.ownerId,
    audience: secret.audience,
    recipientIds: secret.recipientIds,
    disabledAt: secret.disabledAt,
    deletedAt: secret.deletedAt,
  })) throw new Error("secret not found");
  return secret;
}

/** Metadata-only pin used by trusted control-plane workflows such as RunSkill and provider binds. */
export interface AccessibleSecretPin {
  secretId: string;
  version: number;
  key: string;
  name: string;
  ownerId: string;
  ownerName: string;
  audience: SecretAudience;
}

/**
 * Revalidate the normal vault ACL and pin the current immutable value version without decrypting it.
 * Callers persist this reference, never a plaintext or ciphertext copy.
 */
export async function pinAccessibleSecret(input: {
  actor: SecretActorContext;
  orgId: string;
  secretId: string;
  database?: Db;
}): Promise<AccessibleSecretPin> {
  const database = input.database ?? db;
  const secret = await assertSecretAccess(database, input.actor, input.orgId, input.secretId);
  return {
    secretId: secret.id,
    version: secret.currentVersion,
    key: secret.key,
    name: secret.name,
    ownerId: secret.ownerId,
    ownerName: secret.ownerName,
    audience: secret.audience,
  };
}

/**
 * Last-moment trusted resolver for an already pinned version. Access is checked again before the
 * immutable version is opened; disabled/deleted/revoked secrets therefore stop a queued run.
 */
export async function decryptPinnedSecret(input: {
  actor: SecretActorContext;
  orgId: string;
  secretId: string;
  version: number;
  masterKey?: Buffer;
  database?: Db;
}): Promise<{ pin: AccessibleSecretPin; value: string }> {
  const database = input.database ?? db;
  const secret = await assertSecretAccess(database, input.actor, input.orgId, input.secretId);
  const row = await database.query.secretVersions.findFirst({
    where: and(
      eq(schema.secretVersions.orgId, input.orgId),
      eq(schema.secretVersions.secretId, input.secretId),
      eq(schema.secretVersions.version, input.version),
    ),
  });
  if (!row) throw new Error("secret not found");
  return {
    pin: {
      secretId: secret.id,
      version: input.version,
      key: secret.key,
      name: secret.name,
      ownerId: secret.ownerId,
      ownerName: secret.ownerName,
      audience: secret.audience,
    },
    value: decryptSecretValue(
      { orgId: input.orgId, secretId: input.secretId, version: input.version, ...ciphertextFromRow(row) },
      input.masterKey,
    ),
  };
}

async function assertSecretOwner(
  database: Db,
  actor: SecretActorContext,
  orgId: string,
  secretId: string,
): Promise<SecretRecord> {
  await assertSecretMember(database, actor, orgId);
  const secret = await loadSecretRecord(database, orgId, secretId);
  if (!secret || !canManageSecret(actor.id, { ownerId: secret.ownerId })) throw new Error("secret not found");
  return secret;
}

async function recipientRows(database: Db, secret: SecretRecord, actorId: string) {
  if (secret.ownerId !== actorId) return [];
  return database
    .select({
      id: schema.profiles.id,
      name: schema.profiles.name,
      initials: schema.profiles.initials,
      avatar_url: schema.profiles.avatarUrl,
    })
    .from(schema.secretRecipients)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.secretRecipients.userId))
    .where(and(eq(schema.secretRecipients.orgId, secret.orgId), eq(schema.secretRecipients.secretId, secret.id)))
    .orderBy(asc(schema.profiles.name));
}

async function toSecretRow(database: Db, actorId: string, secret: SecretRecord): Promise<SecretRow> {
  const usageCount = secret.ownerId === actorId
    ? (
        await Promise.all([
          database
            .select({ value: count() })
            .from(schema.skillSecretBindings)
            .where(and(eq(schema.skillSecretBindings.orgId, secret.orgId), eq(schema.skillSecretBindings.secretId, secret.id), isNull(schema.skillSecretBindings.revokedAt))),
          database
            .select({ value: count() })
            .from(schema.skillRunConfigSecrets)
            .where(and(eq(schema.skillRunConfigSecrets.orgId, secret.orgId), eq(schema.skillRunConfigSecrets.secretId, secret.id))),
          database
            .select({ value: count() })
            .from(schema.userProviderConnections)
            .where(and(eq(schema.userProviderConnections.orgId, secret.orgId), eq(schema.userProviderConnections.secretId, secret.id))),
          database
            .select({ value: count() })
            .from(schema.orgProviderConnections)
            .where(and(eq(schema.orgProviderConnections.orgId, secret.orgId), eq(schema.orgProviderConnections.secretId, secret.id))),
        ])
      ).reduce((total, rows) => total + Number(rows[0]?.value ?? 0), 0)
    : 0;
  return {
    id: secret.id,
    org_id: secret.orgId,
    name: secret.name,
    key: secret.key,
    audience: secret.audience,
    owner: {
      id: secret.ownerId,
      name: secret.ownerName,
      initials: secret.ownerInitials,
      avatar_url: secret.ownerAvatarUrl,
    },
    recipients: await recipientRows(database, secret, actorId),
    current_version: secret.currentVersion,
    last_rotated_at: secret.lastRotatedAt.toISOString(),
    disabled_at: secret.disabledAt?.toISOString() ?? null,
    deleted_at: secret.deletedAt?.toISOString() ?? null,
    created_at: secret.createdAt.toISOString(),
    updated_at: secret.updatedAt.toISOString(),
    can_use: canAccessSecret(actorId, {
      ownerId: secret.ownerId,
      audience: secret.audience,
      recipientIds: secret.recipientIds,
      disabledAt: secret.disabledAt,
      deletedAt: secret.deletedAt,
    }),
    can_manage: canManageSecret(actorId, secret),
    usage_count: usageCount,
  };
}

async function audit(
  database: Db,
  input: { orgId: string; actorId: string; action: string; targetType: string; targetId: string; metadata?: Record<string, unknown> },
) {
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: input.metadata ?? {},
  });
}

async function durableAudit(
  input: { orgId: string; actorId: string; action: string; targetType: string; targetId: string; metadata?: Record<string, unknown> },
) {
  await withTenantContext({ orgId: input.orgId, userId: input.actorId }, (database) => audit(database, input));
}

async function validateRecipients(database: Db, orgId: string, ownerId: string, ids: string[]): Promise<string[]> {
  const deduped = [...new Set(ids)].filter((id) => id !== ownerId);
  if (!deduped.length) return [];
  const members = await database
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.orgId, orgId), inArray(schema.memberships.userId, deduped)));
  if (members.length !== deduped.length) throw new Error("every secret recipient must be a current organization member");
  return deduped;
}

async function replaceRecipients(database: Db, orgId: string, secretId: string, ownerId: string, recipientIds: string[]): Promise<void> {
  await database.delete(schema.secretRecipients).where(and(eq(schema.secretRecipients.orgId, orgId), eq(schema.secretRecipients.secretId, secretId)));
  if (recipientIds.length) {
    await database.insert(schema.secretRecipients).values(recipientIds.map((userId) => ({ orgId, secretId, ownerId, userId })));
  }
}

export async function listSecrets(input: {
  actor: SecretActorContext;
  orgId: string;
  database?: Db;
}): Promise<SecretRow[]> {
  const database = input.database ?? db;
  await assertSecretMember(database, input.actor, input.orgId);
  const rows = await database
    .select({ id: schema.secrets.id })
    .from(schema.secrets)
    .where(accessibleSecretWhere(input.actor.id, input.orgId))
    .orderBy(desc(schema.secrets.updatedAt));
  const result: SecretRow[] = [];
  for (const row of rows) {
    const secret = await loadSecretRecord(database, input.orgId, row.id);
    if (secret) result.push(await toSecretRow(database, input.actor.id, secret));
  }
  return result;
}

export async function getSecret(input: {
  actor: SecretActorContext;
  orgId: string;
  secretId: string;
  database?: Db;
}): Promise<SecretRow> {
  const database = input.database ?? db;
  const secret = await assertSecretAccess(database, input.actor, input.orgId, input.secretId);
  return toSecretRow(database, input.actor.id, secret);
}

export async function createSecret(input: {
  actor: SecretActorContext;
  orgId: string;
  value: CreateSecretInput;
  database?: Db;
}): Promise<SecretRow> {
  const database = input.database ?? db;
  await assertSecretMember(database, input.actor, input.orgId);
  const secretId = randomUUID();
  const recipients = input.value.audience === "restricted"
    ? await validateRecipients(database, input.orgId, input.actor.id, input.value.recipient_ids)
    : [];
  if (input.value.audience === "restricted" && !recipients.length) throw new Error("restricted secrets require at least one other member");
  const encrypted = encryptSecretValue({ orgId: input.orgId, secretId, version: 1, value: input.value.value });
  await database.transaction(async (tx) => {
    await tx.insert(schema.secrets).values({
      id: secretId,
      orgId: input.orgId,
      ownerId: input.actor.id,
      name: input.value.name,
      key: input.value.key,
      audience: input.value.audience,
    });
    await tx.insert(schema.secretVersions).values({
      orgId: input.orgId,
      secretId,
      version: 1,
      ...encrypted,
      createdBy: input.actor.id,
    });
    if (recipients.length) await tx.insert(schema.secretRecipients).values(recipients.map((userId) => ({ orgId: input.orgId, secretId, ownerId: input.actor.id, userId })));
    await audit(tx as unknown as Db, {
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "secret.create",
      targetType: "secret",
      targetId: secretId,
      metadata: { audience: input.value.audience, recipientCount: recipients.length, version: 1 },
    });
  });
  return getSecret({ actor: input.actor, orgId: input.orgId, secretId, database });
}

export async function updateSecret(input: {
  actor: SecretActorContext;
  orgId: string;
  secretId: string;
  value: UpdateSecretInput;
  database?: Db;
}): Promise<SecretRow> {
  const database = input.database ?? db;
  const secret = await assertSecretOwner(database, input.actor, input.orgId, input.secretId);
  if (secret.deletedAt || secret.disabledAt) throw new Error("secret is disabled");
  const audience = input.value.audience ?? secret.audience;
  const requestedRecipients = input.value.recipient_ids ?? secret.recipientIds;
  const recipients = audience === "restricted"
    ? await validateRecipients(database, input.orgId, input.actor.id, requestedRecipients)
    : [];
  if (audience === "restricted" && !recipients.length) throw new Error("restricted secrets require at least one other member");
  await database.transaction(async (tx) => {
    await tx.update(schema.secrets).set({
      ...(input.value.name ? { name: input.value.name } : {}),
      ...(input.value.key ? { key: input.value.key } : {}),
      audience,
      updatedAt: new Date(),
    }).where(and(eq(schema.secrets.orgId, input.orgId), eq(schema.secrets.id, input.secretId), eq(schema.secrets.ownerId, input.actor.id)));
    await replaceRecipients(tx as unknown as Db, input.orgId, input.secretId, input.actor.id, recipients);
    await audit(tx as unknown as Db, {
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "secret.acl.update",
      targetType: "secret",
      targetId: input.secretId,
      metadata: { audience, recipientCount: recipients.length, metadataChanged: Boolean(input.value.name || input.value.key) },
    });
  });
  return getSecret({ actor: input.actor, orgId: input.orgId, secretId: input.secretId, database });
}

export async function rotateSecret(input: {
  actor: SecretActorContext;
  orgId: string;
  secretId: string;
  value: string;
  database?: Db;
}): Promise<SecretRow> {
  const database = input.database ?? db;
  const secret = await assertSecretOwner(database, input.actor, input.orgId, input.secretId);
  if (secret.deletedAt || secret.disabledAt) throw new Error("secret is disabled");
  await database.transaction(async (tx) => {
    const rotatedAt = new Date();
    const [rotated] = await tx
      .update(schema.secrets)
      .set({ currentVersion: sql`${schema.secrets.currentVersion} + 1`, lastRotatedAt: rotatedAt, updatedAt: rotatedAt })
      .where(and(
        eq(schema.secrets.orgId, input.orgId),
        eq(schema.secrets.id, input.secretId),
        eq(schema.secrets.ownerId, input.actor.id),
        isNull(schema.secrets.disabledAt),
        isNull(schema.secrets.deletedAt),
      ))
      .returning({ version: schema.secrets.currentVersion });
    if (!rotated) throw new Error("secret is disabled");
    const version = rotated.version;
    const encrypted = encryptSecretValue({ orgId: input.orgId, secretId: input.secretId, version, value: input.value });
    await tx.insert(schema.secretVersions).values({ orgId: input.orgId, secretId: input.secretId, version, ...encrypted, createdBy: input.actor.id });
    await audit(tx as unknown as Db, { orgId: input.orgId, actorId: input.actor.id, action: "secret.rotate", targetType: "secret", targetId: input.secretId, metadata: { version } });
  });
  return getSecret({ actor: input.actor, orgId: input.orgId, secretId: input.secretId, database });
}

export async function deleteSecret(input: { actor: SecretActorContext; orgId: string; secretId: string; database?: Db }): Promise<void> {
  const database = input.database ?? db;
  await assertSecretOwner(database, input.actor, input.orgId, input.secretId);
  const now = new Date();
  await database.transaction(async (tx) => {
    await tx.update(schema.secrets).set({ disabledAt: now, deletedAt: now, updatedAt: now }).where(and(eq(schema.secrets.orgId, input.orgId), eq(schema.secrets.id, input.secretId)));
    await tx.update(schema.skillSecretBindings).set({ revokedAt: now, updatedAt: now }).where(and(eq(schema.skillSecretBindings.orgId, input.orgId), eq(schema.skillSecretBindings.secretId, input.secretId), isNull(schema.skillSecretBindings.revokedAt)));
    await audit(tx as unknown as Db, { orgId: input.orgId, actorId: input.actor.id, action: "secret.delete", targetType: "secret", targetId: input.secretId });
  });
}

export async function disableSecretsForDepartingMember(input: { orgId: string; userId: string; actorId: string; database: Db }): Promise<void> {
  const now = new Date();
  await input.database.execute(sql`select set_config('app.departing_user_id', ${input.userId}, true)`);
  try {
    const owned = await input.database.select({ id: schema.secrets.id }).from(schema.secrets).where(and(eq(schema.secrets.orgId, input.orgId), eq(schema.secrets.ownerId, input.userId), isNull(schema.secrets.disabledAt)));
    if (!owned.length) return;
    const ids = owned.map((row) => row.id);
    await input.database.update(schema.secrets).set({ disabledAt: now, updatedAt: now }).where(and(eq(schema.secrets.orgId, input.orgId), inArray(schema.secrets.id, ids)));
    for (const id of ids) await audit(input.database, { orgId: input.orgId, actorId: input.actorId, action: "secret.disable.owner_departed", targetType: "secret", targetId: id });
  } finally {
    await input.database.execute(sql`select set_config('app.departing_user_id', '', true)`);
  }
}

export async function persistSkillSecretSlots(input: {
  orgId: string;
  skillId: string;
  skillVersionId: string;
  frontmatter: string;
  database: Db;
}): Promise<void> {
  let manifest;
  try {
    const stored = JSON.parse(input.frontmatter) as { companion?: unknown };
    const parsed = companionManifestSchema.safeParse(stored.companion);
    if (!parsed.success) return;
    manifest = parsed.data;
  } catch {
    return;
  }
  for (const [envKey, declaration] of Object.entries(manifest.environment.secrets)) {
    const slotId = declaration.slotId ?? deterministicSecretSlotId(input.skillId, envKey);
    await input.database
      .insert(schema.skillSecretSlots)
      .values({ orgId: input.orgId, skillId: input.skillId, slotId, lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.skillSecretSlots.orgId, schema.skillSecretSlots.skillId, schema.skillSecretSlots.slotId],
        set: { lastSeenAt: new Date() },
      });
    await input.database.insert(schema.skillVersionSecretSlots).values({
      orgId: input.orgId,
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
      slotId,
      envKey,
      description: declaration.description,
      required: declaration.required,
    });
  }
}

async function accessibleSkill(database: Db, actor: SecretActorContext, orgId: string, slug: string) {
  await assertSecretMember(database, actor, orgId);
  const skill = await database.query.skills.findFirst({ where: and(eq(schema.skills.orgId, orgId), eq(schema.skills.slug, slug)) });
  if (!skill || (skill.scope === "personal" && skill.creatorId !== actor.id)) throw new Error("skill not found");
  return skill;
}

async function currentSkillSlots(database: Db, actor: SecretActorContext, orgId: string, slug: string, versionLabel?: string) {
  const skill = await accessibleSkill(database, actor, orgId, slug);
  const version = versionLabel
    ? await database.query.skillVersions.findFirst({ where: and(eq(schema.skillVersions.orgId, orgId), eq(schema.skillVersions.skillId, skill.id), eq(schema.skillVersions.version, versionLabel)) })
    : skill.currentVersionId
      ? await database.query.skillVersions.findFirst({ where: and(eq(schema.skillVersions.orgId, orgId), eq(schema.skillVersions.id, skill.currentVersionId)) })
      : null;
  if (!version) return { skill, version: null, slots: [] };
  const slots = await database.select().from(schema.skillVersionSecretSlots).where(and(eq(schema.skillVersionSecretSlots.orgId, orgId), eq(schema.skillVersionSecretSlots.skillVersionId, version.id))).orderBy(asc(schema.skillVersionSecretSlots.envKey));
  return { skill, version, slots };
}

function secretCandidate(secret: SecretRow, actorId: string) {
  return {
    id: secret.id,
    name: secret.name,
    key: secret.key,
    owner: secret.owner,
    audience: secret.audience,
    personal: secret.owner.id === actorId,
  };
}

export async function getSkillSecretConfiguration(input: {
  actor: SecretActorContext;
  orgId: string;
  slug: string;
  version?: string;
  database?: Db;
}): Promise<SkillSecretConfiguration> {
  const database = input.database ?? db;
  const { skill, version, slots } = await currentSkillSlots(database, input.actor, input.orgId, input.slug, input.version);
  const secrets = await listSecrets({ actor: input.actor, orgId: input.orgId, database });
  const byId = new Map(secrets.map((secret) => [secret.id, secret]));
  const bindings = await database.select().from(schema.skillSecretBindings).where(and(eq(schema.skillSecretBindings.orgId, input.orgId), eq(schema.skillSecretBindings.userId, input.actor.id), eq(schema.skillSecretBindings.skillId, skill.id), isNull(schema.skillSecretBindings.revokedAt)));
  const suggestions = await database.select().from(schema.skillSecretSuggestions).where(and(eq(schema.skillSecretSuggestions.orgId, input.orgId), eq(schema.skillSecretSuggestions.skillId, skill.id)));
  const bindingBySlot = new Map(bindings.map((binding) => [binding.slotId, binding]));
  const suggestionBySlot = new Map(suggestions.map((suggestion) => [suggestion.slotId, suggestion]));
  let blockers = 0;
  let warnings = 0;
  const rows = slots.map((slot) => {
    const bindingRow = bindingBySlot.get(slot.slotId);
    const bound = bindingRow ? byId.get(bindingRow.secretId) ?? null : null;
    const suggestionRow = suggestionBySlot.get(slot.slotId);
    const suggested = suggestionRow ? byId.get(suggestionRow.secretId) ?? null : null;
    const status = bound ? (bound.owner.id === input.actor.id ? "personal" as const : "shared" as const) : slot.required ? "required" as const : "optional_missing" as const;
    if (status === "required") blockers += 1;
    if (status === "optional_missing") warnings += 1;
    return {
      slot_id: slot.slotId,
      env_key: slot.envKey,
      description: slot.description,
      required: slot.required,
      status,
      binding: bound ? secretCandidate(bound, input.actor.id) : null,
      suggestion: suggested ? secretCandidate(suggested, input.actor.id) : null,
      suggestion_confirmed: bindingRow?.source === "suggestion" && Boolean(bound),
      candidates: secrets.map((secret) => secretCandidate(secret, input.actor.id)),
    };
  });
  return { skill_id: skill.id, slug: skill.slug, version: version?.version ?? null, slots: rows, configured: blockers === 0, blockers, warnings };
}

async function assertStableSlot(database: Db, orgId: string, skillId: string, slotId: string) {
  const slot = await database.query.skillSecretSlots.findFirst({ where: and(eq(schema.skillSecretSlots.orgId, orgId), eq(schema.skillSecretSlots.skillId, skillId), eq(schema.skillSecretSlots.slotId, slotId)) });
  if (!slot) throw new Error("secret slot not found");
  return slot;
}

export async function setSkillSecretBinding(input: { actor: SecretActorContext; orgId: string; slug: string; slotId: string; secretId: string; source?: "manual" | "suggestion"; database?: Db }): Promise<SkillSecretConfiguration> {
  const database = input.database ?? db;
  const skill = await accessibleSkill(database, input.actor, input.orgId, input.slug);
  await assertStableSlot(database, input.orgId, skill.id, input.slotId);
  await assertSecretAccess(database, input.actor, input.orgId, input.secretId);
  const now = new Date();
  await database.insert(schema.skillSecretBindings).values({ orgId: input.orgId, userId: input.actor.id, skillId: skill.id, slotId: input.slotId, secretId: input.secretId, source: input.source ?? "manual", confirmedAt: now }).onConflictDoUpdate({
    target: [schema.skillSecretBindings.orgId, schema.skillSecretBindings.userId, schema.skillSecretBindings.skillId, schema.skillSecretBindings.slotId],
    set: { secretId: input.secretId, source: input.source ?? "manual", confirmedAt: now, revokedAt: null, updatedAt: now },
  });
  await audit(database, { orgId: input.orgId, actorId: input.actor.id, action: "secret.binding.set", targetType: "skill_secret_slot", targetId: input.slotId, metadata: { skillId: skill.id, source: input.source ?? "manual" } });
  return getSkillSecretConfiguration({ actor: input.actor, orgId: input.orgId, slug: input.slug, database });
}

export async function removeSkillSecretBinding(input: { actor: SecretActorContext; orgId: string; slug: string; slotId: string; database?: Db }): Promise<SkillSecretConfiguration> {
  const database = input.database ?? db;
  const skill = await accessibleSkill(database, input.actor, input.orgId, input.slug);
  await database.update(schema.skillSecretBindings).set({ revokedAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.skillSecretBindings.orgId, input.orgId), eq(schema.skillSecretBindings.userId, input.actor.id), eq(schema.skillSecretBindings.skillId, skill.id), eq(schema.skillSecretBindings.slotId, input.slotId)));
  await audit(database, { orgId: input.orgId, actorId: input.actor.id, action: "secret.binding.remove", targetType: "skill_secret_slot", targetId: input.slotId, metadata: { skillId: skill.id } });
  return getSkillSecretConfiguration({ actor: input.actor, orgId: input.orgId, slug: input.slug, database });
}

export async function setSkillSecretSuggestion(input: { actor: SecretActorContext; orgId: string; slug: string; slotId: string; secretId: string; database?: Db }): Promise<SkillSecretConfiguration> {
  const database = input.database ?? db;
  const skill = await accessibleSkill(database, input.actor, input.orgId, input.slug);
  if (skill.scope === "personal" && skill.creatorId !== input.actor.id) throw new Error("skill not found");
  await assertStableSlot(database, input.orgId, skill.id, input.slotId);
  await assertSecretAccess(database, input.actor, input.orgId, input.secretId);
  await database.insert(schema.skillSecretSuggestions).values({ orgId: input.orgId, skillId: skill.id, slotId: input.slotId, secretId: input.secretId, suggestedBy: input.actor.id }).onConflictDoUpdate({
    target: [schema.skillSecretSuggestions.orgId, schema.skillSecretSuggestions.skillId, schema.skillSecretSuggestions.slotId],
    set: { secretId: input.secretId, suggestedBy: input.actor.id, updatedAt: new Date() },
  });
  await audit(database, { orgId: input.orgId, actorId: input.actor.id, action: "secret.suggestion.set", targetType: "skill_secret_slot", targetId: input.slotId, metadata: { skillId: skill.id } });
  return getSkillSecretConfiguration({ actor: input.actor, orgId: input.orgId, slug: input.slug, database });
}

export async function removeSkillSecretSuggestion(input: { actor: SecretActorContext; orgId: string; slug: string; slotId: string; database?: Db }): Promise<SkillSecretConfiguration> {
  const database = input.database ?? db;
  const skill = await accessibleSkill(database, input.actor, input.orgId, input.slug);
  await database.delete(schema.skillSecretSuggestions).where(and(eq(schema.skillSecretSuggestions.orgId, input.orgId), eq(schema.skillSecretSuggestions.skillId, skill.id), eq(schema.skillSecretSuggestions.slotId, input.slotId)));
  await audit(database, { orgId: input.orgId, actorId: input.actor.id, action: "secret.suggestion.remove", targetType: "skill_secret_slot", targetId: input.slotId, metadata: { skillId: skill.id } });
  return getSkillSecretConfiguration({ actor: input.actor, orgId: input.orgId, slug: input.slug, database });
}

export async function acceptSkillSecretSuggestion(input: { actor: SecretActorContext; orgId: string; slug: string; slotId: string; database?: Db }): Promise<SkillSecretConfiguration> {
  const database = input.database ?? db;
  const skill = await accessibleSkill(database, input.actor, input.orgId, input.slug);
  const suggestion = await database.query.skillSecretSuggestions.findFirst({ where: and(eq(schema.skillSecretSuggestions.orgId, input.orgId), eq(schema.skillSecretSuggestions.skillId, skill.id), eq(schema.skillSecretSuggestions.slotId, input.slotId)) });
  if (!suggestion) throw new Error("secret suggestion not found");
  await assertSecretAccess(database, input.actor, input.orgId, suggestion.secretId);
  return setSkillSecretBinding({ actor: input.actor, orgId: input.orgId, slug: input.slug, slotId: input.slotId, secretId: suggestion.secretId, source: "suggestion", database });
}

type SecretRateLimitKind = "preflight" | "grant_create" | "grant_redeem";

async function assertRateLimit(database: Db, orgId: string, userId: string, kind: SecretRateLimitKind) {
  const since = new Date(Date.now() - RATE_WINDOW_MS);
  const bucket = kind === "preflight" ? "preflight" : "grant";
  const limit = bucket === "preflight" ? PREFLIGHT_RATE_LIMIT : GRANT_RATE_LIMIT;
  // Retrieval services normally run inside the route's tenant transaction. Claims must commit on
  // an independent connection so a later validation error cannot roll back quota/accounting rows.
  // Keep the parameter for service-call compatibility, but never attach the claim to that request tx.
  void database;
  const allowed = await withTenantContext({ orgId, userId }, async (tx) => {
    // Serialize quota claims for one user + bucket. Counting and recording the attempt inside the
    // same transaction makes parallel requests obey the exact cap; grant creation and redemption
    // intentionally share the same ten-attempt budget.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${userId}:${bucket}`}, 0))`);
    const [claimed] = await tx
      .select({ value: count() })
      .from(schema.auditLog)
      .where(and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.actorId, userId),
        eq(schema.auditLog.action, "secret.retrieval.rate_claim"),
        eq(schema.auditLog.targetType, "secret_retrieval"),
        eq(schema.auditLog.targetId, bucket),
        gt(schema.auditLog.createdAt, since),
      ));
    if (Number(claimed?.value ?? 0) < limit) {
      await audit(tx, {
        orgId,
        actorId: userId,
        action: "secret.retrieval.rate_claim",
        targetType: "secret_retrieval",
        targetId: bucket,
        metadata: { kind },
      });
      return true;
    }

    const [recentDenials] = await tx
      .select({ value: count() })
      .from(schema.auditLog)
      .where(and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.actorId, userId),
        eq(schema.auditLog.action, "secret.retrieval.rate_limited"),
        eq(schema.auditLog.targetType, "secret_retrieval"),
        eq(schema.auditLog.targetId, bucket),
        gt(schema.auditLog.createdAt, since),
      ));
    await audit(tx, {
      orgId,
      actorId: userId,
      action: "secret.retrieval.rate_limited",
      targetType: "secret_retrieval",
      targetId: bucket,
      metadata: { kind },
    });
    if (Number(recentDenials?.value ?? 0) >= 2) {
      await audit(tx, {
        orgId,
        actorId: userId,
        action: "secret.retrieval.anomaly",
        targetType: "secret_retrieval",
        targetId: bucket,
        metadata: { kind, repeatedRateLimitRefusals: Number(recentDenials?.value ?? 0) + 1 },
      });
    }
    return false;
  });
  if (!allowed) throw new Error(`secret ${bucket} rate limit exceeded`);
}

type PlannedItem = typeof schema.secretRetrievalPlanItems.$inferInsert;

async function planSkillClosure(
  database: Db,
  actor: SecretActorContext,
  orgId: string,
  rootSlug: string,
  rootVersion: string | undefined,
  visited: Set<string>,
  items: PlannedItem[],
) {
  const marker = `${rootSlug}@${rootVersion ?? "current"}`;
  if (visited.has(marker)) return;
  visited.add(marker);
  const { skill, version, slots } = await currentSkillSlots(database, actor, orgId, rootSlug, rootVersion);
  if (!version) throw new Error(`skill ${rootSlug} has no published version`);
  const bindings = await database.select().from(schema.skillSecretBindings).where(and(eq(schema.skillSecretBindings.orgId, orgId), eq(schema.skillSecretBindings.userId, actor.id), eq(schema.skillSecretBindings.skillId, skill.id)));
  const bindingBySlot = new Map(bindings.map((binding) => [binding.slotId, binding]));
  const activeSlotIds = new Set(slots.map((slot) => slot.slotId));
  for (const slot of slots) {
    const binding = bindingBySlot.get(slot.slotId);
    let secret: SecretRecord | null = null;
    if (binding && !binding.revokedAt) {
      try { secret = await assertSecretAccess(database, actor, orgId, binding.secretId); } catch { secret = null; }
    }
    const status = secret ? (secret.ownerId === actor.id ? "personal" as const : "shared" as const) : slot.required ? "required" as const : "optional_missing" as const;
    items.push({
      orgId,
      planId: "00000000-0000-0000-0000-000000000000",
      projectionId: binding?.projectionId ?? randomUUID(),
      skill: skill.slug,
      skillId: skill.id,
      skillVersionId: version.id,
      skillVersion: version.version,
      slotId: slot.slotId,
      envKey: slot.envKey,
      required: slot.required,
      status,
      secretId: secret?.id ?? null,
      secretVersion: secret?.currentVersion ?? null,
      secretName: secret?.name ?? null,
      ownerName: secret?.ownerName ?? null,
      tombstone: Boolean(binding && !secret),
    });
  }
  for (const binding of bindings) {
    if (activeSlotIds.has(binding.slotId)) continue;
    items.push({
      orgId,
      planId: "00000000-0000-0000-0000-000000000000",
      projectionId: binding.projectionId,
      skill: skill.slug,
      skillId: skill.id,
      skillVersionId: version.id,
      skillVersion: version.version,
      slotId: null,
      envKey: "",
      required: false,
      status: "optional_missing",
      secretId: null,
      secretVersion: null,
      secretName: null,
      ownerName: null,
      tombstone: true,
    });
  }
  const deps = await database.select({ targetId: schema.skillVersionDependencies.dependsOnSkillId, targetSlug: schema.skillVersionDependencies.dependsOnSlug }).from(schema.skillVersionDependencies).where(and(eq(schema.skillVersionDependencies.orgId, orgId), eq(schema.skillVersionDependencies.skillVersionId, version.id)));
  for (const dep of deps) {
    const target = dep.targetId ? await database.query.skills.findFirst({ where: and(eq(schema.skills.orgId, orgId), eq(schema.skills.id, dep.targetId)) }) : null;
    await planSkillClosure(database, actor, orgId, target?.slug ?? dep.targetSlug, undefined, visited, items);
  }
}

function preflightFromRows(plan: typeof schema.secretRetrievalPlans.$inferSelect, rows: Array<typeof schema.secretRetrievalPlanItems.$inferSelect>): SecretRetrievalPreflight {
  // An inaccessible binding for a still-active slot is both a tombstone for the old local
  // projection and a configuration blocker/warning. Removed slots are tombstones only.
  const normal = rows.filter((row) => !row.tombstone || row.slotId !== null);
  return {
    plan_id: plan.id,
    operation_id: plan.operationId,
    expires_at: plan.expiresAt.toISOString(),
    items: normal.map((row) => ({
      projection_id: row.projectionId,
      skill: row.skill,
      skill_version: row.skillVersion,
      slot_id: row.slotId,
      env_key: row.envKey,
      required: row.required,
      status: row.status,
      secret_id: row.secretId,
      secret_version: row.secretVersion,
      secret_name: row.secretName,
      owner_name: row.ownerName,
    })),
    tombstones: rows.filter((row) => row.tombstone).map((row) => ({ projection_id: row.projectionId, skill: row.skill })),
    blockers: normal.filter((row) => row.required && !row.secretId).length,
    warnings: normal.filter((row) => !row.required && !row.secretId).length,
  };
}

export async function preflightSecretRetrieval(input: { actor: SecretActorContext; orgId: string; value: SecretRetrievalPreflightInput; database?: Db }): Promise<SecretRetrievalPreflight> {
  const database = input.database ?? db;
  await assertSecretMember(database, input.actor, input.orgId);
  const existing = await database.query.secretRetrievalPlans.findFirst({ where: and(eq(schema.secretRetrievalPlans.orgId, input.orgId), eq(schema.secretRetrievalPlans.userId, input.actor.id), eq(schema.secretRetrievalPlans.operationId, input.value.operation_id)) });
  if (existing && existing.expiresAt > new Date()) {
    const rows = await database.select().from(schema.secretRetrievalPlanItems).where(and(eq(schema.secretRetrievalPlanItems.orgId, input.orgId), eq(schema.secretRetrievalPlanItems.planId, existing.id)));
    return preflightFromRows(existing, rows);
  }
  if (existing) await database.delete(schema.secretRetrievalPlans).where(eq(schema.secretRetrievalPlans.id, existing.id));
  await assertRateLimit(database, input.orgId, input.actor.id, "preflight");
  const planId = randomUUID();
  const items: PlannedItem[] = [];
  const visited = new Set<string>();
  for (const skill of input.value.skills) await planSkillClosure(database, input.actor, input.orgId, skill.slug, skill.version, visited, items);
  for (const direct of input.value.direct) {
    let secret: SecretRecord;
    try {
      secret = await assertSecretAccess(database, input.actor, input.orgId, direct.secret_id);
    } catch (error) {
      await durableAudit({ orgId: input.orgId, actorId: input.actor.id, action: "secret.retrieval.denied", targetType: "secret", targetId: direct.secret_id, metadata: { reason: "preflight_access_denied" } });
      throw error;
    }
    items.push({ orgId: input.orgId, planId, projectionId: randomUUID(), skill: `_manual/${direct.profile}`, skillId: null, skillVersionId: null, skillVersion: null, slotId: null, envKey: direct.env_key, required: true, status: secret.ownerId === input.actor.id ? "personal" : "shared", secretId: secret.id, secretVersion: secret.currentVersion, secretName: secret.name, ownerName: secret.ownerName, tombstone: false });
  }
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS);
  await database.transaction(async (tx) => {
    await tx.insert(schema.secretRetrievalPlans).values({ id: planId, orgId: input.orgId, userId: input.actor.id, operationId: input.value.operation_id, expiresAt });
    if (items.length) await tx.insert(schema.secretRetrievalPlanItems).values(items.map((item) => ({ ...item, planId })));
    await audit(tx as unknown as Db, { orgId: input.orgId, actorId: input.actor.id, action: "secret.retrieval.preflight", targetType: "secret_retrieval_plan", targetId: planId, metadata: { itemCount: items.length, blockerCount: items.filter((item) => item.required && !item.secretId).length } });
  });
  const plan = await database.query.secretRetrievalPlans.findFirst({ where: eq(schema.secretRetrievalPlans.id, planId) });
  const rows = await database.select().from(schema.secretRetrievalPlanItems).where(eq(schema.secretRetrievalPlanItems.planId, planId));
  if (!plan) throw new Error("could not create secret retrieval plan");
  return preflightFromRows(plan, rows);
}

async function planItemsStillAuthorized(database: Db, actor: SecretActorContext, orgId: string, planId: string) {
  const rows = await database.select().from(schema.secretRetrievalPlanItems).where(and(eq(schema.secretRetrievalPlanItems.orgId, orgId), eq(schema.secretRetrievalPlanItems.planId, planId)));
  for (const row of rows) {
    if (!row.secretId || row.tombstone) continue;
    try { await assertSecretAccess(database, actor, orgId, row.secretId); } catch { return { ok: false as const, rows }; }
  }
  return { ok: true as const, rows };
}

export async function createSecretRetrievalGrant(input: { actor: SecretActorContext; orgId: string; planId: string; database?: Db }): Promise<CreateSecretGrantResult> {
  const database = input.database ?? db;
  await assertSecretMember(database, input.actor, input.orgId);
  await assertRateLimit(database, input.orgId, input.actor.id, "grant_create");
  const plan = await database.query.secretRetrievalPlans.findFirst({ where: and(eq(schema.secretRetrievalPlans.id, input.planId), eq(schema.secretRetrievalPlans.orgId, input.orgId), eq(schema.secretRetrievalPlans.userId, input.actor.id), gt(schema.secretRetrievalPlans.expiresAt, new Date())) });
  if (!plan || plan.grantedAt) throw new Error("secret retrieval plan is expired or already granted");
  const authorization = await planItemsStillAuthorized(database, input.actor, input.orgId, plan.id);
  if (!authorization.ok) {
    await durableAudit({ orgId: input.orgId, actorId: input.actor.id, action: "secret.retrieval.denied", targetType: "secret_retrieval_plan", targetId: plan.id, metadata: { reason: "access_changed_before_grant" } });
    throw new Error("secret access changed; run preflight again");
  }
  if (authorization.rows.some((row) => row.required && !row.secretId && row.slotId !== null)) {
    await durableAudit({ orgId: input.orgId, actorId: input.actor.id, action: "secret.retrieval.denied", targetType: "secret_retrieval_plan", targetId: plan.id, metadata: { reason: "required_configuration_missing" } });
    throw new Error("required secret configuration is missing");
  }
  const grant = `cmp_grant_${randomBytes(32).toString("hex")}`;
  const tokenHash = createHash("sha256").update(grant).digest("hex");
  const expiresAt = new Date(Date.now() + GRANT_TTL_MS);
  await database.transaction(async (tx) => {
    const [claimed] = await tx
      .update(schema.secretRetrievalPlans)
      .set({ grantedAt: new Date() })
      .where(and(
        eq(schema.secretRetrievalPlans.id, plan.id),
        eq(schema.secretRetrievalPlans.orgId, input.orgId),
        eq(schema.secretRetrievalPlans.userId, input.actor.id),
        isNull(schema.secretRetrievalPlans.grantedAt),
        gt(schema.secretRetrievalPlans.expiresAt, new Date()),
      ))
      .returning({ id: schema.secretRetrievalPlans.id });
    if (!claimed) throw new Error("secret retrieval plan is expired or already granted");
    await tx.insert(schema.secretRetrievalGrants).values({ orgId: input.orgId, userId: input.actor.id, planId: plan.id, tokenPrefix: grant.slice(0, 18), tokenHash, expiresAt });
    await audit(tx as unknown as Db, { orgId: input.orgId, actorId: input.actor.id, action: "secret.retrieval.grant", targetType: "secret_retrieval_plan", targetId: plan.id, metadata: { itemCount: authorization.rows.filter((row) => row.secretId).length } });
  });
  return { grant, expires_at: expiresAt.toISOString(), item_count: authorization.rows.filter((row) => row.secretId).length };
}

function ciphertextFromRow(row: typeof schema.secretVersions.$inferSelect): SecretCiphertext {
  return { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, wrappedDek: row.wrappedDek, wrapIv: row.wrapIv, wrapAuthTag: row.wrapAuthTag, keyId: row.keyId };
}

export type RedeemSecretGrantResult = { ok: true; value: RedeemedSecretGrant } | { ok: false; error: string };

export async function redeemSecretRetrievalGrant(input: { actor: SecretActorContext; orgId: string; grant: string; database?: Db }): Promise<RedeemSecretGrantResult> {
  const database = input.database ?? db;
  await assertSecretMember(database, input.actor, input.orgId);
  await assertRateLimit(database, input.orgId, input.actor.id, "grant_redeem");
  const tokenHash = createHash("sha256").update(input.grant).digest("hex");
  await audit(database, {
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "secret.retrieval.redeem_attempt",
    targetType: "secret_retrieval_grant",
    targetId: tokenHash.slice(0, 16),
  });
  const claimedAt = new Date();
  const [grant] = await database
    .update(schema.secretRetrievalGrants)
    .set({ redeemedAt: claimedAt })
    .where(and(
      eq(schema.secretRetrievalGrants.orgId, input.orgId),
      eq(schema.secretRetrievalGrants.userId, input.actor.id),
      eq(schema.secretRetrievalGrants.tokenHash, tokenHash),
      isNull(schema.secretRetrievalGrants.redeemedAt),
      isNull(schema.secretRetrievalGrants.failedAt),
      gt(schema.secretRetrievalGrants.expiresAt, claimedAt),
    ))
    .returning();
  if (!grant) {
    await audit(database, { orgId: input.orgId, actorId: input.actor.id, action: "secret.retrieval.denied", targetType: "secret_retrieval_grant", targetId: tokenHash.slice(0, 16), metadata: { reason: "invalid_expired_or_replayed" } });
    return { ok: false, error: "secret grant is invalid, expired, or already used" };
  }
  const plan = await database.query.secretRetrievalPlans.findFirst({ where: and(eq(schema.secretRetrievalPlans.id, grant.planId), eq(schema.secretRetrievalPlans.orgId, input.orgId), eq(schema.secretRetrievalPlans.userId, input.actor.id)) });
  if (!plan) return { ok: false, error: "secret retrieval plan not found" };
  const authorization = await planItemsStillAuthorized(database, input.actor, input.orgId, plan.id);
  if (!authorization.ok) {
    await database.update(schema.secretRetrievalGrants).set({ failedAt: new Date() }).where(eq(schema.secretRetrievalGrants.id, grant.id));
    await audit(database, { orgId: input.orgId, actorId: input.actor.id, action: "secret.retrieval.denied", targetType: "secret_retrieval_plan", targetId: plan.id, metadata: { reason: "access_changed" } });
    return { ok: false, error: "secret access changed; run preflight again" };
  }
  const values: RedeemedSecretGrant["items"] = [];
  try {
    for (const item of authorization.rows) {
      if (!item.secretId || !item.secretVersion || item.tombstone) continue;
      const version = await database.query.secretVersions.findFirst({ where: and(eq(schema.secretVersions.orgId, input.orgId), eq(schema.secretVersions.secretId, item.secretId), eq(schema.secretVersions.version, item.secretVersion)) });
      if (!version) throw new Error("planned secret version is unavailable");
      values.push({ projection_id: item.projectionId, skill: item.skill, skill_version: item.skillVersion, slot_id: item.slotId, env_key: item.envKey, secret_id: item.secretId, secret_version: item.secretVersion, value: decryptSecretValue({ orgId: input.orgId, secretId: item.secretId, version: item.secretVersion, ...ciphertextFromRow(version) }) });
    }
  } catch {
    await database.update(schema.secretRetrievalGrants).set({ failedAt: new Date() }).where(eq(schema.secretRetrievalGrants.id, grant.id));
    await audit(database, { orgId: input.orgId, actorId: input.actor.id, action: "secret.retrieval.denied", targetType: "secret_retrieval_plan", targetId: plan.id, metadata: { reason: "decrypt_or_version_failure" } });
    return { ok: false, error: "secret grant could not be redeemed" };
  }
  await audit(database, { orgId: input.orgId, actorId: input.actor.id, action: "secret.retrieval.redeem", targetType: "secret_retrieval_plan", targetId: plan.id, metadata: { itemCount: values.length, tombstoneCount: authorization.rows.filter((row) => row.tombstone).length } });
  return { ok: true, value: { operation_id: plan.operationId, items: values, tombstones: authorization.rows.filter((row) => row.tombstone).map((row) => ({ projection_id: row.projectionId, skill: row.skill })) } };
}
