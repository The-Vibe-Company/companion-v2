import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type {
  CreateGitHubDestinationInput,
  GitHubIntegrationResponse,
  GitHubSyncDestination,
  GitHubSyncMode,
  UpdateGitHubDestinationInput,
} from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import { canManageOrg } from "./authz";
import { decryptOpaqueValue, encryptOpaqueValue, type OpaqueCiphertext } from "./secretsCrypto";
import { getOrgRole, type ActorContext } from "./services";

const ACCESS_PURPOSE = "github-user-access-token";
const REFRESH_PURPOSE = "github-user-refresh-token";

type DestinationRow = typeof schema.githubSyncDestinations.$inferSelect;
type ConnectionRow = typeof schema.githubConnections.$inferSelect;

function ciphertextFromConnection(row: ConnectionRow, prefix: "access" | "refresh"): OpaqueCiphertext | null {
  const ciphertext = row[`${prefix}Ciphertext`];
  const iv = row[`${prefix}Iv`];
  const authTag = row[`${prefix}AuthTag`];
  const wrappedDek = row[`${prefix}WrappedDek`];
  const wrapIv = row[`${prefix}WrapIv`];
  const wrapAuthTag = row[`${prefix}WrapAuthTag`];
  const keyId = row[`${prefix}KeyId`];
  if (!ciphertext || !iv || !authTag || !wrappedDek || !wrapIv || !wrapAuthTag || !keyId) return null;
  return { ciphertext, iv, authTag, wrappedDek, wrapIv, wrapAuthTag, keyId };
}

async function assertGitHubAdmin(database: Db, actor: ActorContext, orgId: string): Promise<void> {
  const role = await getOrgRole(orgId, actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to manage GitHub synchronization");
}

async function lockGitHubLifecycle(database: Db, orgId: string): Promise<void> {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:github:${orgId}`}))`);
}

async function lockGitHubConnection(database: Db, orgId: string): Promise<ConnectionRow> {
  await lockGitHubLifecycle(database, orgId);
  const [connection] = await database.select().from(schema.githubConnections)
    .where(eq(schema.githubConnections.orgId, orgId)).limit(1).for("update");
  if (!connection) throw new Error("GitHub is not connected");
  return connection;
}

function destinationContract(row: DestinationRow, selectedSkillIds: string[]): GitHubSyncDestination {
  return {
    id: row.id,
    installation_id: row.installationId,
    repository_id: row.repositoryId,
    owner: row.owner,
    name: row.name,
    full_name: `${row.owner}/${row.name}`,
    html_url: row.htmlUrl,
    default_branch: row.defaultBranch,
    private: row.private,
    mode: row.mode,
    selected_skill_ids: selectedSkillIds,
    resolved_skill_count: row.resolvedSkillCount,
    status: row.status,
    desired_revision: row.desiredRevision,
    applied_revision: row.appliedRevision,
    last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
    last_commit_sha: row.lastCommitSha,
    last_error: row.lastError,
    next_retry_at: row.nextRetryAt?.toISOString() ?? null,
  };
}

export async function getGitHubIntegration(input: {
  actor: ActorContext;
  orgId: string;
  configured: boolean;
  appSlug: string | null;
  appName: string;
  managed: boolean;
  database?: Db;
}): Promise<GitHubIntegrationResponse> {
  const database = input.database ?? db;
  await assertGitHubAdmin(database, input.actor, input.orgId);
  const [connection, destinations, selections] = await Promise.all([
    database.query.githubConnections.findFirst({ where: eq(schema.githubConnections.orgId, input.orgId) }),
    database.select().from(schema.githubSyncDestinations)
      .where(eq(schema.githubSyncDestinations.orgId, input.orgId))
      .orderBy(asc(schema.githubSyncDestinations.createdAt)),
    database.select().from(schema.githubSyncDestinationSkills)
      .where(eq(schema.githubSyncDestinationSkills.orgId, input.orgId)),
  ]);
  const selectedByDestination = new Map<string, string[]>();
  for (const selection of selections) {
    selectedByDestination.set(selection.destinationId, [
      ...(selectedByDestination.get(selection.destinationId) ?? []),
      selection.skillId,
    ]);
  }
  return {
    connection: {
      configured: input.configured,
      app_slug: input.appSlug,
      app_name: input.appName,
      managed: input.managed,
      connected: Boolean(connection),
      github_login: connection?.githubLogin ?? null,
      github_avatar_url: connection?.githubAvatarUrl ?? null,
      connected_at: connection?.createdAt.toISOString() ?? null,
    },
    destinations: destinations.map((row) => destinationContract(row, selectedByDestination.get(row.id) ?? [])),
  };
}

export async function saveGitHubConnection(input: {
  actor: ActorContext;
  orgId: string;
  githubUserId: string;
  githubLogin: string;
  githubAvatarUrl?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  accessExpiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
  masterKey?: Buffer;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertGitHubAdmin(database, input.actor, input.orgId);
  await database.transaction(async (tx) => {
    await lockGitHubLifecycle(tx as unknown as Db, input.orgId);
    const [existing] = await tx.select().from(schema.githubConnections)
      .where(eq(schema.githubConnections.orgId, input.orgId)).limit(1).for("update");
    const credentialGeneration = randomUUID();
    const credentialVersion = (existing?.credentialVersion ?? 0) + 1;
    const access = encryptOpaqueValue({
      orgId: input.orgId,
      purpose: ACCESS_PURPOSE,
      subjectId: `${input.orgId}:${credentialGeneration}`,
      value: input.accessToken,
    }, input.masterKey);
    const refresh = input.refreshToken ? encryptOpaqueValue({
      orgId: input.orgId,
      purpose: REFRESH_PURPOSE,
      subjectId: `${input.orgId}:${credentialGeneration}`,
      value: input.refreshToken,
    }, input.masterKey) : null;
    const accessColumns = {
      accessCiphertext: access.ciphertext,
      accessIv: access.iv,
      accessAuthTag: access.authTag,
      accessWrappedDek: access.wrappedDek,
      accessWrapIv: access.wrapIv,
      accessWrapAuthTag: access.wrapAuthTag,
      accessKeyId: access.keyId,
    };
    const refreshColumns = refresh ? {
      refreshCiphertext: refresh.ciphertext,
      refreshIv: refresh.iv,
      refreshAuthTag: refresh.authTag,
      refreshWrappedDek: refresh.wrappedDek,
      refreshWrapIv: refresh.wrapIv,
      refreshWrapAuthTag: refresh.wrapAuthTag,
      refreshKeyId: refresh.keyId,
    } : {
      refreshCiphertext: null, refreshIv: null, refreshAuthTag: null, refreshWrappedDek: null,
      refreshWrapIv: null, refreshWrapAuthTag: null, refreshKeyId: null,
    };
    await tx.insert(schema.githubConnections).values({
      orgId: input.orgId,
      githubUserId: input.githubUserId,
      githubLogin: input.githubLogin,
      githubAvatarUrl: input.githubAvatarUrl ?? null,
      credentialGeneration,
      credentialVersion,
      ...accessColumns,
      ...refreshColumns,
      accessExpiresAt: input.accessExpiresAt ?? null,
      refreshExpiresAt: input.refreshExpiresAt ?? null,
      connectedBy: input.actor.id,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: schema.githubConnections.orgId,
      set: {
        githubUserId: input.githubUserId, githubLogin: input.githubLogin,
        githubAvatarUrl: input.githubAvatarUrl ?? null, credentialGeneration, credentialVersion,
        ...accessColumns,
        ...refreshColumns,
        accessExpiresAt: input.accessExpiresAt ?? null, refreshExpiresAt: input.refreshExpiresAt ?? null,
        connectedBy: input.actor.id, updatedAt: new Date(),
      },
    });
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId, actorId: input.actor.id, action: "github.account.connected",
      targetType: "github_account", targetId: input.githubUserId, metadata: { login: input.githubLogin },
    });
  });
}

export async function getGitHubUserCredential(input: {
  actor: ActorContext;
  orgId: string;
  masterKey?: Buffer;
  database?: Db;
}): Promise<{
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  credentialGeneration: string;
  credentialVersion: number;
}> {
  const database = input.database ?? db;
  await assertGitHubAdmin(database, input.actor, input.orgId);
  const row = await database.query.githubConnections.findFirst({ where: eq(schema.githubConnections.orgId, input.orgId) });
  if (!row) throw new Error("GitHub is not connected");
  const access = ciphertextFromConnection(row, "access");
  if (!access) throw new Error("GitHub credential is unavailable");
  const subjectId = `${input.orgId}:${row.credentialGeneration}`;
  const refresh = ciphertextFromConnection(row, "refresh");
  return {
    accessToken: decryptOpaqueValue({ orgId: input.orgId, purpose: ACCESS_PURPOSE, subjectId, ...access }, input.masterKey),
    refreshToken: refresh
      ? decryptOpaqueValue({ orgId: input.orgId, purpose: REFRESH_PURPOSE, subjectId, ...refresh }, input.masterKey)
      : null,
    accessExpiresAt: row.accessExpiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    credentialGeneration: row.credentialGeneration,
    credentialVersion: row.credentialVersion,
  };
}

/**
 * Persist one user-token refresh only if the exact encrypted credential generation is still live.
 * This is intentionally update-only: a refresh can never recreate a connection after disconnect.
 */
export async function refreshGitHubConnectionCredential(input: {
  actor: ActorContext;
  orgId: string;
  expectedCredentialGeneration: string;
  expectedCredentialVersion: number;
  accessToken: string;
  refreshToken?: string | null;
  accessExpiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
  masterKey?: Buffer;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  await assertGitHubAdmin(database, input.actor, input.orgId);
  const credentialGeneration = randomUUID();
  const credentialVersion = input.expectedCredentialVersion + 1;
  const access = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: ACCESS_PURPOSE,
    subjectId: `${input.orgId}:${credentialGeneration}`,
    value: input.accessToken,
  }, input.masterKey);
  const refresh = input.refreshToken ? encryptOpaqueValue({
    orgId: input.orgId,
    purpose: REFRESH_PURPOSE,
    subjectId: `${input.orgId}:${credentialGeneration}`,
    value: input.refreshToken,
  }, input.masterKey) : null;
  const [updated] = await database.update(schema.githubConnections).set({
    credentialGeneration,
    credentialVersion,
    accessCiphertext: access.ciphertext,
    accessIv: access.iv,
    accessAuthTag: access.authTag,
    accessWrappedDek: access.wrappedDek,
    accessWrapIv: access.wrapIv,
    accessWrapAuthTag: access.wrapAuthTag,
    accessKeyId: access.keyId,
    refreshCiphertext: refresh?.ciphertext ?? null,
    refreshIv: refresh?.iv ?? null,
    refreshAuthTag: refresh?.authTag ?? null,
    refreshWrappedDek: refresh?.wrappedDek ?? null,
    refreshWrapIv: refresh?.wrapIv ?? null,
    refreshWrapAuthTag: refresh?.wrapAuthTag ?? null,
    refreshKeyId: refresh?.keyId ?? null,
    accessExpiresAt: input.accessExpiresAt ?? null,
    refreshExpiresAt: input.refreshExpiresAt ?? null,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.githubConnections.orgId, input.orgId),
    eq(schema.githubConnections.credentialGeneration, input.expectedCredentialGeneration),
    eq(schema.githubConnections.credentialVersion, input.expectedCredentialVersion),
  )).returning({ orgId: schema.githubConnections.orgId });
  return Boolean(updated);
}

export async function deleteGitHubConnection(input: {
  actor: ActorContext;
  orgId: string;
  revokeAccessToken: (accessToken: string) => Promise<void>;
  masterKey?: Buffer;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertGitHubAdmin(database, input.actor, input.orgId);
  await database.transaction(async (tx) => {
    await lockGitHubLifecycle(tx as unknown as Db, input.orgId);
    const [connection] = await tx.select().from(schema.githubConnections)
      .where(eq(schema.githubConnections.orgId, input.orgId)).limit(1).for("update");
    await tx.update(schema.githubSyncDestinations).set({
      status: "disconnected", leaseOwner: null, leaseUntil: null, nextRetryAt: null, updatedAt: new Date(),
    }).where(eq(schema.githubSyncDestinations.orgId, input.orgId));
    if (connection) {
      const access = ciphertextFromConnection(connection, "access");
      if (!access) throw new Error("GitHub credential is unavailable");
      await input.revokeAccessToken(decryptOpaqueValue({
        orgId: input.orgId,
        purpose: ACCESS_PURPOSE,
        subjectId: `${input.orgId}:${connection.credentialGeneration}`,
        ...access,
      }, input.masterKey));
    }
    await tx.delete(schema.githubConnections).where(eq(schema.githubConnections.orgId, input.orgId));
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId, actorId: input.actor.id, action: "github.account.disconnected",
      targetType: "github_account", targetId: input.orgId,
    });
  });
}

async function validateSelectedSkills(database: Db, orgId: string, mode: GitHubSyncMode, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (mode === "selected" && unique.length === 0) throw new Error("select at least one organization skill");
  if (unique.length === 0) return unique;
  const rows = await database.select({ id: schema.skills.id }).from(schema.skills).where(and(
    eq(schema.skills.orgId, orgId), eq(schema.skills.scope, "org"), inArray(schema.skills.id, unique),
  ));
  if (rows.length !== unique.length) throw new Error("one or more selected skills are unavailable");
  return unique;
}

async function replaceSelections(database: Db, orgId: string, destinationId: string, ids: string[]): Promise<void> {
  await database.delete(schema.githubSyncDestinationSkills).where(and(
    eq(schema.githubSyncDestinationSkills.orgId, orgId),
    eq(schema.githubSyncDestinationSkills.destinationId, destinationId),
  ));
  if (ids.length) await database.insert(schema.githubSyncDestinationSkills).values(
    ids.map((skillId) => ({ orgId, destinationId, skillId })),
  );
}

export async function createGitHubDestination(input: {
  actor: ActorContext;
  orgId: string;
  destination: CreateGitHubDestinationInput;
  database?: Db;
}): Promise<string> {
  const database = input.database ?? db;
  await assertGitHubAdmin(database, input.actor, input.orgId);
  const selected = await validateSelectedSkills(database, input.orgId, input.destination.mode, input.destination.selected_skill_ids);
  const id = randomUUID();
  try {
    await database.transaction(async (tx) => {
      await lockGitHubConnection(tx as unknown as Db, input.orgId);
      await tx.insert(schema.githubSyncDestinations).values({
        id, orgId: input.orgId, installationId: input.destination.installation_id,
        repositoryId: input.destination.repository_id, owner: input.destination.owner,
        name: input.destination.name, htmlUrl: input.destination.html_url,
        defaultBranch: input.destination.default_branch, private: input.destination.private,
        mode: input.destination.mode, createdBy: input.actor.id, updatedBy: input.actor.id,
      });
      await replaceSelections(tx as unknown as Db, input.orgId, id, selected);
      await tx.insert(schema.auditLog).values({
        orgId: input.orgId, actorId: input.actor.id, action: "github.destination.created",
        targetType: "github_destination", targetId: id,
        metadata: { repository: `${input.destination.owner}/${input.destination.name}`, mode: input.destination.mode },
      });
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
      throw new Error("this GitHub repository is already managed by Companion");
    }
    throw error;
  }
  return id;
}

export async function updateGitHubDestination(input: {
  actor: ActorContext; orgId: string; destinationId: string; patch: UpdateGitHubDestinationInput; database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertGitHubAdmin(database, input.actor, input.orgId);
  const selected = await validateSelectedSkills(database, input.orgId, input.patch.mode, input.patch.selected_skill_ids);
  await database.transaction(async (tx) => {
    await lockGitHubConnection(tx as unknown as Db, input.orgId);
    const [updated] = await tx.update(schema.githubSyncDestinations).set({
      mode: input.patch.mode,
      status: sql`CASE WHEN ${schema.githubSyncDestinations.status} = 'syncing'::github_sync_status THEN 'syncing'::github_sync_status ELSE 'pending'::github_sync_status END`,
      desiredRevision: sql`${schema.githubSyncDestinations.desiredRevision} + 1`,
      nextRetryAt: null, lastError: null, updatedBy: input.actor.id, updatedAt: new Date(),
    }).where(and(
      eq(schema.githubSyncDestinations.orgId, input.orgId),
      eq(schema.githubSyncDestinations.id, input.destinationId),
      sql`${schema.githubSyncDestinations.status} <> 'disconnected'::github_sync_status`,
    ))
      .returning({ id: schema.githubSyncDestinations.id });
    if (!updated) throw new Error("GitHub destination is disconnected or unavailable");
    await replaceSelections(tx as unknown as Db, input.orgId, input.destinationId, selected);
  });
}

export async function requestGitHubDestinationSync(input: {
  actor: ActorContext; orgId: string; destinationId: string; resumeDisconnected?: boolean; database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertGitHubAdmin(database, input.actor, input.orgId);
  await database.transaction(async (tx) => {
    await lockGitHubConnection(tx as unknown as Db, input.orgId);
    const [updated] = await tx.update(schema.githubSyncDestinations).set({
      desiredRevision: sql`${schema.githubSyncDestinations.desiredRevision} + 1`,
      status: sql`CASE WHEN ${schema.githubSyncDestinations.status} = 'syncing'::github_sync_status THEN 'syncing'::github_sync_status ELSE 'pending'::github_sync_status END`,
      nextRetryAt: null, lastError: null, updatedBy: input.actor.id, updatedAt: new Date(),
    }).where(and(
      eq(schema.githubSyncDestinations.orgId, input.orgId),
      eq(schema.githubSyncDestinations.id, input.destinationId),
      input.resumeDisconnected
        ? eq(schema.githubSyncDestinations.status, "disconnected")
        : sql`${schema.githubSyncDestinations.status} <> 'disconnected'::github_sync_status`,
    )).returning({ id: schema.githubSyncDestinations.id });
    if (!updated) throw new Error(input.resumeDisconnected
      ? "GitHub destination is not available to resume"
      : "GitHub destination is disconnected or unavailable");
  });
}

export async function deleteGitHubDestination(input: {
  actor: ActorContext; orgId: string; destinationId: string; database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertGitHubAdmin(database, input.actor, input.orgId);
  const [deleted] = await database.delete(schema.githubSyncDestinations).where(and(
    eq(schema.githubSyncDestinations.orgId, input.orgId), eq(schema.githubSyncDestinations.id, input.destinationId),
  )).returning({ id: schema.githubSyncDestinations.id, repository: schema.githubSyncDestinations.repositoryId });
  if (!deleted) throw new Error("GitHub destination not found");
  await database.insert(schema.auditLog).values({
    orgId: input.orgId, actorId: input.actor.id, action: "github.destination.disconnected",
    targetType: "github_destination", targetId: deleted.id, metadata: { repository_id: deleted.repository },
  });
}

/** Called in the same transaction as org-skill mutations. Coalesces every affected repo. */
export async function enqueueOrgGitHubSync(orgId: string, database: Db): Promise<void> {
  await database.update(schema.githubSyncDestinations).set({
    desiredRevision: sql`${schema.githubSyncDestinations.desiredRevision} + 1`,
    status: sql`CASE WHEN ${schema.githubSyncDestinations.status} = 'syncing'::github_sync_status THEN 'syncing'::github_sync_status ELSE 'pending'::github_sync_status END`,
    nextRetryAt: null, updatedAt: new Date(),
  }).where(and(eq(schema.githubSyncDestinations.orgId, orgId), sql`${schema.githubSyncDestinations.status} <> 'disconnected'`));
}

export interface ClaimedGitHubDestination {
  orgId: string;
  destinationId: string;
  claimedRevision: number;
  leaseGeneration: number;
}

export interface GitHubSyncFence {
  orgId: string;
  destinationId: string;
  workerId: string;
  claimedRevision: number;
  leaseGeneration: number;
}

export async function claimGitHubSyncDestinations(input: {
  workerId: string; limit?: number; leaseSeconds?: number; database?: Db;
}): Promise<ClaimedGitHubDestination[]> {
  const database = input.database ?? db;
  const result = await database.execute(sql<{
    org_id: string; destination_id: string; claimed_revision: number; lease_generation: number;
  }>`select * from companion_claim_github_sync_destinations(${input.workerId}, ${input.limit ?? 5}, ${input.leaseSeconds ?? 300})`);
  return result.map((row) => ({
    orgId: String(row.org_id), destinationId: String(row.destination_id), claimedRevision: Number(row.claimed_revision),
    leaseGeneration: Number(row.lease_generation),
  }));
}

export interface GitHubSyncSkill {
  id: string; slug: string; version: string; checksum: string; storagePath: string;
}

export interface GitHubSyncGraphSkill extends GitHubSyncSkill {
  archived: boolean;
  dependencies: Array<{ slug: string; skillId: string | null }>;
}

/** Pure selected-root + live dependency closure. Archived explicit roots are temporarily omitted. */
export function resolveGitHubSkillClosure(input: {
  mode: GitHubSyncMode;
  selectedSkillIds: string[];
  skills: GitHubSyncGraphSkill[];
}): GitHubSyncSkill[] {
  const active = new Map(input.skills.filter((skill) => !skill.archived).map((skill) => [skill.id, skill]));
  const activeBySlug = new Map([...active.values()].map((skill) => [skill.slug, skill]));
  const rootIds = input.mode === "all"
    ? [...active.keys()]
    : input.selectedSkillIds.filter((id) => active.has(id));
  const resultIds = new Set(rootIds);
  const queue = [...rootIds];
  while (queue.length) {
    const skill = active.get(queue.shift()!)!;
    for (const dependency of skill.dependencies) {
      const target = dependency.skillId ? active.get(dependency.skillId) : activeBySlug.get(dependency.slug);
      if (!target) throw new Error(`dependency ${dependency.slug} is missing or archived`);
      if (!resultIds.has(target.id)) {
        resultIds.add(target.id);
        queue.push(target.id);
      }
    }
  }
  return [...resultIds].map((id) => active.get(id)!).map(({ archived: _archived, dependencies: _dependencies, ...skill }) => skill)
    .sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

export async function getGitHubSyncPlan(input: {
  orgId: string; destinationId: string; workerId: string; claimedRevision: number;
  leaseGeneration: number; database?: Db;
}): Promise<{ destination: DestinationRow; skills: GitHubSyncSkill[] }> {
  const database = input.database ?? db;
  const [destination] = await database.select().from(schema.githubSyncDestinations).where(and(
    eq(schema.githubSyncDestinations.orgId, input.orgId),
    eq(schema.githubSyncDestinations.id, input.destinationId),
    eq(schema.githubSyncDestinations.status, "syncing"),
    eq(schema.githubSyncDestinations.leaseOwner, input.workerId),
    eq(schema.githubSyncDestinations.leaseGeneration, input.leaseGeneration),
    eq(schema.githubSyncDestinations.desiredRevision, input.claimedRevision),
    sql`${schema.githubSyncDestinations.leaseUntil} > statement_timestamp()`,
    sql`EXISTS (
      SELECT 1 FROM ${schema.githubConnections}
      WHERE ${schema.githubConnections.orgId} = ${input.orgId}
    )`,
  )).limit(1);
  if (!destination) throw new Error("GitHub destination lease was lost");
  const rows = await database.select({
    id: schema.skills.id, slug: schema.skills.slug, archivedAt: schema.skills.archivedAt,
    versionId: schema.skillVersions.id, version: schema.skillVersions.version,
    checksum: schema.skillVersions.checksum, storagePath: schema.skillVersions.storagePath,
  }).from(schema.skills).leftJoin(schema.skillVersions, and(
    eq(schema.skillVersions.orgId, schema.skills.orgId), eq(schema.skillVersions.id, schema.skills.currentVersionId),
  )).where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.scope, "org")));
  const selectedRows = destination.mode === "selected"
    ? await database.select({ skillId: schema.githubSyncDestinationSkills.skillId }).from(schema.githubSyncDestinationSkills).where(and(
      eq(schema.githubSyncDestinationSkills.orgId, input.orgId),
      eq(schema.githubSyncDestinationSkills.destinationId, destination.id),
    ))
    : [];
  const versionIds = rows.flatMap((row) => row.versionId ? [row.versionId] : []);
  const dependencyRows = versionIds.length ? await database.select({
    versionId: schema.skillVersionDependencies.skillVersionId,
    slug: schema.skillVersionDependencies.dependsOnSlug,
    skillId: schema.skillVersionDependencies.dependsOnSkillId,
  }).from(schema.skillVersionDependencies).where(and(
    eq(schema.skillVersionDependencies.orgId, input.orgId),
    inArray(schema.skillVersionDependencies.skillVersionId, versionIds),
  )) : [];
  const dependenciesByVersion = new Map<string, Array<{ slug: string; skillId: string | null }>>();
  for (const dependency of dependencyRows) {
    dependenciesByVersion.set(dependency.versionId, [
      ...(dependenciesByVersion.get(dependency.versionId) ?? []),
      { slug: dependency.slug, skillId: dependency.skillId },
    ]);
  }
  const graph = rows.flatMap((row): GitHubSyncGraphSkill[] => row.versionId && row.version && row.checksum && row.storagePath ? [{
    id: row.id,
    slug: row.slug,
    version: row.version,
    checksum: row.checksum,
    storagePath: row.storagePath,
    archived: Boolean(row.archivedAt),
    dependencies: dependenciesByVersion.get(row.versionId) ?? [],
  }] : []);
  const skills = resolveGitHubSkillClosure({
    mode: destination.mode,
    selectedSkillIds: selectedRows.map((row) => row.skillId),
    skills: graph,
  });
  return { destination, skills };
}

/** Cheap, lock-free revalidation used after preparing a mirror and before opening the publish transaction. */
export async function isGitHubSyncFenceLive(input: GitHubSyncFence & { database?: Db }): Promise<boolean> {
  const database = input.database ?? db;
  const [destination] = await database.select({ id: schema.githubSyncDestinations.id })
    .from(schema.githubSyncDestinations)
    .where(and(
      eq(schema.githubSyncDestinations.orgId, input.orgId),
      eq(schema.githubSyncDestinations.id, input.destinationId),
      eq(schema.githubSyncDestinations.status, "syncing"),
      eq(schema.githubSyncDestinations.leaseOwner, input.workerId),
      eq(schema.githubSyncDestinations.leaseGeneration, input.leaseGeneration),
      eq(schema.githubSyncDestinations.desiredRevision, input.claimedRevision),
      sql`${schema.githubSyncDestinations.leaseUntil} > statement_timestamp()`,
      sql`EXISTS (
        SELECT 1 FROM ${schema.githubConnections}
        WHERE ${schema.githubConnections.orgId} = ${input.orgId}
      )`,
    ))
    .limit(1);
  return Boolean(destination);
}

/**
 * Serializes the final remote write with connect/disconnect and destination changes.
 * The caller must keep this transaction open through the GitHub write and fenced completion.
 */
export async function lockGitHubSyncPublishFence(input: GitHubSyncFence & { database: Db }): Promise<void> {
  await lockGitHubConnection(input.database, input.orgId);
  const [destination] = await input.database.select({ id: schema.githubSyncDestinations.id })
    .from(schema.githubSyncDestinations)
    .where(and(
      eq(schema.githubSyncDestinations.orgId, input.orgId),
      eq(schema.githubSyncDestinations.id, input.destinationId),
      eq(schema.githubSyncDestinations.status, "syncing"),
      eq(schema.githubSyncDestinations.leaseOwner, input.workerId),
      eq(schema.githubSyncDestinations.leaseGeneration, input.leaseGeneration),
      eq(schema.githubSyncDestinations.desiredRevision, input.claimedRevision),
      sql`${schema.githubSyncDestinations.leaseUntil} > statement_timestamp()`,
    ))
    .limit(1)
    .for("update");
  if (!destination) throw new Error("GitHub synchronization publish fence was lost");
}

export async function completeGitHubSync(input: {
  orgId: string; destinationId: string; workerId: string; claimedRevision: number; leaseGeneration: number;
  commitSha: string | null; branch: string; skillCount: number; database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const now = new Date();
  const [updated] = await database.update(schema.githubSyncDestinations).set({
    appliedRevision: input.claimedRevision, status: "synced",
    resolvedSkillCount: input.skillCount, lastSyncedAt: now, lastObservedAt: now,
    defaultBranch: input.branch, lastCommitSha: input.commitSha, lastError: null, attempts: 0, nextRetryAt: null,
    leaseOwner: null, leaseUntil: null, updatedAt: now,
  }).where(and(
    eq(schema.githubSyncDestinations.orgId, input.orgId), eq(schema.githubSyncDestinations.id, input.destinationId),
    eq(schema.githubSyncDestinations.status, "syncing"),
    eq(schema.githubSyncDestinations.leaseOwner, input.workerId),
    eq(schema.githubSyncDestinations.leaseGeneration, input.leaseGeneration),
    eq(schema.githubSyncDestinations.desiredRevision, input.claimedRevision),
    sql`${schema.githubSyncDestinations.leaseUntil} > transaction_timestamp()`,
  )).returning({ id: schema.githubSyncDestinations.id });
  return Boolean(updated);
}

export async function failGitHubSync(input: {
  orgId: string; destinationId: string; workerId: string; claimedRevision: number;
  leaseGeneration: number; error: string; database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const [updated] = await database.update(schema.githubSyncDestinations).set({
    status: sql`CASE
      WHEN ${schema.githubSyncDestinations.desiredRevision} > ${input.claimedRevision}
        THEN 'pending'::github_sync_status
      ELSE 'error'::github_sync_status
    END`,
    attempts: sql`CASE
      WHEN ${schema.githubSyncDestinations.desiredRevision} > ${input.claimedRevision}
        THEN ${schema.githubSyncDestinations.attempts}
      ELSE ${schema.githubSyncDestinations.attempts} + 1
    END`,
    lastError: sql`CASE
      WHEN ${schema.githubSyncDestinations.desiredRevision} > ${input.claimedRevision}
        THEN NULL
      ELSE ${input.error.slice(0, 1000)}
    END`,
    nextRetryAt: sql`CASE
      WHEN ${schema.githubSyncDestinations.desiredRevision} > ${input.claimedRevision}
        THEN NULL
      ELSE statement_timestamp() + make_interval(secs => LEAST(
        900,
        15 * CAST(power(2, LEAST(GREATEST(${schema.githubSyncDestinations.attempts}, 0), 6)) AS integer)
      ))
    END`,
    leaseOwner: null, leaseUntil: null, updatedAt: sql`statement_timestamp()`,
  }).where(and(
    eq(schema.githubSyncDestinations.orgId, input.orgId),
    eq(schema.githubSyncDestinations.id, input.destinationId),
    eq(schema.githubSyncDestinations.status, "syncing"),
    eq(schema.githubSyncDestinations.leaseOwner, input.workerId),
    eq(schema.githubSyncDestinations.leaseGeneration, input.leaseGeneration),
    sql`${schema.githubSyncDestinations.leaseUntil} > statement_timestamp()`,
    sql`${schema.githubSyncDestinations.desiredRevision} >= ${input.claimedRevision}`,
  ))
    .returning({ id: schema.githubSyncDestinations.id });
  return Boolean(updated);
}

export function githubRetryDelayMs(attempts: number): number {
  return Math.min(15 * 60_000, 15_000 * 2 ** Math.min(Math.max(0, attempts - 1), 6));
}
