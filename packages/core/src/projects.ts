import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, max, or, sql } from "drizzle-orm";
import {
  PROJECT_ATTACHMENT_MAX_BYTES,
  PROJECT_ATTACHMENT_MAX_FILES,
  PROJECT_NAME_MAX,
  PROJECT_SESSION_TITLE_MAX,
  projectSessionEventSchema,
  projectTranscriptSchema,
  type CreateProjectInput,
  type ListProjectSessionsQuery,
  type ProjectAccessModelConnection,
  type ProjectAccessSecret,
  type ProjectDetail,
  type ProjectEventEnvelope,
  type ProjectFileDownload,
  type ProjectFileRow,
  type ProjectFileVersionRow,
  type ProjectPromptRow,
  type ProjectRow,
  type ProjectSessionDetail,
  type ProjectSessionRow,
  type ProjectSessionsResponse,
  type ProjectSkill,
  type SetProjectSkillsInput,
  type UpdateProjectInput,
  type UpdateProjectSessionInput,
} from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import { canAccessProject, canAccessSkill } from "./authz";
import {
  admitProjectPromptUsage,
  reserveProjectActivationUsage,
  type ProjectUsageAdmission,
} from "./billing";
import { deterministicAgentMessageId } from "./messageIds";
import {
  isManagedProjectFilePath,
  isProjectControlPlaneEnvKey,
  isProjectSessionProviderAdmitted,
  loadEffectiveProjectProviderKeys,
} from "./projectJobs";
import { listSecrets } from "./secrets";
import { resolveRunDependencyClosure } from "./skillRuns";
import { assertMember, type ActorContext } from "./services";

type ProjectRecord = typeof schema.projects.$inferSelect;
type ProjectWorkspaceRecord = typeof schema.projectWorkspaces.$inferSelect;
type ProjectSessionRecord = typeof schema.projectSessions.$inferSelect;

export interface CreateProjectAttachment {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  storageKey: string;
  workspacePath: string;
}

export interface CreateProjectFileUpload {
  path: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  storageKey: string;
}

export class ProjectNotFoundError extends Error {
  constructor(message = "project not found") {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectConflictError extends Error {
  constructor(message = "the project changed; reload it and try again") {
    super(message);
    this.name = "ProjectConflictError";
  }
}

export class ProjectValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "invalid_project") {
    super(message);
    this.name = "ProjectValidationError";
    this.code = code;
  }
}

export function sandboxNameForProject(projectId: string): string {
  return `project-${projectId.toLowerCase()}`;
}

export function deriveProjectSessionTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const normalized = (firstLine || "New session").replace(/\s+/g, " ");
  return Array.from(normalized).slice(0, PROJECT_SESSION_TITLE_MAX).join("");
}

function modelCredentialEnvKeysSnapshot(values: string[]): string[] {
  const keys = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  if (
    keys.length > 16
    || keys.some(
      (key) =>
        key.length > 120
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
        || isProjectControlPlaneEnvKey(key),
    )
  ) {
    throw new ProjectValidationError(
      "the selected model has an invalid credential declaration",
      "model_unavailable",
    );
  }
  return keys;
}

export function reopenedProjectSessionState(input: {
  isWorking: boolean;
  hasActivePrompt: boolean;
}): {
  status: "working" | "queued";
  stopRequestedAt: null;
  errorCode: null;
  userMessage: null;
} {
  return {
    status: input.isWorking || input.hasActivePrompt ? "working" : "queued",
    stopRequestedAt: null,
    errorCode: null,
    userMessage: null,
  };
}

function projectPayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeName(value: string): string {
  return Array.from(value.trim()).slice(0, PROJECT_NAME_MAX).join("");
}

function assertProjectAcceptsWork(project: ProjectRecord): void {
  if (project.archivedAt) {
    throw new ProjectConflictError("restore this project before starting new work");
  }
}

function assertSessionAcceptsWork(session: ProjectSessionRecord): void {
  if (session.archivedAt) {
    throw new ProjectConflictError("restore this conversation before continuing");
  }
}

/**
 * A cold provider gate can outlive the connection change that made a session admissible (for
 * example when the connect signal raced an earlier worker write). Prompt admission already holds
 * the workspace row lock; reopen only that pre-exposure state and leave warm runtimes to the
 * provider recycle fence.
 */
async function reopenColdProviderGateForSession(input: {
  orgId: string;
  projectId: string;
  creatorId: string;
  session: Pick<
    ProjectSessionRecord,
    "modelProvider" | "modelCredentialEnvKeys"
  >;
  database: Db;
  now: Date;
}): Promise<void> {
  const effectiveProviderKeys = await loadEffectiveProjectProviderKeys({
    database: input.database,
    orgId: input.orgId,
    creatorId: input.creatorId,
  });
  if (
    !isProjectSessionProviderAdmitted({
      modelProvider: input.session.modelProvider,
      modelCredentialEnvKeys: input.session.modelCredentialEnvKeys,
      effectiveProviderKeys,
    })
  ) {
    return;
  }
  await input.database
    .update(schema.projectWorkspaces)
    .set({
      status: "queued",
      recycleRequestedAt: null,
      recycleReason: null,
      attempt: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      availableAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(schema.projectWorkspaces.orgId, input.orgId),
        eq(schema.projectWorkspaces.projectId, input.projectId),
        eq(schema.projectWorkspaces.creatorId, input.creatorId),
        eq(
          schema.projectWorkspaces.lastErrorCode,
          "project_provider_unavailable",
        ),
        isNull(schema.projectWorkspaces.environmentExposureAttemptedAt),
      ),
    );
}

function projectCreatePayloadHash(value: CreateProjectInput): string {
  return projectPayloadHash({
    name: safeName(value.name),
    default_model: value.default_model,
    skill_slugs: [...value.skill_slugs].sort(),
  });
}

const PROJECT_CREATE_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function assertValidProjectCreateIdempotencyKey(value: string): void {
  if (
    value.length < 8
    || value.length > 200
    || !PROJECT_CREATE_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw new ProjectValidationError(
      "a valid Idempotency-Key header is required",
      "invalid_idempotency_key",
    );
  }
}

/** A Project has one filesystem projection, so one skill cannot resolve to two versions. */
export function assertCompatibleProjectSkillClosure(
  items: Array<{ skill_id: string; skill_version_id: string }>,
): void {
  const versionBySkill = new Map<string, string>();
  for (const item of items) {
    const existing = versionBySkill.get(item.skill_id);
    if (existing && existing !== item.skill_version_id) {
      throw new ProjectValidationError(
        "selected skills require incompatible versions of the same dependency",
        "skill_dependency_version_conflict",
      );
    }
    versionBySkill.set(item.skill_id, item.skill_version_id);
  }
}

async function loadOwnedProject(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  database: Db;
  lock?: boolean;
}): Promise<ProjectRecord> {
  const query = input.database
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.orgId, input.orgId),
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.creatorId, input.actor.id),
        isNull(schema.projects.deleteRequestedAt),
      ),
    );
  const rows = input.lock ? await query.for("update") : await query;
  const project = rows[0];
  if (!project || !canAccessProject(input.actor.id, project)) throw new ProjectNotFoundError();
  return project;
}

async function loadOwnedSession(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  sessionId: string;
  database: Db;
  lock?: boolean;
  acceptsWork?: boolean;
}): Promise<ProjectSessionRecord> {
  const project = await loadOwnedProject(input);
  if (input.acceptsWork) assertProjectAcceptsWork(project);
  const query = input.database
    .select()
    .from(schema.projectSessions)
    .where(
      and(
        eq(schema.projectSessions.orgId, input.orgId),
        eq(schema.projectSessions.projectId, input.projectId),
        eq(schema.projectSessions.id, input.sessionId),
        eq(schema.projectSessions.creatorId, input.actor.id),
      ),
    );
  const rows = input.lock ? await query.for("update") : await query;
  const session = rows[0];
  if (!session) throw new ProjectNotFoundError("session not found");
  if (input.acceptsWork) assertSessionAcceptsWork(session);
  return session;
}

function toSessionRow(row: ProjectSessionRecord): ProjectSessionRow {
  const isUnread = isProjectSessionUnread(row);
  return {
    id: row.id,
    project_id: row.projectId,
    title: row.title,
    model: row.model,
    status: row.status,
    stop_requested_at: row.stopRequestedAt?.toISOString() ?? null,
    last_active_at: row.lastActiveAt.toISOString(),
    archived_at: row.archivedAt?.toISOString() ?? null,
    last_viewed_at: row.lastViewedAt.toISOString(),
    is_unread: isUnread,
    error_code: row.errorCode,
    message: row.userMessage,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function isProjectSessionUnread(input: {
  status: string;
  updatedAt: Date;
  lastViewedAt: Date;
}): boolean {
  return (
    ["idle", "stopped", "completed", "error"].includes(input.status) &&
    input.updatedAt.getTime() > input.lastViewedAt.getTime()
  );
}

export function projectFileChangeKind(
  input: { baseVersion: number | null; version: number },
): "created" | "updated" {
  return input.baseVersion === 0
    || (input.baseVersion === null && input.version === 1)
    ? "created"
    : "updated";
}

async function loadProjectSkills(input: {
  orgId: string;
  projectId: string;
  database: Db;
}): Promise<ProjectSkill[]> {
  const rows = await input.database
    .select({
      skillId: schema.skills.id,
      slug: schema.skills.slug,
      displayName: schema.skills.displayName,
      description: schema.skills.description,
      archivedAt: schema.skills.archivedAt,
      version: schema.skillVersions.version,
    })
    .from(schema.projectSkills)
    .innerJoin(
      schema.skills,
      and(
        eq(schema.skills.orgId, schema.projectSkills.orgId),
        eq(schema.skills.id, schema.projectSkills.skillId),
      ),
    )
    .innerJoin(
      schema.skillVersions,
      and(
        eq(schema.skillVersions.orgId, schema.projectSkills.orgId),
        eq(schema.skillVersions.id, schema.projectSkills.desiredVersionId),
      ),
    )
    .where(
      and(
        eq(schema.projectSkills.orgId, input.orgId),
        eq(schema.projectSkills.projectId, input.projectId),
      ),
    )
    .orderBy(asc(schema.skills.slug));
  return rows.map((skill) => ({
    skill_id: skill.skillId,
    slug: skill.slug,
    display_name: skill.displayName?.trim() || skill.slug,
    summary: skill.description,
    version: skill.version,
    archived: skill.archivedAt !== null,
  }));
}

async function projectCounts(input: {
  orgId: string;
  projectId: string;
  creatorId: string;
  database: Db;
}): Promise<{
  skills: number;
  sessions: number;
  activeSessions: number;
  archivedSessions: number;
  unreadSessions: number;
  files: number;
}> {
  const [skills, sessions, activeSessions, archivedSessions, unreadSessions, files] = await Promise.all([
    input.database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.projectSkills)
      .where(
        and(
          eq(schema.projectSkills.orgId, input.orgId),
          eq(schema.projectSkills.projectId, input.projectId),
          eq(schema.projectSkills.creatorId, input.creatorId),
        ),
      ),
    input.database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.projectSessions)
      .where(
        and(
          eq(schema.projectSessions.orgId, input.orgId),
          eq(schema.projectSessions.projectId, input.projectId),
          eq(schema.projectSessions.creatorId, input.creatorId),
          isNull(schema.projectSessions.archivedAt),
        ),
      ),
    input.database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.projectSessions)
      .where(
        and(
          eq(schema.projectSessions.orgId, input.orgId),
          eq(schema.projectSessions.projectId, input.projectId),
          eq(schema.projectSessions.creatorId, input.creatorId),
          isNull(schema.projectSessions.archivedAt),
          inArray(schema.projectSessions.status, [
            "queued",
            "working",
            "stopping",
          ]),
        ),
      ),
    input.database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.projectSessions)
      .where(
        and(
          eq(schema.projectSessions.orgId, input.orgId),
          eq(schema.projectSessions.projectId, input.projectId),
          eq(schema.projectSessions.creatorId, input.creatorId),
          isNotNull(schema.projectSessions.archivedAt),
        ),
      ),
    input.database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.projectSessions)
      .where(
        and(
          eq(schema.projectSessions.orgId, input.orgId),
          eq(schema.projectSessions.projectId, input.projectId),
          eq(schema.projectSessions.creatorId, input.creatorId),
          isNull(schema.projectSessions.archivedAt),
          inArray(schema.projectSessions.status, ["idle", "stopped", "completed", "error"]),
          sql`${schema.projectSessions.updatedAt} > ${schema.projectSessions.lastViewedAt}`,
        ),
      ),
    input.database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.projectFiles)
      .where(
        and(
          eq(schema.projectFiles.orgId, input.orgId),
          eq(schema.projectFiles.projectId, input.projectId),
          eq(schema.projectFiles.creatorId, input.creatorId),
          isNull(schema.projectFiles.deletedAt),
        ),
      ),
  ]);
  return {
    skills: Number(skills[0]?.count ?? 0),
    sessions: Number(sessions[0]?.count ?? 0),
    activeSessions: Number(activeSessions[0]?.count ?? 0),
    archivedSessions: Number(archivedSessions[0]?.count ?? 0),
    unreadSessions: Number(unreadSessions[0]?.count ?? 0),
    files: Number(files[0]?.count ?? 0),
  };
}

function toProjectRow(
  project: ProjectRecord,
  workspace: ProjectWorkspaceRecord,
  counts: {
    skills: number;
    sessions: number;
    activeSessions: number;
    archivedSessions: number;
    unreadSessions: number;
    files: number;
  },
  recentSessions: ProjectSessionRow[] = [],
): ProjectRow {
  return {
    id: project.id,
    name: project.name,
    default_model: project.defaultModel,
    revision: project.revision,
    status: workspace.status,
    skill_count: counts.skills,
    session_count: counts.sessions,
    active_session_count: counts.activeSessions,
    archived_session_count: counts.archivedSessions,
    unread_session_count: counts.unreadSessions,
    file_count: counts.files,
    recent_sessions: recentSessions.slice(0, 5),
    last_activity_at: workspace.lastActivityAt.toISOString(),
    error_code: workspace.lastErrorCode,
    message: workspace.lastErrorMessage,
    archived_at: project.archivedAt?.toISOString() ?? null,
    created_at: project.createdAt.toISOString(),
    updated_at: project.updatedAt.toISOString(),
  };
}

async function projectDetailFromRecords(input: {
  project: ProjectRecord;
  workspace: ProjectWorkspaceRecord;
  database: Db;
}): Promise<ProjectDetail> {
  const [skills, sessions, counts, secretCount, personalConnections, orgConnections] =
    await Promise.all([
      loadProjectSkills({
        orgId: input.project.orgId,
        projectId: input.project.id,
        database: input.database,
      }),
      input.database
        .select()
        .from(schema.projectSessions)
        .where(
          and(
            eq(schema.projectSessions.orgId, input.project.orgId),
            eq(schema.projectSessions.projectId, input.project.id),
            eq(schema.projectSessions.creatorId, input.project.creatorId),
            isNull(schema.projectSessions.archivedAt),
          ),
        )
        .orderBy(
          desc(schema.projectSessions.createdAt),
          desc(schema.projectSessions.id),
        )
        .limit(50),
      projectCounts({
        orgId: input.project.orgId,
        projectId: input.project.id,
        creatorId: input.project.creatorId,
        database: input.database,
      }),
      listSecrets({
        actor: { id: input.project.creatorId, email: "", name: "" },
        orgId: input.project.orgId,
        database: input.database,
      }),
      input.database
        .select({
          id: schema.modelProviderConnections.id,
          provider: schema.modelProviderConnections.provider,
        })
        .from(schema.modelProviderConnections)
        .where(
          and(
            eq(schema.modelProviderConnections.orgId, input.project.orgId),
            eq(schema.modelProviderConnections.scope, "personal"),
            eq(schema.modelProviderConnections.userId, input.project.creatorId),
          ),
        ),
      input.database
        .select({
          id: schema.modelProviderConnections.id,
          provider: schema.modelProviderConnections.provider,
        })
        .from(schema.modelProviderConnections)
        .where(
          and(
            eq(schema.modelProviderConnections.orgId, input.project.orgId),
            eq(schema.modelProviderConnections.scope, "organization"),
          ),
        ),
    ]);
  const eligibleSecrets = secretCount
    .filter(
      (secret) =>
        secret.can_use &&
        !secret.disabled_at &&
        !secret.deleted_at &&
        !isProjectControlPlaneEnvKey(secret.key),
    )
    .map<ProjectAccessSecret>((secret) => ({
      id: secret.id,
      name: secret.name,
      source:
        secret.audience === "organization"
          ? "organization"
          : secret.owner.id === input.project.creatorId
            ? "personal"
            : "shared",
      owner_name: secret.owner.name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const effectiveConnections = new Map<string, ProjectAccessModelConnection>();
  for (const connection of orgConnections) {
    effectiveConnections.set(connection.provider, {
      id: connection.id,
      provider: connection.provider,
      source: "organization",
    });
  }
  for (const connection of personalConnections) {
    effectiveConnections.set(connection.provider, {
      id: connection.id,
      provider: connection.provider,
      source: "personal",
    });
  }
  const modelConnections = [...effectiveConnections.values()].sort((left, right) =>
    left.provider.localeCompare(right.provider),
  );
  return {
    ...toProjectRow(
      input.project,
      input.workspace,
      counts,
      sessions.slice(0, 5).map(toSessionRow),
    ),
    skills,
    sessions: sessions.map(toSessionRow),
    secret_count: eligibleSecrets.length,
    model_connection_count: modelConnections.length,
    access: {
      secrets: eligibleSecrets,
      model_connections: modelConnections,
    },
  };
}

async function ownedProjectWithWorkspace(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  database: Db;
}): Promise<{ project: ProjectRecord; workspace: ProjectWorkspaceRecord }> {
  const project = await loadOwnedProject(input);
  const rows = await input.database
    .select()
    .from(schema.projectWorkspaces)
    .where(
      and(
        eq(schema.projectWorkspaces.orgId, input.orgId),
        eq(schema.projectWorkspaces.projectId, input.projectId),
        eq(schema.projectWorkspaces.creatorId, input.actor.id),
      ),
    );
  if (!rows[0]) throw new ProjectNotFoundError();
  return { project, workspace: rows[0] };
}

async function resolveSelectedSkills(input: {
  actor: ActorContext;
  orgId: string;
  skillSlugs: string[];
  generation: number;
  projectId: string;
  database: Db;
}): Promise<{
  roots: Array<{ skillId: string; versionId: string }>;
  snapshots: Array<typeof schema.projectSkillSnapshots.$inferInsert>;
}> {
  if (new Set(input.skillSlugs).size !== input.skillSlugs.length) {
    throw new ProjectValidationError("skill slugs must be unique", "duplicate_skill");
  }
  if (input.skillSlugs.length === 0) return { roots: [], snapshots: [] };
  const skillRows = await input.database
    .select()
    .from(schema.skills)
    .where(
      and(
        eq(schema.skills.orgId, input.orgId),
        inArray(schema.skills.slug, input.skillSlugs),
      ),
    );
  const bySlug = new Map(skillRows.map((row) => [row.slug, row]));
  const versionIds = new Set<string>();
  const closures = [];
  const allClosureItems: Array<{ skill_id: string; skill_version_id: string }> = [];
  const roots: Array<{ skillId: string; versionId: string }> = [];
  for (const slug of input.skillSlugs) {
    const root = bySlug.get(slug);
    if (
      !root ||
      root.archivedAt ||
      !root.currentVersionId ||
      !canAccessSkill(input.actor.id, root)
    ) {
      throw new ProjectValidationError(`skill ${slug} is unavailable`, "skill_not_found");
    }
    const closure = await resolveRunDependencyClosure({
      actor: input.actor,
      orgId: input.orgId,
      slug,
      skillVersionId: root.currentVersionId,
      database: input.database,
    });
    roots.push({ skillId: root.id, versionId: root.currentVersionId });
    closures.push({ rootSkillId: root.id, closure });
    allClosureItems.push(...closure);
    for (const item of closure) versionIds.add(item.skill_version_id);
  }
  assertCompatibleProjectSkillClosure(allClosureItems);
  const versions = await input.database
    .select({
      id: schema.skillVersions.id,
      checksum: schema.skillVersions.checksum,
      storagePath: schema.skillVersions.storagePath,
    })
    .from(schema.skillVersions)
    .where(
      and(
        eq(schema.skillVersions.orgId, input.orgId),
        inArray(schema.skillVersions.id, [...versionIds]),
      ),
    );
  const versionById = new Map(versions.map((row) => [row.id, row]));
  const snapshots: Array<typeof schema.projectSkillSnapshots.$inferInsert> = [];
  for (const { rootSkillId, closure } of closures) {
    for (const item of closure) {
      const version = versionById.get(item.skill_version_id);
      if (!version) {
        throw new ProjectValidationError("a skill version is unavailable", "skill_version_not_found");
      }
      snapshots.push({
        orgId: input.orgId,
        projectId: input.projectId,
        creatorId: input.actor.id,
        generation: input.generation,
        rootSkillId,
        skillId: item.skill_id,
        skillVersionId: item.skill_version_id,
        mountOrder: item.mountOrder,
        isRoot: item.root,
        checksum: version.checksum,
        storagePath: version.storagePath,
      });
    }
  }
  return { roots, snapshots };
}

export async function listProjects(input: {
  actor: ActorContext;
  orgId: string;
  view?: "active" | "archived";
  database?: Db;
}): Promise<ProjectRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const rows = await database
    .select({ project: schema.projects, workspace: schema.projectWorkspaces })
    .from(schema.projects)
    .innerJoin(
      schema.projectWorkspaces,
      and(
        eq(schema.projectWorkspaces.orgId, schema.projects.orgId),
        eq(schema.projectWorkspaces.projectId, schema.projects.id),
        eq(schema.projectWorkspaces.creatorId, schema.projects.creatorId),
      ),
    )
    .where(
      and(
        eq(schema.projects.orgId, input.orgId),
        eq(schema.projects.creatorId, input.actor.id),
        isNull(schema.projects.deleteRequestedAt),
        input.view === "archived"
          ? isNotNull(schema.projects.archivedAt)
          : isNull(schema.projects.archivedAt),
      ),
    )
    .orderBy(desc(schema.projectWorkspaces.lastActivityAt), desc(schema.projects.id));
  return Promise.all(
    rows.map(async ({ project, workspace }) => {
      const [counts, recentSessions] = await Promise.all([
        projectCounts({
          orgId: input.orgId,
          projectId: project.id,
          creatorId: input.actor.id,
          database,
        }),
        database
          .select()
          .from(schema.projectSessions)
          .where(
            and(
              eq(schema.projectSessions.orgId, input.orgId),
              eq(schema.projectSessions.projectId, project.id),
              eq(schema.projectSessions.creatorId, input.actor.id),
              isNull(schema.projectSessions.archivedAt),
            ),
          )
          .orderBy(
            desc(schema.projectSessions.createdAt),
            desc(schema.projectSessions.id),
          )
          .limit(5),
      ]);
      return toProjectRow(project, workspace, counts, recentSessions.map(toSessionRow));
    }),
  );
}

export async function getProject(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  database?: Db;
}): Promise<ProjectDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const records = await ownedProjectWithWorkspace({ ...input, database });
  return projectDetailFromRecords({ ...records, database });
}

async function existingProjectForKey(input: {
  actor: ActorContext;
  orgId: string;
  idempotencyKey: string;
  payloadHash: string;
  database: Db;
}): Promise<ProjectDetail | null> {
  const rows = await input.database
    .select({
      id: schema.projects.id,
      payloadHash: schema.projects.payloadHash,
    })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.orgId, input.orgId),
        eq(schema.projects.creatorId, input.actor.id),
        eq(schema.projects.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return null;
  if (existing.payloadHash !== input.payloadHash) {
    throw new ProjectConflictError(
      "this idempotency key was already used for another project",
    );
  }
  const records = await ownedProjectWithWorkspace({
    actor: input.actor,
    orgId: input.orgId,
    projectId: existing.id,
    database: input.database,
  });
  return projectDetailFromRecords({ ...records, database: input.database });
}

export async function getProjectCreateReplay(input: {
  actor: ActorContext;
  orgId: string;
  value: CreateProjectInput;
  idempotencyKey: string;
  database?: Db;
}): Promise<ProjectDetail | null> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  assertValidProjectCreateIdempotencyKey(input.idempotencyKey);
  return existingProjectForKey({
    ...input,
    payloadHash: projectCreatePayloadHash(input.value),
    database,
  });
}

export async function createProject(input: {
  actor: ActorContext;
  orgId: string;
  value: CreateProjectInput;
  idempotencyKey: string;
  database?: Db;
}): Promise<ProjectDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const payloadHash = projectCreatePayloadHash(input.value);
  const replay = await getProjectCreateReplay({
    ...input,
    database,
  });
  if (replay) return replay;
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockProjectIdempotencyKey({
      orgId: input.orgId,
      creatorId: input.actor.id,
      idempotencyKey: input.idempotencyKey,
      database: tx,
    });
    const lockedReplay = await existingProjectForKey({
      ...input,
      payloadHash,
      database: tx,
    });
    if (lockedReplay) return lockedReplay;
    const projectId = randomUUID();
    const sandboxName = sandboxNameForProject(projectId);
    const selected = await resolveSelectedSkills({
      actor: input.actor,
      orgId: input.orgId,
      projectId,
      skillSlugs: input.value.skill_slugs,
      generation: 1,
      database: tx,
    });
    const rows = await tx
      .insert(schema.projects)
      .values({
        id: projectId,
        orgId: input.orgId,
        creatorId: input.actor.id,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        name: safeName(input.value.name),
        defaultModel: input.value.default_model,
      })
      .returning();
    const project = rows[0];
    if (!project) throw new Error("project insert returned no row");
    const workspaceRows = await tx
      .insert(schema.projectWorkspaces)
      .values({
        orgId: input.orgId,
        projectId,
        creatorId: input.actor.id,
        sandboxName,
        desiredGeneration: 1,
      })
      .returning();
    const workspace = workspaceRows[0];
    if (!workspace) throw new Error("project workspace insert returned no row");
    await reserveProjectActivationUsage({
      orgId: input.orgId,
      creatorId: input.actor.id,
      projectId,
      sandboxName,
      activationRevision: 1,
      database: tx,
    });
    if (selected.roots.length > 0) {
      await tx.insert(schema.projectSkills).values(
        selected.roots.map((root) => ({
          orgId: input.orgId,
          projectId,
          creatorId: input.actor.id,
          skillId: root.skillId,
          desiredVersionId: root.versionId,
        })),
      );
      await tx.insert(schema.projectSkillSnapshots).values(selected.snapshots);
    }
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      privateToUserId: input.actor.id,
      action: "project.created",
      targetType: "project",
      targetId: projectId,
      metadata: {
        skill_count: selected.roots.length,
      },
    });
    return projectDetailFromRecords({ project, workspace, database: tx });
  }) as Promise<ProjectDetail>;
}

export async function updateProject(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  value: UpdateProjectInput;
  database?: Db;
}): Promise<ProjectDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const current = await loadOwnedProject({ ...input, database: tx, lock: true });
    if (current.revision !== input.value.revision) throw new ProjectConflictError();

    if (input.value.archived === true && !current.archivedAt) {
      const active = await tx
        .select({ id: schema.projectSessions.id })
        .from(schema.projectSessions)
        .where(
          and(
            eq(schema.projectSessions.orgId, input.orgId),
            eq(schema.projectSessions.projectId, input.projectId),
            eq(schema.projectSessions.creatorId, input.actor.id),
            isNull(schema.projectSessions.archivedAt),
            inArray(schema.projectSessions.status, ["queued", "working", "stopping"]),
          ),
        )
        .limit(1);
      if (active[0]) {
        throw new ProjectConflictError(
          "stop active conversations before archiving this project",
        );
      }
    }

    const now = new Date();
    const rows = await tx
      .update(schema.projects)
      .set({
        ...(input.value.name !== undefined
          ? { name: safeName(input.value.name) }
          : {}),
        ...(input.value.default_model !== undefined
          ? { defaultModel: input.value.default_model }
          : {}),
        ...(input.value.archived !== undefined
          ? { archivedAt: input.value.archived ? now : null }
          : {}),
        revision: current.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projects.orgId, input.orgId),
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.creatorId, input.actor.id),
          eq(schema.projects.revision, current.revision),
          isNull(schema.projects.deleteRequestedAt),
        ),
      )
      .returning();
    const project = rows[0];
    if (!project) throw new ProjectConflictError();

    const workspaces = await tx
      .select()
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.orgId, input.orgId),
          eq(schema.projectWorkspaces.projectId, input.projectId),
          eq(schema.projectWorkspaces.creatorId, input.actor.id),
        ),
      );
    const workspace = workspaces[0];
    if (!workspace) throw new ProjectNotFoundError();
    const archiveChanged =
      input.value.archived !== undefined &&
      input.value.archived !== Boolean(current.archivedAt);
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      privateToUserId: input.actor.id,
      action: archiveChanged
        ? input.value.archived
          ? "project.archived"
          : "project.restored"
        : "project.updated",
      targetType: "project",
      targetId: input.projectId,
      metadata: { revision: project.revision },
    });
    return projectDetailFromRecords({ project, workspace, database: tx });
  }) as Promise<ProjectDetail>;
}

/**
 * Re-admit a terminal Project workspace to the durable worker queue.
 *
 * Retrying deliberately changes only scheduling/error state. Provider identity, checkpoints,
 * generations, activation admission and accounting fences stay intact so the worker must observe
 * and resume the existing workspace instead of silently provisioning an empty replacement.
 * Returning the current detail for an already re-queued workspace makes duplicate browser commands
 * idempotent.
 */
export async function retryProjectWorkspace(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  database?: Db;
}): Promise<ProjectDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const project = await loadOwnedProject({ ...input, database: tx, lock: true });
    assertProjectAcceptsWork(project);
    const workspaceRows = await tx
      .select()
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.orgId, input.orgId),
          eq(schema.projectWorkspaces.projectId, input.projectId),
          eq(schema.projectWorkspaces.creatorId, input.actor.id),
        ),
      )
      .for("update");
    let workspace = workspaceRows[0];
    if (!workspace) throw new ProjectNotFoundError();

    if (workspace.status === "error" || workspace.status === "needs_attention") {
      const previousStatus = workspace.status;
      const previousErrorCode = workspace.lastErrorCode;
      const now = new Date();
      const updatedRows = await tx
        .update(schema.projectWorkspaces)
        .set({
          status: "queued",
          availableAt: now,
          attempt: 0,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.orgId),
            eq(schema.projectWorkspaces.projectId, input.projectId),
            eq(schema.projectWorkspaces.creatorId, input.actor.id),
            eq(schema.projectWorkspaces.status, previousStatus),
          ),
        )
        .returning();
      workspace = updatedRows[0] ?? workspace;
      if (updatedRows[0]) {
        await tx.insert(schema.auditLog).values({
          orgId: input.orgId,
          actorId: input.actor.id,
          privateToUserId: input.actor.id,
          action: "project.workspace.retry_requested",
          targetType: "project",
          targetId: input.projectId,
          metadata: {
            previous_status: previousStatus,
            previous_error_code: previousErrorCode,
          },
        });
      }
    }

    return projectDetailFromRecords({ project, workspace, database: tx });
  }) as Promise<ProjectDetail>;
}

export async function setProjectSkills(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  value: SetProjectSkillsInput;
  database?: Db;
}): Promise<ProjectDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const project = await loadOwnedProject({ ...input, database: tx, lock: true });
    assertProjectAcceptsWork(project);
    if (project.revision !== input.value.revision) throw new ProjectConflictError();
    const workspaceRows = await tx
      .select()
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.orgId, input.orgId),
          eq(schema.projectWorkspaces.projectId, input.projectId),
          eq(schema.projectWorkspaces.creatorId, input.actor.id),
        ),
      )
      .for("update");
    const workspace = workspaceRows[0];
    if (!workspace) throw new ProjectNotFoundError();
    const generation = workspace.desiredGeneration + 1;
    const selected = await resolveSelectedSkills({
      actor: input.actor,
      orgId: input.orgId,
      projectId: input.projectId,
      skillSlugs: input.value.skill_slugs,
      generation,
      database: tx,
    });
    await tx
      .delete(schema.projectSkills)
      .where(
        and(
          eq(schema.projectSkills.orgId, input.orgId),
          eq(schema.projectSkills.projectId, input.projectId),
          eq(schema.projectSkills.creatorId, input.actor.id),
        ),
      );
    if (selected.roots.length > 0) {
      await tx.insert(schema.projectSkills).values(
        selected.roots.map((root) => ({
          orgId: input.orgId,
          projectId: input.projectId,
          creatorId: input.actor.id,
          skillId: root.skillId,
          desiredVersionId: root.versionId,
        })),
      );
      await tx.insert(schema.projectSkillSnapshots).values(selected.snapshots);
    }
    const updatedProjects = await tx
      .update(schema.projects)
      .set({ revision: project.revision + 1, updatedAt: new Date() })
      .where(
        and(
          eq(schema.projects.orgId, input.orgId),
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.creatorId, input.actor.id),
          eq(schema.projects.revision, project.revision),
        ),
      )
      .returning();
    const updatedWorkspaces = await tx
      .update(schema.projectWorkspaces)
      .set({
        desiredGeneration: generation,
        availableAt: new Date(),
        skillSyncErrorAt: null,
        skillSyncErrorCode: null,
        skillSyncErrorMessage: null,
        ...(workspace.status === "error" &&
        workspace.lastErrorCode === "project_skill_sync_failed"
          ? {
              status: "queued" as const,
              attempt: 0,
              lastErrorCode: null,
              lastErrorMessage: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.projectWorkspaces.orgId, input.orgId),
          eq(schema.projectWorkspaces.projectId, input.projectId),
          eq(schema.projectWorkspaces.creatorId, input.actor.id),
        ),
      )
      .returning();
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      privateToUserId: input.actor.id,
      action: "project.skills.updated",
      targetType: "project",
      targetId: input.projectId,
      metadata: { generation, skill_count: selected.roots.length },
    });
    return projectDetailFromRecords({
      project: updatedProjects[0]!,
      workspace: updatedWorkspaces[0]!,
      database: tx,
    });
  }) as Promise<ProjectDetail>;
}

/**
 * Rebuild every affected Project's complete desired skill closure after a root or transitive skill
 * publishes. The discovery RPC returns identities only; each update re-enters the Project creator's
 * RLS context and commits behind a savepoint so one broken closure cannot partially replace another.
 */
export async function refreshProjectsForSkillPublication(input: {
  actor: ActorContext;
  orgId: string;
  skillId: string;
  database?: Db;
}): Promise<{ refreshed: number; failed: number }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const result = await database.execute(sql`
    select
      target."project_id" as "projectId",
      target."creator_id" as "creatorId"
    from companion_project_skill_refresh_targets(
      ${input.orgId}::uuid,
      ${input.skillId}::uuid
    ) as target
  `);
  const targets = Array.from(
    result as unknown as Iterable<{ projectId: string; creatorId: string }>,
  );
  let refreshed = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      await database.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        await tx.execute(sql`
          select
            set_config('app.org_id', ${input.orgId}, true),
            set_config('app.user_id', ${target.creatorId}, true)
        `);
        const projects = await tx
          .select()
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.orgId, input.orgId),
              eq(schema.projects.id, target.projectId),
              eq(schema.projects.creatorId, target.creatorId),
              isNull(schema.projects.deleteRequestedAt),
            ),
          )
          .for("update");
        const project = projects[0];
        if (!project) return;
        const workspaces = await tx
          .select()
          .from(schema.projectWorkspaces)
          .where(
            and(
              eq(schema.projectWorkspaces.orgId, input.orgId),
              eq(schema.projectWorkspaces.projectId, target.projectId),
              eq(schema.projectWorkspaces.creatorId, target.creatorId),
            ),
          )
          .for("update");
        const workspace = workspaces[0];
        if (!workspace) return;
        const rootRows = await tx
          .select({ slug: schema.skills.slug })
          .from(schema.projectSkills)
          .innerJoin(
            schema.skills,
            and(
              eq(schema.skills.orgId, schema.projectSkills.orgId),
              eq(schema.skills.id, schema.projectSkills.skillId),
            ),
          )
          .where(
            and(
              eq(schema.projectSkills.orgId, input.orgId),
              eq(schema.projectSkills.projectId, target.projectId),
              eq(schema.projectSkills.creatorId, target.creatorId),
            ),
          )
          .orderBy(asc(schema.skills.slug));
        if (rootRows.length === 0) return;
        const generation = workspace.desiredGeneration + 1;
        const selected = await resolveSelectedSkills({
          actor: { id: target.creatorId, email: "", name: "" },
          orgId: input.orgId,
          projectId: target.projectId,
          skillSlugs: rootRows.map((row) => row.slug),
          generation,
          database: tx,
        });
        await tx
          .delete(schema.projectSkills)
          .where(
            and(
              eq(schema.projectSkills.orgId, input.orgId),
              eq(schema.projectSkills.projectId, target.projectId),
              eq(schema.projectSkills.creatorId, target.creatorId),
            ),
          );
        await tx.insert(schema.projectSkills).values(
          selected.roots.map((root) => ({
            orgId: input.orgId,
            projectId: target.projectId,
            creatorId: target.creatorId,
            skillId: root.skillId,
            desiredVersionId: root.versionId,
          })),
        );
        await tx.insert(schema.projectSkillSnapshots).values(selected.snapshots);
        await tx
          .update(schema.projects)
          .set({
            revision: project.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projects.orgId, input.orgId),
              eq(schema.projects.id, target.projectId),
              eq(schema.projects.creatorId, target.creatorId),
            ),
          );
        await tx
          .update(schema.projectWorkspaces)
          .set({
            desiredGeneration: generation,
            availableAt: new Date(),
            skillSyncErrorAt: null,
            skillSyncErrorCode: null,
            skillSyncErrorMessage: null,
            ...(workspace.status === "error" &&
            workspace.lastErrorCode === "project_skill_sync_failed"
              ? {
                  status: "queued" as const,
                  attempt: 0,
                  lastErrorCode: null,
                  lastErrorMessage: null,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectWorkspaces.orgId, input.orgId),
              eq(schema.projectWorkspaces.projectId, target.projectId),
              eq(schema.projectWorkspaces.creatorId, target.creatorId),
            ),
          );
        await tx.insert(schema.auditLog).values({
          orgId: input.orgId,
          actorId: input.actor.id,
          privateToUserId: target.creatorId,
          action: "project.skills.auto_refresh",
          targetType: "project",
          targetId: target.projectId,
          metadata: {
            triggering_skill_id: input.skillId,
            generation,
            skill_count: selected.roots.length,
          },
        });
        refreshed += 1;
      });
    } catch (error) {
      failed += 1;
      await database.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        await tx.execute(sql`
          select
            set_config('app.org_id', ${input.orgId}, true),
            set_config('app.user_id', ${target.creatorId}, true)
        `);
        await tx
          .update(schema.projectWorkspaces)
          .set({
            skillSyncErrorAt: new Date(),
            skillSyncErrorCode: "project_skill_sync_failed",
            skillSyncErrorMessage:
              error instanceof ProjectValidationError
                ? error.message.slice(0, 1_000)
                : "The synchronized skill closure could not be updated.",
            availableAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectWorkspaces.orgId, input.orgId),
              eq(schema.projectWorkspaces.projectId, target.projectId),
              eq(schema.projectWorkspaces.creatorId, target.creatorId),
            ),
          );
        await tx.insert(schema.auditLog).values({
          orgId: input.orgId,
          actorId: input.actor.id,
          privateToUserId: target.creatorId,
          action: "project.skills.auto_refresh_failed",
          targetType: "project",
          targetId: target.projectId,
          metadata: { triggering_skill_id: input.skillId },
        });
      });
    } finally {
      await database.execute(sql`
        select
          set_config('app.org_id', ${input.orgId}, true),
          set_config('app.user_id', ${input.actor.id}, true)
      `);
    }
  }
  return { refreshed, failed };
}

export async function requestProjectDeletion(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const now = new Date();
  const rows = await database
    .update(schema.projects)
    .set({ deleteRequestedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.projects.orgId, input.orgId),
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.creatorId, input.actor.id),
        isNull(schema.projects.deleteRequestedAt),
      ),
    )
    .returning({ id: schema.projects.id });
  if (!rows[0]) throw new ProjectNotFoundError();
  await database
    .update(schema.projectWorkspaces)
    .set({ status: "deleting", availableAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.projectWorkspaces.orgId, input.orgId),
        eq(schema.projectWorkspaces.projectId, input.projectId),
        eq(schema.projectWorkspaces.creatorId, input.actor.id),
      ),
    );
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    privateToUserId: input.actor.id,
    action: "project.deletion_requested",
    targetType: "project",
    targetId: input.projectId,
    metadata: {},
  });
}

export async function listProjectSessions(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  query?: ListProjectSessionsQuery;
  database?: Db;
}): Promise<ProjectSessionsResponse> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await loadOwnedProject({ ...input, database });
  const query = input.query ?? {
    q: "",
    view: "active",
    limit: 50,
  };
  const cursor = query.cursor ? decodeProjectSessionCursor(query.cursor) : null;
  const titleFilter = query.q
    ? sql`position(lower(${query.q}) in lower(${schema.projectSessions.title})) > 0`
    : undefined;
  const cursorFilter = cursor
    ? or(
        lt(schema.projectSessions.createdAt, cursor.createdAt),
        and(
          eq(schema.projectSessions.createdAt, cursor.createdAt),
          lt(schema.projectSessions.id, cursor.id),
        ),
      )
    : undefined;
  const rows = await database
    .select()
    .from(schema.projectSessions)
    .where(
      and(
        eq(schema.projectSessions.orgId, input.orgId),
        eq(schema.projectSessions.projectId, input.projectId),
        eq(schema.projectSessions.creatorId, input.actor.id),
        query.view === "archived"
          ? isNotNull(schema.projectSessions.archivedAt)
          : isNull(schema.projectSessions.archivedAt),
        titleFilter,
        cursorFilter,
      ),
    )
    .orderBy(
      desc(schema.projectSessions.createdAt),
      desc(schema.projectSessions.id),
    )
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const visible = hasMore ? rows.slice(0, query.limit) : rows;
  const last = visible.at(-1);
  return {
    sessions: visible.map(toSessionRow),
    next_cursor:
      hasMore && last
        ? encodeProjectSessionCursor({
            createdAt: last.createdAt,
            id: last.id,
          })
        : null,
  };
}

const PROJECT_SESSION_CURSOR_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeProjectSessionCursor(input: {
  createdAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({ created_at: input.createdAt.toISOString(), id: input.id }),
    "utf8",
  ).toString("base64url");
}

function decodeProjectSessionCursor(value: string): {
  createdAt: Date;
  id: string;
} {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { created_at?: unknown; id?: unknown };
    if (
      typeof parsed.created_at !== "string" ||
      typeof parsed.id !== "string" ||
      !PROJECT_SESSION_CURSOR_UUID.test(parsed.id)
    ) {
      throw new Error("invalid cursor shape");
    }
    const createdAt = new Date(parsed.created_at);
    if (!Number.isFinite(createdAt.getTime())) {
      throw new Error("invalid cursor date");
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new ProjectValidationError(
      "the conversation cursor is invalid",
      "invalid_cursor",
    );
  }
}

export async function updateProjectSession(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  sessionId: string;
  value: UpdateProjectSessionInput;
  database?: Db;
}): Promise<ProjectSessionRow> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const session = await loadOwnedSession({
      ...input,
      database: tx,
      lock: true,
    });
    const active = ["queued", "working", "stopping"].includes(session.status);
    if (input.value.archived === true && active && !input.value.stop_active) {
      throw new ProjectConflictError(
        "stop_active is required to archive an active conversation",
      );
    }

    const now = new Date();
    const wasUnread = isProjectSessionUnread(session);
    const changes: Partial<typeof schema.projectSessions.$inferInsert> = {
      ...(input.value.title !== undefined
        ? {
            title: Array.from(input.value.title.trim())
              .slice(0, PROJECT_SESSION_TITLE_MAX)
              .join(""),
          }
        : {}),
      ...(input.value.archived !== undefined
        ? {
            archivedAt: input.value.archived ? now : null,
            // Archiving/restoring is an explicit acknowledgement, so stale result badges do not
            // reappear when a conversation returns to the active library.
            lastViewedAt: now,
          }
        : input.value.viewed ||
            (input.value.title !== undefined && !wasUnread)
          ? { lastViewedAt: now }
          : {}),
      ...(input.value.archived === true && active
        ? {
            status: "stopping" as const,
            stopRequestedAt: session.stopRequestedAt ?? now,
          }
        : {}),
      ...(input.value.title !== undefined || input.value.archived !== undefined
        ? { updatedAt: now }
        : {}),
    };
    const rows = await tx
      .update(schema.projectSessions)
      .set(changes)
      .where(
        and(
          eq(schema.projectSessions.orgId, input.orgId),
          eq(schema.projectSessions.projectId, input.projectId),
          eq(schema.projectSessions.id, input.sessionId),
          eq(schema.projectSessions.creatorId, input.actor.id),
        ),
      )
      .returning();
    const updated = rows[0];
    if (!updated) throw new ProjectNotFoundError("session not found");

    const archiveChanged =
      input.value.archived !== undefined &&
      input.value.archived !== Boolean(session.archivedAt);
    const titleChanged =
      input.value.title !== undefined && input.value.title.trim() !== session.title;
    if (archiveChanged || titleChanged) {
      await tx.insert(schema.auditLog).values({
        orgId: input.orgId,
        actorId: input.actor.id,
        privateToUserId: input.actor.id,
        action: archiveChanged
          ? input.value.archived
            ? "project.session.archived"
            : "project.session.restored"
          : "project.session.renamed",
        targetType: "project_session",
        targetId: input.sessionId,
        metadata: {
          project_id: input.projectId,
          stop_requested: Boolean(
            input.value.archived === true && active,
          ),
        },
      });
    }
    return toSessionRow(updated);
  }) as Promise<ProjectSessionRow>;
}

async function promptRows(input: {
  orgId: string;
  sessionId: string;
  creatorId: string;
  database: Db;
}): Promise<ProjectPromptRow[]> {
  const rows = await input.database
    .select()
    .from(schema.projectPrompts)
    .where(
      and(
        eq(schema.projectPrompts.orgId, input.orgId),
        eq(schema.projectPrompts.sessionId, input.sessionId),
        eq(schema.projectPrompts.creatorId, input.creatorId),
      ),
    )
    .orderBy(asc(schema.projectPrompts.sequence));
  if (rows.length === 0) return [];
  const promptIds = rows.map((row) => row.id);
  const [attachments, fileChanges] = await Promise.all([
    input.database
      .select()
      .from(schema.projectAttachments)
      .where(
        and(
          eq(schema.projectAttachments.orgId, input.orgId),
          eq(schema.projectAttachments.sessionId, input.sessionId),
          eq(schema.projectAttachments.creatorId, input.creatorId),
          inArray(schema.projectAttachments.promptId, promptIds),
        ),
      )
      .orderBy(
        asc(schema.projectAttachments.createdAt),
        asc(schema.projectAttachments.id),
      ),
    input.database
      .select({
        promptId: schema.projectFileVersions.modifiedByPromptId,
        projectId: schema.projectFileVersions.projectId,
        fileId: schema.projectFileVersions.fileId,
        path: schema.projectFiles.path,
        version: schema.projectFileVersions.version,
        contentType: schema.projectFileVersions.contentType,
        byteSize: schema.projectFileVersions.byteSize,
        checksum: schema.projectFileVersions.checksum,
        baseVersion: schema.projectFileVersions.baseVersion,
        sessionId: schema.projectFileVersions.modifiedBySessionId,
        conflictDetected: schema.projectFileVersions.conflictDetected,
        createdAt: schema.projectFileVersions.createdAt,
      })
      .from(schema.projectFileVersions)
      .innerJoin(
        schema.projectFiles,
        and(
          eq(schema.projectFiles.orgId, schema.projectFileVersions.orgId),
          eq(schema.projectFiles.projectId, schema.projectFileVersions.projectId),
          eq(schema.projectFiles.id, schema.projectFileVersions.fileId),
          eq(schema.projectFiles.creatorId, schema.projectFileVersions.creatorId),
        ),
      )
      .where(
        and(
          eq(schema.projectFileVersions.orgId, input.orgId),
          eq(schema.projectFileVersions.modifiedBySessionId, input.sessionId),
          eq(schema.projectFileVersions.creatorId, input.creatorId),
          inArray(schema.projectFileVersions.modifiedByPromptId, promptIds),
        ),
      )
      .orderBy(
        asc(schema.projectFileVersions.createdAt),
        asc(schema.projectFileVersions.fileId),
        asc(schema.projectFileVersions.version),
      ),
  ]);
  const attachmentsByPrompt = new Map<
    string,
    ProjectPromptRow["attachments"]
  >();
  const uploadedFileIdentities = new Set<string>();
  for (const attachment of attachments) {
    const group = attachmentsByPrompt.get(attachment.promptId) ?? [];
    group.push({
      id: attachment.id,
      file_name: attachment.fileName,
      content_type: attachment.contentType,
      byte_size: attachment.byteSize,
      workspace_path: attachment.workspacePath,
      status: attachment.status,
      created_at: attachment.createdAt.toISOString(),
    });
    attachmentsByPrompt.set(attachment.promptId, group);
    uploadedFileIdentities.add(
      `${attachment.promptId}\0${attachment.workspacePath}\0${attachment.checksum}`,
    );
  }
  const fileChangesByPrompt = new Map<
    string,
    ProjectPromptRow["file_changes"]
  >();
  for (const change of fileChanges) {
    if (!change.promptId || !change.sessionId) continue;
    if (
      uploadedFileIdentities.has(
        `${change.promptId}\0${change.path}\0${change.checksum}`,
      )
    ) {
      continue;
    }
    const group = fileChangesByPrompt.get(change.promptId) ?? [];
    group.push({
      project_id: change.projectId,
      file_id: change.fileId,
      path: change.path,
      kind: projectFileChangeKind({
        baseVersion: change.baseVersion,
        version: change.version,
      }),
      version: change.version,
      content_type: change.contentType,
      byte_size: change.byteSize,
      modified_by_session_id: change.sessionId,
      modified_by_prompt_id: change.promptId,
      conflict_detected: change.conflictDetected,
      created_at: change.createdAt.toISOString(),
    });
    fileChangesByPrompt.set(change.promptId, group);
  }
  return rows.map((row) => ({
    id: row.id,
    session_id: row.sessionId,
    sequence: row.sequence,
    opencode_message_id: row.opencodeMessageId,
    text: row.text,
    status: row.status,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    attachments: attachmentsByPrompt.get(row.id) ?? [],
    file_changes: fileChangesByPrompt.get(row.id) ?? [],
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
  }));
}

export async function getProjectSession(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  sessionId: string;
  database?: Db;
}): Promise<ProjectSessionDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const session = await loadOwnedSession({ ...input, database });
  return {
    ...toSessionRow(session),
    prompts: await promptRows({
      orgId: input.orgId,
      sessionId: input.sessionId,
      creatorId: input.actor.id,
      database,
    }),
    transcript: projectTranscriptSchema.parse(session.transcript),
    current_event_sequence: session.transcriptSequence,
    // Resume after the event prefix represented by this transcript, not after the current event
    // allocator maximum. Mid-turn events appended after the last snapshot must still replay.
    latest_event_sequence: session.transcriptEventSequence,
  };
}

export async function getProjectPromptAttachment(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  sessionId: string;
  attachmentId: string;
  database?: Db;
}): Promise<{
  fileName: string;
  contentType: string;
  byteSize: number;
  storageKey: string;
}> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await loadOwnedSession({ ...input, database });
  const rows = await database
    .select()
    .from(schema.projectAttachments)
    .where(
      and(
        eq(schema.projectAttachments.orgId, input.orgId),
        eq(schema.projectAttachments.projectId, input.projectId),
        eq(schema.projectAttachments.sessionId, input.sessionId),
        eq(schema.projectAttachments.id, input.attachmentId),
        eq(schema.projectAttachments.creatorId, input.actor.id),
      ),
    )
    .limit(1);
  const attachment = rows[0];
  if (!attachment) throw new ProjectNotFoundError("attachment not found");
  return {
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    storageKey: attachment.storageKey,
  };
}

function validateAttachments(attachments: CreateProjectAttachment[]): void {
  if (attachments.length > PROJECT_ATTACHMENT_MAX_FILES) {
    throw new ProjectValidationError(
      `a prompt can have at most ${PROJECT_ATTACHMENT_MAX_FILES} attachments`,
      "too_many_attachments",
    );
  }
  const paths = new Set<string>();
  for (const attachment of attachments) {
    if (attachment.byteSize < 1 || attachment.byteSize > PROJECT_ATTACHMENT_MAX_BYTES) {
      throw new ProjectValidationError(
        "each attachment must be non-empty and 10 MB or smaller",
        "invalid_attachment",
      );
    }
    if (
      !isManagedProjectFilePath(attachment.workspacePath) ||
      paths.has(attachment.workspacePath)
    ) {
      throw new ProjectValidationError("attachment paths must be unique files/ paths", "invalid_attachment_path");
    }
    paths.add(attachment.workspacePath);
  }
}

async function existingPromptForKey(input: {
  orgId: string;
  creatorId: string;
  idempotencyKey: string;
  payloadHash: string;
  database: Db;
}) {
  const rows = await input.database
    .select()
    .from(schema.projectPrompts)
    .where(
      and(
        eq(schema.projectPrompts.orgId, input.orgId),
        eq(schema.projectPrompts.creatorId, input.creatorId),
        eq(schema.projectPrompts.idempotencyKey, input.idempotencyKey),
      ),
    );
  const existing = rows[0];
  if (existing && existing.payloadHash !== input.payloadHash) {
    throw new ProjectConflictError("this idempotency key was already used for another prompt");
  }
  return existing ?? null;
}

/** Cheap replay preflight so an accepted idempotent retry survives temporary runtime/model outages. */
export async function hasProjectPromptIdempotencyKey(input: {
  actor: ActorContext;
  orgId: string;
  idempotencyKey: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const rows = await database
    .select({ id: schema.projectPrompts.id })
    .from(schema.projectPrompts)
    .where(
      and(
        eq(schema.projectPrompts.orgId, input.orgId),
        eq(schema.projectPrompts.creatorId, input.actor.id),
        eq(schema.projectPrompts.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}

async function lockProjectIdempotencyKey(input: {
  orgId: string;
  creatorId: string;
  idempotencyKey: string;
  database: Db;
}): Promise<void> {
  await input.database.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        ${`companion:project-idempotency:${input.orgId}:${input.creatorId}:${input.idempotencyKey}`},
        0
      )
    )
  `);
}

async function admitAcceptedProjectPrompt(input: {
  orgId: string;
  projectId: string;
  creatorId: string;
  database: Db;
  now: Date;
}): Promise<ProjectUsageAdmission> {
  const rows = await input.database
    .select({
      sandboxName: schema.projectWorkspaces.sandboxName,
      activationRevision: schema.projectWorkspaces.activationRevision,
      activationAdmissionRevision:
        schema.projectWorkspaces.activationAdmissionRevision,
    })
    .from(schema.projectWorkspaces)
    .where(
      and(
        eq(schema.projectWorkspaces.orgId, input.orgId),
        eq(schema.projectWorkspaces.projectId, input.projectId),
        eq(schema.projectWorkspaces.creatorId, input.creatorId),
      ),
    )
    .limit(1)
    .for("update");
  const workspace = rows[0];
  if (!workspace) throw new ProjectNotFoundError();
  return admitProjectPromptUsage({
    orgId: input.orgId,
    creatorId: input.creatorId,
    projectId: input.projectId,
    sandboxName: workspace.sandboxName,
    currentActivationRevision: workspace.activationRevision,
    pendingActivationRevision: workspace.activationAdmissionRevision,
    database: input.database,
    now: input.now,
  });
}

async function insertPromptAttachments(input: {
  orgId: string;
  projectId: string;
  sessionId: string;
  promptId: string;
  creatorId: string;
  attachments: CreateProjectAttachment[];
  database: Db;
}): Promise<void> {
  if (input.attachments.length === 0) return;
  const storageKeys = [...new Set(input.attachments.map((attachment) => attachment.storageKey))];
  const reserved = await input.database
    .update(schema.projectAttachmentUploads)
    .set({ touchedAt: new Date() })
    .where(
      and(
        eq(schema.projectAttachmentUploads.orgId, input.orgId),
        eq(schema.projectAttachmentUploads.projectId, input.projectId),
        eq(schema.projectAttachmentUploads.creatorId, input.creatorId),
        eq(schema.projectAttachmentUploads.kind, "attachment"),
        isNull(schema.projectAttachmentUploads.deleteRequestedAt),
        inArray(schema.projectAttachmentUploads.storageKey, storageKeys),
      ),
    )
    .returning({ storageKey: schema.projectAttachmentUploads.storageKey });
  if (reserved.length !== storageKeys.length) {
    throw new ProjectValidationError(
      "an attachment upload reservation is missing",
      "invalid_attachment",
    );
  }
  await input.database.insert(schema.projectAttachments).values(
    input.attachments.map((attachment) => ({
      ...attachment,
      orgId: input.orgId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      promptId: input.promptId,
      creatorId: input.creatorId,
    })),
  );
  await input.database
    .update(schema.projectAttachmentUploads)
    .set({ committedAt: new Date(), touchedAt: new Date() })
    .where(
      and(
        eq(schema.projectAttachmentUploads.orgId, input.orgId),
        eq(schema.projectAttachmentUploads.projectId, input.projectId),
        eq(schema.projectAttachmentUploads.creatorId, input.creatorId),
        eq(schema.projectAttachmentUploads.kind, "attachment"),
        inArray(schema.projectAttachmentUploads.storageKey, storageKeys),
      ),
    );
}

/**
 * Reserve deterministic S3 keys before upload.
 *
 * The ownership row is retained after metadata commits and intentionally outlives Project deletion:
 * a delayed sweep can therefore remove bytes from an upload that lost a race with DELETE.
 */
export async function reserveProjectAttachmentUploads(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  storageKeys: string[];
  database?: Db;
}): Promise<void> {
  if (input.storageKeys.length === 0) return;
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const project = await loadOwnedProject({ ...input, database });
  assertProjectAcceptsWork(project);
  const touchedAt = new Date();
  for (const storageKey of [...new Set(input.storageKeys)]) {
    if (!storageKey.trim()) {
      throw new ProjectValidationError("attachment storage key is required", "invalid_attachment");
    }
    await database
      .insert(schema.projectAttachmentUploads)
      .values({
        storageKey,
        orgId: input.orgId,
        projectId: input.projectId,
        creatorId: input.actor.id,
        kind: "attachment",
        touchedAt,
      })
      .onConflictDoUpdate({
        target: schema.projectAttachmentUploads.storageKey,
        set: { touchedAt },
      });
  }
}

/**
 * Reserve content-addressed file objects before the API writes them to S3.
 *
 * The API remains a desired-state publisher: it never touches the Project runtime. The durable
 * ownership row also makes every failed upload/metadata boundary recoverable by the orphan sweep.
 */
export async function reserveProjectFileUploads(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  storageKeys: string[];
  database?: Db;
}): Promise<void> {
  if (input.storageKeys.length === 0) return;
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const project = await loadOwnedProject({ ...input, database });
  assertProjectAcceptsWork(project);
  const touchedAt = new Date();
  for (const storageKey of [...new Set(input.storageKeys)]) {
    if (!storageKey.trim()) {
      throw new ProjectValidationError("file storage key is required", "invalid_file");
    }
    await database
      .insert(schema.projectAttachmentUploads)
      .values({
        storageKey,
        orgId: input.orgId,
        projectId: input.projectId,
        creatorId: input.actor.id,
        kind: "file",
        touchedAt,
      })
      .onConflictDoUpdate({
        target: schema.projectAttachmentUploads.storageKey,
        set: { touchedAt },
      });
    const owned = await database
      .select({ kind: schema.projectAttachmentUploads.kind })
      .from(schema.projectAttachmentUploads)
      .where(
        and(
          eq(schema.projectAttachmentUploads.storageKey, storageKey),
          eq(schema.projectAttachmentUploads.orgId, input.orgId),
          eq(schema.projectAttachmentUploads.projectId, input.projectId),
          eq(schema.projectAttachmentUploads.creatorId, input.actor.id),
          isNull(schema.projectAttachmentUploads.deleteRequestedAt),
        ),
      )
      .limit(1);
    if (owned[0]?.kind !== "file") {
      throw new ProjectValidationError("file storage reservation is unavailable", "invalid_file");
    }
  }
}

/** Hold the reservation lock across S3 deletion so a concurrent retry cannot lose its bytes. */
export async function deleteProjectAttachmentOrphanIfReserved(input: {
  storageKey: string;
  before: Date;
  deleteObject: () => Promise<void>;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const locked = await tx.execute(sql`
      select companion_lock_project_attachment_orphan(
        ${input.storageKey},
        ${input.before.toISOString()}::timestamp with time zone
      ) as locked
    `);
    const row = Array.from(locked as unknown as Iterable<{ locked: boolean }>)[0];
    if (row?.locked !== true) return false;
    await input.deleteObject();
    await tx.execute(sql`
      select companion_complete_project_attachment_orphan(${input.storageKey})
    `);
    return true;
  });
}

export async function listProjectAttachmentOrphanReservations(input: {
  before: Date;
  limit?: number;
  database?: Db;
}): Promise<string[]> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select storage_key as "storageKey"
    from companion_list_project_attachment_orphans(
      ${input.before.toISOString()}::timestamp with time zone,
      ${input.limit ?? 250}
    )
  `);
  return Array.from(result as unknown as Iterable<{ storageKey: string }>).map(
    (row) => row.storageKey,
  );
}

export async function deferProjectAttachmentOrphanReservation(input: {
  storageKey: string;
  before: Date;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select companion_defer_project_attachment_orphan(
      ${input.storageKey},
      ${input.before.toISOString()}::timestamp with time zone
    ) as deferred
  `);
  const row = Array.from(result as unknown as Iterable<{ deferred: boolean }>)[0];
  return row?.deferred ?? false;
}

export async function createProjectSession(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  prompt: string;
  model?: string;
  /** Immutable provider id returned by the same catalog row as the model. */
  modelProvider: string | null;
  /** Immutable env-key declaration from the validated model catalog; empty is credentialless. */
  modelCredentialEnvKeys: string[] | null;
  title?: string;
  idempotencyKey: string;
  attachments: CreateProjectAttachment[];
  database?: Db;
}): Promise<ProjectSessionDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  validateAttachments(input.attachments);
  const payloadHash = projectPayloadHash({
    projectId: input.projectId,
    prompt: input.prompt,
    model: input.model ?? null,
    title: input.title ?? null,
    attachments: input.attachments.map((attachment) => ({
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      byteSize: attachment.byteSize,
      checksum: attachment.checksum,
      workspacePath: attachment.workspacePath,
    })),
  });
  const replay = await existingPromptForKey({
    orgId: input.orgId,
    creatorId: input.actor.id,
    idempotencyKey: input.idempotencyKey,
    payloadHash,
    database,
  });
  if (replay) {
    return getProjectSession({
      actor: input.actor,
      orgId: input.orgId,
      projectId: replay.projectId,
      sessionId: replay.sessionId,
      database,
    });
  }
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockProjectIdempotencyKey({
      orgId: input.orgId,
      creatorId: input.actor.id,
      idempotencyKey: input.idempotencyKey,
      database: tx,
    });
    const lockedReplay = await existingPromptForKey({
      orgId: input.orgId,
      creatorId: input.actor.id,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      database: tx,
    });
    if (lockedReplay) {
      return getProjectSession({
        actor: input.actor,
        orgId: input.orgId,
        projectId: lockedReplay.projectId,
        sessionId: lockedReplay.sessionId,
        database: tx,
      });
    }
    const project = await loadOwnedProject({ ...input, database: tx, lock: true });
    assertProjectAcceptsWork(project);
    const model = input.model?.trim() || project.defaultModel;
    if (!model) throw new ProjectValidationError("a model is required", "model_required");
    if (
      input.modelProvider === null
      || !input.modelProvider.trim()
      || input.modelProvider.length > 120
      || input.modelCredentialEnvKeys === null
    ) {
      throw new ProjectValidationError(
        "the selected model credential declaration is unavailable",
        "model_unavailable",
      );
    }
    const modelProvider = input.modelProvider.trim();
    const modelCredentialEnvKeys = modelCredentialEnvKeysSnapshot(input.modelCredentialEnvKeys);
    const sessionId = randomUUID();
    const promptId = randomUUID();
    const promptCreatedAt = new Date();
    const usageAdmission = await admitAcceptedProjectPrompt({
      orgId: input.orgId,
      projectId: input.projectId,
      creatorId: input.actor.id,
      database: tx,
      now: promptCreatedAt,
    });
    const sessions = await tx
      .insert(schema.projectSessions)
      .values({
        id: sessionId,
        orgId: input.orgId,
        projectId: input.projectId,
        creatorId: input.actor.id,
        title: input.title?.trim() || deriveProjectSessionTitle(input.prompt),
        model,
        modelProvider,
        modelCredentialEnvKeys,
      })
      .returning();
    await tx.insert(schema.projectPrompts).values({
      id: promptId,
      orgId: input.orgId,
      projectId: input.projectId,
      sessionId,
      creatorId: input.actor.id,
      sequence: 1,
      text: input.prompt,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      usageActivationRevision: usageAdmission.activationRevision,
      usageReservationMs: usageAdmission.reservationMs,
      opencodeMessageId: deterministicAgentMessageId(
        "project",
        sessionId,
        1,
        promptCreatedAt.getTime(),
      ),
      createdAt: promptCreatedAt,
      updatedAt: promptCreatedAt,
    });
    await insertPromptAttachments({
      orgId: input.orgId,
      projectId: input.projectId,
      sessionId,
      promptId,
      creatorId: input.actor.id,
      attachments: input.attachments,
      database: tx,
    });
    const now = new Date();
    await tx
      .update(schema.projectWorkspaces)
      .set({ availableAt: now, lastActivityAt: now, idleDeadlineAt: null, updatedAt: now })
      .where(
        and(
          eq(schema.projectWorkspaces.orgId, input.orgId),
          eq(schema.projectWorkspaces.projectId, input.projectId),
          eq(schema.projectWorkspaces.creatorId, input.actor.id),
        ),
      );
    await reopenColdProviderGateForSession({
      orgId: input.orgId,
      projectId: input.projectId,
      creatorId: input.actor.id,
      session: sessions[0]!,
      database: tx,
      now,
    });
    await tx
      .update(schema.projects)
      .set({ updatedAt: now })
      .where(
        and(
          eq(schema.projects.orgId, input.orgId),
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.creatorId, input.actor.id),
        ),
      );
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      privateToUserId: input.actor.id,
      action: "project.session.created",
      targetType: "project_session",
      targetId: sessionId,
      metadata: { project_id: input.projectId },
    });
    const session = sessions[0]!;
    return {
      ...toSessionRow(session),
      prompts: await promptRows({
        orgId: input.orgId,
        sessionId,
        creatorId: input.actor.id,
        database: tx,
      }),
      transcript: [],
      current_event_sequence: 0,
      latest_event_sequence: 0,
    };
  }) as Promise<ProjectSessionDetail>;
}

export async function enqueueProjectPrompt(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  sessionId: string;
  text: string;
  /** Optional multipart assertion; a Project session's model is immutable after creation. */
  model?: string;
  idempotencyKey: string;
  attachments: CreateProjectAttachment[];
  database?: Db;
}): Promise<ProjectPromptRow> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  validateAttachments(input.attachments);
  const assertedSession = await loadOwnedSession({
    ...input,
    database,
    acceptsWork: true,
  });
  if (input.model && input.model !== assertedSession.model) {
    throw new ProjectConflictError("A session's model cannot change.");
  }
  const payloadHash = projectPayloadHash({
    projectId: input.projectId,
    sessionId: input.sessionId,
    text: input.text,
    model: input.model ?? null,
    attachments: input.attachments.map((attachment) => ({
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      byteSize: attachment.byteSize,
      checksum: attachment.checksum,
      workspacePath: attachment.workspacePath,
    })),
  });
  const replay = await existingPromptForKey({
    orgId: input.orgId,
    creatorId: input.actor.id,
    idempotencyKey: input.idempotencyKey,
    payloadHash,
    database,
  });
  if (replay) {
    return (await promptRows({
      orgId: input.orgId,
      sessionId: replay.sessionId,
      creatorId: input.actor.id,
      database,
    })).find((row) => row.id === replay.id)!;
  }
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockProjectIdempotencyKey({
      orgId: input.orgId,
      creatorId: input.actor.id,
      idempotencyKey: input.idempotencyKey,
      database: tx,
    });
    const lockedReplay = await existingPromptForKey({
      orgId: input.orgId,
      creatorId: input.actor.id,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      database: tx,
    });
    if (lockedReplay) {
      const replayed = await promptRows({
        orgId: input.orgId,
        sessionId: lockedReplay.sessionId,
        creatorId: input.actor.id,
        database: tx,
      });
      const prompt = replayed.find((row) => row.id === lockedReplay.id);
      if (!prompt) throw new ProjectNotFoundError("prompt not found");
      return prompt;
    }
    const session = await loadOwnedSession({
      ...input,
      database: tx,
      lock: true,
      acceptsWork: true,
    });
    if (input.model && input.model !== session.model) {
      throw new ProjectConflictError("A session's model cannot change.");
    }
    if (session.status === "stopping" || session.stopRequestedAt) {
      throw new ProjectConflictError("this session is stopping");
    }
    const activeEarlierPrompts = await tx
      .select({ id: schema.projectPrompts.id })
      .from(schema.projectPrompts)
      .where(
        and(
          eq(schema.projectPrompts.orgId, input.orgId),
          eq(schema.projectPrompts.projectId, input.projectId),
          eq(schema.projectPrompts.sessionId, input.sessionId),
          eq(schema.projectPrompts.creatorId, input.actor.id),
          inArray(schema.projectPrompts.status, ["dispatching", "running"]),
        ),
      )
      .limit(1);
    const sequenceRows = await tx
      .select({ value: max(schema.projectPrompts.sequence) })
      .from(schema.projectPrompts)
      .where(
        and(
          eq(schema.projectPrompts.orgId, input.orgId),
          eq(schema.projectPrompts.sessionId, input.sessionId),
        ),
      );
    const promptId = randomUUID();
    const sequence = Number(sequenceRows[0]?.value ?? 0) + 1;
    const promptCreatedAt = new Date();
    const usageAdmission = await admitAcceptedProjectPrompt({
      orgId: input.orgId,
      projectId: input.projectId,
      creatorId: input.actor.id,
      database: tx,
      now: promptCreatedAt,
    });
    const inserted = await tx
      .insert(schema.projectPrompts)
      .values({
        id: promptId,
        orgId: input.orgId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        creatorId: input.actor.id,
        sequence,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        usageActivationRevision: usageAdmission.activationRevision,
        usageReservationMs: usageAdmission.reservationMs,
        opencodeMessageId: deterministicAgentMessageId(
          "project",
          input.sessionId,
          sequence,
          promptCreatedAt.getTime(),
        ),
        createdAt: promptCreatedAt,
        updatedAt: promptCreatedAt,
      })
      .returning();
    await insertPromptAttachments({
      orgId: input.orgId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      promptId,
      creatorId: input.actor.id,
      attachments: input.attachments,
      database: tx,
    });
    const now = new Date();
    await tx
      .update(schema.projectSessions)
      .set({
        ...reopenedProjectSessionState({
          isWorking: session.status === "working",
          hasActivePrompt: Boolean(activeEarlierPrompts[0]),
        }),
        lastActiveAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectSessions.orgId, input.orgId),
          eq(schema.projectSessions.id, input.sessionId),
          eq(schema.projectSessions.creatorId, input.actor.id),
        ),
      );
    await tx
      .update(schema.projectWorkspaces)
      .set({ availableAt: now, lastActivityAt: now, idleDeadlineAt: null, updatedAt: now })
      .where(
        and(
          eq(schema.projectWorkspaces.orgId, input.orgId),
          eq(schema.projectWorkspaces.projectId, input.projectId),
          eq(schema.projectWorkspaces.creatorId, input.actor.id),
        ),
      );
    await reopenColdProviderGateForSession({
      orgId: input.orgId,
      projectId: input.projectId,
      creatorId: input.actor.id,
      session,
      database: tx,
      now,
    });
    const row = inserted[0]!;
    return {
      id: row.id,
      session_id: row.sessionId,
      sequence: row.sequence,
      opencode_message_id: row.opencodeMessageId,
      text: row.text,
      status: row.status,
      error_code: row.errorCode,
      error_message: row.errorMessage,
      attachments: input.attachments.map((attachment) => ({
        id: attachment.id,
        file_name: attachment.fileName,
        content_type: attachment.contentType,
        byte_size: attachment.byteSize,
        workspace_path: attachment.workspacePath,
        status: "uploaded" as const,
        created_at: promptCreatedAt.toISOString(),
      })),
      file_changes: [],
      created_at: row.createdAt.toISOString(),
      started_at: null,
      completed_at: null,
    };
  }) as Promise<ProjectPromptRow>;
}

export async function requestProjectSessionStop(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  sessionId: string;
  database?: Db;
}): Promise<ProjectSessionRow> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const session = await loadOwnedSession({ ...input, database: tx, lock: true });
    if (
      session.status === "stopping" ||
      session.status === "stopped" ||
      session.status === "completed" ||
      session.status === "error"
    ) {
      return toSessionRow(session);
    }
    const now = new Date();
    const rows = await tx
      .update(schema.projectSessions)
      .set({ status: "stopping", stopRequestedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.projectSessions.orgId, input.orgId),
          eq(schema.projectSessions.projectId, input.projectId),
          eq(schema.projectSessions.id, input.sessionId),
          eq(schema.projectSessions.creatorId, input.actor.id),
        ),
      )
      .returning();
    if (!rows[0]) throw new ProjectNotFoundError("session not found");
    await tx
      .update(schema.projectWorkspaces)
      .set({ availableAt: now, idleDeadlineAt: null, updatedAt: now })
      .where(
        and(
          eq(schema.projectWorkspaces.orgId, input.orgId),
          eq(schema.projectWorkspaces.projectId, input.projectId),
          eq(schema.projectWorkspaces.creatorId, input.actor.id),
        ),
      );
    return toSessionRow(rows[0]);
  }) as Promise<ProjectSessionRow>;
}

export async function listProjectSessionEvents(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  sessionId: string;
  after?: number;
  limit?: number;
  database?: Db;
}): Promise<ProjectEventEnvelope[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await loadOwnedSession({ ...input, database });
  const rows = await database
    .select()
    .from(schema.projectSessionEvents)
    .where(
      and(
        eq(schema.projectSessionEvents.orgId, input.orgId),
        eq(schema.projectSessionEvents.projectId, input.projectId),
        eq(schema.projectSessionEvents.sessionId, input.sessionId),
        eq(schema.projectSessionEvents.creatorId, input.actor.id),
        sql`${schema.projectSessionEvents.sequence} > ${input.after ?? 0}`,
      ),
    )
    .orderBy(asc(schema.projectSessionEvents.sequence))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  return rows.map((row) => ({
    sequence: row.sequence,
    created_at: row.createdAt.toISOString(),
    event: projectSessionEventSchema.parse(row.event),
  }));
}

function toProjectFileRow(row: typeof schema.projectFiles.$inferSelect): ProjectFileRow {
  return {
    id: row.id,
    project_id: row.projectId,
    path: row.path,
    version: row.currentVersion,
    content_type: row.contentType,
    byte_size: row.byteSize,
    checksum: row.checksum,
    modified_by_session_id: row.modifiedBySessionId,
    modified_by_prompt_id: row.modifiedByPromptId,
    conflict_detected: row.conflictDetected,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function validateProjectFileUploads(files: CreateProjectFileUpload[]): void {
  if (files.length < 1 || files.length > PROJECT_ATTACHMENT_MAX_FILES) {
    throw new ProjectValidationError(
      `a Project upload must contain between 1 and ${PROJECT_ATTACHMENT_MAX_FILES} files`,
      "invalid_file_count",
    );
  }
  const paths = new Set<string>();
  for (const file of files) {
    if (
      !isManagedProjectFilePath(file.path)
      || paths.has(file.path)
      || file.byteSize < 1
      || file.byteSize > PROJECT_ATTACHMENT_MAX_BYTES
      || !/^sha256:[0-9a-f]{64}$/.test(file.checksum)
      || !file.contentType.trim()
      || !file.storageKey.trim()
    ) {
      throw new ProjectValidationError(
        "Project files must be unique, non-empty, 10 MB or smaller files/ paths",
        "invalid_file",
      );
    }
    paths.add(file.path);
  }
}

/**
 * Publish creator-uploaded bytes as the durable last-writer-wins files/ projection.
 *
 * S3 writes happen before this transaction. The transaction both consumes their ownership
 * reservations and advances the independent projection fence that a warm supervisor observes
 * between turns. No provider or OpenCode operation is reachable from this service.
 */
export async function commitProjectFileUploads(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  files: CreateProjectFileUpload[];
  database?: Db;
}): Promise<ProjectFileRow[]> {
  validateProjectFileUploads(input.files);
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const project = await loadOwnedProject({ ...input, database: tx, lock: true });
    assertProjectAcceptsWork(project);
    const workspaceRows = await tx
      .select()
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.orgId, input.orgId),
          eq(schema.projectWorkspaces.projectId, input.projectId),
          eq(schema.projectWorkspaces.creatorId, input.actor.id),
        ),
      )
      .for("update")
      .limit(1);
    const workspace = workspaceRows[0];
    if (!workspace) throw new ProjectNotFoundError();

    const output: ProjectFileRow[] = [];
    let changed = false;
    const now = new Date();
    for (const file of input.files) {
      const ownership = await tx
        .update(schema.projectAttachmentUploads)
        .set({ committedAt: now, touchedAt: now })
        .where(
          and(
            eq(schema.projectAttachmentUploads.storageKey, file.storageKey),
            eq(schema.projectAttachmentUploads.orgId, input.orgId),
            eq(schema.projectAttachmentUploads.projectId, input.projectId),
            eq(schema.projectAttachmentUploads.creatorId, input.actor.id),
            eq(schema.projectAttachmentUploads.kind, "file"),
            isNull(schema.projectAttachmentUploads.deleteRequestedAt),
          ),
        )
        .returning({ storageKey: schema.projectAttachmentUploads.storageKey });
      if (!ownership[0]) {
        throw new ProjectValidationError(
          "a Project file upload reservation is missing",
          "invalid_file",
        );
      }

      const existingRows = await tx
        .select()
        .from(schema.projectFiles)
        .where(
          and(
            eq(schema.projectFiles.orgId, input.orgId),
            eq(schema.projectFiles.projectId, input.projectId),
            eq(schema.projectFiles.creatorId, input.actor.id),
            eq(schema.projectFiles.path, file.path),
          ),
        )
        .for("update")
        .limit(1);
      const existing = existingRows[0];
      if (existing?.checksum === file.checksum && !existing.deletedAt) {
        output.push(toProjectFileRow(existing));
        continue;
      }

      const version = (existing?.currentVersion ?? 0) + 1;
      const fileId = existing?.id ?? randomUUID();
      const baseVersion = existing?.currentVersion ?? 0;
      const values = {
        contentType: file.contentType,
        byteSize: file.byteSize,
        checksum: file.checksum,
        storageKey: file.storageKey,
        modifiedBySessionId: null,
        modifiedByPromptId: null,
        deletedAt: null,
        updatedAt: now,
      };
      let current: typeof schema.projectFiles.$inferSelect;
      if (existing) {
        const rows = await tx
          .update(schema.projectFiles)
          .set({ ...values, currentVersion: version })
          .where(
            and(
              eq(schema.projectFiles.orgId, input.orgId),
              eq(schema.projectFiles.projectId, input.projectId),
              eq(schema.projectFiles.id, existing.id),
              eq(schema.projectFiles.creatorId, input.actor.id),
            ),
          )
          .returning();
        current = rows[0]!;
      } else {
        const rows = await tx
          .insert(schema.projectFiles)
          .values({
            id: fileId,
            orgId: input.orgId,
            projectId: input.projectId,
            creatorId: input.actor.id,
            path: file.path,
            currentVersion: version,
            conflictDetected: false,
            ...values,
          })
          .returning();
        current = rows[0]!;
      }
      await tx.insert(schema.projectFileVersions).values({
        orgId: input.orgId,
        projectId: input.projectId,
        fileId,
        creatorId: input.actor.id,
        version,
        contentType: file.contentType,
        byteSize: file.byteSize,
        checksum: file.checksum,
        storageKey: file.storageKey,
        modifiedBySessionId: null,
        modifiedByPromptId: null,
        baseVersion,
        conflictDetected: current.conflictDetected,
      });
      changed = true;
      output.push(toProjectFileRow(current));
    }

    if (changed) {
      await tx
        .update(schema.projectWorkspaces)
        .set({
          desiredFileRevision: workspace.desiredFileRevision + 1,
          availableAt: now,
          lastActivityAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.orgId),
            eq(schema.projectWorkspaces.projectId, input.projectId),
            eq(schema.projectWorkspaces.creatorId, input.actor.id),
          ),
        );
      await tx.insert(schema.auditLog).values({
        orgId: input.orgId,
        actorId: input.actor.id,
        privateToUserId: input.actor.id,
        action: "project.files.upload",
        targetType: "project",
        targetId: input.projectId,
        metadata: {
          paths: input.files.map((file) => file.path),
          file_count: input.files.length,
          desired_file_revision: workspace.desiredFileRevision + 1,
        },
      });
    }
    return output;
  }) as Promise<ProjectFileRow[]>;
}

export async function listProjectFiles(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  database?: Db;
}): Promise<ProjectFileRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await loadOwnedProject({ ...input, database });
  const rows = await database
    .select()
    .from(schema.projectFiles)
    .where(
      and(
        eq(schema.projectFiles.orgId, input.orgId),
        eq(schema.projectFiles.projectId, input.projectId),
        eq(schema.projectFiles.creatorId, input.actor.id),
        isNull(schema.projectFiles.deletedAt),
      ),
    )
    .orderBy(asc(schema.projectFiles.path));
  return rows.map(toProjectFileRow);
}

export async function getProjectFile(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  fileId: string;
  database?: Db;
}): Promise<ProjectFileDownload> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await loadOwnedProject({ ...input, database });
  const rows = await database
    .select()
    .from(schema.projectFiles)
    .where(
      and(
        eq(schema.projectFiles.orgId, input.orgId),
        eq(schema.projectFiles.projectId, input.projectId),
        eq(schema.projectFiles.id, input.fileId),
        eq(schema.projectFiles.creatorId, input.actor.id),
        isNull(schema.projectFiles.deletedAt),
      ),
    );
  const row = rows[0];
  if (!row) throw new ProjectNotFoundError("file not found");
  return {
    id: row.id,
    project_id: row.projectId,
    path: row.path,
    version: row.currentVersion,
    content_type: row.contentType,
    byte_size: row.byteSize,
    checksum: row.checksum,
    modified_by_session_id: row.modifiedBySessionId,
    modified_by_prompt_id: row.modifiedByPromptId,
    conflict_detected: row.conflictDetected,
    storage_key: row.storageKey,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface ProjectFileVersionDownload extends ProjectFileVersionRow {
  storage_key: string;
}

async function ownedProjectFileRecord(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  fileId: string;
  database: Db;
}) {
  await loadOwnedProject(input);
  const rows = await input.database
    .select({
      id: schema.projectFiles.id,
      path: schema.projectFiles.path,
    })
    .from(schema.projectFiles)
    .where(
      and(
        eq(schema.projectFiles.orgId, input.orgId),
        eq(schema.projectFiles.projectId, input.projectId),
        eq(schema.projectFiles.id, input.fileId),
        eq(schema.projectFiles.creatorId, input.actor.id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new ProjectNotFoundError("file not found");
  return rows[0];
}

export async function listProjectFileVersions(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  fileId: string;
  database?: Db;
}): Promise<ProjectFileVersionRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const file = await ownedProjectFileRecord({ ...input, database });
  const rows = await database
    .select()
    .from(schema.projectFileVersions)
    .where(
      and(
        eq(schema.projectFileVersions.orgId, input.orgId),
        eq(schema.projectFileVersions.projectId, input.projectId),
        eq(schema.projectFileVersions.fileId, input.fileId),
        eq(schema.projectFileVersions.creatorId, input.actor.id),
      ),
    )
    .orderBy(desc(schema.projectFileVersions.version));
  return rows.map((row) => ({
    project_id: row.projectId,
    file_id: row.fileId,
    path: file.path,
    version: row.version,
    content_type: row.contentType,
    byte_size: row.byteSize,
    checksum: row.checksum,
    modified_by_session_id: row.modifiedBySessionId,
    modified_by_prompt_id: row.modifiedByPromptId,
    base_version: row.baseVersion,
    conflict_detected: row.conflictDetected,
    created_at: row.createdAt.toISOString(),
  }));
}

export async function getProjectFileVersion(input: {
  actor: ActorContext;
  orgId: string;
  projectId: string;
  fileId: string;
  version: number;
  database?: Db;
}): Promise<ProjectFileVersionDownload> {
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new ProjectValidationError(
      "file version must be a positive integer",
      "invalid_file_version",
    );
  }
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const file = await ownedProjectFileRecord({ ...input, database });
  const rows = await database
    .select()
    .from(schema.projectFileVersions)
    .where(
      and(
        eq(schema.projectFileVersions.orgId, input.orgId),
        eq(schema.projectFileVersions.projectId, input.projectId),
        eq(schema.projectFileVersions.fileId, input.fileId),
        eq(schema.projectFileVersions.creatorId, input.actor.id),
        eq(schema.projectFileVersions.version, input.version),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new ProjectNotFoundError("file version not found");
  return {
    project_id: row.projectId,
    file_id: row.fileId,
    path: file.path,
    version: row.version,
    content_type: row.contentType,
    byte_size: row.byteSize,
    checksum: row.checksum,
    storage_key: row.storageKey,
    modified_by_session_id: row.modifiedBySessionId,
    modified_by_prompt_id: row.modifiedByPromptId,
    base_version: row.baseVersion,
    conflict_detected: row.conflictDetected,
    created_at: row.createdAt.toISOString(),
  };
}
