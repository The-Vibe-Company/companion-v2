import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type {
  ProjectAuthorityState,
  ProjectFileReconciliationJob,
  ProjectMaterializationPlan,
  ProjectModelProviderPin,
  ProjectPromptJob,
  ProjectSecretPin,
  ProjectSessionEvent,
  ProjectSessionStopJob,
  ProjectWorkspaceJob,
  ProjectWorkspaceStatus,
  RunChatHistoryItem,
} from "@companion/contracts";
import {
  PROJECT_SECRET_MAX,
  runChatEventSchema,
  runChatHistoryItemSchema,
} from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import {
  redactAndBoundProjectEvents,
  redactAndBoundProjectTranscript,
} from "./runRedaction";
import { decryptPinnedSecret, listSecrets } from "./secrets";
import { decryptOpaqueValue, encryptOpaqueValue, type OpaqueCiphertext } from "./secretsCrypto";
import { getDecryptedProviderKey } from "./providerConnections";

const PROJECT_OPENCODE_PASSWORD_PURPOSE = "project-opencode-password";
const DEFAULT_PROJECT_IDLE_MS = 10 * 60 * 1000;
const CONTROL_PLANE_ENV_KEYS = new Set([
  "DATABASE_URL",
  "DIRECT_URL",
  "PGPASSWORD",
  "BETTER_AUTH_SECRET",
  "AUTH_SECRET",
  "SESSION_SECRET",
  "COOKIE_SECRET",
  "VERCEL_TOKEN",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "RESEND_API_KEY",
]);
const CONTROL_PLANE_ENV_PREFIXES = [
  "OPENCODE_SERVER_",
  "COMPANION_",
  "PAT_",
  "BETTER_AUTH_",
  "AUTH_",
  "SESSION_",
  "COOKIE_",
  "VERCEL_",
  "MINIO_",
  "S3_",
  "POSTGRES_",
  "AGENT_AUTH_",
  "OAUTH_",
  "GITHUB_APP_",
  "GITHUB_CLIENT_",
  "STRIPE_",
  "GOOGLE_CLIENT_",
  "RESEND_",
  "EMAIL_",
];
const RESERVED_PROJECT_FILE_ROOTS = new Set([
  ".claude",
  ".companion",
  ".git",
  ".opencode",
]);

type RawWorkspaceClaim = {
  orgId: string;
  projectId: string;
  creatorId: string;
  status: ProjectWorkspaceStatus;
  sandboxName: string;
  sandboxId: string | null;
  sandboxDomain: string | null;
  checkpointId: string | null;
  checkpointGeneration: number;
  desiredGeneration: number;
  appliedGeneration: number;
  desiredFileRevision: number;
  appliedFileRevision: number;
  lastActivityAt: Date | string;
  idleDeadlineAt: Date | string | null;
  activationRevision: number;
  authorityRevision: string | null;
  activationAdmissionToken: string | null;
  activationAdmissionRevision: number | null;
  activationAdmissionAuthorityRevision: string | null;
  activationAdmittedAt: Date | string | null;
  environmentExposureAttemptedAt: Date | string | null;
  recycleRequestedAt: Date | string | null;
  recycleReason: string | null;
  skillSyncErrorAt: Date | string | null;
  skillSyncErrorCode: string | null;
  skillSyncErrorMessage: string | null;
  leaseGeneration: number;
  deleteRequestedAt: Date | string | null;
};

export class LostProjectWorkspaceLeaseError extends Error {
  constructor() {
    super("project workspace lease was lost");
    this.name = "LostProjectWorkspaceLeaseError";
  }
}

export class ProjectAuthorityRevokedError extends Error {
  readonly state: ProjectAuthorityState;

  constructor(state: ProjectAuthorityState) {
    super(`project runtime authority requires recycle: ${state.reason}`);
    this.name = "ProjectAuthorityRevokedError";
    this.state = state;
  }
}

/** Stable, non-secret admission failure for an environment that the creator can repair. */
export class ProjectEnvironmentInvalidError extends Error {
  readonly code = "project_environment_invalid";

  constructor() {
    super("Project environment configuration is invalid.");
    this.name = "ProjectEnvironmentInvalidError";
  }
}

export function isProjectControlPlaneEnvKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return (
    CONTROL_PLANE_ENV_KEYS.has(normalized) ||
    CONTROL_PLANE_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

export function isManagedProjectFilePath(path: string): boolean {
  if (
    !/^files\/[^\\\u0000-\u001f\u007f]+$/.test(path) ||
    path.includes("/../") ||
    path.endsWith("/..") ||
    path.includes("/./") ||
    path.includes("//")
  ) {
    return false;
  }
  const firstSegment = path.slice("files/".length).split("/", 1)[0]!.toLowerCase();
  return !RESERVED_PROJECT_FILE_ROOTS.has(firstSegment);
}

export function buildProjectAuthorityInputs(input: {
  creatorId: string;
  accessibleSecrets: Array<{
    id: string;
    key: string;
    currentVersion: number;
  }>;
  connections: Array<{
    id: string;
    provider: string;
    keyName: string;
    currentVersion: number;
    scope: "personal" | "organization";
    userId: string | null;
  }>;
}): {
  secrets: ProjectSecretPin[];
  modelProviders: ProjectModelProviderPin[];
  environmentInvalid: boolean;
} {
  // Most control-plane credentials are silently excluded. OpenCode server variables are special:
  // allowing a user secret with that namespace would override Companion's authenticated server.
  const reservedOpenCodeKey = input.accessibleSecrets.some((secret) =>
    secret.key.trim().toUpperCase().startsWith("OPENCODE_SERVER_"),
  );
  const available = input.accessibleSecrets.filter(
    (secret) => !isProjectControlPlaneEnvKey(secret.key),
  );
  const keys = new Set<string>();
  let environmentInvalid = reservedOpenCodeKey || available.length > PROJECT_SECRET_MAX;
  const secrets: ProjectSecretPin[] = [];
  for (const secret of available) {
    if (keys.has(secret.key)) environmentInvalid = true;
    keys.add(secret.key);
    secrets.push({
      envKey: secret.key,
      secretId: secret.id,
      secretVersion: secret.currentVersion,
    });
  }

  const authorizedConnections = input.connections.filter(
    (row) =>
      row.scope === "organization" ||
      (row.scope === "personal" && row.userId === input.creatorId),
  );
  const personal = new Map(
    authorizedConnections
      .filter(
        (row) => row.scope === "personal" && row.userId === input.creatorId,
      )
      .map((row) => [row.provider, row]),
  );
  const effective = new Map(
    authorizedConnections
      .filter((row) => row.scope === "organization")
      .map((row) => [row.provider, row]),
  );
  for (const [provider, row] of personal) effective.set(provider, row);
  const modelProviders: ProjectModelProviderPin[] = [];
  for (const row of effective.values()) {
    if (isProjectControlPlaneEnvKey(row.keyName) || keys.has(row.keyName)) {
      environmentInvalid = true;
    }
    keys.add(row.keyName);
    modelProviders.push({
      provider: row.provider,
      envKey: row.keyName,
      connectionId: row.id,
      credentialVersion: row.currentVersion,
      connectionScope: row.scope,
    });
  }
  return { secrets, modelProviders, environmentInvalid };
}

function authorityHash(input: {
  secrets: ProjectSecretPin[];
  modelProviders: ProjectModelProviderPin[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        secrets: [...input.secrets].sort((a, b) => a.envKey.localeCompare(b.envKey)),
        modelProviders: [...input.modelProviders].sort((a, b) =>
          a.provider.localeCompare(b.provider),
        ),
      }),
    )
    .digest("hex");
}

function canonicalPins<T>(pins: T[], key: (pin: T) => string): string {
  return JSON.stringify([...pins].sort((left, right) => key(left).localeCompare(key(right))));
}

export type ProjectPromptProviderAdmission =
  | "none"
  | "admitted"
  | "provider_unavailable";

export type ProjectPromptSendFenceResult =
  | "lost"
  | "recycle"
  | "provider_unavailable"
  | "marked";

/**
 * A session keeps the catalog's immutable credential declaration beside its immutable model.
 * Empty env keys are an explicit credentialless declaration; every other model must still have an
 * effective personal-then-organization connection for its provider at each admission boundary.
 */
export function isProjectSessionProviderAdmitted(input: {
  modelProvider: string;
  modelCredentialEnvKeys: string[];
  effectiveProviderKeys: ReadonlyMap<string, string>;
}): boolean {
  if (input.modelCredentialEnvKeys.length === 0) return true;
  const effectiveKey = input.effectiveProviderKeys.get(input.modelProvider);
  return Boolean(effectiveKey && input.modelCredentialEnvKeys.includes(effectiveKey));
}

/**
 * Pure half of the final prompt-send fence. The database path evaluates this decision while holding
 * the workspace row lock, so a credential/recycle signal either precedes the durable send marker or
 * follows it and is handled as an interruption of an already-admitted send.
 */
export function projectPromptSendFenceDecision(input: {
  recycleRequired: boolean;
  modelProvider: string;
  modelCredentialEnvKeys: string[];
  effectiveProviderKeys: ReadonlyMap<string, string>;
}): "admitted" | "recycle" | "provider_unavailable" {
  if (input.recycleRequired) return "recycle";
  return isProjectSessionProviderAdmitted(input)
    ? "admitted"
    : "provider_unavailable";
}

export async function loadEffectiveProjectProviderKeys(input: {
  database: Db;
  orgId: string;
  creatorId: string;
}): Promise<Map<string, string>> {
  const connections = await input.database
    .select()
    .from(schema.modelProviderConnections)
    .where(eq(schema.modelProviderConnections.orgId, input.orgId));
  return new Map(
    buildProjectAuthorityInputs({
      creatorId: input.creatorId,
      accessibleSecrets: [],
      connections,
    }).modelProviders.map((pin) => [pin.provider, pin.envKey]),
  );
}

function projectProviderAdmissionForSessions(
  sessions: Array<{
    modelProvider: string;
    modelCredentialEnvKeys: string[];
  }>,
  effectiveProviderKeys: ReadonlyMap<string, string>,
): ProjectPromptProviderAdmission {
  if (sessions.length === 0) return "none";
  return sessions.some((session) =>
    isProjectSessionProviderAdmitted({ ...session, effectiveProviderKeys }),
  )
    ? "admitted"
    : "provider_unavailable";
}

/**
 * Classify authority changes by the availability of the credential source already injected, not by
 * whether it remains the currently effective source. For example, adding a personal provider that
 * overrides a still-valid organization provider is a boundary update, while disconnecting the
 * injected organization provider is immediate.
 */
export function classifyProjectAuthorityChange(input: {
  currentSecrets: ProjectSecretPin[];
  pinnedSecrets: ProjectSecretPin[];
  availablePinnedSecretSources: ReadonlySet<string>;
  currentModels: ProjectModelProviderPin[];
  pinnedModels: ProjectModelProviderPin[];
  availablePinnedModelSources: ReadonlySet<string>;
  environmentInvalid: boolean;
}): Pick<ProjectAuthorityState, "recycleRequired" | "mode" | "reason"> {
  const secretSourceRevoked = input.pinnedSecrets.some(
    (pin) =>
      !input.availablePinnedSecretSources.has(
        `${pin.secretId}:${pin.secretVersion}`,
      ),
  );
  const modelSourceRevoked = input.pinnedModels.some(
    (pin) =>
      !input.availablePinnedModelSources.has(
        `${pin.connectionId}:${pin.credentialVersion}`,
      ),
  );
  if (secretSourceRevoked || modelSourceRevoked) {
    return {
      recycleRequired: true,
      mode: "immediate",
      reason: secretSourceRevoked
        ? "secrets_changed"
        : "model_connections_changed",
    };
  }

  const secretsChanged =
    canonicalPins(
      input.currentSecrets,
      (pin) => `${pin.envKey}:${pin.secretId}:${pin.secretVersion}`,
    ) !==
    canonicalPins(
      input.pinnedSecrets,
      (pin) => `${pin.envKey}:${pin.secretId}:${pin.secretVersion}`,
    );
  const modelsChanged =
    canonicalPins(
      input.currentModels,
      (pin) =>
        `${pin.provider}:${pin.envKey}:${pin.connectionId}:${pin.credentialVersion}:${pin.connectionScope}`,
    ) !==
    canonicalPins(
      input.pinnedModels,
      (pin) =>
        `${pin.provider}:${pin.envKey}:${pin.connectionId}:${pin.credentialVersion}:${pin.connectionScope}`,
    );
  if (input.environmentInvalid || secretsChanged || modelsChanged) {
    return {
      recycleRequired: true,
      mode: "boundary",
      reason: input.environmentInvalid
        ? "environment_invalid"
        : secretsChanged
          ? "secrets_changed"
          : "model_connections_changed",
    };
  }
  return {
    recycleRequired: false,
    mode: "current",
    reason: "current",
  };
}

async function currentProjectAuthority(input: {
  database: Db;
  job: ProjectWorkspaceJob;
  activationRevision: number;
}): Promise<
  ProjectAuthorityState & {
    secrets: ProjectSecretPin[];
    modelProviders: ProjectModelProviderPin[];
  }
> {
  const membership = await input.database
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.orgId, input.job.orgId),
        eq(schema.memberships.userId, input.job.creatorId),
      ),
    );
  if (!membership[0]) {
    return {
      authorityRevision: "membership-revoked",
      recycleRequired: true,
      mode: "immediate",
      reason: "membership_revoked",
      secrets: [],
      modelProviders: [],
    };
  }
  const actor = { id: input.job.creatorId, email: "", name: "" };
  const accessible = (await listSecrets({
    actor,
    orgId: input.job.orgId,
    database: input.database,
  })).filter(
    (secret) =>
      secret.can_use &&
      !secret.disabled_at &&
      !secret.deleted_at,
  );
  const connections = await input.database
    .select()
    .from(schema.modelProviderConnections)
    .where(eq(schema.modelProviderConnections.orgId, input.job.orgId));
  const {
    secrets,
    modelProviders,
    environmentInvalid: invalid,
  } = buildProjectAuthorityInputs({
    creatorId: input.job.creatorId,
    accessibleSecrets: accessible.map((secret) => ({
      id: secret.id,
      key: secret.key,
      currentVersion: secret.current_version,
    })),
    connections,
  });
  const authorizedConnections = connections.filter(
    (row) =>
      row.scope === "organization" ||
      (row.scope === "personal" && row.userId === input.job.creatorId),
  );
  const authorityRevision = authorityHash({ secrets, modelProviders });
  if (input.activationRevision < 1) {
    return {
      authorityRevision,
      recycleRequired: true,
      mode: "boundary",
      reason: invalid ? "environment_invalid" : "not_activated",
      secrets,
      modelProviders,
    };
  }
  const [pinnedSecrets, pinnedModels] = await Promise.all([
    input.database
      .select({
        envKey: schema.projectSecretInputs.envKey,
        secretId: schema.projectSecretInputs.secretId,
        secretVersion: schema.projectSecretInputs.secretVersion,
        injectedAt: schema.projectSecretInputs.injectedAt,
      })
      .from(schema.projectSecretInputs)
      .where(
        and(
          eq(schema.projectSecretInputs.orgId, input.job.orgId),
          eq(schema.projectSecretInputs.projectId, input.job.projectId),
          eq(schema.projectSecretInputs.creatorId, input.job.creatorId),
          eq(
            schema.projectSecretInputs.activationRevision,
            input.activationRevision,
          ),
        ),
      ),
    input.database
      .select({
        provider: schema.projectModelProviderInputs.provider,
        envKey: schema.projectModelProviderInputs.envKey,
        connectionId: schema.projectModelProviderInputs.connectionId,
        credentialVersion: schema.projectModelProviderInputs.credentialVersion,
        connectionScope: schema.projectModelProviderInputs.connectionScope,
        injectedAt: schema.projectModelProviderInputs.injectedAt,
      })
      .from(schema.projectModelProviderInputs)
      .where(
        and(
          eq(schema.projectModelProviderInputs.orgId, input.job.orgId),
          eq(schema.projectModelProviderInputs.projectId, input.job.projectId),
          eq(schema.projectModelProviderInputs.creatorId, input.job.creatorId),
          eq(
            schema.projectModelProviderInputs.activationRevision,
            input.activationRevision,
          ),
        ),
      ),
  ]);
  const comparisonSecrets: ProjectSecretPin[] = pinnedSecrets.map((pin) => ({
    envKey: pin.envKey,
    secretId: pin.secretId,
    secretVersion: pin.secretVersion,
  }));
  const comparisonModels: ProjectModelProviderPin[] = pinnedModels.map((pin) => ({
    provider: pin.provider,
    envKey: pin.envKey,
    connectionId: pin.connectionId,
    credentialVersion: pin.credentialVersion,
    connectionScope: pin.connectionScope,
  }));
  const activationWasInjected = [...pinnedSecrets, ...pinnedModels].some(
    (pin) => pin.injectedAt !== null,
  );
  const [secretVersionRows, modelVersionRows] = await Promise.all([
    pinnedSecrets.length === 0
      ? Promise.resolve([])
      : input.database
          .select({
            secretId: schema.secretVersions.secretId,
            version: schema.secretVersions.version,
          })
          .from(schema.secretVersions)
          .where(
            and(
              eq(schema.secretVersions.orgId, input.job.orgId),
              inArray(
                schema.secretVersions.secretId,
                pinnedSecrets.map((pin) => pin.secretId),
              ),
            ),
          ),
    pinnedModels.length === 0
      ? Promise.resolve([])
      : input.database
          .select({
            connectionId: schema.modelProviderCredentialVersions.connectionId,
            version: schema.modelProviderCredentialVersions.version,
          })
          .from(schema.modelProviderCredentialVersions)
          .where(
            and(
              eq(
                schema.modelProviderCredentialVersions.orgId,
                input.job.orgId,
              ),
              inArray(
                schema.modelProviderCredentialVersions.connectionId,
                pinnedModels.map((pin) => pin.connectionId),
              ),
            ),
          ),
  ]);
  const accessibleSecretIds = new Set(accessible.map((secret) => secret.id));
  const availablePinnedSecretSources = activationWasInjected
    ? new Set(
        secretVersionRows
          .filter((row) => accessibleSecretIds.has(row.secretId))
          .map((row) => `${row.secretId}:${row.version}`),
      )
    : new Set(
        comparisonSecrets.map((pin) => `${pin.secretId}:${pin.secretVersion}`),
      );
  const authorizedConnectionIds = new Set(
    authorizedConnections.map((connection) => connection.id),
  );
  const availablePinnedModelSources = activationWasInjected
    ? new Set(
        modelVersionRows
          .filter((row) => authorizedConnectionIds.has(row.connectionId))
          .map((row) => `${row.connectionId}:${row.version}`),
      )
    : new Set(
        comparisonModels.map(
          (pin) => `${pin.connectionId}:${pin.credentialVersion}`,
        ),
      );
  const classification = classifyProjectAuthorityChange({
    currentSecrets: secrets,
    pinnedSecrets: comparisonSecrets,
    availablePinnedSecretSources,
    currentModels: modelProviders,
    pinnedModels: comparisonModels,
    availablePinnedModelSources,
    environmentInvalid: invalid,
  });
  return {
    authorityRevision,
    ...classification,
    secrets,
    modelProviders,
  };
}

function date(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function workspaceJob(row: RawWorkspaceClaim): ProjectWorkspaceJob {
  return {
    ...row,
    deleteRequestedAt: date(row.deleteRequestedAt),
    lastActivityAt: date(row.lastActivityAt)!,
    idleDeadlineAt: date(row.idleDeadlineAt),
    activationAdmittedAt: date(row.activationAdmittedAt),
    environmentExposureAttemptedAt: date(row.environmentExposureAttemptedAt),
    recycleRequestedAt: date(row.recycleRequestedAt),
    skillSyncErrorAt: date(row.skillSyncErrorAt),
  };
}

async function enterWorkspaceLease(input: {
  database: Db;
  job: Pick<ProjectWorkspaceJob, "orgId" | "projectId" | "creatorId" | "leaseGeneration">;
  workerId: string;
}): Promise<void> {
  const result = await input.database.execute(sql`
    select companion_enter_project_worker_lease(
      ${input.job.orgId}::uuid,
      ${input.job.projectId}::uuid,
      ${input.job.creatorId},
      ${input.workerId},
      ${input.job.leaseGeneration}
    ) as entered
  `);
  const row = Array.from(result as unknown as Iterable<{ entered: boolean }>)[0];
  if (row?.entered !== true) throw new LostProjectWorkspaceLeaseError();
}

async function withWorkspaceLease<T>(input: {
  database: Db;
  job: Pick<ProjectWorkspaceJob, "orgId" | "projectId" | "creatorId" | "leaseGeneration">;
  workerId: string;
  fn: (database: Db) => Promise<T>;
}): Promise<T> {
  return input.database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await enterWorkspaceLease({ ...input, database: tx });
    return input.fn(tx);
  }) as Promise<T>;
}

async function readCurrentWorkspaceState(input: {
  database: Db;
  job: Pick<ProjectWorkspaceJob, "orgId" | "projectId" | "creatorId" | "leaseGeneration">;
  workerId: string;
}): Promise<{
  desiredGeneration: number;
  appliedGeneration: number;
  desiredFileRevision: number;
  appliedFileRevision: number;
  checkpointGeneration: number;
  activationRevision: number;
  authorityRevision: string | null;
  activationAdmissionToken: string | null;
  activationAdmissionRevision: number | null;
  activationAdmissionAuthorityRevision: string | null;
  recycleRequestedAt: Date | null;
  recycleReason: string | null;
}> {
  const rows = await input.database
    .select({
      desiredGeneration: schema.projectWorkspaces.desiredGeneration,
      appliedGeneration: schema.projectWorkspaces.appliedGeneration,
      desiredFileRevision: schema.projectWorkspaces.desiredFileRevision,
      appliedFileRevision: schema.projectWorkspaces.appliedFileRevision,
      checkpointGeneration: schema.projectWorkspaces.checkpointGeneration,
      activationRevision: schema.projectWorkspaces.activationRevision,
      authorityRevision: schema.projectWorkspaces.authorityRevision,
      activationAdmissionToken: schema.projectWorkspaces.activationAdmissionToken,
      activationAdmissionRevision: schema.projectWorkspaces.activationAdmissionRevision,
      activationAdmissionAuthorityRevision:
        schema.projectWorkspaces.activationAdmissionAuthorityRevision,
      recycleRequestedAt: schema.projectWorkspaces.recycleRequestedAt,
      recycleReason: schema.projectWorkspaces.recycleReason,
    })
    .from(schema.projectWorkspaces)
    .where(
      and(
        eq(schema.projectWorkspaces.orgId, input.job.orgId),
        eq(schema.projectWorkspaces.projectId, input.job.projectId),
        eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
        eq(schema.projectWorkspaces.leaseOwner, input.workerId),
        eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new LostProjectWorkspaceLeaseError();
  return rows[0];
}

export async function heartbeatProjectWorker(input: {
  workerId: string;
  ttlSeconds?: number;
  protocolVersion?: number;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await database.execute(sql`
    select companion_heartbeat_project_worker(
      ${input.workerId},
      ${input.ttlSeconds ?? 15},
      ${input.protocolVersion ?? 1}
    )
  `);
}

export async function removeProjectWorkerHeartbeat(input: {
  workerId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await database.execute(sql`select companion_remove_project_worker(${input.workerId})`);
}

export async function isProjectWorkerReady(
  input: { database?: Db } = {},
): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(
    sql`select companion_project_worker_ready() as ready`,
  );
  const row = Array.from(result as unknown as Iterable<{ ready: boolean }>)[0];
  return row?.ready ?? false;
}

export async function signalProjectSecretChange(input: {
  orgId: string;
  secretId: string;
  mode: "boundary" | "immediate";
  changeKind?: "projection" | "create" | "rotate" | "key_acl" | "delete" | "disable";
  previous?: {
    key: string;
    audience: "personal" | "restricted" | "organization";
    recipientIds: string[];
  };
  /** Supply when the caller is not already inside withTenantContext (service-level tests included). */
  actorId?: string;
  database?: Db;
}): Promise<number> {
  const database = input.database ?? db;
  const executeSignal = async (tx: Db): Promise<number> => {
    const previousRecipientsJson = input.previous
      ? JSON.stringify(input.previous.recipientIds)
      : null;
    const result = await tx.execute(sql`
      select companion_signal_project_secret_change(
        ${input.orgId}::uuid,
        ${input.secretId}::uuid,
        ${input.mode},
        ${input.changeKind ?? "projection"},
        ${input.previous?.key ?? null},
        ${input.previous?.audience ?? null}::secret_audience,
        CASE
          WHEN ${previousRecipientsJson}::text IS NULL THEN NULL
          ELSE ARRAY(
            SELECT jsonb_array_elements_text(${previousRecipientsJson}::jsonb)
          )
        END
      ) as changed
    `);
    const row = Array.from(result as unknown as Iterable<{ changed: number }>)[0];
    return Number(row?.changed ?? 0);
  };
  if (!input.actorId) return executeSignal(database);
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const previous = await tx.execute(sql`
      select current_setting('app.org_id', true) as "orgId",
             current_setting('app.user_id', true) as "userId"
    `);
    const context = Array.from(
      previous as unknown as Iterable<{ orgId: string | null; userId: string | null }>,
    )[0];
    await tx.execute(sql`
      select set_config('app.org_id', ${input.orgId}, true),
             set_config('app.user_id', ${input.actorId}, true)
    `);
    const changed = await executeSignal(tx);
    await tx.execute(sql`
      select set_config('app.org_id', ${context?.orgId ?? ""}, true),
             set_config('app.user_id', ${context?.userId ?? ""}, true)
    `);
    return changed;
  });
}

export async function signalProjectProviderChange(input: {
  orgId: string;
  provider: string;
  connectionId: string;
  scope: "personal" | "organization";
  userId: string | null;
  mode: "boundary" | "immediate";
  actorId?: string;
  database?: Db;
}): Promise<number> {
  const database = input.database ?? db;
  const executeSignal = async (tx: Db): Promise<number> => {
    const result = await tx.execute(sql`
      select companion_signal_project_provider_change(
        ${input.orgId}::uuid,
        ${input.provider},
        ${input.connectionId}::uuid,
        ${input.scope}::model_provider_connection_scope,
        ${input.userId},
        ${input.mode}
      ) as changed
    `);
    const row = Array.from(result as unknown as Iterable<{ changed: number }>)[0];
    return Number(row?.changed ?? 0);
  };
  if (!input.actorId) return executeSignal(database);
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const previous = await tx.execute(sql`
      select current_setting('app.org_id', true) as "orgId",
             current_setting('app.user_id', true) as "userId"
    `);
    const context = Array.from(
      previous as unknown as Iterable<{ orgId: string | null; userId: string | null }>,
    )[0];
    await tx.execute(sql`
      select set_config('app.org_id', ${input.orgId}, true),
             set_config('app.user_id', ${input.actorId}, true)
    `);
    const changed = await executeSignal(tx);
    await tx.execute(sql`
      select set_config('app.org_id', ${context?.orgId ?? ""}, true),
             set_config('app.user_id', ${context?.userId ?? ""}, true)
    `);
    return changed;
  });
}

/** Cross-tenant claim through the narrow SECURITY DEFINER function installed by migration 0054. */
export async function claimProjectWorkspaceJobs(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  database?: Db;
}): Promise<ProjectWorkspaceJob[]> {
  const database = input.database ?? db;
  const limit = input.limit ?? 1;
  const leaseSeconds = input.leaseSeconds ?? 30;
  if (!input.workerId.trim()) throw new Error("worker id is required");
  if (limit < 1 || limit > 32 || leaseSeconds < 5 || leaseSeconds > 300) {
    throw new Error("invalid project workspace claim limits");
  }
  const result = await database.execute(sql`
    select
      claimed."org_id" as "orgId",
      claimed."project_id" as "projectId",
      claimed."creator_id" as "creatorId",
      claimed."status",
      claimed."sandbox_name" as "sandboxName",
      claimed."sandbox_id" as "sandboxId",
      claimed."sandbox_domain" as "sandboxDomain",
      claimed."checkpoint_id" as "checkpointId",
      claimed."checkpoint_generation" as "checkpointGeneration",
      claimed."desired_generation" as "desiredGeneration",
      claimed."applied_generation" as "appliedGeneration",
      claimed."desired_file_revision" as "desiredFileRevision",
      claimed."applied_file_revision" as "appliedFileRevision",
      claimed."last_activity_at" as "lastActivityAt",
      claimed."idle_deadline_at" as "idleDeadlineAt",
      claimed."activation_revision" as "activationRevision",
      claimed."authority_revision" as "authorityRevision",
      claimed."activation_admission_token" as "activationAdmissionToken",
      claimed."activation_admission_revision" as "activationAdmissionRevision",
      claimed."activation_admission_authority_revision" as "activationAdmissionAuthorityRevision",
      claimed."activation_admitted_at" as "activationAdmittedAt",
      claimed."environment_exposure_attempted_at" as "environmentExposureAttemptedAt",
      claimed."recycle_requested_at" as "recycleRequestedAt",
      claimed."recycle_reason" as "recycleReason",
      claimed."skill_sync_error_at" as "skillSyncErrorAt",
      claimed."skill_sync_error_code" as "skillSyncErrorCode",
      claimed."skill_sync_error_message" as "skillSyncErrorMessage",
      claimed."lease_generation" as "leaseGeneration",
      claimed."delete_requested_at" as "deleteRequestedAt"
    from companion_claim_project_workspaces(
      ${input.workerId},
      ${limit},
      ${leaseSeconds}
    ) as claimed
  `);
  return Array.from(result as unknown as Iterable<RawWorkspaceClaim>, workspaceJob);
}

export async function heartbeatProjectWorkspaceLease(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  leaseSeconds?: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const leaseSeconds = input.leaseSeconds ?? 30;
  if (leaseSeconds < 5 || leaseSeconds > 300) throw new Error("invalid project lease duration");
  try {
    return await withWorkspaceLease({
      ...input,
      database,
      fn: async (tx) => {
        const rows = await tx
          .update(schema.projectWorkspaces)
          .set({
            heartbeatAt: sql`clock_timestamp()`,
            leaseExpiresAt: sql`clock_timestamp() + make_interval(secs => ${leaseSeconds})`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectWorkspaces.orgId, input.job.orgId),
              eq(schema.projectWorkspaces.projectId, input.job.projectId),
              eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
              eq(schema.projectWorkspaces.leaseOwner, input.workerId),
              eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
            ),
          )
          .returning({ projectId: schema.projectWorkspaces.projectId });
        return Boolean(rows[0]);
      },
    });
  } catch (error) {
    if (error instanceof LostProjectWorkspaceLeaseError) return false;
    throw error;
  }
}

export async function releaseProjectWorkspaceLease(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  delayMs?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  try {
    return await withWorkspaceLease({
      ...input,
      database,
      fn: async (tx) => {
        const rows = await tx
          .update(schema.projectWorkspaces)
          .set({
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            availableAt: new Date(Date.now() + Math.max(0, input.delayMs ?? 0)),
            ...(input.errorCode !== undefined ? { lastErrorCode: input.errorCode } : {}),
            ...(input.errorMessage !== undefined
              ? { lastErrorMessage: input.errorMessage }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectWorkspaces.orgId, input.job.orgId),
              eq(schema.projectWorkspaces.projectId, input.job.projectId),
              eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
              eq(schema.projectWorkspaces.leaseOwner, input.workerId),
              eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
            ),
          )
          .returning({ projectId: schema.projectWorkspaces.projectId });
        return Boolean(rows[0]);
      },
    });
  } catch (error) {
    if (error instanceof LostProjectWorkspaceLeaseError) return false;
    throw error;
  }
}

export async function loadProjectMaterializationPlan(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<ProjectMaterializationPlan> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const workspace = await readCurrentWorkspaceState({
        database: tx,
        job: input.job,
        workerId: input.workerId,
      });
      const [snapshots, skills, versions, secretRows, modelRows, files] = await Promise.all([
        tx
          .select()
          .from(schema.projectSkillSnapshots)
          .where(
            and(
              eq(schema.projectSkillSnapshots.orgId, input.job.orgId),
              eq(schema.projectSkillSnapshots.projectId, input.job.projectId),
              eq(schema.projectSkillSnapshots.creatorId, input.job.creatorId),
              eq(
                schema.projectSkillSnapshots.generation,
                workspace.desiredGeneration,
              ),
            ),
          )
          .orderBy(
            asc(schema.projectSkillSnapshots.rootSkillId),
            asc(schema.projectSkillSnapshots.mountOrder),
          ),
        tx
          .select({ id: schema.skills.id, slug: schema.skills.slug })
          .from(schema.skills)
          .where(eq(schema.skills.orgId, input.job.orgId)),
        tx
          .select({ id: schema.skillVersions.id, version: schema.skillVersions.version })
          .from(schema.skillVersions)
          .where(eq(schema.skillVersions.orgId, input.job.orgId)),
        tx
          .select()
          .from(schema.projectSecretInputs)
          .where(
            and(
              eq(schema.projectSecretInputs.orgId, input.job.orgId),
              eq(schema.projectSecretInputs.projectId, input.job.projectId),
              eq(schema.projectSecretInputs.creatorId, input.job.creatorId),
              eq(
                schema.projectSecretInputs.activationRevision,
                workspace.activationRevision,
              ),
            ),
          ),
        tx
          .select()
          .from(schema.projectModelProviderInputs)
          .where(
            and(
              eq(schema.projectModelProviderInputs.orgId, input.job.orgId),
              eq(schema.projectModelProviderInputs.projectId, input.job.projectId),
              eq(schema.projectModelProviderInputs.creatorId, input.job.creatorId),
              eq(
                schema.projectModelProviderInputs.activationRevision,
                workspace.activationRevision,
              ),
            ),
          ),
        tx
          .select({
            storageKey: schema.projectFiles.storageKey,
            workspacePath: schema.projectFiles.path,
            checksum: schema.projectFiles.checksum,
          })
          .from(schema.projectFiles)
          .where(
            and(
              eq(schema.projectFiles.orgId, input.job.orgId),
              eq(schema.projectFiles.projectId, input.job.projectId),
              eq(schema.projectFiles.creatorId, input.job.creatorId),
              isNull(schema.projectFiles.deletedAt),
            ),
          )
          .orderBy(asc(schema.projectFiles.path)),
      ]);
      const slugById = new Map(skills.map((row) => [row.id, row.slug]));
      const versionById = new Map(versions.map((row) => [row.id, row.version]));
      const materializedSnapshots: typeof snapshots = [];
      const projectedVersionBySkill = new Map<string, string>();
      for (const row of snapshots) {
        const projectedVersion = projectedVersionBySkill.get(row.skillId);
        if (projectedVersion && projectedVersion !== row.skillVersionId) {
          throw new Error("Project skill projection contains incompatible dependency versions");
        }
        if (projectedVersion) continue;
        projectedVersionBySkill.set(row.skillId, row.skillVersionId);
        materializedSnapshots.push(row);
      }
      return {
        projectId: input.job.projectId,
        creatorId: input.job.creatorId,
        desiredGeneration: workspace.desiredGeneration,
        appliedGeneration: workspace.appliedGeneration,
        desiredFileRevision: workspace.desiredFileRevision,
        appliedFileRevision: workspace.appliedFileRevision,
        checkpointGeneration: workspace.checkpointGeneration,
        generation: workspace.desiredGeneration,
        skills: materializedSnapshots.map((row) => ({
          rootSkillId: row.rootSkillId,
          skillId: row.skillId,
          skillVersionId: row.skillVersionId,
          slug: slugById.get(row.skillId) ?? row.skillId,
          version: versionById.get(row.skillVersionId) ?? row.skillVersionId,
          mountOrder: row.mountOrder,
          checksum: row.checksum,
          storagePath: row.storagePath,
        })),
        secrets: secretRows.map((row) => ({
          envKey: row.envKey,
          secretId: row.secretId,
          secretVersion: row.secretVersion,
        })),
        modelProviders: modelRows.map((row) => ({
          provider: row.provider,
          envKey: row.envKey,
          connectionId: row.connectionId,
          credentialVersion: row.credentialVersion,
          connectionScope: row.connectionScope,
        })),
        bootstrapFiles: files,
      };
    },
  });
}

/**
 * Linearize a secretless provider create/resume without holding a database transaction open over
 * network I/O. Secret/provider signals treat the durable token as admitted work and set the
 * recycle fence when a later mutation wins the ordering.
 */
export async function beginProjectActivationAdmission(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  activationRevision: number;
  database?: Db;
}): Promise<{
  token: string;
  authorityRevision: string;
  activationRevision: number;
}> {
  const database = input.database ?? db;
  if (input.activationRevision !== input.job.activationRevision + 1) {
    throw new Error("activation admission revision must follow the active revision");
  }
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const workspace = await readCurrentWorkspaceState({
        database: tx,
        job: input.job,
        workerId: input.workerId,
      });
      if (
        workspace.activationRevision + 1 !== input.activationRevision
        || workspace.recycleRequestedAt
      ) {
        throw new ProjectAuthorityRevokedError({
          authorityRevision: workspace.authorityRevision ?? "",
          recycleRequired: true,
          mode: "immediate",
          reason: workspace.recycleRequestedAt
            ? "recycle_requested"
            : "activation_changed",
        });
      }
      const authority = await currentProjectAuthority({
        database: tx,
        job: input.job,
        activationRevision: workspace.activationRevision,
      });
      if (authority.reason === "membership_revoked") {
        throw new ProjectAuthorityRevokedError(authority);
      }
      if (authority.reason === "environment_invalid") {
        throw new ProjectEnvironmentInvalidError();
      }
      if (
        workspace.activationAdmissionToken
        && workspace.activationAdmissionRevision === input.activationRevision
        && workspace.activationAdmissionAuthorityRevision === authority.authorityRevision
      ) {
        return {
          token: workspace.activationAdmissionToken,
          authorityRevision: authority.authorityRevision,
          activationRevision: input.activationRevision,
        };
      }

      // A retry may replace a never-exposed stale admission. The named provider activation is
      // secretless until prepareProjectActivationInputs consumes this exact token.
      const token = randomUUID();
      const admittedAt = new Date();
      const rows = await tx
        .update(schema.projectWorkspaces)
        .set({
          activationAdmissionToken: token,
          activationAdmissionRevision: input.activationRevision,
          activationAdmissionAuthorityRevision: authority.authorityRevision,
          activationAdmittedAt: admittedAt,
          updatedAt: admittedAt,
        })
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.job.orgId),
            eq(schema.projectWorkspaces.projectId, input.job.projectId),
            eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
            eq(schema.projectWorkspaces.leaseOwner, input.workerId),
            eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
            eq(schema.projectWorkspaces.activationRevision, workspace.activationRevision),
            isNull(schema.projectWorkspaces.recycleRequestedAt),
          ),
        )
        .returning({ projectId: schema.projectWorkspaces.projectId });
      if (!rows[0]) throw new LostProjectWorkspaceLeaseError();
      return {
        token,
        authorityRevision: authority.authorityRevision,
        activationRevision: input.activationRevision,
      };
    },
  });
}

/** Clear only the caller's exact, never-consumed admission after provider activation did not run. */
export async function cancelProjectActivationAdmission(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  activationRevision: number;
  admissionToken: string;
  /** Safe only before first provision, or after provider observation proved the named VM missing. */
  resetFreshRecycle?: boolean;
  database?: Db;
}): Promise<"cancelled" | "fresh_requeued" | "not_found"> {
  const database = input.database ?? db;
  try {
    return await withWorkspaceLease({
      ...input,
      database,
      fn: async (tx) => {
        if (input.resetFreshRecycle) {
          const reset = await tx
            .update(schema.projectWorkspaces)
            .set({
              status: "queued",
              activationAdmissionToken: null,
              activationAdmissionRevision: null,
              activationAdmissionAuthorityRevision: null,
              activationAdmittedAt: null,
              recycleRequestedAt: null,
              recycleReason: null,
              attempt: 0,
              lastErrorCode: null,
              lastErrorMessage: null,
              availableAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.projectWorkspaces.orgId, input.job.orgId),
                eq(schema.projectWorkspaces.projectId, input.job.projectId),
                eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
                eq(schema.projectWorkspaces.leaseOwner, input.workerId),
                eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
                eq(schema.projectWorkspaces.activationRevision, 0),
                isNull(schema.projectWorkspaces.sandboxId),
                isNull(schema.projectWorkspaces.checkpointId),
                isNull(schema.projectWorkspaces.environmentExposureAttemptedAt),
                eq(schema.projectWorkspaces.activationAdmissionToken, input.admissionToken),
                eq(schema.projectWorkspaces.activationAdmissionRevision, input.activationRevision),
              ),
            )
            .returning({ projectId: schema.projectWorkspaces.projectId });
          if (reset[0]) return "fresh_requeued";
        }
        const rows = await tx
          .update(schema.projectWorkspaces)
          .set({
            activationAdmissionToken: null,
            activationAdmissionRevision: null,
            activationAdmissionAuthorityRevision: null,
            activationAdmittedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectWorkspaces.orgId, input.job.orgId),
              eq(schema.projectWorkspaces.projectId, input.job.projectId),
              eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
              eq(schema.projectWorkspaces.leaseOwner, input.workerId),
              eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
              eq(schema.projectWorkspaces.activationRevision, input.job.activationRevision),
              eq(schema.projectWorkspaces.activationAdmissionToken, input.admissionToken),
              eq(
                schema.projectWorkspaces.activationAdmissionRevision,
                input.activationRevision,
              ),
            ),
          )
          .returning({ projectId: schema.projectWorkspaces.projectId });
        return rows[0] ? "cancelled" : "not_found";
      },
    });
  } catch (error) {
    if (error instanceof LostProjectWorkspaceLeaseError) return "not_found";
    throw error;
  }
}

/**
 * Consume the exact provider-admission fence, revalidate the creator's complete accessible vault
 * and effective model connections, then pin metadata for one activation. Plaintext remains outside
 * PostgreSQL. This is the final race-closing boundary before credential injection.
 */
export async function prepareProjectActivationInputs(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  activationRevision: number;
  admissionToken: string;
  database?: Db;
}): Promise<{
  secrets: ProjectSecretPin[];
  modelProviders: ProjectModelProviderPin[];
  authorityRevision: string;
  activationRevision: number;
}> {
  const database = input.database ?? db;
  if (input.activationRevision < 1) throw new Error("activation revision must be positive");
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const workspace = await readCurrentWorkspaceState({
        database: tx,
        job: input.job,
        workerId: input.workerId,
      });
      if (workspace.recycleRequestedAt) {
        throw new ProjectAuthorityRevokedError({
          authorityRevision: workspace.authorityRevision ?? "",
          recycleRequired: true,
          mode: workspace.recycleReason?.startsWith("boundary:")
            ? "boundary"
            : "immediate",
          reason: "recycle_requested",
        });
      }
      if (
        workspace.activationAdmissionToken !== input.admissionToken
        || workspace.activationAdmissionRevision !== input.activationRevision
        || !workspace.activationAdmissionAuthorityRevision
      ) {
        throw new ProjectAuthorityRevokedError({
          authorityRevision: workspace.authorityRevision ?? "",
          recycleRequired: true,
          mode: "immediate",
          reason: "activation_changed",
        });
      }
      const authority = await currentProjectAuthority({
        database: tx,
        job: input.job,
        activationRevision: workspace.activationRevision,
      });
      if (authority.reason === "environment_invalid") {
        throw new ProjectEnvironmentInvalidError();
      }
      if (authority.reason === "membership_revoked") {
        throw new ProjectAuthorityRevokedError(authority);
      }
      if (
        authority.authorityRevision
        !== workspace.activationAdmissionAuthorityRevision
      ) {
        throw new ProjectAuthorityRevokedError({
          authorityRevision: authority.authorityRevision,
          recycleRequired: true,
          mode: "boundary",
          reason: "secrets_changed",
        });
      }
      const secretPins = authority.secrets;
      const modelPins = authority.modelProviders;
      await tx
        .delete(schema.projectSecretInputs)
        .where(
          and(
            eq(schema.projectSecretInputs.orgId, input.job.orgId),
            eq(schema.projectSecretInputs.projectId, input.job.projectId),
            eq(schema.projectSecretInputs.creatorId, input.job.creatorId),
            eq(
              schema.projectSecretInputs.activationRevision,
              input.activationRevision,
            ),
          ),
        );
      await tx
        .delete(schema.projectModelProviderInputs)
        .where(
          and(
            eq(schema.projectModelProviderInputs.orgId, input.job.orgId),
            eq(schema.projectModelProviderInputs.projectId, input.job.projectId),
            eq(schema.projectModelProviderInputs.creatorId, input.job.creatorId),
            eq(
              schema.projectModelProviderInputs.activationRevision,
              input.activationRevision,
            ),
          ),
        );
      if (secretPins.length > 0) {
        const names = await tx
          .select({ id: schema.secrets.id, name: schema.secrets.name })
          .from(schema.secrets)
          .where(
            and(
              eq(schema.secrets.orgId, input.job.orgId),
              inArray(
                schema.secrets.id,
                secretPins.map((pin) => pin.secretId),
              ),
            ),
          );
        const nameById = new Map(names.map((secret) => [secret.id, secret.name]));
        await tx.insert(schema.projectSecretInputs).values(
          secretPins.map((pin) => ({
            orgId: input.job.orgId,
            projectId: input.job.projectId,
            creatorId: input.job.creatorId,
            activationRevision: input.activationRevision,
            envKey: pin.envKey,
            secretId: pin.secretId,
            secretVersion: pin.secretVersion,
            secretNameSnapshot: nameById.get(pin.secretId) ?? "Secret",
          })),
        );
      }
      if (modelPins.length > 0) {
        await tx.insert(schema.projectModelProviderInputs).values(
          modelPins.map((pin) => ({
            orgId: input.job.orgId,
            projectId: input.job.projectId,
            creatorId: input.job.creatorId,
            activationRevision: input.activationRevision,
            provider: pin.provider,
            envKey: pin.envKey,
            connectionId: pin.connectionId,
            credentialVersion: pin.credentialVersion,
            connectionScope: pin.connectionScope,
          })),
        );
      }
      const updatedWorkspaces = await tx
        .update(schema.projectWorkspaces)
        .set({
          authorityRevision: authority.authorityRevision,
          activationRevision: input.activationRevision,
          activationAdmissionToken: null,
          activationAdmissionRevision: null,
          activationAdmissionAuthorityRevision: null,
          activationAdmittedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.job.orgId),
            eq(schema.projectWorkspaces.projectId, input.job.projectId),
            eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
            eq(schema.projectWorkspaces.leaseOwner, input.workerId),
            eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
            eq(schema.projectWorkspaces.activationAdmissionToken, input.admissionToken),
            eq(
              schema.projectWorkspaces.activationAdmissionRevision,
              input.activationRevision,
            ),
            // A concurrent secret/provider signal wins admission. The whole transaction, including
            // prepared pin rows, rolls back instead of erasing or straddling the recycle intent.
            isNull(schema.projectWorkspaces.recycleRequestedAt),
          ),
        )
        .returning({ projectId: schema.projectWorkspaces.projectId });
      if (!updatedWorkspaces[0]) {
        const latest = await readCurrentWorkspaceState({
          database: tx,
          job: input.job,
          workerId: input.workerId,
        });
        if (latest.recycleRequestedAt) {
          throw new ProjectAuthorityRevokedError({
            authorityRevision: latest.authorityRevision ?? "",
            recycleRequired: true,
            mode: latest.recycleReason?.startsWith("boundary:")
              ? "boundary"
              : "immediate",
            reason: "recycle_requested",
          });
        }
        throw new LostProjectWorkspaceLeaseError();
      }
      return {
        secrets: secretPins,
        modelProviders: modelPins,
        authorityRevision: authority.authorityRevision,
        activationRevision: input.activationRevision,
      };
    },
  });
}

/**
 * Validate the current secret/provider projection before billing or provider activation.
 *
 * This deliberately does not pin or decrypt anything. The same validation is repeated by
 * prepareProjectActivationInputs under the activation fence to close the race with a concurrent
 * secret/provider update.
 */
export async function validateProjectActivationEnvironment(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<{ authorityRevision: string }> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const workspace = await readCurrentWorkspaceState({
        database: tx,
        job: input.job,
        workerId: input.workerId,
      });
      if (workspace.recycleRequestedAt) {
        throw new ProjectAuthorityRevokedError({
          authorityRevision: workspace.authorityRevision ?? "",
          recycleRequired: true,
          mode: workspace.recycleReason?.startsWith("boundary:")
            ? "boundary"
            : "immediate",
          reason: "recycle_requested",
        });
      }
      const authority = await currentProjectAuthority({
        database: tx,
        job: input.job,
        activationRevision: workspace.activationRevision,
      });
      if (authority.reason === "membership_revoked") {
        throw new ProjectAuthorityRevokedError(authority);
      }
      if (authority.reason === "environment_invalid") {
        throw new ProjectEnvironmentInvalidError();
      }
      return { authorityRevision: authority.authorityRevision };
    },
  });
}

export async function revalidateProjectWorkspaceAuthority(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  activationRevision: number;
  authorityRevision: string;
  database?: Db;
}): Promise<ProjectAuthorityState> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const workspace = await readCurrentWorkspaceState({
        database: tx,
        job: input.job,
        workerId: input.workerId,
      });
      if (workspace.activationRevision !== input.activationRevision) {
        return {
          authorityRevision: workspace.authorityRevision ?? "",
          recycleRequired: true,
          mode: "immediate",
          reason: "activation_changed",
        };
      }
      if (workspace.recycleRequestedAt) {
        return {
          authorityRevision: workspace.authorityRevision ?? "",
          recycleRequired: true,
          mode: workspace.recycleReason?.startsWith("boundary:")
            ? "boundary"
            : "immediate",
          reason: "recycle_requested",
        };
      }
      const authority = await currentProjectAuthority({
        database: tx,
        job: input.job,
        activationRevision: input.activationRevision,
      });
      const result: ProjectAuthorityState =
        authority.mode === "current" &&
        (workspace.authorityRevision !== input.authorityRevision ||
          authority.authorityRevision !== input.authorityRevision)
          ? {
              authorityRevision: authority.authorityRevision,
              recycleRequired: true,
              mode: "boundary",
              reason: "secrets_changed",
            }
          : {
        authorityRevision: authority.authorityRevision,
        recycleRequired: authority.recycleRequired,
        mode: authority.mode,
        reason: authority.reason,
      };
      if (result.recycleRequired) {
        await tx
          .update(schema.projectWorkspaces)
          .set({
            recycleRequestedAt: sql`coalesce(${schema.projectWorkspaces.recycleRequestedAt}, clock_timestamp())`,
            recycleReason: `${result.mode}:${result.reason}`,
            availableAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectWorkspaces.orgId, input.job.orgId),
              eq(schema.projectWorkspaces.projectId, input.job.projectId),
              eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
              eq(schema.projectWorkspaces.leaseOwner, input.workerId),
              eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
            ),
          );
      }
      return result;
    },
  });
}

/** Last-moment decrypt. Callers must clear returned strings from their runtime environment. */
export async function resolveProjectActivationEnvironment(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  activationRevision: number;
  masterKey: Buffer;
  database?: Db;
}): Promise<Record<string, string>> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const workspace = await readCurrentWorkspaceState({
        database: tx,
        job: input.job,
        workerId: input.workerId,
      });
      if (
        workspace.activationRevision !== input.activationRevision ||
        workspace.recycleRequestedAt
      ) {
        throw new ProjectAuthorityRevokedError({
          authorityRevision: workspace.authorityRevision ?? "",
          recycleRequired: true,
          mode: "immediate",
          reason:
            workspace.activationRevision !== input.activationRevision
              ? "activation_changed"
              : "recycle_requested",
        });
      }
      const [secretRows, modelRows] = await Promise.all([
        tx
          .select()
          .from(schema.projectSecretInputs)
          .where(
            and(
              eq(schema.projectSecretInputs.orgId, input.job.orgId),
              eq(schema.projectSecretInputs.projectId, input.job.projectId),
              eq(schema.projectSecretInputs.creatorId, input.job.creatorId),
              eq(
                schema.projectSecretInputs.activationRevision,
                input.activationRevision,
              ),
            ),
          ),
        tx
          .select()
          .from(schema.projectModelProviderInputs)
          .where(
            and(
              eq(schema.projectModelProviderInputs.orgId, input.job.orgId),
              eq(schema.projectModelProviderInputs.projectId, input.job.projectId),
              eq(schema.projectModelProviderInputs.creatorId, input.job.creatorId),
              eq(
                schema.projectModelProviderInputs.activationRevision,
                input.activationRevision,
              ),
            ),
          ),
      ]);
      const actor = { id: input.job.creatorId, email: "", name: "" };
      const environment: Record<string, string> = {};
      for (const row of secretRows) {
        const resolved = await decryptPinnedSecret({
          actor,
          orgId: input.job.orgId,
          secretId: row.secretId,
          version: row.secretVersion,
          masterKey: input.masterKey,
          database: tx,
        });
        environment[row.envKey] = resolved.value;
      }
      for (const row of modelRows) {
        const resolved = await getDecryptedProviderKey({
          actor,
          orgId: input.job.orgId,
          provider: row.provider,
          connectionId: row.connectionId,
          credentialVersion: row.credentialVersion,
          keyName: row.envKey,
          masterKey: input.masterKey,
          database: tx,
        });
        if (!resolved) throw new Error(`model connection ${row.provider} was revoked`);
        environment[row.envKey] = resolved.value;
      }
      return environment;
    },
  });
}

/**
 * Persist the conservative exposure fence immediately before the external OpenCode start request.
 * A timeout or broken transport can still leave the detached process running, so credential pins
 * become "injected" at attempt time and remain security-revocable until a verified stop/checkpoint.
 */
export async function markProjectActivationExposureAttempted(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  activationRevision: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const workspace = await readCurrentWorkspaceState({
        database: tx,
        job: input.job,
        workerId: input.workerId,
      });
      if (
        workspace.activationRevision !== input.activationRevision ||
        workspace.recycleRequestedAt
      ) {
        return false;
      }
      const now = new Date();
      await tx
        .update(schema.projectSecretInputs)
        .set({ injectedAt: now })
        .where(
          and(
            eq(schema.projectSecretInputs.orgId, input.job.orgId),
            eq(schema.projectSecretInputs.projectId, input.job.projectId),
            eq(schema.projectSecretInputs.creatorId, input.job.creatorId),
            eq(
              schema.projectSecretInputs.activationRevision,
              input.activationRevision,
            ),
            isNull(schema.projectSecretInputs.injectedAt),
          ),
        );
      await tx
        .update(schema.projectModelProviderInputs)
        .set({ injectedAt: now })
        .where(
          and(
            eq(schema.projectModelProviderInputs.orgId, input.job.orgId),
            eq(schema.projectModelProviderInputs.projectId, input.job.projectId),
            eq(schema.projectModelProviderInputs.creatorId, input.job.creatorId),
            eq(
              schema.projectModelProviderInputs.activationRevision,
              input.activationRevision,
            ),
            isNull(schema.projectModelProviderInputs.injectedAt),
          ),
        );
      const workspaceRows = await tx
        .update(schema.projectWorkspaces)
        .set({ environmentExposureAttemptedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.job.orgId),
            eq(schema.projectWorkspaces.projectId, input.job.projectId),
            eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
            eq(schema.projectWorkspaces.activationRevision, input.activationRevision),
            eq(schema.projectWorkspaces.leaseOwner, input.workerId),
            eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
            isNull(schema.projectWorkspaces.recycleRequestedAt),
          ),
        )
        .returning({ projectId: schema.projectWorkspaces.projectId });
      if (!workspaceRows[0]) throw new LostProjectWorkspaceLeaseError();
      return true;
    },
  });
}

/** Confirm that the attempted start returned; the conservative attempt fence remains authoritative. */
export async function markProjectActivationInjected(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  activationRevision: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const workspaceRows = await tx
        .update(schema.projectWorkspaces)
        .set({ environmentInjectedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.job.orgId),
            eq(schema.projectWorkspaces.projectId, input.job.projectId),
            eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
            eq(schema.projectWorkspaces.activationRevision, input.activationRevision),
            eq(schema.projectWorkspaces.leaseOwner, input.workerId),
            eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
            isNotNull(schema.projectWorkspaces.environmentExposureAttemptedAt),
            isNull(schema.projectWorkspaces.recycleRequestedAt),
          ),
        )
        .returning({ projectId: schema.projectWorkspaces.projectId });
      if (!workspaceRows[0]) throw new LostProjectWorkspaceLeaseError();
      return true;
    },
  });
}

export async function setProjectOpencodePassword(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  password: string;
  masterKey: Buffer;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const encrypted = encryptOpaqueValue(
    {
      orgId: input.job.orgId,
      purpose: PROJECT_OPENCODE_PASSWORD_PURPOSE,
      subjectId: input.job.projectId,
      value: input.password,
    },
    input.masterKey,
  );
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .update(schema.projectWorkspaces)
        .set({
          opencodePasswordCiphertext: encrypted.ciphertext,
          opencodePasswordIv: encrypted.iv,
          opencodePasswordAuthTag: encrypted.authTag,
          opencodePasswordWrappedDek: encrypted.wrappedDek,
          opencodePasswordWrapIv: encrypted.wrapIv,
          opencodePasswordWrapAuthTag: encrypted.wrapAuthTag,
          opencodePasswordKeyId: encrypted.keyId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.job.orgId),
            eq(schema.projectWorkspaces.projectId, input.job.projectId),
            eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
            eq(schema.projectWorkspaces.leaseOwner, input.workerId),
            eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
          ),
        )
        .returning({ projectId: schema.projectWorkspaces.projectId });
      return Boolean(rows[0]);
    },
  });
}

export async function getProjectOpencodePassword(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  masterKey: Buffer;
  database?: Db;
}): Promise<string | null> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .select()
        .from(schema.projectWorkspaces)
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.job.orgId),
            eq(schema.projectWorkspaces.projectId, input.job.projectId),
            eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
            eq(schema.projectWorkspaces.leaseOwner, input.workerId),
            eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row?.opencodePasswordCiphertext) return null;
      const encrypted: OpaqueCiphertext = {
        ciphertext: row.opencodePasswordCiphertext,
        iv: row.opencodePasswordIv!,
        authTag: row.opencodePasswordAuthTag!,
        wrappedDek: row.opencodePasswordWrappedDek!,
        wrapIv: row.opencodePasswordWrapIv!,
        wrapAuthTag: row.opencodePasswordWrapAuthTag!,
        keyId: row.opencodePasswordKeyId!,
      };
      return decryptOpaqueValue(
        {
          orgId: input.job.orgId,
          purpose: PROJECT_OPENCODE_PASSWORD_PURPOSE,
          subjectId: input.job.projectId,
          ...encrypted,
        },
        input.masterKey,
      );
    },
  });
}

/** Poll mutable control state that may change after this immutable claim was issued. */
export async function readProjectWorkspaceControl(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<{
  deleteRequestedAt: Date | null;
  status: ProjectWorkspaceStatus;
  skillSyncErrorAt: Date | null;
  skillSyncErrorCode: string | null;
  skillSyncErrorMessage: string | null;
}> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .select({
          deleteRequestedAt: schema.projects.deleteRequestedAt,
          status: schema.projectWorkspaces.status,
          skillSyncErrorAt: schema.projectWorkspaces.skillSyncErrorAt,
          skillSyncErrorCode: schema.projectWorkspaces.skillSyncErrorCode,
          skillSyncErrorMessage: schema.projectWorkspaces.skillSyncErrorMessage,
        })
        .from(schema.projectWorkspaces)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.orgId, schema.projectWorkspaces.orgId),
            eq(schema.projects.id, schema.projectWorkspaces.projectId),
            eq(schema.projects.creatorId, schema.projectWorkspaces.creatorId),
          ),
        )
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.job.orgId),
            eq(schema.projectWorkspaces.projectId, input.job.projectId),
            eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
            eq(schema.projectWorkspaces.leaseOwner, input.workerId),
            eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
          ),
        )
        .limit(1);
      if (!rows[0]) throw new LostProjectWorkspaceLeaseError();
      return rows[0];
    },
  });
}

/**
 * Surface a durable publisher-side closure failure through lifecycle state under the exact lease.
 *
 * This is recoverable: the previous complete projection remains valid and a later publication or
 * explicit skill selection can replace it. Consume the pending marker so the worker does not spin
 * on an already-surfaced error; the reader-facing error remains on the workspace.
 */
export async function surfaceProjectSkillSyncFailure(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .update(schema.projectWorkspaces)
        .set({
          status: "error",
          lastErrorCode: schema.projectWorkspaces.skillSyncErrorCode,
          lastErrorMessage: schema.projectWorkspaces.skillSyncErrorMessage,
          skillSyncErrorAt: null,
          skillSyncErrorCode: null,
          skillSyncErrorMessage: null,
          idleDeadlineAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.job.orgId),
            eq(schema.projectWorkspaces.projectId, input.job.projectId),
            eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
            eq(schema.projectWorkspaces.leaseOwner, input.workerId),
            eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
            sql`${schema.projectWorkspaces.skillSyncErrorAt} IS NOT NULL`,
          ),
        )
        .returning({ projectId: schema.projectWorkspaces.projectId });
      return Boolean(rows[0]);
    },
  });
}

export async function updateProjectWorkspaceState(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  status?: ProjectWorkspaceStatus;
  sandboxId?: string | null;
  sandboxDomain?: string | null;
  checkpointId?: string | null;
  checkpointCreatedAt?: Date | null;
  checkpointGeneration?: number;
  appliedGeneration?: number;
  appliedFileRevision?: number;
  activationRevision?: number;
  lastActivityAt?: Date;
  idleDeadlineAt?: Date | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  if (input.checkpointGeneration !== undefined && input.checkpointGeneration < 0) {
    throw new Error("checkpoint generation must be non-negative");
  }
  if (input.appliedFileRevision !== undefined && input.appliedFileRevision < 0) {
    throw new Error("applied file revision must be non-negative");
  }
  try {
    return await withWorkspaceLease({
      ...input,
      database,
      fn: async (tx) => {
        const rows = await tx
          .update(schema.projectWorkspaces)
          .set({
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.status === "ready" ||
            input.status === "running" ||
            input.status === "stopped"
              ? {
                  attempt: 0,
                  lastErrorCode: null,
                  lastErrorMessage: null,
                }
              : {}),
            ...(input.status === "stopped"
              ? {
                  environmentExposureAttemptedAt: null,
                  environmentInjectedAt: null,
                }
              : {}),
            ...(input.sandboxId !== undefined ? { sandboxId: input.sandboxId } : {}),
            ...(input.sandboxDomain !== undefined
              ? { sandboxDomain: input.sandboxDomain }
              : {}),
            ...(input.checkpointId !== undefined
              ? { checkpointId: input.checkpointId }
              : {}),
            ...(input.checkpointCreatedAt !== undefined
              ? { checkpointCreatedAt: input.checkpointCreatedAt }
              : {}),
            ...(input.checkpointId !== undefined
              ? {
                  checkpointGeneration:
                    input.checkpointId === null
                      ? 0
                      : (input.checkpointGeneration ??
                        input.appliedGeneration ??
                        schema.projectWorkspaces.appliedGeneration),
                }
              : input.checkpointGeneration !== undefined
                ? { checkpointGeneration: input.checkpointGeneration }
                : {}),
            ...(input.appliedGeneration !== undefined
              ? { appliedGeneration: input.appliedGeneration }
              : {}),
            ...(input.appliedFileRevision !== undefined
              ? { appliedFileRevision: input.appliedFileRevision }
              : {}),
            ...(input.activationRevision !== undefined
              ? { activationRevision: input.activationRevision }
              : {}),
            ...(input.lastActivityAt !== undefined
              ? { lastActivityAt: input.lastActivityAt }
              : {}),
            ...(input.idleDeadlineAt !== undefined
              ? { idleDeadlineAt: input.idleDeadlineAt }
              : {}),
            ...(input.errorCode !== undefined ? { lastErrorCode: input.errorCode } : {}),
            ...(input.errorMessage !== undefined
              ? { lastErrorMessage: input.errorMessage }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectWorkspaces.orgId, input.job.orgId),
              eq(schema.projectWorkspaces.projectId, input.job.projectId),
              eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
              eq(schema.projectWorkspaces.leaseOwner, input.workerId),
              eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
            ),
          )
          .returning({ projectId: schema.projectWorkspaces.projectId });
        return Boolean(rows[0]);
      },
    });
  } catch (error) {
    if (error instanceof LostProjectWorkspaceLeaseError) return false;
    throw error;
  }
}

/**
 * Finish a credential recycle after the provider has checkpointed and stopped the VM.
 *
 * Clearing the intent is intentionally coupled to persisting the stopped checkpoint. Otherwise a
 * worker crash between those writes could either expose the old environment again or restore from
 * a stale checkpoint. Prepared/injected pin rows remain immutable audit snapshots; the workspace
 * marker is cleared because no process currently holds those values.
 */
export async function completeProjectWorkspaceRecycle(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  checkpointId: string;
  checkpointCreatedAt?: Date;
  checkpointGeneration: number;
  appliedGeneration: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  if (!input.checkpointId.trim()) throw new Error("checkpoint id is required");
  if (
    input.checkpointGeneration < 0 ||
    input.appliedGeneration < 0 ||
    input.checkpointGeneration > input.appliedGeneration
  ) {
    throw new Error("invalid recycle checkpoint generation");
  }
  try {
    return await withWorkspaceLease({
      ...input,
      database,
      fn: async (tx) => {
        const rows = await tx
          .update(schema.projectWorkspaces)
          .set({
            status: "stopped",
            sandboxDomain: null,
            checkpointId: input.checkpointId,
            checkpointCreatedAt: input.checkpointCreatedAt ?? new Date(),
            checkpointGeneration: input.checkpointGeneration,
            appliedGeneration: input.appliedGeneration,
            activationAdmissionToken: null,
            activationAdmissionRevision: null,
            activationAdmissionAuthorityRevision: null,
            activationAdmittedAt: null,
            environmentInjectedAt: null,
            environmentExposureAttemptedAt: null,
            recycleRequestedAt: null,
            recycleReason: null,
            idleDeadlineAt: null,
            attempt: 0,
            lastErrorCode: null,
            lastErrorMessage: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectWorkspaces.orgId, input.job.orgId),
              eq(schema.projectWorkspaces.projectId, input.job.projectId),
              eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
              eq(schema.projectWorkspaces.leaseOwner, input.workerId),
              eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
              isNotNull(schema.projectWorkspaces.recycleRequestedAt),
            ),
          )
          .returning({ projectId: schema.projectWorkspaces.projectId });
        return Boolean(rows[0]);
      },
    });
  } catch (error) {
    if (error instanceof LostProjectWorkspaceLeaseError) return false;
    throw error;
  }
}

/**
 * Inspect durable queued/pre-send work before a stopped Project can reserve billing or touch its
 * provider. A blocked result is recoverable: prompts remain queued; a provider-connect signal or a
 * newly accepted compatible prompt wakes the cold workspace after an effective connection exists.
 */
export async function inspectProjectPromptProviderAdmission(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<ProjectPromptProviderAdmission> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const [sessions, effectiveProviderKeys] = await Promise.all([
        tx
          .selectDistinct({
            modelProvider: schema.projectSessions.modelProvider,
            modelCredentialEnvKeys:
              schema.projectSessions.modelCredentialEnvKeys,
          })
          .from(schema.projectPrompts)
          .innerJoin(
            schema.projectSessions,
            and(
              eq(schema.projectSessions.orgId, schema.projectPrompts.orgId),
              eq(schema.projectSessions.projectId, schema.projectPrompts.projectId),
              eq(schema.projectSessions.id, schema.projectPrompts.sessionId),
              eq(schema.projectSessions.creatorId, schema.projectPrompts.creatorId),
            ),
          )
          .where(
            and(
              eq(schema.projectPrompts.orgId, input.job.orgId),
              eq(schema.projectPrompts.projectId, input.job.projectId),
              eq(schema.projectPrompts.creatorId, input.job.creatorId),
              or(
                and(
                  eq(schema.projectPrompts.status, "queued"),
                  sql`${schema.projectPrompts.availableAt} <= clock_timestamp()`,
                ),
                inArray(schema.projectPrompts.status, ["dispatching", "running"]),
              ),
            ),
          ),
        loadEffectiveProjectProviderKeys({
          database: tx,
          orgId: input.job.orgId,
          creatorId: input.job.creatorId,
        }),
      ]);
      return projectProviderAdmissionForSessions(sessions, effectiveProviderKeys);
    },
  });
}

/** Re-check one claimed prompt immediately before any OpenCode server start or prompt send. */
export async function revalidateProjectPromptProviderAdmission(input: {
  job: ProjectWorkspaceJob;
  prompt: ProjectPromptJob;
  workerId: string;
  database?: Db;
}): Promise<"admitted" | "provider_unavailable" | "lost_lease"> {
  const database = input.database ?? db;
  try {
    return await withWorkspaceLease({
      ...input,
      database,
      fn: async (tx) => {
        const sessions = await tx
          .select({
            modelProvider: schema.projectSessions.modelProvider,
            modelCredentialEnvKeys:
              schema.projectSessions.modelCredentialEnvKeys,
          })
          .from(schema.projectPrompts)
          .innerJoin(
            schema.projectSessions,
            and(
              eq(schema.projectSessions.orgId, schema.projectPrompts.orgId),
              eq(schema.projectSessions.projectId, schema.projectPrompts.projectId),
              eq(schema.projectSessions.id, schema.projectPrompts.sessionId),
              eq(schema.projectSessions.creatorId, schema.projectPrompts.creatorId),
            ),
          )
          .where(
            and(
              eq(schema.projectPrompts.orgId, input.prompt.orgId),
              eq(schema.projectPrompts.projectId, input.prompt.projectId),
              eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
              eq(schema.projectPrompts.id, input.prompt.id),
              eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
              eq(schema.projectPrompts.leaseOwner, input.workerId),
              inArray(schema.projectPrompts.status, ["dispatching", "running"]),
            ),
          )
          .limit(1);
        if (!sessions[0]) return "lost_lease" as const;
        const effectiveProviderKeys = await loadEffectiveProjectProviderKeys({
          database: tx,
          orgId: input.job.orgId,
          creatorId: input.job.creatorId,
        });
        return isProjectSessionProviderAdmitted({
          ...sessions[0],
          effectiveProviderKeys,
        })
          ? "admitted" as const
          : "provider_unavailable" as const;
      },
    });
  } catch (error) {
    if (error instanceof LostProjectWorkspaceLeaseError) return "lost_lease";
    throw error;
  }
}

/** Claim ready prompts while preserving strict order inside each OpenCode session. */
export async function claimProjectPromptJobs(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  /** Native sessions already active in this process cannot be safely reclaimed locally. */
  excludeSessionIds?: string[];
  database?: Db;
}): Promise<ProjectPromptJob[]> {
  const database = input.database ?? db;
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 32);
  const leaseSeconds = input.leaseSeconds ?? 30;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const workspace = await readCurrentWorkspaceState({
        database: tx,
        job: input.job,
        workerId: input.workerId,
      });
      // A prompt may only observe fully materialized skill and creator-uploaded file projections.
      // Holding claims here lets the supervisor stage/swap either complete projection first.
      if (
        workspace.desiredGeneration !== workspace.appliedGeneration
        || workspace.desiredFileRevision !== workspace.appliedFileRevision
      ) return [];
      if (workspace.recycleRequestedAt) {
        const recycled: ProjectAuthorityState = {
          authorityRevision: workspace.authorityRevision ?? "",
          recycleRequired: true,
          mode: workspace.recycleReason?.startsWith("boundary:")
            ? "boundary"
            : "immediate",
          reason: "recycle_requested",
        };
        if (recycled.mode === "boundary") return [];
        throw new ProjectAuthorityRevokedError(recycled);
      }
      const authority = await currentProjectAuthority({
        database: tx,
        job: input.job,
        activationRevision: workspace.activationRevision,
      });
      if (authority.mode === "immediate") {
        throw new ProjectAuthorityRevokedError(authority);
      }
      if (authority.mode === "boundary") return [];
      const effectiveProviderKeys = new Map(
        authority.modelProviders.map((pin) => [pin.provider, pin.envKey]),
      );
      const providerAdmissionCondition = or(
        sql`cardinality(${schema.projectSessions.modelCredentialEnvKeys}) = 0`,
        ...[...effectiveProviderKeys].map(([provider, envKey]) =>
          and(
            eq(schema.projectSessions.modelProvider, provider),
            sql`${envKey} = ANY(${schema.projectSessions.modelCredentialEnvKeys})`,
          ),
        ),
      );
      const excludedSessionIds = input.excludeSessionIds ?? [];
      const sessionNotExcluded =
        excludedSessionIds.length > 0
          ? notInArray(schema.projectPrompts.sessionId, excludedSessionIds)
          : undefined;
      // An expired command at its retry ceiling is terminalized before FIFO selection. It cannot be
      // resent to OpenCode, and making it terminal releases a later prompt in the same session.
      const exhausted = await tx
        .update(schema.projectPrompts)
        .set({
          status: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          errorCode: "project_prompt_attempts_exhausted",
          errorMessage: "The prompt could not be resumed safely after repeated interruptions.",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.job.orgId),
            eq(schema.projectPrompts.projectId, input.job.projectId),
            eq(schema.projectPrompts.creatorId, input.job.creatorId),
            sessionNotExcluded,
            sql`${schema.projectPrompts.attempt} >= ${schema.projectPrompts.maxAttempts}`,
            or(
              and(
                eq(schema.projectPrompts.status, "queued"),
                sql`${schema.projectPrompts.availableAt} <= clock_timestamp()`,
              ),
              and(
                inArray(schema.projectPrompts.status, ["dispatching", "running"]),
                sql`${schema.projectPrompts.leaseExpiresAt} <= clock_timestamp()`,
              ),
            ),
          ),
        )
        .returning({ sessionId: schema.projectPrompts.sessionId });
      if (exhausted.length > 0) {
        await tx
          .update(schema.projectSessions)
          .set({
            status: "error",
            errorCode: "project_prompt_attempts_exhausted",
            userMessage: "This session needs a new prompt to continue.",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectSessions.orgId, input.job.orgId),
              eq(schema.projectSessions.projectId, input.job.projectId),
              eq(schema.projectSessions.creatorId, input.job.creatorId),
              inArray(
                schema.projectSessions.id,
                [...new Set(exhausted.map((row) => row.sessionId))],
              ),
            ),
          );
      }
      const candidates = await tx
        .select({ prompt: schema.projectPrompts, session: schema.projectSessions })
        .from(schema.projectPrompts)
        .innerJoin(
          schema.projectSessions,
          and(
            eq(schema.projectSessions.orgId, schema.projectPrompts.orgId),
            eq(schema.projectSessions.projectId, schema.projectPrompts.projectId),
            eq(schema.projectSessions.id, schema.projectPrompts.sessionId),
            eq(schema.projectSessions.creatorId, schema.projectPrompts.creatorId),
          ),
        )
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.job.orgId),
            eq(schema.projectPrompts.projectId, input.job.projectId),
            eq(schema.projectPrompts.creatorId, input.job.creatorId),
            isNull(schema.projectSessions.archivedAt),
            isNull(schema.projectSessions.stopRequestedAt),
            notInArray(schema.projectSessions.status, ["stopping"]),
            sessionNotExcluded,
            providerAdmissionCondition,
            sql`${schema.projectPrompts.attempt} < ${schema.projectPrompts.maxAttempts}`,
            or(
              and(
                eq(schema.projectPrompts.status, "queued"),
                sql`${schema.projectPrompts.availableAt} <= clock_timestamp()`,
              ),
              and(
                inArray(schema.projectPrompts.status, ["dispatching", "running"]),
                lt(schema.projectPrompts.leaseExpiresAt, new Date()),
              ),
            ),
            sql`not exists (
              select 1 from project_prompts earlier
              where earlier.org_id = ${schema.projectPrompts.orgId}
                and earlier.session_id = ${schema.projectPrompts.sessionId}
                and earlier.sequence < ${schema.projectPrompts.sequence}
                and earlier.status not in ('completed', 'failed', 'cancelled')
            )`,
          ),
        )
        .orderBy(asc(schema.projectPrompts.createdAt))
        .limit(limit)
        // Lock the conversation together with its head prompt. Archive/stop mutations lock this
        // same session row, so either they linearize first and remove the candidate, or the claim
        // linearizes first and the mutation waits until the dispatching claim is committed.
        .for("update", {
          of: [schema.projectPrompts, schema.projectSessions],
          skipLocked: true,
        });
      const jobs: ProjectPromptJob[] = [];
      for (const { prompt, session } of candidates) {
        if (
          !isProjectSessionProviderAdmitted({
            modelProvider: session.modelProvider,
            modelCredentialEnvKeys: session.modelCredentialEnvKeys,
            effectiveProviderKeys,
          })
        ) {
          continue;
        }
        const leased = await tx
          .update(schema.projectPrompts)
          .set({
            status: "dispatching",
            attempt: sql`${schema.projectPrompts.attempt} + 1`,
            leaseOwner: input.workerId,
            leaseExpiresAt: sql`clock_timestamp() + make_interval(secs => ${leaseSeconds})`,
            heartbeatAt: new Date(),
            startedAt: sql`coalesce(${schema.projectPrompts.startedAt}, clock_timestamp())`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectPrompts.orgId, prompt.orgId),
              eq(schema.projectPrompts.projectId, prompt.projectId),
              eq(schema.projectPrompts.sessionId, prompt.sessionId),
              eq(schema.projectPrompts.id, prompt.id),
              eq(schema.projectPrompts.creatorId, prompt.creatorId),
              sessionNotExcluded,
              sql`${schema.projectPrompts.attempt} < ${schema.projectPrompts.maxAttempts}`,
              or(
                eq(schema.projectPrompts.status, "queued"),
                and(
                  inArray(schema.projectPrompts.status, ["dispatching", "running"]),
                  lt(schema.projectPrompts.leaseExpiresAt, new Date()),
                ),
              ),
            ),
          )
          .returning();
        if (!leased[0]) continue;
        await tx
          .update(schema.projectSessions)
          .set({ status: "working", lastActiveAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(schema.projectSessions.orgId, session.orgId),
              eq(schema.projectSessions.projectId, session.projectId),
              eq(schema.projectSessions.id, session.id),
              eq(schema.projectSessions.creatorId, session.creatorId),
            ),
          );
        jobs.push({
          id: prompt.id,
          orgId: prompt.orgId,
          projectId: prompt.projectId,
          sessionId: prompt.sessionId,
          creatorId: prompt.creatorId,
          sequence: prompt.sequence,
          text: prompt.text,
          model: session.model,
          opencodeSessionId: session.opencodeSessionId,
          opencodeMessageId: leased[0].opencodeMessageId,
          sendAttemptedAt: leased[0].sendAttemptedAt,
          leaseOwner: input.workerId,
        });
      }
      return jobs;
    },
  });
}

/**
 * Linearize runtime authority and the external-side-effect barrier immediately before OpenCode.
 *
 * The workspace row lock serializes this transaction with every secret/provider recycle signal.
 * Therefore a revocation either makes this fence return `recycle` without marking the prompt, or
 * commits after `send_attempted_at` and is treated as interruption of an already-admitted send.
 *
 * A crash after `marked` is inherently ambiguous: OpenCode may have accepted the request. Recovery
 * may observe the deterministic message and continue it, but it must never blindly resend the
 * command when that message cannot be found.
 */
export async function markProjectPromptSendAttempted(input: {
  job: ProjectWorkspaceJob;
  prompt: ProjectPromptJob;
  workerId: string;
  activationRevision: number;
  authorityRevision: string;
  database?: Db;
}): Promise<ProjectPromptSendFenceResult> {
  const database = input.database ?? db;
  try {
    return await withWorkspaceLease({
      ...input,
      database,
      fn: async (tx) => {
        // This explicit row lock is the linearization point shared with the SQL signal functions,
        // both of which update this exact workspace row in their credential-changing transaction.
        const workspaces = await tx
          .select({
            activationRevision: schema.projectWorkspaces.activationRevision,
            authorityRevision: schema.projectWorkspaces.authorityRevision,
            recycleRequestedAt: schema.projectWorkspaces.recycleRequestedAt,
            recycleReason: schema.projectWorkspaces.recycleReason,
          })
          .from(schema.projectWorkspaces)
          .where(
            and(
              eq(schema.projectWorkspaces.orgId, input.job.orgId),
              eq(schema.projectWorkspaces.projectId, input.job.projectId),
              eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
              eq(schema.projectWorkspaces.leaseOwner, input.workerId),
              eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
            ),
          )
          .limit(1)
          .for("update");
        const workspace = workspaces[0];
        if (!workspace) return "lost" as const;

        const existing = await tx
          .select({
            sendAttemptedAt: schema.projectPrompts.sendAttemptedAt,
            modelProvider: schema.projectSessions.modelProvider,
            modelCredentialEnvKeys:
              schema.projectSessions.modelCredentialEnvKeys,
          })
          .from(schema.projectPrompts)
          .innerJoin(
            schema.projectSessions,
            and(
              eq(schema.projectSessions.orgId, schema.projectPrompts.orgId),
              eq(schema.projectSessions.projectId, schema.projectPrompts.projectId),
              eq(schema.projectSessions.id, schema.projectPrompts.sessionId),
              eq(schema.projectSessions.creatorId, schema.projectPrompts.creatorId),
            ),
          )
          .where(
            and(
              eq(schema.projectPrompts.orgId, input.prompt.orgId),
              eq(schema.projectPrompts.projectId, input.prompt.projectId),
              eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
              eq(schema.projectPrompts.id, input.prompt.id),
              eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
              eq(schema.projectPrompts.leaseOwner, input.workerId),
              inArray(schema.projectPrompts.status, ["dispatching", "running"]),
            ),
          )
          .limit(1)
          .for("update");
        if (!existing[0] || existing[0].sendAttemptedAt) return "lost" as const;

        const authority = await currentProjectAuthority({
          database: tx,
          job: input.job,
          activationRevision: workspace.activationRevision,
        });
        const activationChanged =
          workspace.activationRevision !== input.activationRevision;
        const authorityChanged =
          workspace.authorityRevision !== input.authorityRevision ||
          authority.authorityRevision !== input.authorityRevision;
        const recycleRequired =
          Boolean(workspace.recycleRequestedAt) ||
          activationChanged ||
          authority.recycleRequired ||
          authorityChanged;
        const decision = projectPromptSendFenceDecision({
          recycleRequired,
          modelProvider: existing[0].modelProvider,
          modelCredentialEnvKeys: existing[0].modelCredentialEnvKeys,
          effectiveProviderKeys: new Map(
            authority.modelProviders.map((pin) => [pin.provider, pin.envKey]),
          ),
        });
        if (decision === "recycle") {
          const recycleMode = workspace.recycleRequestedAt
            ? workspace.recycleReason?.startsWith("boundary:")
              ? "boundary"
              : "immediate"
            : activationChanged
              ? "immediate"
              : authority.recycleRequired
                ? authority.mode
                : "boundary";
          const recycleReason = workspace.recycleRequestedAt
            ? workspace.recycleReason?.split(":").slice(1).join(":") ||
              "recycle_requested"
            : activationChanged
              ? "activation_changed"
              : authority.recycleRequired
                ? authority.reason
                : "secrets_changed";
          await tx
            .update(schema.projectWorkspaces)
            .set({
              recycleRequestedAt: sql`coalesce(${schema.projectWorkspaces.recycleRequestedAt}, clock_timestamp())`,
              recycleReason: `${recycleMode}:${recycleReason}`,
              availableAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.projectWorkspaces.orgId, input.job.orgId),
                eq(schema.projectWorkspaces.projectId, input.job.projectId),
                eq(schema.projectWorkspaces.creatorId, input.job.creatorId),
                eq(schema.projectWorkspaces.leaseOwner, input.workerId),
                eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
              ),
            );
          return "recycle" as const;
        }
        if (decision === "provider_unavailable") {
          return "provider_unavailable" as const;
        }
        const rows = await tx
          .update(schema.projectPrompts)
          .set({ sendAttemptedAt: sql`clock_timestamp()`, updatedAt: new Date() })
          .where(
            and(
              eq(schema.projectPrompts.orgId, input.prompt.orgId),
              eq(schema.projectPrompts.projectId, input.prompt.projectId),
              eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
              eq(schema.projectPrompts.id, input.prompt.id),
              eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
              eq(schema.projectPrompts.leaseOwner, input.workerId),
              inArray(schema.projectPrompts.status, ["dispatching", "running"]),
              isNull(schema.projectPrompts.sendAttemptedAt),
            ),
          )
          .returning({ id: schema.projectPrompts.id });
        return rows[0] ? "marked" as const : "lost" as const;
      },
    });
  } catch (error) {
    if (error instanceof LostProjectWorkspaceLeaseError) return "lost";
    throw error;
  }
}

/** Bind the native session before dispatch. The message id already exists on the durable command. */
export async function markProjectPromptDispatch(input: {
  job: ProjectWorkspaceJob;
  prompt: ProjectPromptJob;
  workerId: string;
  opencodeSessionId: string;
  opencodeMessageId?: string;
  database?: Db;
}): Promise<{ opencodeSessionId: string; messageId: string } | null> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      if (
        input.opencodeMessageId &&
        input.prompt.opencodeMessageId !== input.opencodeMessageId
      ) {
        throw new Error("OpenCode message identity cannot change");
      }
      const prompts = await tx
        .update(schema.projectPrompts)
        .set({
          status: "running",
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.id, input.prompt.id),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            eq(schema.projectPrompts.leaseOwner, input.workerId),
            inArray(schema.projectPrompts.status, ["dispatching", "running"]),
          ),
        )
        .returning({ id: schema.projectPrompts.id });
      if (!prompts[0]) return null;
      const sessions = await tx
        .update(schema.projectSessions)
        .set({ opencodeSessionId: input.opencodeSessionId, updatedAt: new Date() })
        .where(
          and(
            eq(schema.projectSessions.orgId, input.prompt.orgId),
            eq(schema.projectSessions.projectId, input.prompt.projectId),
            eq(schema.projectSessions.id, input.prompt.sessionId),
            eq(schema.projectSessions.creatorId, input.prompt.creatorId),
            or(
              sql`${schema.projectSessions.opencodeSessionId} IS NULL`,
              eq(schema.projectSessions.opencodeSessionId, input.opencodeSessionId),
            ),
          ),
        )
        .returning({ id: schema.projectSessions.id });
      if (!sessions[0]) throw new Error("OpenCode session identity cannot change");
      return {
        opencodeSessionId: input.opencodeSessionId,
        messageId: input.prompt.opencodeMessageId,
      };
    },
  });
}

/** Read the redacted durable recovery context for one session under the exact workspace lease. */
export async function loadProjectSessionTranscript(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  sessionId: string;
  database?: Db;
}): Promise<RunChatHistoryItem[]> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .select({ transcript: schema.projectSessions.transcript })
        .from(schema.projectSessions)
        .where(
          and(
            eq(schema.projectSessions.orgId, input.job.orgId),
            eq(schema.projectSessions.projectId, input.job.projectId),
            eq(schema.projectSessions.id, input.sessionId),
            eq(schema.projectSessions.creatorId, input.job.creatorId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw new Error("project session not found");
      const parsed = runChatHistoryItemSchema.array().safeParse(rows[0].transcript);
      if (!parsed.success) throw new Error("project session transcript is invalid");
      return parsed.data;
    },
  });
}

/**
 * Replace a stale native OpenCode session binding after a checkpoint restore. The durable prompt and
 * message identities remain unchanged; retrying the same replacement is idempotent.
 */
export async function rebindProjectSession(input: {
  job: ProjectWorkspaceJob;
  prompt: ProjectPromptJob;
  workerId: string;
  opencodeSessionId: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  if (!input.opencodeSessionId.trim()) throw new Error("OpenCode session id is required");
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const promptRows = await tx
        .select({ id: schema.projectPrompts.id })
        .from(schema.projectPrompts)
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.id, input.prompt.id),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            eq(schema.projectPrompts.leaseOwner, input.workerId),
            inArray(schema.projectPrompts.status, ["dispatching", "running"]),
          ),
        )
        .limit(1);
      if (!promptRows[0]) return false;
      const rows = await tx
        .update(schema.projectSessions)
        .set({
          opencodeSessionId: input.opencodeSessionId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectSessions.orgId, input.prompt.orgId),
            eq(schema.projectSessions.projectId, input.prompt.projectId),
            eq(schema.projectSessions.id, input.prompt.sessionId),
            eq(schema.projectSessions.creatorId, input.prompt.creatorId),
          ),
        )
        .returning({ id: schema.projectSessions.id });
      return Boolean(rows[0]);
    },
  });
}

export async function loadProjectPromptAttachments(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  promptId: string;
  database?: Db;
}): Promise<Array<{
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  storageKey: string;
  workspacePath: string;
}>> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) =>
      tx
        .select({
          id: schema.projectAttachments.id,
          fileName: schema.projectAttachments.fileName,
          contentType: schema.projectAttachments.contentType,
          byteSize: schema.projectAttachments.byteSize,
          checksum: schema.projectAttachments.checksum,
          storageKey: schema.projectAttachments.storageKey,
          workspacePath: schema.projectAttachments.workspacePath,
        })
        .from(schema.projectAttachments)
        .where(
          and(
            eq(schema.projectAttachments.orgId, input.job.orgId),
            eq(schema.projectAttachments.projectId, input.job.projectId),
            eq(schema.projectAttachments.promptId, input.promptId),
            eq(schema.projectAttachments.creatorId, input.job.creatorId),
          ),
        )
        .orderBy(asc(schema.projectAttachments.createdAt)),
  });
}

export async function claimProjectSessionStops(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<ProjectSessionStopJob[]> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .select({
          sessionId: schema.projectSessions.id,
          opencodeSessionId: schema.projectSessions.opencodeSessionId,
        })
        .from(schema.projectSessions)
        .where(
          and(
            eq(schema.projectSessions.orgId, input.job.orgId),
            eq(schema.projectSessions.projectId, input.job.projectId),
            eq(schema.projectSessions.creatorId, input.job.creatorId),
            or(
              eq(schema.projectSessions.status, "stopping"),
              sql`${schema.projectSessions.stopRequestedAt} IS NOT NULL`,
            ),
          ),
        )
        .orderBy(asc(schema.projectSessions.updatedAt));
      return rows.map((row) => ({
        orgId: input.job.orgId,
        projectId: input.job.projectId,
        creatorId: input.job.creatorId,
        sessionId: row.sessionId,
        opencodeSessionId: row.opencodeSessionId,
      }));
    },
  });
}

export async function completeProjectSessionStop(input: {
  job: ProjectWorkspaceJob;
  stop: ProjectSessionStopJob;
  workerId: string;
  transcript?: unknown[];
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const transcript = input.transcript === undefined
    ? undefined
    : redactAndBoundProjectTranscript(
        runChatHistoryItemSchema.array().parse(input.transcript),
      );
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const now = new Date();
      await tx
        .update(schema.projectPrompts)
        .set({
          status: "cancelled",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.stop.orgId),
            eq(schema.projectPrompts.projectId, input.stop.projectId),
            eq(schema.projectPrompts.sessionId, input.stop.sessionId),
            eq(schema.projectPrompts.creatorId, input.stop.creatorId),
            inArray(schema.projectPrompts.status, ["queued", "dispatching", "running"]),
          ),
        );
      const rows = await tx
        .update(schema.projectSessions)
        .set({
          status: "stopped",
          stopRequestedAt: null,
          ...(transcript !== undefined
            ? {
                transcript,
                transcriptEventSequence: schema.projectSessions.transcriptSequence,
              }
            : {}),
          lastActiveAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectSessions.orgId, input.stop.orgId),
            eq(schema.projectSessions.projectId, input.stop.projectId),
            eq(schema.projectSessions.id, input.stop.sessionId),
            eq(schema.projectSessions.creatorId, input.stop.creatorId),
          ),
        )
        .returning({
          id: schema.projectSessions.id,
          transcriptEventSequence: schema.projectSessions.transcriptEventSequence,
        });
      const row = rows[0];
      if (row && transcript !== undefined) {
        await tx
          .delete(schema.projectSessionEvents)
          .where(
            and(
              eq(schema.projectSessionEvents.orgId, input.stop.orgId),
              eq(schema.projectSessionEvents.projectId, input.stop.projectId),
              eq(schema.projectSessionEvents.sessionId, input.stop.sessionId),
              eq(schema.projectSessionEvents.creatorId, input.stop.creatorId),
              lte(schema.projectSessionEvents.sequence, row.transcriptEventSequence),
            ),
          );
      }
      return Boolean(row);
    },
  });
}

export async function failProjectSessionStop(input: {
  job: ProjectWorkspaceJob;
  stop: ProjectSessionStopJob;
  workerId: string;
  errorCode: string;
  errorMessage: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .update(schema.projectSessions)
        .set({
          status: "error",
          errorCode: input.errorCode,
          userMessage: input.errorMessage.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectSessions.orgId, input.stop.orgId),
            eq(schema.projectSessions.projectId, input.stop.projectId),
            eq(schema.projectSessions.id, input.stop.sessionId),
            eq(schema.projectSessions.creatorId, input.stop.creatorId),
          ),
        )
        .returning({ id: schema.projectSessions.id });
      return Boolean(rows[0]);
    },
  });
}

export async function interruptProjectPromptsForRecycle(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<number> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .update(schema.projectPrompts)
        .set({
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.job.orgId),
            eq(schema.projectPrompts.projectId, input.job.projectId),
            eq(schema.projectPrompts.creatorId, input.job.creatorId),
            inArray(schema.projectPrompts.status, ["dispatching", "running"]),
          ),
        )
        .returning({ sessionId: schema.projectPrompts.sessionId });
      if (rows.length > 0) {
        await tx
          .update(schema.projectSessions)
          .set({ status: "queued", updatedAt: new Date() })
          .where(
            and(
              eq(schema.projectSessions.orgId, input.job.orgId),
              eq(schema.projectSessions.projectId, input.job.projectId),
              eq(schema.projectSessions.creatorId, input.job.creatorId),
              inArray(
                schema.projectSessions.id,
                [...new Set(rows.map((row) => row.sessionId))],
              ),
            ),
          );
      }
      return rows.length;
    },
  });
}

/** Return one claimed command to admission without spending an attempt or changing its identity. */
export async function requeueProjectPromptAtBoundary(input: {
  job: ProjectWorkspaceJob;
  prompt: ProjectPromptJob;
  workerId: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .update(schema.projectPrompts)
        .set({
          status: "queued",
          attempt: sql`greatest(${schema.projectPrompts.attempt} - 1, 0)`,
          availableAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.id, input.prompt.id),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            eq(schema.projectPrompts.leaseOwner, input.workerId),
            inArray(schema.projectPrompts.status, ["dispatching", "running"]),
          ),
        )
        .returning({ sessionId: schema.projectPrompts.sessionId });
      if (!rows[0]) return false;
      await tx
        .update(schema.projectSessions)
        .set({ status: "queued", updatedAt: new Date() })
        .where(
          and(
            eq(schema.projectSessions.orgId, input.prompt.orgId),
            eq(schema.projectSessions.projectId, input.prompt.projectId),
            eq(schema.projectSessions.id, input.prompt.sessionId),
            eq(schema.projectSessions.creatorId, input.prompt.creatorId),
          ),
        );
      return true;
    },
  });
}

/**
 * Mark and enumerate every Project-owned object before removing the Project graph.
 *
 * Ownership rows remain after the cascade. The worker performs an eager idempotent delete now; an
 * age-gated second delete later closes the race with any API PUT that had already reserved its key.
 */
export async function listProjectStorageKeys(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<string[]> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const deletionRequestedAt = new Date();
      const owned = await tx
        .update(schema.projectAttachmentUploads)
        .set({
          deleteRequestedAt: deletionRequestedAt,
          touchedAt: deletionRequestedAt,
        })
        .where(
          and(
            eq(schema.projectAttachmentUploads.orgId, input.job.orgId),
            eq(schema.projectAttachmentUploads.projectId, input.job.projectId),
            eq(schema.projectAttachmentUploads.creatorId, input.job.creatorId),
          ),
        )
        .returning({ key: schema.projectAttachmentUploads.storageKey });
      const [attachments, currentFiles, versions] = await Promise.all([
        tx
          .select({ key: schema.projectAttachments.storageKey })
          .from(schema.projectAttachments)
          .where(
            and(
              eq(schema.projectAttachments.orgId, input.job.orgId),
              eq(schema.projectAttachments.projectId, input.job.projectId),
              eq(schema.projectAttachments.creatorId, input.job.creatorId),
            ),
          ),
        tx
          .select({ key: schema.projectFiles.storageKey })
          .from(schema.projectFiles)
          .where(
            and(
              eq(schema.projectFiles.orgId, input.job.orgId),
              eq(schema.projectFiles.projectId, input.job.projectId),
              eq(schema.projectFiles.creatorId, input.job.creatorId),
            ),
          ),
        tx
          .select({ key: schema.projectFileVersions.storageKey })
          .from(schema.projectFileVersions)
          .where(
            and(
              eq(schema.projectFileVersions.orgId, input.job.orgId),
              eq(schema.projectFileVersions.projectId, input.job.projectId),
              eq(schema.projectFileVersions.creatorId, input.job.creatorId),
            ),
          ),
      ]);
      return [
        ...new Set(
          [...owned, ...attachments, ...currentFiles, ...versions].map((row) => row.key),
        ),
      ].sort();
    },
  });
}

export async function captureProjectFileBaseline(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<Array<{ path: string; version: number; checksum: string }>> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .select({
          path: schema.projectFiles.path,
          version: schema.projectFiles.currentVersion,
          checksum: schema.projectFiles.checksum,
        })
        .from(schema.projectFiles)
        .where(
          and(
            eq(schema.projectFiles.orgId, input.job.orgId),
            eq(schema.projectFiles.projectId, input.job.projectId),
            eq(schema.projectFiles.creatorId, input.job.creatorId),
            isNull(schema.projectFiles.deletedAt),
          ),
        );
      return rows;
    },
  });
}

export async function heartbeatProjectPromptLease(input: {
  job: ProjectWorkspaceJob;
  prompt: ProjectPromptJob;
  workerId: string;
  leaseSeconds?: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const leaseSeconds = input.leaseSeconds ?? 30;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .update(schema.projectPrompts)
        .set({
          status: "running",
          heartbeatAt: new Date(),
          leaseExpiresAt: sql`clock_timestamp() + make_interval(secs => ${leaseSeconds})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.id, input.prompt.id),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            eq(schema.projectPrompts.leaseOwner, input.workerId),
            inArray(schema.projectPrompts.status, ["dispatching", "running"]),
          ),
        )
        .returning({ id: schema.projectPrompts.id });
      return Boolean(rows[0]);
    },
  });
}

export async function appendProjectSessionEvent(input: {
  job: ProjectWorkspaceJob;
  prompt: ProjectPromptJob;
  workerId: string;
  event: ProjectSessionEvent;
  database?: Db;
}): Promise<number> {
  const database = input.database ?? db;
  const events = redactAndBoundProjectEvents([
    runChatEventSchema.parse(input.event),
  ]);
  if (events.length === 0) {
    throw new Error("project session event produced no persistable events");
  }
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const promptRows = await tx
        .select({ id: schema.projectPrompts.id })
        .from(schema.projectPrompts)
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.id, input.prompt.id),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            eq(schema.projectPrompts.leaseOwner, input.workerId),
            inArray(schema.projectPrompts.status, ["dispatching", "running"]),
          ),
        );
      if (!promptRows[0]) throw new LostProjectWorkspaceLeaseError();
      const sequenceRows = await tx
        .update(schema.projectSessions)
        .set({
          transcriptSequence:
            sql`${schema.projectSessions.transcriptSequence} + ${events.length}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectSessions.orgId, input.prompt.orgId),
            eq(schema.projectSessions.projectId, input.prompt.projectId),
            eq(schema.projectSessions.id, input.prompt.sessionId),
            eq(schema.projectSessions.creatorId, input.prompt.creatorId),
          ),
        )
        .returning({ sequence: schema.projectSessions.transcriptSequence });
      const sequence = sequenceRows[0]?.sequence;
      if (!sequence) throw new LostProjectWorkspaceLeaseError();
      await tx.insert(schema.projectSessionEvents).values(
        events.map((event, index) => ({
          orgId: input.prompt.orgId,
          projectId: input.prompt.projectId,
          sessionId: input.prompt.sessionId,
          creatorId: input.prompt.creatorId,
          sequence: sequence - events.length + index + 1,
          event,
        })),
      );
      return sequence;
    },
  });
}

/**
 * Reconstruct post-turn Files work under the current Project workspace lease.
 *
 * Prompt leases deliberately end at completion, while file capture can be delayed until every
 * concurrent turn is quiescent. The null reconciliation sequence is therefore the durable work
 * queue: it survives Ready lease release and worker crashes without replaying the prompt itself.
 */
export async function loadPendingProjectFileReconciliations(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<ProjectFileReconciliationJob[]> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .select({
          id: schema.projectPrompts.id,
          orgId: schema.projectPrompts.orgId,
          projectId: schema.projectPrompts.projectId,
          sessionId: schema.projectPrompts.sessionId,
          creatorId: schema.projectPrompts.creatorId,
          sequence: schema.projectPrompts.sequence,
        })
        .from(schema.projectPrompts)
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.job.orgId),
            eq(schema.projectPrompts.projectId, input.job.projectId),
            eq(schema.projectPrompts.creatorId, input.job.creatorId),
            eq(schema.projectPrompts.status, "completed"),
            isNull(schema.projectPrompts.fileReconciliationEventSequence),
          ),
        )
        .orderBy(
          asc(schema.projectPrompts.completedAt),
          asc(schema.projectPrompts.id),
        );
      return rows;
    },
  });
}

/**
 * Publish the post-turn file barrier after a completed prompt.
 *
 * Ordinary OpenCode events are accepted only while their prompt lease is live. File
 * reconciliation deliberately happens after every concurrent turn has completed, so this
 * narrower writer validates the current workspace lease plus the terminal prompt instead. The
 * prompt row is locked and records the committed event sequence, making concurrent retries
 * idempotent without relying on a racy JSON event lookup.
 */
export async function appendCompletedProjectPromptArtifactsUpdated(input: {
  job: ProjectWorkspaceJob;
  prompt: ProjectFileReconciliationJob;
  workerId: string;
  count: number;
  database?: Db;
}): Promise<number> {
  const database = input.database ?? db;
  const event = runChatEventSchema.parse({
    type: "artifacts.updated",
    count: input.count,
    prompt_id: input.prompt.id,
  });
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      // Serialize retries for this prompt. The marker and event are committed in this same
      // transaction, so a concurrent caller either writes the one barrier or observes its exact
      // sequence after the row lock is released.
      const promptRows = await tx
        .select({
          id: schema.projectPrompts.id,
          status: schema.projectPrompts.status,
          eventSequence: schema.projectPrompts.fileReconciliationEventSequence,
        })
        .from(schema.projectPrompts)
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.id, input.prompt.id),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
          ),
        )
        .limit(1)
        .for("update");
      const prompt = promptRows[0];
      if (!prompt || prompt.status !== "completed") {
        throw new LostProjectWorkspaceLeaseError();
      }
      if (prompt.eventSequence !== null) return prompt.eventSequence;

      const sequenceRows = await tx
        .update(schema.projectSessions)
        .set({
          transcriptSequence: sql`${schema.projectSessions.transcriptSequence} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectSessions.orgId, input.prompt.orgId),
            eq(schema.projectSessions.projectId, input.prompt.projectId),
            eq(schema.projectSessions.id, input.prompt.sessionId),
            eq(schema.projectSessions.creatorId, input.prompt.creatorId),
          ),
        )
        .returning({ sequence: schema.projectSessions.transcriptSequence });
      const sequence = sequenceRows[0]?.sequence;
      if (!sequence) throw new LostProjectWorkspaceLeaseError();
      await tx.insert(schema.projectSessionEvents).values({
        orgId: input.prompt.orgId,
        projectId: input.prompt.projectId,
        sessionId: input.prompt.sessionId,
        creatorId: input.prompt.creatorId,
        sequence,
        event,
      });
      const marked = await tx
        .update(schema.projectPrompts)
        .set({
          fileReconciliationEventSequence: sequence,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.id, input.prompt.id),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            eq(schema.projectPrompts.status, "completed"),
            isNull(schema.projectPrompts.fileReconciliationEventSequence),
          ),
        )
        .returning({ id: schema.projectPrompts.id });
      if (!marked[0]) throw new LostProjectWorkspaceLeaseError();
      return sequence;
    },
  });
}

export async function completeProjectPrompt(input: {
  job: ProjectWorkspaceJob;
  prompt: ProjectPromptJob;
  workerId: string;
  opencodeSessionId: string;
  transcript: unknown[];
  idleMs?: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const idleMs = input.idleMs ?? DEFAULT_PROJECT_IDLE_MS;
  const transcript = redactAndBoundProjectTranscript(
    runChatHistoryItemSchema.array().parse(input.transcript),
  );
  if (idleMs < 60_000 || idleMs > 24 * 60 * 60 * 1000) {
    throw new Error("project idle duration is out of range");
  }
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const now = new Date();
      const prompts = await tx
        .update(schema.projectPrompts)
        .set({
          status: "completed",
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          completedAt: now,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.id, input.prompt.id),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            eq(schema.projectPrompts.leaseOwner, input.workerId),
            inArray(schema.projectPrompts.status, ["dispatching", "running"]),
          ),
        )
        .returning({ id: schema.projectPrompts.id });
      if (!prompts[0]) return false;
      const later = await tx
        .select({ id: schema.projectPrompts.id })
        .from(schema.projectPrompts)
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            eq(schema.projectPrompts.status, "queued"),
          ),
        )
        .limit(1);
      const sessions = await tx
        .update(schema.projectSessions)
        .set({
          status: later[0] ? "queued" : "idle",
          opencodeSessionId: input.opencodeSessionId,
          transcript,
          transcriptEventSequence: schema.projectSessions.transcriptSequence,
          stopRequestedAt: null,
          lastActiveAt: now,
          errorCode: null,
          userMessage: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectSessions.orgId, input.prompt.orgId),
            eq(schema.projectSessions.projectId, input.prompt.projectId),
            eq(schema.projectSessions.id, input.prompt.sessionId),
            eq(schema.projectSessions.creatorId, input.prompt.creatorId),
          ),
        )
        .returning({
          transcriptEventSequence: schema.projectSessions.transcriptEventSequence,
        });
      const session = sessions[0];
      if (session) {
        await tx
          .delete(schema.projectSessionEvents)
          .where(
            and(
              eq(schema.projectSessionEvents.orgId, input.prompt.orgId),
              eq(schema.projectSessionEvents.projectId, input.prompt.projectId),
              eq(schema.projectSessionEvents.sessionId, input.prompt.sessionId),
              eq(schema.projectSessionEvents.creatorId, input.prompt.creatorId),
              lte(
                schema.projectSessionEvents.sequence,
                session.transcriptEventSequence,
              ),
            ),
          );
      }
      const active = await tx
        .select({ id: schema.projectPrompts.id })
        .from(schema.projectPrompts)
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            inArray(schema.projectPrompts.status, ["queued", "dispatching", "running"]),
          ),
        )
        .limit(1);
      await tx
        .update(schema.projectWorkspaces)
        .set({
          lastActivityAt: now,
          idleDeadlineAt: active[0] ? null : new Date(now.getTime() + idleMs),
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, input.prompt.orgId),
            eq(schema.projectWorkspaces.projectId, input.prompt.projectId),
            eq(schema.projectWorkspaces.creatorId, input.prompt.creatorId),
            eq(schema.projectWorkspaces.leaseOwner, input.workerId),
            eq(schema.projectWorkspaces.leaseGeneration, input.job.leaseGeneration),
          ),
        );
      return true;
    },
  });
}

export async function failProjectPrompt(input: {
  job: ProjectWorkspaceJob;
  prompt: ProjectPromptJob;
  workerId: string;
  errorCode: string;
  errorMessage: string;
  retryAt?: Date;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .select({ attempt: schema.projectPrompts.attempt, maxAttempts: schema.projectPrompts.maxAttempts })
        .from(schema.projectPrompts)
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.id, input.prompt.id),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            eq(schema.projectPrompts.leaseOwner, input.workerId),
          ),
        )
        .for("update");
      const row = rows[0];
      if (!row) return false;
      const retry = Boolean(input.retryAt && row.attempt < row.maxAttempts);
      await tx
        .update(schema.projectPrompts)
        .set({
          status: retry ? "queued" : "failed",
          availableAt: input.retryAt ?? new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: new Date(),
          errorCode: input.errorCode,
          errorMessage: input.errorMessage.slice(0, 2000),
          completedAt: retry ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectPrompts.orgId, input.prompt.orgId),
            eq(schema.projectPrompts.projectId, input.prompt.projectId),
            eq(schema.projectPrompts.sessionId, input.prompt.sessionId),
            eq(schema.projectPrompts.id, input.prompt.id),
            eq(schema.projectPrompts.creatorId, input.prompt.creatorId),
            eq(schema.projectPrompts.leaseOwner, input.workerId),
          ),
        );
      await tx
        .update(schema.projectSessions)
        .set({
          status: retry ? "queued" : "error",
          errorCode: input.errorCode,
          userMessage: input.errorMessage.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectSessions.orgId, input.prompt.orgId),
            eq(schema.projectSessions.projectId, input.prompt.projectId),
            eq(schema.projectSessions.id, input.prompt.sessionId),
            eq(schema.projectSessions.creatorId, input.prompt.creatorId),
          ),
        );
      return true;
    },
  });
}

export async function completeProjectDeletion(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .delete(schema.projects)
        .where(
          and(
            eq(schema.projects.orgId, input.job.orgId),
            eq(schema.projects.id, input.job.projectId),
            eq(schema.projects.creatorId, input.job.creatorId),
            sql`${schema.projects.deleteRequestedAt} IS NOT NULL`,
          ),
        )
        .returning({ id: schema.projects.id });
      return Boolean(rows[0]);
    },
  });
}

/**
 * Establish durable Project ownership before a worker writes a generated/cache object to S3.
 *
 * The row survives the external PUT and Project deletion. File metadata marks it committed in the
 * same transaction, while the delayed sweep owns every crash boundary in between.
 */
export async function reserveProjectFileStorageObject(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  storageKey: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  if (!input.storageKey.trim()) throw new Error("project file storage key is required");
  await withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const touchedAt = new Date();
      await tx
        .insert(schema.projectAttachmentUploads)
        .values({
          storageKey: input.storageKey,
          orgId: input.job.orgId,
          projectId: input.job.projectId,
          creatorId: input.job.creatorId,
          kind: "file",
          touchedAt,
        })
        .onConflictDoUpdate({
          target: schema.projectAttachmentUploads.storageKey,
          set: { touchedAt },
        });
      const rows = await tx
        .select({
          kind: schema.projectAttachmentUploads.kind,
          deleteRequestedAt: schema.projectAttachmentUploads.deleteRequestedAt,
        })
        .from(schema.projectAttachmentUploads)
        .where(
          and(
            eq(schema.projectAttachmentUploads.storageKey, input.storageKey),
            eq(schema.projectAttachmentUploads.orgId, input.job.orgId),
            eq(schema.projectAttachmentUploads.projectId, input.job.projectId),
            eq(schema.projectAttachmentUploads.creatorId, input.job.creatorId),
          ),
        )
        .limit(1);
      if (rows[0]?.kind !== "file" || rows[0].deleteRequestedAt) {
        throw new Error("project file storage ownership is unavailable");
      }
    },
  });
}

/** Persist one S3-backed file version and expose it as the current last-writer-wins value. */
export function projectFileConflictState(input: {
  existingConflict: boolean;
  currentVersion: number;
  observedBaseVersion: number;
}): boolean {
  return input.existingConflict || input.observedBaseVersion !== input.currentVersion;
}

async function assertProjectFileAttribution(input: {
  database: Db;
  job: ProjectWorkspaceJob;
  modifiedBySessionId?: string | null;
  modifiedByPromptId?: string | null;
}): Promise<void> {
  if (input.modifiedByPromptId && !input.modifiedBySessionId) {
    throw new Error("project file prompt attribution requires a session");
  }
  if (input.modifiedByPromptId) {
    const prompts = await input.database
      .select({ id: schema.projectPrompts.id })
      .from(schema.projectPrompts)
      .where(
        and(
          eq(schema.projectPrompts.orgId, input.job.orgId),
          eq(schema.projectPrompts.projectId, input.job.projectId),
          eq(schema.projectPrompts.sessionId, input.modifiedBySessionId!),
          eq(schema.projectPrompts.id, input.modifiedByPromptId),
          eq(schema.projectPrompts.creatorId, input.job.creatorId),
        ),
      )
      .limit(1);
    if (!prompts[0]) {
      throw new Error("project file prompt is outside the leased project session");
    }
    return;
  }
  if (input.modifiedBySessionId) {
    const sessions = await input.database
      .select({ id: schema.projectSessions.id })
      .from(schema.projectSessions)
      .where(
        and(
          eq(schema.projectSessions.orgId, input.job.orgId),
          eq(schema.projectSessions.projectId, input.job.projectId),
          eq(schema.projectSessions.id, input.modifiedBySessionId),
          eq(schema.projectSessions.creatorId, input.job.creatorId),
        ),
      )
      .limit(1);
    if (!sessions[0]) {
      throw new Error("project file session is outside the leased project");
    }
  }
}

export async function recordProjectFileVersion(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  path: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  storageKey: string;
  modifiedBySessionId?: string | null;
  modifiedByPromptId?: string | null;
  baseVersion?: number | null;
  database?: Db;
}): Promise<{ fileId: string; version: number; conflictDetected: boolean }> {
  const database = input.database ?? db;
  if (!isManagedProjectFilePath(input.path)) {
    throw new Error("project file path must stay under files/");
  }
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const ownership = await tx
        .update(schema.projectAttachmentUploads)
        .set({ committedAt: new Date(), touchedAt: new Date() })
        .where(
          and(
            eq(schema.projectAttachmentUploads.storageKey, input.storageKey),
            eq(schema.projectAttachmentUploads.orgId, input.job.orgId),
            eq(schema.projectAttachmentUploads.projectId, input.job.projectId),
            eq(schema.projectAttachmentUploads.creatorId, input.job.creatorId),
            eq(schema.projectAttachmentUploads.kind, "file"),
            isNull(schema.projectAttachmentUploads.deleteRequestedAt),
          ),
        )
        .returning({ storageKey: schema.projectAttachmentUploads.storageKey });
      if (!ownership[0]) {
        throw new Error("project file storage object was not reserved");
      }
      const existingRows = await tx
        .select()
        .from(schema.projectFiles)
        .where(
          and(
            eq(schema.projectFiles.orgId, input.job.orgId),
            eq(schema.projectFiles.projectId, input.job.projectId),
            eq(schema.projectFiles.creatorId, input.job.creatorId),
            eq(schema.projectFiles.path, input.path),
          ),
        )
        .for("update");
      const existing = existingRows[0];
      const observedBaseVersion = input.baseVersion ?? 0;
      if (existing?.checksum === input.checksum && !existing.deletedAt) {
        const convergedConflict = observedBaseVersion !== existing.currentVersion;
        if (convergedConflict && !existing.conflictDetected) {
          await tx
            .update(schema.projectFiles)
            .set({ conflictDetected: true, updatedAt: new Date() })
            .where(
              and(
                eq(schema.projectFiles.orgId, input.job.orgId),
                eq(schema.projectFiles.projectId, input.job.projectId),
                eq(schema.projectFiles.id, existing.id),
                eq(schema.projectFiles.creatorId, input.job.creatorId),
              ),
            );
        }
        return {
          fileId: existing.id,
          version: existing.currentVersion,
          conflictDetected: existing.conflictDetected || convergedConflict,
        };
      }
      await assertProjectFileAttribution({ ...input, database: tx });
      const versionRows = existing
        ? await tx
            .select({
              value: sql<number>`coalesce(max(${schema.projectFileVersions.version}), 0)`,
            })
            .from(schema.projectFileVersions)
            .where(
              and(
                eq(schema.projectFileVersions.orgId, input.job.orgId),
                eq(schema.projectFileVersions.projectId, input.job.projectId),
                eq(schema.projectFileVersions.fileId, existing.id),
                eq(schema.projectFileVersions.creatorId, input.job.creatorId),
              ),
            )
        : [];
      const version = Math.max(
        existing?.currentVersion ?? 0,
        Number(versionRows[0]?.value ?? 0),
      ) + 1;
      const conflictDetected = projectFileConflictState({
        existingConflict: Boolean(existing?.conflictDetected),
        currentVersion: existing?.currentVersion ?? 0,
        observedBaseVersion,
      });
      const fileId = existing?.id ?? randomUUID();
      if (existing) {
        await tx
          .update(schema.projectFiles)
          .set({
            currentVersion: version,
            contentType: input.contentType,
            byteSize: input.byteSize,
            checksum: input.checksum,
            storageKey: input.storageKey,
            modifiedBySessionId: input.modifiedBySessionId ?? null,
            modifiedByPromptId: input.modifiedByPromptId ?? null,
            conflictDetected,
            deletedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.projectFiles.orgId, input.job.orgId),
              eq(schema.projectFiles.projectId, input.job.projectId),
              eq(schema.projectFiles.id, existing.id),
              eq(schema.projectFiles.creatorId, input.job.creatorId),
            ),
          );
      } else {
        await tx.insert(schema.projectFiles).values({
          id: fileId,
          orgId: input.job.orgId,
          projectId: input.job.projectId,
          creatorId: input.job.creatorId,
          path: input.path,
          currentVersion: version,
          contentType: input.contentType,
          byteSize: input.byteSize,
          checksum: input.checksum,
          storageKey: input.storageKey,
          modifiedBySessionId: input.modifiedBySessionId ?? null,
          modifiedByPromptId: input.modifiedByPromptId ?? null,
          conflictDetected,
        });
      }
      await tx.insert(schema.projectFileVersions).values({
        orgId: input.job.orgId,
        projectId: input.job.projectId,
        fileId,
        creatorId: input.job.creatorId,
        version,
        contentType: input.contentType,
        byteSize: input.byteSize,
        checksum: input.checksum,
        storageKey: input.storageKey,
        modifiedBySessionId: input.modifiedBySessionId ?? null,
        modifiedByPromptId: input.modifiedByPromptId ?? null,
        baseVersion: observedBaseVersion,
        conflictDetected,
      });
      return { fileId, version, conflictDetected };
    },
  });
}

/**
 * Retain provider bytes observed behind a newer durable projection without changing the current
 * last-writer-wins pointer. Version allocation considers this recovery history so a later current
 * write cannot reuse its immutable version number.
 */
export async function recordProjectFileHistoricalVersion(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  path: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  storageKey: string;
  modifiedBySessionId?: string | null;
  modifiedByPromptId?: string | null;
  baseVersion?: number | null;
  database?: Db;
}): Promise<{ fileId: string; version: number; conflictDetected: boolean }> {
  const database = input.database ?? db;
  if (!isManagedProjectFilePath(input.path)) {
    throw new Error("project file path must stay under files/");
  }
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const ownership = await tx
        .update(schema.projectAttachmentUploads)
        .set({ committedAt: new Date(), touchedAt: new Date() })
        .where(
          and(
            eq(schema.projectAttachmentUploads.storageKey, input.storageKey),
            eq(schema.projectAttachmentUploads.orgId, input.job.orgId),
            eq(schema.projectAttachmentUploads.projectId, input.job.projectId),
            eq(schema.projectAttachmentUploads.creatorId, input.job.creatorId),
            eq(schema.projectAttachmentUploads.kind, "file"),
            isNull(schema.projectAttachmentUploads.deleteRequestedAt),
          ),
        )
        .returning({ storageKey: schema.projectAttachmentUploads.storageKey });
      if (!ownership[0]) {
        throw new Error("project file storage object was not reserved");
      }
      const existingRows = await tx
        .select()
        .from(schema.projectFiles)
        .where(
          and(
            eq(schema.projectFiles.orgId, input.job.orgId),
            eq(schema.projectFiles.projectId, input.job.projectId),
            eq(schema.projectFiles.creatorId, input.job.creatorId),
            eq(schema.projectFiles.path, input.path),
            isNull(schema.projectFiles.deletedAt),
          ),
        )
        .for("update");
      const existing = existingRows[0];
      if (!existing) {
        throw new Error("historical project file requires a durable current version");
      }
      if (existing.checksum === input.checksum) {
        return {
          fileId: existing.id,
          version: existing.currentVersion,
          conflictDetected: existing.conflictDetected,
        };
      }
      await assertProjectFileAttribution({ ...input, database: tx });
      const versionRows = await tx
        .select({
          value: sql<number>`coalesce(max(${schema.projectFileVersions.version}), 0)`,
        })
        .from(schema.projectFileVersions)
        .where(
          and(
            eq(schema.projectFileVersions.orgId, input.job.orgId),
            eq(schema.projectFileVersions.projectId, input.job.projectId),
            eq(schema.projectFileVersions.fileId, existing.id),
            eq(schema.projectFileVersions.creatorId, input.job.creatorId),
          ),
        );
      const version = Math.max(
        existing.currentVersion,
        Number(versionRows[0]?.value ?? 0),
      ) + 1;
      const observedBaseVersion = input.baseVersion ?? 0;
      // Reaching this path means provider truth diverged from an already-newer durable projection.
      // Preserve that overlap explicitly even when the scan's durable baseline version happens to
      // equal the current pointer.
      const conflictDetected = true;
      if (!existing.conflictDetected) {
        await tx
          .update(schema.projectFiles)
          .set({ conflictDetected: true, updatedAt: new Date() })
          .where(
            and(
              eq(schema.projectFiles.orgId, input.job.orgId),
              eq(schema.projectFiles.projectId, input.job.projectId),
              eq(schema.projectFiles.id, existing.id),
              eq(schema.projectFiles.creatorId, input.job.creatorId),
            ),
          );
      }
      await tx.insert(schema.projectFileVersions).values({
        orgId: input.job.orgId,
        projectId: input.job.projectId,
        fileId: existing.id,
        creatorId: input.job.creatorId,
        version,
        contentType: input.contentType,
        byteSize: input.byteSize,
        checksum: input.checksum,
        storageKey: input.storageKey,
        modifiedBySessionId: input.modifiedBySessionId ?? null,
        modifiedByPromptId: input.modifiedByPromptId ?? null,
        baseVersion: observedBaseVersion,
        conflictDetected,
      });
      return { fileId: existing.id, version, conflictDetected };
    },
  });
}

/** Persist a last-writer-wins tombstone while retaining every immutable content version. */
export async function recordProjectFileDeletion(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  path: string;
  baseVersion: number;
  modifiedBySessionId?: string | null;
  modifiedByPromptId?: string | null;
  database?: Db;
}): Promise<{
  fileId: string;
  version: number;
  conflictDetected: boolean;
} | null> {
  const database = input.database ?? db;
  if (!isManagedProjectFilePath(input.path)) {
    throw new Error("project file path must stay under files/");
  }
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) {
    throw new Error("project file base version is invalid");
  }
  return withWorkspaceLease({
    ...input,
    database,
    fn: async (tx) => {
      const rows = await tx
        .select()
        .from(schema.projectFiles)
        .where(
          and(
            eq(schema.projectFiles.orgId, input.job.orgId),
            eq(schema.projectFiles.projectId, input.job.projectId),
            eq(schema.projectFiles.creatorId, input.job.creatorId),
            eq(schema.projectFiles.path, input.path),
          ),
        )
        .for("update");
      const current = rows[0];
      if (!current || current.deletedAt) return null;
      await assertProjectFileAttribution({ ...input, database: tx });
      const conflictDetected =
        current.conflictDetected || input.baseVersion !== current.currentVersion;
      const version = current.currentVersion + 1;
      const updated = await tx
        .update(schema.projectFiles)
        .set({
          currentVersion: version,
          deletedAt: new Date(),
          modifiedBySessionId: input.modifiedBySessionId ?? null,
          modifiedByPromptId: input.modifiedByPromptId ?? null,
          conflictDetected,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.projectFiles.orgId, input.job.orgId),
            eq(schema.projectFiles.projectId, input.job.projectId),
            eq(schema.projectFiles.id, current.id),
            eq(schema.projectFiles.creatorId, input.job.creatorId),
            isNull(schema.projectFiles.deletedAt),
          ),
        )
        .returning({ id: schema.projectFiles.id });
      if (!updated[0]) return null;
      return { fileId: current.id, version, conflictDetected };
    },
  });
}
