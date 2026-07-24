import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ProjectPromptJob as CoreProjectPromptJob,
  ProjectSessionStopJob as CoreProjectSessionStopJob,
  ProjectSessionEvent,
  ProjectWorkspaceJob as CoreProjectWorkspaceJob,
  ProjectWorkspaceStatus,
  RunChatEvent,
  RunChatHistoryItem,
} from "@companion/contracts";
import {
  billingRuntimeConfig,
  createRunRedactor,
  loadSecretsMasterKey,
  OPENCODE_SERVER_USERNAME,
  redactAndBoundProjectEvents,
  redactAndBoundProjectTranscript,
  recordSandboxRuntimeObservation,
  refreshSandboxUsageReservation,
  reserveSandboxUsage,
  RunRuntimeError,
  SANDBOX_RUN_ACTIVATION_RESERVATION_MS,
  settleSandboxUsage,
  startSandboxUsage,
  type ProjectChatRuntime,
  type ProjectChatTarget,
  type ProjectFileChange,
  type ProjectManagedFile,
  type ProjectWorkspaceRef,
  type ProjectWorkspaceRuntime,
  type RunRedactor,
  type ServeEnv,
  type SkillBundle,
} from "@companion/core";
import {
  appendProjectSessionEvent,
  beginProjectActivationAdmission,
  buildSkillBundle,
  cancelProjectActivationAdmission,
  captureProjectFileBaseline,
  claimProjectPromptJobs,
  claimProjectSessionStops,
  claimProjectWorkspaceJobs,
  completeProjectDeletion,
  completeProjectPrompt,
  completeProjectSessionStop,
  completeProjectWorkspaceRecycle,
  detectRunArtifactType,
  failProjectPrompt,
  getProjectOpencodePassword,
  heartbeatProjectPromptLease,
  heartbeatProjectWorker,
  heartbeatProjectWorkspaceLease,
  interruptProjectPromptsForRecycle,
  inspectProjectPromptProviderAdmission,
  listProjectStorageKeys,
  loadProjectMaterializationPlan,
  loadProjectPromptAttachments,
  loadProjectSessionTranscript,
  LostProjectWorkspaceLeaseError,
  ProjectAuthorityRevokedError,
  ProjectEnvironmentInvalidError,
  markProjectActivationExposureAttempted,
  markProjectActivationInjected,
  markProjectPromptDispatch,
  markProjectPromptSendAttempted,
  prepareProjectActivationInputs,
  readProjectWorkspaceControl,
  reserveProjectFileStorageObject,
  recordProjectFileVersion,
  recordProjectFileDeletion,
  rebindProjectSession,
  releaseProjectWorkspaceLease,
  removeProjectWorkerHeartbeat,
  requeueProjectPromptAtBoundary,
  revalidateProjectPromptProviderAdmission,
  revalidateProjectWorkspaceAuthority,
  resolveProjectActivationEnvironment,
  setProjectOpencodePassword,
  surfaceProjectSkillSyncFailure,
  updateProjectWorkspaceState,
  validateProjectActivationEnvironment,
} from "@companion/core/services";
import { db, type Db } from "@companion/db";
import {
  createOpencodeProjectChatRuntime,
  createVercelProjectWorkspaceRuntime,
  vercelConfigFromEnv,
} from "@companion/sandbox";
import { skillChecksum, toTar } from "@companion/skills";
import {
  deleteSkillArchive,
  getSkillArchive,
  isStoragePreconditionFailure,
  putSkillArchive,
} from "@companion/storage";
import { sql as drizzleSql } from "drizzle-orm";
import type { Supervisor } from "./billingSupervisor";
import { projectWorkerConfig, type ProjectWorkerConfig } from "./config";
import { sweepProjectAttachmentOrphans } from "./runAttachmentCleanup";

const PROJECT_FILE_MAX_COUNT = 1_000;
const PROJECT_FILE_MAX_BYTES = 25 * 1024 * 1024;
const PROJECT_FILE_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const MATERIALIZATION_POLL_MS = 5_000;
const PROMPT_STATE_POLL_MS = 500;
const RESERVED_PROJECT_FILE_ROOTS = new Set([
  ".claude",
  ".companion",
  ".git",
  ".opencode",
]);

class ProjectLostLease extends Error {}
class ProjectRecycleRequired extends Error {}
class ProjectPromptStopped extends Error {}
class ProjectInterruptedPrompt extends Error {}
class ProjectFileCaptureError extends Error {}
class ProjectWorkerShutdown extends Error {}
class ProjectDeletionRequested extends Error {}
class ProjectWorkspaceUnrecoverable extends Error {}

export interface ProjectWorkspaceJob extends CoreProjectWorkspaceJob {}

export interface ProjectPromptJob extends CoreProjectPromptJob {}

export interface ProjectStoredFile {
  storageKey: string;
  workspacePath: string;
  checksum: string;
}

export interface ProjectSessionStopJob extends CoreProjectSessionStopJob {}

export interface ProjectMaterializationPlan {
  desiredGeneration: number;
  appliedGeneration: number;
  checkpointGeneration: number;
  skills: SkillBundle[];
  /** Existing files that must be restored when a checkpoint did not already contain them. */
  bootstrapFiles: ProjectStoredFile[];
}

export interface ProjectActivationEnvironment {
  /** Exact environment admitted for this activation, including the server password. */
  env: ServeEnv;
  serverPassword: string;
  /** Every injected literal, used before any event, transcript or file can be persisted. */
  injectedLiterals: string[];
  /** Changes whenever membership, a secret pin, provider credential or ACL changes. */
  authorityRevision: string;
}

export interface ProjectCachedFile {
  path: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  storageKey: string;
  modifiedAt: Date;
  modifiedBySessionId: string | null;
  baseVersion: number | null;
}

export interface ProjectFileBaseline {
  path: string;
  version: number;
  checksum: string;
}

export interface ProjectDeletedFile {
  path: string;
  modifiedBySessionId: string | null;
  baseVersion: number;
}

/**
 * Persistence seam owned by packages/core. All prompt claims are scoped to the already-held
 * workspace lease: a second worker can never own a prompt or SSE recorder for this Project.
 */
export interface ProjectWorkspaceStore {
  claimProjectWorkspaceJobs(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<ProjectWorkspaceJob[]>;
  heartbeatProjectWorkspaceLease(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    leaseSeconds: number;
  }): Promise<boolean>;
  readProjectWorkspaceControl(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
  }): Promise<{
    deleteRequestedAt: Date | null;
    status: ProjectWorkspaceStatus;
    skillSyncErrorAt: Date | null;
    skillSyncErrorCode: string | null;
    skillSyncErrorMessage: string | null;
  }>;
  surfaceProjectSkillSyncFailure(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
  }): Promise<boolean>;
  completeProjectWorkspaceRecycle(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    checkpointId: string;
    checkpointCreatedAt?: Date;
    checkpointGeneration: number;
    appliedGeneration: number;
  }): Promise<boolean>;
  releaseProjectWorkspaceLease(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    delayMs?: number;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<boolean>;
  loadProjectMaterializationPlan(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
  }): Promise<ProjectMaterializationPlan>;
  /** Validate metadata-only environment admission before billing or provider activation. */
  validateProjectActivation(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
  }): Promise<void>;
  /** Persist the durable, secretless provider-admission fence before billing/provider I/O. */
  beginProjectActivation(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    activationRevision: number;
  }): Promise<{
    token: string;
    authorityRevision: string;
    activationRevision: number;
  }>;
  cancelProjectActivation(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    activationRevision: number;
    admissionToken: string;
    resetFreshRecycle?: boolean;
  }): Promise<"cancelled" | "fresh_requeued" | "not_found">;
  /** Pin authority metadata and rotate the server credential without decrypting any user secret. */
  prepareProjectActivation(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    activationRevision: number;
    admissionToken: string;
  }): Promise<{ authorityRevision: string }>;
  resolveProjectActivationEnvironment(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    activationRevision: number;
    authorityRevision: string;
  }): Promise<ProjectActivationEnvironment>;
  markProjectActivationInjected(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    activationRevision: number;
  }): Promise<boolean>;
  markProjectActivationExposureAttempted(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    activationRevision: number;
  }): Promise<boolean>;
  /**
   * Revalidate membership and every exact secret/provider ACL+version. Boundary changes are
   * applied only between turns; immediate changes close admission and erase the live environment.
   */
  revalidateProjectWorkspaceAuthority(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    authorityRevision: string;
    activationRevision: number;
  }): Promise<"current" | "boundary" | "immediate" | "lost_lease">;
  inspectProjectPromptProviderAdmission(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
  }): Promise<"none" | "admitted" | "provider_unavailable">;
  revalidateProjectPromptProviderAdmission(input: {
    job: ProjectWorkspaceJob;
    prompt: ProjectPromptJob;
    workerId: string;
  }): Promise<"admitted" | "provider_unavailable" | "lost_lease">;
  updateProjectWorkspaceState(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    status?: string;
    sandboxId?: string | null;
    sandboxDomain?: string | null;
    checkpointId?: string | null;
    checkpointCreatedAt?: Date | null;
    checkpointGeneration?: number;
    appliedGeneration?: number;
    activationRevision?: number;
    lastActivityAt?: Date;
    idleDeadlineAt?: Date | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<boolean>;
  completeProjectDeletion(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
  }): Promise<boolean>;
  claimProjectPromptJobs(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    limit: number;
    leaseSeconds: number;
    /** Sessions currently dispatching in this process; the store also enforces FIFO in SQL. */
    excludeSessionIds: string[];
  }): Promise<ProjectPromptJob[]>;
  claimProjectSessionStops(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
  }): Promise<ProjectSessionStopJob[]>;
  completeProjectSessionStop(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    session: ProjectSessionStopJob;
    transcript?: RunChatHistoryItem[];
  }): Promise<boolean>;
  heartbeatProjectPromptLease(input: {
    job: ProjectWorkspaceJob;
    prompt: ProjectPromptJob;
    workerId: string;
    leaseSeconds: number;
  }): Promise<boolean>;
  loadProjectPromptAttachments(input: {
    job: ProjectWorkspaceJob;
    prompt: ProjectPromptJob;
    workerId: string;
  }): Promise<ProjectStoredFile[]>;
  loadProjectSessionTranscript(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    sessionId: string;
  }): Promise<RunChatHistoryItem[]>;
  rebindProjectSession(input: {
    job: ProjectWorkspaceJob;
    prompt: ProjectPromptJob;
    workerId: string;
    opencodeSessionId: string;
  }): Promise<boolean>;
  completeProjectPrompt(input: {
    job: ProjectWorkspaceJob;
    prompt: ProjectPromptJob;
    workerId: string;
    opencodeSessionId: string;
    transcript: RunChatHistoryItem[];
  }): Promise<boolean>;
  markProjectPromptDispatch(input: {
    job: ProjectWorkspaceJob;
    prompt: ProjectPromptJob;
    workerId: string;
    opencodeSessionId: string;
    opencodeMessageId: string;
  }): Promise<boolean>;
  markProjectPromptSendAttempted(input: {
    job: ProjectWorkspaceJob;
    prompt: ProjectPromptJob;
    workerId: string;
    activationRevision: number;
    authorityRevision: string;
  }): Promise<"lost" | "recycle" | "provider_unavailable" | "marked">;
  failProjectPrompt(input: {
    job: ProjectWorkspaceJob;
    prompt: ProjectPromptJob;
    workerId: string;
    errorCode: string;
    errorMessage: string;
    retryAt?: Date;
  }): Promise<boolean>;
  requeueProjectPromptAtBoundary(input: {
    job: ProjectWorkspaceJob;
    prompt: ProjectPromptJob;
    workerId: string;
  }): Promise<boolean>;
  requeueProjectPrompts(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    prompts: ProjectPromptJob[];
    reason: string;
  }): Promise<void>;
  appendProjectSessionEvent(input: {
    job: ProjectWorkspaceJob;
    prompt: ProjectPromptJob;
    workerId: string;
    event: RunChatEvent;
  }): Promise<number>;
  persistProjectFiles(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    files: ProjectCachedFile[];
  }): Promise<void>;
  persistProjectFileDeletions(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    files: ProjectDeletedFile[];
  }): Promise<void>;
  loadProjectFileBaseline(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
  }): Promise<ProjectFileBaseline[]>;
  reserveProjectFileStorageObject(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
    storageKey: string;
  }): Promise<void>;
  listProjectStorageKeys(input: {
    job: ProjectWorkspaceJob;
    workerId: string;
  }): Promise<string[]>;
}

export interface ProjectUsageMeter {
  reserve(input: {
    job: ProjectWorkspaceJob;
    activationRevision: number;
  }): Promise<{ limitMs: number } | null>;
  start(input: {
    job: ProjectWorkspaceJob;
    activationRevision: number;
    runtimeDeadlineAt: Date;
  }): Promise<void>;
  refresh(input: {
    job: ProjectWorkspaceJob;
    activationRevision: number;
  }): Promise<{ limitMs: number } | null>;
  record(input: {
    job: ProjectWorkspaceJob;
    activationRevision: number;
    state: "running" | "stopped" | "missing";
    expiresAt: Date | null;
  }): Promise<void>;
  settle(input: {
    job: ProjectWorkspaceJob;
    activationRevision: number;
  }): Promise<void>;
}

export interface ProjectFileStorage {
  get(key: string, signal?: AbortSignal): Promise<Buffer>;
  putContentAddressed(input: {
    orgId: string;
    projectId: string;
    checksum: string;
    contentType: string;
    body: Buffer;
    signal?: AbortSignal;
  }): Promise<string>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

export function projectFileCacheKey(input: {
  orgId: string;
  projectId: string;
  checksum: string;
}): string {
  const digest = /^sha256:([0-9a-f]{64})$/.exec(input.checksum)?.[1];
  if (!digest) throw new Error("Project file checksum must be sha256");
  for (const value of [input.orgId, input.projectId]) {
    if (!value || value.includes("/") || value.includes("\\") || value.includes("..")) {
      throw new Error("Project file cache identity is invalid");
    }
  }
  return `${input.orgId}/project-files/${input.projectId}/sha256/${digest}`;
}

export function createProjectFileStorage(): ProjectFileStorage {
  return {
    get(key, signal) {
      return getSkillArchive({ key, signal });
    },
    async putContentAddressed(input) {
      const key = projectFileCacheKey(input);
      try {
        await putSkillArchive({
          key,
          body: input.body,
          contentType: input.contentType,
          preventOverwrite: true,
          signal: input.signal,
        });
      } catch (error) {
        if (!isStoragePreconditionFailure(error)) throw error;
        const existing = await getSkillArchive({ key, signal: input.signal });
        const checksum = `sha256:${createHash("sha256").update(existing).digest("hex")}`;
        if (checksum !== input.checksum || existing.length !== input.body.length) {
          throw new RunRuntimeError("Stored Project file does not match its content address");
        }
      }
      return key;
    },
    delete(key, signal) {
      return deleteSkillArchive({ key, signal });
    },
  };
}

async function putOwnedProjectFile(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  store: ProjectWorkspaceStore;
  storage: ProjectFileStorage;
  checksum: string;
  contentType: string;
  body: Buffer;
  signal: AbortSignal;
}): Promise<string> {
  const expectedKey = projectFileCacheKey({
    orgId: input.job.orgId,
    projectId: input.job.projectId,
    checksum: input.checksum,
  });
  // Durable ownership must precede the external side effect. If either the PUT or the following
  // metadata transaction crashes, the Project storage sweep retains enough identity to clean it.
  await input.store.reserveProjectFileStorageObject({
    job: input.job,
    workerId: input.workerId,
    storageKey: expectedKey,
  });
  const storageKey = await input.storage.putContentAddressed({
    orgId: input.job.orgId,
    projectId: input.job.projectId,
    checksum: input.checksum,
    contentType: input.contentType,
    body: input.body,
    signal: input.signal,
  });
  if (storageKey !== expectedKey) {
    throw new RunRuntimeError("Project file storage returned an unexpected object key");
  }
  return storageKey;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Project worker stopped");
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish(abortReason(signal));
    function finish(error?: Error) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  // Never include provider response bodies or environment values in durable errors.
  if (error instanceof ProjectLostLease) return "Project workspace lease was lost";
  if (error instanceof ProjectRecycleRequired) return "Project credentials changed";
  if (error instanceof ProjectInterruptedPrompt) {
    return "The previous agent turn was interrupted and could not be resumed safely";
  }
  if (error instanceof ProjectFileCaptureError) {
    return "A concurrent file change could not be captured safely";
  }
  if (error instanceof ProjectEnvironmentInvalidError) return error.message;
  if (error instanceof RunRuntimeError) return "Project runtime operation failed";
  return "Project workspace operation failed";
}

function clearProjectChatTarget(target: ProjectChatTarget | null): void {
  if (target) target.password = "";
}

async function loadStoredFiles(input: {
  files: ProjectStoredFile[];
  storage: ProjectFileStorage;
  signal: AbortSignal;
}): Promise<ProjectManagedFile[]> {
  return Promise.all(input.files.map(async (file) => {
    const data = await input.storage.get(file.storageKey, input.signal);
    const checksum = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    if (checksum !== file.checksum) {
      throw new RunRuntimeError(`Project upload checksum mismatch: ${file.workspacePath}`);
    }
    return { path: file.workspacePath.replace(/^files\//, ""), data };
  }));
}

async function loadProjectFileBaselineMap(input: {
  store: ProjectWorkspaceStore;
  job: ProjectWorkspaceJob;
  workerId: string;
}): Promise<Map<string, ProjectFileBaseline>> {
  const rows = await input.store.loadProjectFileBaseline(input);
  return new Map(rows.map((file) => [file.path, file]));
}

async function mirrorProjectFiles(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  runtime: ProjectWorkspaceRuntime;
  ref: ProjectWorkspaceRef;
  store: ProjectWorkspaceStore;
  storage: ProjectFileStorage;
  redactor: RunRedactor;
  baseline: Map<string, ProjectFileBaseline>;
  modifiedBySessionId: string | null;
  changedPaths?: ReadonlySet<string>;
  signal: AbortSignal;
}): Promise<void> {
  const files = await input.runtime.listFiles({
    ref: input.ref,
    maxFiles: PROJECT_FILE_MAX_COUNT,
    maxFileBytes: PROJECT_FILE_MAX_BYTES,
    maxTotalBytes: PROJECT_FILE_MAX_TOTAL_BYTES,
    signal: input.signal,
  });
  const cached: ProjectCachedFile[] = [];
  const scrubbedWorkspaceFiles: ProjectManagedFile[] = [];
  const present = new Set(files.map((file) => `files/${file.path}`));
  for (const file of files) {
    const workspacePath = `files/${file.path}`;
    if (
      input.changedPaths
      && !input.changedPaths.has(file.path)
      && !input.changedPaths.has(workspacePath)
    ) {
      continue;
    }
    const redacted = input.redactor.redactBytes(file.data);
    if (!redacted.equals(file.data)) {
      // A model may copy an injected credential into a deliverable. Remove it from both the
      // durable cache and the provider checkpoint before suspension.
      scrubbedWorkspaceFiles.push({ path: file.path, data: redacted });
    }
    const checksum = `sha256:${createHash("sha256").update(redacted).digest("hex")}`;
    const detected = detectRunArtifactType(workspacePath, redacted);
    const base = input.baseline.get(workspacePath);
    if (base?.checksum === checksum) continue;
    const storageKey = await putOwnedProjectFile({
      job: input.job,
      workerId: input.workerId,
      store: input.store,
      storage: input.storage,
      checksum,
      contentType: detected.contentType,
      body: redacted,
      signal: input.signal,
    });
    cached.push({
      path: workspacePath,
      contentType: detected.contentType,
      byteSize: redacted.length,
      checksum,
      storageKey,
      modifiedAt: file.modifiedAt,
      modifiedBySessionId: input.modifiedBySessionId,
      baseVersion: base?.version ?? null,
    });
  }
  if (scrubbedWorkspaceFiles.length > 0) {
    await input.runtime.pushFiles({
      ref: input.ref,
      files: scrubbedWorkspaceFiles,
      signal: input.signal,
    });
  }
  // DB metadata is committed only after every object is durable; previews never reference a
  // partially mirrored idle snapshot.
  await input.store.persistProjectFiles({
    job: input.job,
    workerId: input.workerId,
    files: cached,
  });
  const deleted = [...input.baseline.values()]
    .filter((file) => {
      if (present.has(file.path)) return false;
      if (!input.changedPaths) return true;
      const relative = file.path.replace(/^files\//, "");
      return input.changedPaths.has(file.path) || input.changedPaths.has(relative);
    })
    .map((file) => ({
      path: file.path,
      modifiedBySessionId: input.modifiedBySessionId,
      baseVersion: file.version,
    }));
  await input.store.persistProjectFileDeletions({
    job: input.job,
    workerId: input.workerId,
    files: deleted,
  });
}

function managedChangePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^files\//, "");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || normalized.includes("\0")
  ) {
    throw new ProjectFileCaptureError();
  }
  if (RESERVED_PROJECT_FILE_ROOTS.has(normalized.split("/")[0]!)) return null;
  return normalized;
}

/** Apply the text patch OpenCode ties to one message; never substitute bytes from the shared tree. */
export function applyProjectUnifiedPatch(base: Buffer, patch: string): Buffer {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(base);
  } catch {
    throw new ProjectFileCaptureError();
  }
  const source = text.split("\n");
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  const output: string[] = [];
  let sourceCursor = 0;
  let sawHunk = false;
  let index = 0;
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[index]!);
    if (!header) {
      index += 1;
      continue;
    }
    sawHunk = true;
    const oldLine = Number(header[1]);
    const oldStart = oldLine === 0 ? 0 : oldLine - 1;
    if (!Number.isSafeInteger(oldStart) || oldStart < sourceCursor || oldStart > source.length) {
      throw new ProjectFileCaptureError();
    }
    output.push(...source.slice(sourceCursor, oldStart));
    sourceCursor = oldStart;
    index += 1;
    while (index < lines.length && !lines[index]!.startsWith("@@ ")) {
      const line = lines[index]!;
      index += 1;
      if (line === "\\ No newline at end of file" || line === "") continue;
      const marker = line[0];
      const value = line.slice(1);
      if (marker === " ") {
        if (source[sourceCursor] !== value) throw new ProjectFileCaptureError();
        output.push(value);
        sourceCursor += 1;
      } else if (marker === "-") {
        if (source[sourceCursor] !== value) throw new ProjectFileCaptureError();
        sourceCursor += 1;
      } else if (marker === "+") {
        output.push(value);
      } else {
        throw new ProjectFileCaptureError();
      }
    }
  }
  if (!sawHunk) throw new ProjectFileCaptureError();
  output.push(...source.slice(sourceCursor));
  return Buffer.from(output.join("\n"), "utf8");
}

async function captureManagedFileBytes(input: {
  runtime: ProjectWorkspaceRuntime;
  ref: ProjectWorkspaceRef;
  signal: AbortSignal;
}): Promise<Map<string, Buffer>> {
  const files = await input.runtime.listFiles({
    ref: input.ref,
    maxFiles: PROJECT_FILE_MAX_COUNT,
    maxFileBytes: PROJECT_FILE_MAX_BYTES,
    maxTotalBytes: PROJECT_FILE_MAX_TOTAL_BYTES,
    signal: input.signal,
  });
  return new Map(files.map((file) => [file.path, Buffer.from(file.data)]));
}

async function persistCapturedTurnFiles(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  store: ProjectWorkspaceStore;
  storage: ProjectFileStorage;
  runtime: ProjectWorkspaceRuntime;
  ref: ProjectWorkspaceRef;
  redactor: RunRedactor;
  sessionId: string;
  changes: ProjectFileChange[];
  turnBaseline: Map<string, Buffer>;
  versionBaseline: Map<string, ProjectFileBaseline>;
  signal: AbortSignal;
}): Promise<void> {
  const files: ProjectCachedFile[] = [];
  const deleted: ProjectDeletedFile[] = [];
  const changedPaths = new Set<string>();
  for (const change of input.changes) {
    const relative = managedChangePath(change.path);
    if (relative === null) continue;
    const workspacePath = `files/${relative}`;
    changedPaths.add(relative);
    const baseVersion = input.versionBaseline.get(workspacePath)?.version ?? null;
    if (change.status === "deleted") {
      // Absence at turn start is version zero. If another Session created the path before this
      // deletion, recordProjectFileDeletion compares 0 with its current version and preserves the
      // overlap warning plus the deleting Session's attribution.
      deleted.push({
        path: workspacePath,
        modifiedBySessionId: input.sessionId,
        baseVersion: baseVersion ?? 0,
      });
      continue;
    }
    const base = change.status === "added"
      ? Buffer.alloc(0)
      : input.turnBaseline.get(relative);
    let reconstructed: Buffer;
    try {
      if (!base) throw new ProjectFileCaptureError();
      reconstructed = input.redactor.redactBytes(
        applyProjectUnifiedPatch(base, change.patch),
      );
    } catch (error) {
      if (!(error instanceof ProjectFileCaptureError)) throw error;
      // OpenCode's message diff is text-only. Images, PDFs, archives, or a patch whose base raced
      // another session cannot be attributed safely to this turn. Preserve every prior immutable
      // version and let the guarded current-tree mirror below advance only the neutral LWW pointer.
      continue;
    }
    const checksum = `sha256:${createHash("sha256").update(reconstructed).digest("hex")}`;
    const detected = detectRunArtifactType(workspacePath, reconstructed);
    const storageKey = await putOwnedProjectFile({
      job: input.job,
      workerId: input.workerId,
      store: input.store,
      storage: input.storage,
      checksum,
      contentType: detected.contentType,
      body: reconstructed,
      signal: input.signal,
    });
    files.push({
      path: workspacePath,
      contentType: detected.contentType,
      byteSize: reconstructed.length,
      checksum,
      storageKey,
      modifiedAt: new Date(),
      modifiedBySessionId: input.sessionId,
      baseVersion,
    });
  }
  await input.store.persistProjectFiles({
    job: input.job,
    workerId: input.workerId,
    files,
  });
  await input.store.persistProjectFileDeletions({
    job: input.job,
    workerId: input.workerId,
    files: deleted,
  });
  // Reconcile the current shared tree after preserving the immutable per-turn bytes. This final
  // metadata write is the explicit LWW pointer; concurrent versions above remain recoverable.
  await mirrorProjectFiles({
    job: input.job,
    workerId: input.workerId,
    runtime: input.runtime,
    ref: input.ref,
    store: input.store,
    storage: input.storage,
    redactor: input.redactor,
    baseline: await loadProjectFileBaselineMap(input),
    modifiedBySessionId: null,
    changedPaths,
    signal: input.signal,
  });
}

function createProjectEventRedactor(redactor: RunRedactor) {
  const streams = new Map<string, ReturnType<RunRedactor["createStream"]>>();
  return {
    events(sessionId: string, event: RunChatEvent): RunChatEvent[] {
      if (event.type === "text.delta" || event.type === "reasoning.delta") {
        const partId = event.type === "text.delta" ? event.message_id : event.part_id;
        const key = `${sessionId}:${event.type}:${partId}`;
        let stream = streams.get(key);
        if (!stream) {
          stream = redactor.createStream();
          streams.set(key, stream);
        }
        const delta = stream.push(event.delta);
        return delta ? [{ ...event, delta }] : [];
      }
      if (event.type === "text.done" || event.type === "reasoning.done") {
        const partId = event.type === "text.done" ? event.message_id : event.part_id;
        const deltaType = event.type === "text.done" ? "text.delta" : "reasoning.delta";
        const key = `${sessionId}:${deltaType}:${partId}`;
        const stream = streams.get(key);
        streams.delete(key);
        const tail = stream?.flush() ?? "";
        const prefix: RunChatEvent[] = tail
          ? event.type === "text.done"
            ? [{ type: "text.delta", message_id: event.message_id, delta: tail }]
            : [{ type: "reasoning.delta", part_id: event.part_id, delta: tail }]
          : [];
        return [...prefix, event];
      }
      return [redactor.redactPayload(event)];
    },
    clear() {
      for (const stream of streams.values()) stream.clear();
      streams.clear();
    },
  };
}

interface ProjectRecorder {
  started: Promise<void>;
  error(): Error | null;
  stop(): Promise<void>;
}

function startProjectRecorder(input: {
  chat: ProjectChatRuntime;
  target: ProjectChatTarget;
  store: ProjectWorkspaceStore;
  job: ProjectWorkspaceJob;
  workerId: string;
  promptByNativeSession: Map<string, ProjectPromptJob>;
  redactor: RunRedactor;
  parentSignal: AbortSignal;
}): ProjectRecorder {
  const abort = new AbortController();
  const signal = AbortSignal.any([input.parentSignal, abort.signal]);
  const cursorKey = {};
  const eventRedactor = createProjectEventRedactor(input.redactor);
  let failure: Error | null = null;
  let connected = false;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const loop = (async () => {
    let retryMs = 250;
    while (!signal.aborted) {
      try {
        for await (const envelope of input.chat.streamEvents(
          input.target,
          signal,
          () => {
            if (!connected) {
              connected = true;
              resolveStarted();
            }
          },
          cursorKey,
        )) {
          const prompt = input.promptByNativeSession.get(envelope.sessionId);
          if (!prompt) continue;
          const events = redactAndBoundProjectEvents(
            eventRedactor.events(envelope.sessionId, envelope.event),
          );
          for (const event of events) {
            await input.store.appendProjectSessionEvent({
              job: input.job,
              prompt,
              workerId: input.workerId,
              event,
            });
          }
        }
        if (!signal.aborted) throw new RunRuntimeError("Project event stream closed");
      } catch (error) {
        if (signal.aborted) break;
        if (!connected && retryMs >= 5_000) {
          failure = new RunRuntimeError("Project event recorder could not connect");
          resolveStarted();
          break;
        }
        await wait(retryMs, signal).catch(() => undefined);
        retryMs = Math.min(5_000, retryMs * 2);
      }
    }
  })();

  return {
    started,
    error: () => failure,
    async stop() {
      abort.abort();
      await loop.catch(() => undefined);
      eventRedactor.clear();
    },
  };
}

async function checkProjectAuthority(input: {
  store: ProjectWorkspaceStore;
  job: ProjectWorkspaceJob;
  workerId: string;
  authorityRevision: string;
  activationRevision: number;
  onBoundary(): void;
  boundaryBlocksAdmission: boolean;
}): Promise<boolean> {
  const authority = await input.store.revalidateProjectWorkspaceAuthority(input);
  if (authority === "lost_lease") throw new ProjectLostLease();
  if (authority === "immediate") throw new ProjectRecycleRequired();
  if (authority === "boundary") {
    input.onBoundary();
    return !input.boundaryBlocksAdmission;
  }
  return true;
}

async function checkProjectPromptProvider(input: {
  store: ProjectWorkspaceStore;
  job: ProjectWorkspaceJob;
  prompt: ProjectPromptJob;
  workerId: string;
}): Promise<boolean> {
  const admission = await input.store.revalidateProjectPromptProviderAdmission(input);
  if (admission === "lost_lease") throw new ProjectLostLease();
  if (admission === "admitted") return true;
  const requeued = await input.store.requeueProjectPromptAtBoundary({
    job: input.job,
    prompt: input.prompt,
    workerId: input.workerId,
  });
  if (!requeued) throw new ProjectLostLease();
  return false;
}

async function processProjectPrompt(input: {
  prompt: ProjectPromptJob;
  job: ProjectWorkspaceJob;
  workerId: string;
  store: ProjectWorkspaceStore;
  runtime: ProjectWorkspaceRuntime;
  chat: ProjectChatRuntime;
  target: ProjectChatTarget;
  ref: ProjectWorkspaceRef;
  storage: ProjectFileStorage;
  redactor: RunRedactor;
  authorityRevision: string;
  promptByNativeSession: Map<string, ProjectPromptJob>;
  config: ProjectWorkerConfig;
  activationRevision: number;
  withFileCommit<T>(operation: () => Promise<T>): Promise<T>;
  onBoundary(): void;
  signal: AbortSignal;
}): Promise<void> {
  let nativeSessionId = input.prompt.opencodeSessionId;
  let heartbeatAt = 0;
  try {
    // Authority is checked before reading attachments and again immediately before the external
    // prompt dispatch. The heartbeat loop below repeats that exact check during a long turn.
    const admitted = await checkProjectAuthority({
      ...input,
      boundaryBlocksAdmission: true,
    });
    if (!admitted) {
      const requeued = await input.store.requeueProjectPromptAtBoundary({
        job: input.job,
        prompt: input.prompt,
        workerId: input.workerId,
      });
      if (!requeued) throw new ProjectLostLease();
      return;
    }
    if (!(await checkProjectPromptProvider(input))) return;
    const [attachments, baselineRows] = await Promise.all([
      input.store.loadProjectPromptAttachments({
        job: input.job,
        prompt: input.prompt,
        workerId: input.workerId,
      }),
      input.store.loadProjectFileBaseline({
        job: input.job,
        workerId: input.workerId,
      }),
    ]);
    let baseline = new Map(baselineRows.map((file) => [file.path, file]));
    const files = await loadStoredFiles({ files: attachments, storage: input.storage, signal: input.signal });
    const attachmentPaths = new Set(attachments.map((file) => file.workspacePath));
    if (attachmentPaths.size > 0) {
      // The attachment object is already immutable. Commit push + metadata under the Project file
      // lock so same-name A/B uploads cannot attribute bytes from the shared tree to the wrong
      // session.
      await input.withFileCommit(async () => {
        await input.runtime.pushFiles({ ref: input.ref, files, signal: input.signal });
        const cached: ProjectCachedFile[] = [];
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]!;
          const attachment = attachments[index]!;
          const data = input.redactor.redactBytes(file.data);
          const checksum = `sha256:${createHash("sha256").update(data).digest("hex")}`;
          const detected = detectRunArtifactType(attachment.workspacePath, data);
          const storageKey = await putOwnedProjectFile({
            job: input.job,
            workerId: input.workerId,
            store: input.store,
            storage: input.storage,
            checksum,
            contentType: detected.contentType,
            body: data,
            signal: input.signal,
          });
          cached.push({
            path: attachment.workspacePath,
            contentType: detected.contentType,
            byteSize: data.length,
            checksum,
            storageKey,
            modifiedAt: new Date(),
            modifiedBySessionId: input.prompt.sessionId,
            baseVersion: baseline.get(attachment.workspacePath)?.version ?? null,
          });
        }
        await input.store.persistProjectFiles({
          job: input.job,
          workerId: input.workerId,
          files: cached,
        });
      });
      baseline = await loadProjectFileBaselineMap(input);
    }

    if (nativeSessionId) {
      const nativeState = await input.chat.getSessionState(
        input.target,
        nativeSessionId,
        input.signal,
      );
      if (nativeState === "missing") {
        if (input.prompt.sendAttemptedAt !== null) {
          // The provider may have executed this deterministic message before the checkpoint that
          // lost its native session. Recreating and sending again could duplicate external effects.
          throw new ProjectInterruptedPrompt();
        }
        const title = `companion:${input.prompt.sessionId}`;
        const replacement = await input.chat.findSessionByTitle(
          input.target,
          title,
          input.signal,
        ) ?? await input.chat.createSession(input.target, title, input.signal);
        const transcript = await input.store.loadProjectSessionTranscript({
          job: input.job,
          workerId: input.workerId,
          sessionId: input.prompt.sessionId,
        });
        await input.chat.rehydrateSession(
          input.target,
          replacement.id,
          transcript,
          input.signal,
        );
        const rebound = await input.store.rebindProjectSession({
          job: input.job,
          prompt: input.prompt,
          workerId: input.workerId,
          opencodeSessionId: replacement.id,
        });
        if (!rebound) throw new ProjectLostLease();
        nativeSessionId = replacement.id;
        const dispatched = await input.store.markProjectPromptDispatch({
          job: input.job,
          prompt: input.prompt,
          workerId: input.workerId,
          opencodeSessionId: nativeSessionId,
          opencodeMessageId: input.prompt.opencodeMessageId,
        });
        if (!dispatched) throw new ProjectLostLease();
      }
    }
    if (!nativeSessionId) {
      const existing = await input.chat.findSessionByTitle(
        input.target,
        `companion:${input.prompt.sessionId}`,
        input.signal,
      );
      if (!existing && input.prompt.sendAttemptedAt !== null) {
        throw new ProjectInterruptedPrompt();
      }
      nativeSessionId = existing?.id
        ?? (await input.chat.createSession(
          input.target,
          `companion:${input.prompt.sessionId}`,
          input.signal,
        )).id;
      const persisted = await input.store.markProjectPromptDispatch({
        job: input.job,
        prompt: input.prompt,
        workerId: input.workerId,
        opencodeSessionId: nativeSessionId,
        opencodeMessageId: input.prompt.opencodeMessageId,
      });
      if (!persisted) throw new ProjectLostLease();
    }
    input.promptByNativeSession.set(nativeSessionId, input.prompt);

    const stillAdmitted = await checkProjectAuthority({
      ...input,
      boundaryBlocksAdmission: true,
    });
    if (!stillAdmitted) {
      const requeued = await input.store.requeueProjectPromptAtBoundary({
        job: input.job,
        prompt: input.prompt,
        workerId: input.workerId,
      });
      if (!requeued) throw new ProjectLostLease();
      return;
    }
    // The provider connection can disappear after claim/session binding. Fence the last pre-send
    // edge separately so a credentialless OpenCode call can never cross that race.
    if (!(await checkProjectPromptProvider(input))) return;
    const turnBaseline = await captureManagedFileBytes({
      runtime: input.runtime,
      ref: input.ref,
      signal: input.signal,
    });
    let state = await input.chat.getMessageState(
      input.target,
      nativeSessionId,
      input.prompt.opencodeMessageId,
      input.signal,
    );
    let dispatchedNow = false;
    let observedBusy = false;
    let dispatchedAt = 0;
    if (state === "missing") {
      if (input.prompt.sendAttemptedAt !== null) {
        throw new ProjectInterruptedPrompt();
      }
      const sendFenced = await input.store.markProjectPromptSendAttempted({
        job: input.job,
        prompt: input.prompt,
        workerId: input.workerId,
        activationRevision: input.activationRevision,
        authorityRevision: input.authorityRevision,
      });
      if (sendFenced === "lost") throw new ProjectLostLease();
      if (sendFenced === "recycle") throw new ProjectRecycleRequired();
      if (sendFenced === "provider_unavailable") {
        const requeued = await input.store.requeueProjectPromptAtBoundary({
          job: input.job,
          prompt: input.prompt,
          workerId: input.workerId,
        });
        if (!requeued) throw new ProjectLostLease();
        return;
      }
      await input.chat.sendPrompt(
        input.target,
        nativeSessionId,
        input.prompt.text,
        input.prompt.opencodeMessageId,
        input.prompt.model,
        input.signal,
      );
      state = "pending";
      dispatchedNow = true;
      dispatchedAt = Date.now();
    } else if (state === "error") {
      throw new RunRuntimeError("OpenCode could not complete the Project prompt");
    } else if (state === "pending") {
      const sessionState = await input.chat.getSessionState(
        input.target,
        nativeSessionId,
        input.signal,
      );
      if (sessionState === "idle") {
        // The durable user message exists, but the restarted server has no active assistant turn.
        // Re-sending it would duplicate a command whose external effects are unknown.
        throw new ProjectInterruptedPrompt();
      }
      observedBusy = sessionState === "busy";
    }

    while (state !== "completed") {
      await wait(PROMPT_STATE_POLL_MS, input.signal);
      if (Date.now() >= heartbeatAt) {
        const [lease] = await Promise.all([
          input.store.heartbeatProjectPromptLease({
            job: input.job,
            prompt: input.prompt,
            workerId: input.workerId,
            leaseSeconds: input.config.leaseSeconds,
          }),
          checkProjectAuthority({
            ...input,
            boundaryBlocksAdmission: false,
          }),
        ]);
        if (!lease) throw new ProjectLostLease();
        heartbeatAt = Date.now() + input.config.heartbeatMs;
      }
      state = await input.chat.getMessageState(
        input.target,
        nativeSessionId,
        input.prompt.opencodeMessageId,
        input.signal,
      );
      if (state === "error") throw new RunRuntimeError("OpenCode Project prompt failed");
      if (state === "missing") {
        // A persisted attempted dispatch whose exact deterministic message disappeared is not safe
        // to duplicate automatically.
        throw new RunRuntimeError("OpenCode Project message disappeared after dispatch");
      }
      if (state === "pending") {
        const sessionState = await input.chat.getSessionState(
          input.target,
          nativeSessionId,
          input.signal,
        );
        if (sessionState === "busy") observedBusy = true;
        const startupGraceMs = Math.max(10_000, PROMPT_STATE_POLL_MS * 4);
        if (
          sessionState === "idle"
          && (observedBusy || !dispatchedNow || Date.now() - dispatchedAt >= startupGraceMs)
        ) {
          throw new ProjectInterruptedPrompt();
        }
      }
    }

    const changes = await input.chat.getFileChanges(
      input.target,
      nativeSessionId,
      input.prompt.opencodeMessageId,
      input.signal,
    );
    await input.withFileCommit(() => persistCapturedTurnFiles({
      job: input.job,
      workerId: input.workerId,
      runtime: input.runtime,
      ref: input.ref,
      store: input.store,
      storage: input.storage,
      redactor: input.redactor,
      sessionId: input.prompt.sessionId,
      changes,
      turnBaseline,
      versionBaseline: baseline,
      signal: input.signal,
    }));
    const transcript = redactAndBoundProjectTranscript(
      await input.chat.loadItems(input.target, nativeSessionId, input.signal),
      input.redactor,
    );
    const completed = await input.store.completeProjectPrompt({
      job: input.job,
      prompt: input.prompt,
      workerId: input.workerId,
      opencodeSessionId: nativeSessionId,
      transcript,
    });
    if (!completed) throw new ProjectLostLease();
  } catch (error) {
    const reason = input.signal.aborted ? abortReason(input.signal) : error;
    if (reason instanceof ProjectPromptStopped) return;
    if (
      reason instanceof ProjectLostLease
      || reason instanceof ProjectRecycleRequired
      || reason instanceof ProjectDeletionRequested
      || reason instanceof ProjectWorkerShutdown
    ) {
      if (reason instanceof ProjectRecycleRequired && nativeSessionId) {
        // Revocation is an admission-kill boundary, not merely a later checkpoint request. Abort
        // the native turn while its id is still mapped, then durably requeue the exact prompt
        // before task cleanup removes it from the workspace-level active sets.
        await input.chat.abortSession(
          input.target,
          nativeSessionId,
          AbortSignal.timeout(10_000),
        ).catch(() => undefined);
        await input.store.requeueProjectPrompts({
          job: input.job,
          workerId: input.workerId,
          prompts: [input.prompt],
          reason: "project_credentials_recycled",
        });
      }
      throw reason;
    }
    await input.store.failProjectPrompt({
      job: input.job,
      prompt: input.prompt,
      workerId: input.workerId,
      errorCode: reason instanceof ProjectInterruptedPrompt
        ? "project_prompt_interrupted"
        : "project_prompt_failed",
      errorMessage: errorMessage(reason),
      retryAt: reason instanceof ProjectInterruptedPrompt
        ? undefined
        : new Date(Date.now() + 1_000),
    });
    if (reason instanceof ProjectInterruptedPrompt) throw reason;
  } finally {
    if (nativeSessionId) input.promptByNativeSession.delete(nativeSessionId);
  }
}

export async function runProjectWorkspaceJob(input: {
  job: ProjectWorkspaceJob;
  workerId: string;
  store: ProjectWorkspaceStore;
  runtime: ProjectWorkspaceRuntime;
  chat: ProjectChatRuntime;
  usage: ProjectUsageMeter;
  storage: ProjectFileStorage;
  goldenSnapshotId: string;
  config: ProjectWorkerConfig;
  signal: AbortSignal;
}): Promise<void> {
  const ref: ProjectWorkspaceRef = {
    sandboxName: input.job.sandboxName,
    sandboxId: input.job.sandboxId,
    region: input.config.region,
    timeoutMs: input.config.sandboxTimeoutMs,
  };
  const heartbeatAbort = new AbortController();
  const activationAbort = new AbortController();
  const signal = AbortSignal.any([input.signal, heartbeatAbort.signal, activationAbort.signal]);
  let providerRunning = false;
  let providerStopped = false;
  let providerActivationAttempted = false;
  let usageReserved = false;
  let reservedActivationRevision: number | null = null;
  let recorder: ProjectRecorder | null = null;
  let redactor = createRunRedactor([]);
  let activationEnvironmentResolved = false;
  let target: ProjectChatTarget | null = null;
  let authorityRevision = input.job.authorityRevision ?? "";
  let activationRevision = input.job.activationRevision;
  let activationAdmissionToken = input.job.activationAdmissionToken;
  let activationAdmissionCreatedHere = false;
  let appliedGeneration = input.job.appliedGeneration;
  let boundaryRecyclePending = false;
  let skillSyncFailurePending = input.job.skillSyncErrorAt !== null;
  let activationStartedAt = 0;
  let provisionedUntil = 0;
  let activationBudgetMs = input.config.maxActivationMs;
  const promptByNativeSession = new Map<string, ProjectPromptJob>();
  const activePrompts = new Map<string, {
    prompt: ProjectPromptJob;
    abort: AbortController;
    task: Promise<void>;
  }>();
  const activeSessionIds = new Set<string>();
  const preclaimedPrompts: ProjectPromptJob[] = [];
  const preclaimedSessionStops: ProjectSessionStopJob[] = [];
  let fileCommitTail = Promise.resolve();
  const withFileCommit = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = fileCommitTail;
    let release!: () => void;
    fileCommitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const restoreDurableFileProjection = async (boundarySignal: AbortSignal): Promise<void> => {
    const durablePlan = await input.store.loadProjectMaterializationPlan({
      job: input.job,
      workerId: input.workerId,
    });
    await input.runtime.syncFiles({
      ref,
      files: await loadStoredFiles({
        files: durablePlan.bootstrapFiles,
        storage: input.storage,
        signal: boundarySignal,
      }),
      signal: boundarySignal,
    });
  };
  const persistOrRestoreFileProjection = async (
    boundarySignal: AbortSignal,
  ): Promise<void> => {
    if (!activationEnvironmentResolved) {
      await restoreDurableFileProjection(boundarySignal);
      return;
    }
    await mirrorProjectFiles({
      job: input.job,
      workerId: input.workerId,
      runtime: input.runtime,
      ref,
      store: input.store,
      storage: input.storage,
      redactor,
      baseline: await loadProjectFileBaselineMap(input),
      modifiedBySessionId: null,
      signal: boundarySignal,
    });
  };
  const stopAndSurfaceSkillFailure = async (boundarySignal: AbortSignal): Promise<void> => {
    const observation = await input.runtime.observe(ref, boundarySignal);
    if (observation.state === "running") {
      await (recorder as ProjectRecorder | null)?.stop();
      recorder = null;
      await persistOrRestoreFileProjection(boundarySignal);
      await input.runtime.scrubAgentState(ref, boundarySignal);
      const checkpoint = await input.runtime.checkpointAndStop(ref, boundarySignal);
      providerStopped = true;
      if (activationRevision > 0) {
        await input.usage.record({
          job: input.job,
          activationRevision,
          state: "stopped",
          expiresAt: null,
        });
        await input.usage.settle({ job: input.job, activationRevision });
      }
      const stopped = await input.store.updateProjectWorkspaceState({
        job: input.job,
        workerId: input.workerId,
        status: "stopped",
        checkpointId: checkpoint.snapshotId,
        checkpointCreatedAt: new Date(),
        checkpointGeneration: appliedGeneration,
        appliedGeneration,
        sandboxDomain: null,
        idleDeadlineAt: null,
      });
      if (!stopped) throw new ProjectLostLease();
    }
    const surfaced = await input.store.surfaceProjectSkillSyncFailure({
      job: input.job,
      workerId: input.workerId,
    });
    if (!surfaced) throw new ProjectLostLease();
  };

  const heartbeat = (async () => {
    while (!signal.aborted) {
      await wait(input.config.heartbeatMs, signal);
      const alive = await input.store.heartbeatProjectWorkspaceLease({
        job: input.job,
        workerId: input.workerId,
        leaseSeconds: input.config.leaseSeconds,
      });
      if (!alive) {
        activationAbort.abort(new ProjectLostLease());
        return;
      }
      const control = await input.store.readProjectWorkspaceControl({
        job: input.job,
        workerId: input.workerId,
      });
      if (control.deleteRequestedAt) {
        activationAbort.abort(new ProjectDeletionRequested());
        return;
      }
      if (control.skillSyncErrorAt) skillSyncFailurePending = true;
      if (providerRunning && !providerStopped) {
        const observation = await input.runtime.observe(ref, signal);
        const [runtimeBudget] = await Promise.all([
          input.usage.refresh({ job: input.job, activationRevision }),
          input.usage.record({
            job: input.job,
            activationRevision,
            state: observation.state,
            expiresAt: observation.expiresAt,
          }),
        ]);
        if (observation.state === "missing") {
          activationAbort.abort(
            new RunRuntimeError("Project workspace disappeared during an active lease"),
          );
          return;
        }
        if (observation.state === "stopped" && !providerStopped) {
          activationAbort.abort(
            new RunRuntimeError("Project workspace stopped unexpectedly during an active lease"),
          );
          return;
        }
        const observedExpiry = observation.expiresAt?.getTime() ?? provisionedUntil;
        if (activePrompts.size > 0) {
          const thresholdMs = Math.max(
            input.config.heartbeatMs * 3,
            Math.min(5 * 60_000, Math.floor(input.config.sandboxTimeoutMs / 4)),
          );
          const configuredDeadline = activationStartedAt + input.config.maxActivationMs;
          const admittedDeadline = Math.min(
            configuredDeadline,
            activationStartedAt
              + (runtimeBudget?.limitMs ?? input.config.maxActivationMs),
          );
          if (
            observedExpiry - Date.now() <= thresholdMs
            && observedExpiry < admittedDeadline
          ) {
            const requestedMs = Math.min(
              input.config.sandboxTimeoutMs,
              admittedDeadline - observedExpiry,
            );
            // Prompt admission owns quota extension. The worker may only apply provider time that
            // is already visible in the refreshed durable budget.
            const additionalMs = Math.min(
              requestedMs,
              admittedDeadline - observedExpiry,
            );
            if (additionalMs > 0) {
              const extended = await input.runtime.extendTimeout(
                ref,
                additionalMs,
                AbortSignal.timeout(Math.min(10_000, input.config.heartbeatMs)),
              );
              provisionedUntil = extended.expiresAt?.getTime()
                ?? observedExpiry + additionalMs;
              await input.usage.record({
                job: input.job,
                activationRevision,
                state: extended.state,
                expiresAt: extended.expiresAt,
              });
              if (extended.state !== "running") {
                activationAbort.abort(
                  new RunRuntimeError("Project workspace stopped during timeout extension"),
                );
                return;
              }
            }
          }
        }
      }
      if (authorityRevision) {
        const authority = await input.store.revalidateProjectWorkspaceAuthority({
          job: input.job,
          workerId: input.workerId,
          authorityRevision,
          activationRevision,
        });
        if (authority === "lost_lease") {
          activationAbort.abort(new ProjectLostLease());
          return;
        }
        if (authority === "immediate") {
          activationAbort.abort(new ProjectRecycleRequired());
          return;
        }
        if (authority === "boundary") boundaryRecyclePending = true;
      }
    }
  })().catch((error) => {
    if (!signal.aborted) activationAbort.abort(error);
  });

  try {
    if (input.job.deleteRequestedAt) {
      const storageKeys = await input.store.listProjectStorageKeys({
        job: input.job,
        workerId: input.workerId,
      });
      await input.runtime.destroy(ref, signal);
      for (const key of storageKeys) await input.storage.delete(key, signal);
      providerStopped = true;
      await input.store.updateProjectWorkspaceState({
        job: input.job,
        workerId: input.workerId,
        status: "deleted",
        sandboxId: null,
        sandboxDomain: null,
        checkpointId: null,
      });
      await input.usage.settle({ job: input.job, activationRevision });
      await input.store.completeProjectDeletion({ job: input.job, workerId: input.workerId });
      return;
    }
    if (input.job.recycleRequestedAt) {
      const observation = await input.runtime.observe(ref, signal);
      const observedActivationRevision =
        input.job.activationAdmissionRevision ?? activationRevision;
      let checkpointId = input.job.checkpointId ?? observation.currentSnapshotId;
      if (observation.state === "running") {
        // A warm Project has no active turn. Restore the exact durable Files projection before the
        // security stop so unattended/background writes cannot become trusted Project versions.
        const recyclePlan = await input.store.loadProjectMaterializationPlan({
          job: input.job,
          workerId: input.workerId,
        });
        await input.runtime.syncFiles({
          ref,
          files: await loadStoredFiles({
            files: recyclePlan.bootstrapFiles,
            storage: input.storage,
            signal,
          }),
          signal,
        });
        await input.runtime.scrubAgentState(ref, signal);
        checkpointId = (await input.runtime.checkpointAndStop(ref, signal)).snapshotId;
        providerStopped = true;
      } else if (
        observation.state === "missing"
        && !checkpointId
        && activationRevision === 0
        && activationAdmissionToken
        && input.job.activationAdmissionRevision
      ) {
        // A provider attempt for the very first, secretless activation may have returned
        // ambiguously. Once observation proves the named VM does not exist, no user state or
        // credential can be lost: clear the pending/recycle fence and retry from golden.
        const reset = await input.store.cancelProjectActivation({
          job: input.job,
          workerId: input.workerId,
          activationRevision: input.job.activationAdmissionRevision,
          admissionToken: activationAdmissionToken,
          resetFreshRecycle: true,
        });
        if (reset !== "fresh_requeued") throw new ProjectLostLease();
        await input.usage.settle({
          job: input.job,
          activationRevision: input.job.activationAdmissionRevision,
        });
        activationAdmissionToken = null;
        return;
      } else if (observation.state === "missing" && !checkpointId) {
        throw new ProjectWorkspaceUnrecoverable(
          "Project workspace is missing and has no restorable checkpoint",
        );
      }
      if (!checkpointId) {
        throw new RunRuntimeError("Project recycle has no restorable checkpoint");
      }
      if (observedActivationRevision > 0) {
        await input.usage.record({
          job: input.job,
          activationRevision: observedActivationRevision,
          state: observation.state === "running" ? "stopped" : observation.state,
          expiresAt: null,
        });
        await input.usage.settle({
          job: input.job,
          activationRevision: observedActivationRevision,
        });
      }
      const completed = await input.store.completeProjectWorkspaceRecycle({
        job: input.job,
        workerId: input.workerId,
        checkpointId,
        checkpointCreatedAt: new Date(),
        checkpointGeneration: appliedGeneration,
        appliedGeneration,
      });
      if (!completed) throw new ProjectLostLease();
      return;
    }
    if (skillSyncFailurePending) {
      await stopAndSurfaceSkillFailure(signal);
      return;
    }

    let plan = await input.store.loadProjectMaterializationPlan({
      job: input.job,
      workerId: input.workerId,
    });
    appliedGeneration = plan.appliedGeneration;
    const validateActivationEnvironment = async (): Promise<void> => {
      await input.store.validateProjectActivation({
        job: input.job,
        workerId: input.workerId,
      });
    };

    if (
      (input.job.activationRevision > 0 || input.job.sandboxId !== null)
      && !input.job.checkpointId
    ) {
      await validateActivationEnvironment();
      const existing = await input.runtime.observe(ref, signal);
      if (existing.state === "missing") {
        // Golden is valid only for a Project that has never been provisioned. Recreating an
        // already-activated Project from golden would silently discard its shared filesystem.
        throw new ProjectWorkspaceUnrecoverable(
          "Project workspace is missing and has no restorable checkpoint",
        );
      }
    }

    // A never-provisioned Project can be rejected without even observing the provider. Existing
    // workspaces are observed below so a warm activation still follows the revocation boundary.
    if (input.job.activationRevision === 0 && input.job.sandboxId === null) {
      await validateActivationEnvironment();
    }

    const providerAdmission = await input.store.inspectProjectPromptProviderAdmission({
      job: input.job,
      workerId: input.workerId,
    });
    const warmIdleStopDue =
      activationRevision > 0
      && input.job.status === "ready"
      && input.job.idleDeadlineAt !== null
      && input.job.idleDeadlineAt.getTime() <= Date.now();
    if (
      providerAdmission === "provider_unavailable"
      && !warmIdleStopDue
      && plan.desiredGeneration === plan.appliedGeneration
    ) {
      preclaimedSessionStops.push(...await input.store.claimProjectSessionStops({
        job: input.job,
        workerId: input.workerId,
      }));
    }
    if (
      providerAdmission === "provider_unavailable"
      && !warmIdleStopDue
      && plan.desiredGeneration === plan.appliedGeneration
      && preclaimedSessionStops.length === 0
    ) {
      // Leave every prompt queued before billing or provider I/O. Provider-connect signals are the
      // only path that clears this recoverable gate; another prompt cannot wake it by itself.
      const blocked = await input.store.updateProjectWorkspaceState({
        job: input.job,
        workerId: input.workerId,
        status: input.job.status === "ready" ? "ready" : "error",
        errorCode: "project_provider_unavailable",
        errorMessage: "Reconnect this session's model provider to continue.",
      });
      if (!blocked) throw new ProjectLostLease();
      return;
    }

    // A deadline wake owns the workspace lease but must not manufacture a new provider activation
    // merely to stop the already-running warm VM. Claim once to fence work that raced the deadline;
    // if none exists, checkpoint and settle the current activation directly.
    if (
      activationRevision > 0
      && input.job.status === "ready"
      && input.job.idleDeadlineAt !== null
      && input.job.idleDeadlineAt.getTime() <= Date.now()
      && plan.desiredGeneration === plan.appliedGeneration
    ) {
      preclaimedPrompts.push(...await input.store.claimProjectPromptJobs({
        job: input.job,
        workerId: input.workerId,
        limit: input.config.concurrency,
        leaseSeconds: input.config.leaseSeconds,
        excludeSessionIds: [],
      }));
      preclaimedSessionStops.push(...await input.store.claimProjectSessionStops({
        job: input.job,
        workerId: input.workerId,
      }));
      const [control, refreshedPlan] = await Promise.all([
        input.store.readProjectWorkspaceControl({
          job: input.job,
          workerId: input.workerId,
        }),
        input.store.loadProjectMaterializationPlan({
          job: input.job,
          workerId: input.workerId,
        }),
      ]);
      plan = refreshedPlan;
      if (control.deleteRequestedAt) throw new ProjectDeletionRequested();
      if (control.skillSyncErrorAt) {
        skillSyncFailurePending = true;
        await stopAndSurfaceSkillFailure(signal);
        return;
      }
      if (
        preclaimedPrompts.length === 0
        && preclaimedSessionStops.length === 0
        && refreshedPlan.desiredGeneration === refreshedPlan.appliedGeneration
      ) {
        const observation = await input.runtime.observe(ref, signal);
        providerRunning = observation.state === "running";
        let checkpointId = input.job.checkpointId ?? observation.currentSnapshotId;
        if (observation.state === "running") {
          await input.store.updateProjectWorkspaceState({
            job: input.job,
            workerId: input.workerId,
            status: "stopping",
          });
          // This worker never held the literals injected into the lease-free warm process. Do not
          // trust or mirror unattended bytes with an empty redactor; completed turns are already
          // durable, so restore the exact S3 projection before checkpointing.
          await input.runtime.syncFiles({
            ref,
            files: await loadStoredFiles({
              files: refreshedPlan.bootstrapFiles,
              storage: input.storage,
              signal,
            }),
            signal,
          });
          await input.runtime.scrubAgentState(ref, signal);
          checkpointId = (await input.runtime.checkpointAndStop(ref, signal)).snapshotId;
          providerStopped = true;
        } else if (observation.state === "missing" && !checkpointId) {
          throw new ProjectWorkspaceUnrecoverable(
            "Project workspace is missing and has no restorable checkpoint",
          );
        }
        if (!checkpointId) {
          throw new RunRuntimeError("Project idle suspension has no restorable checkpoint");
        }
        await input.usage.record({
          job: input.job,
          activationRevision,
          state: observation.state === "running" ? "stopped" : observation.state,
          expiresAt: null,
        });
        const stopped = await input.store.updateProjectWorkspaceState({
          job: input.job,
          workerId: input.workerId,
          status: "stopped",
          checkpointId,
          checkpointCreatedAt: new Date(),
          checkpointGeneration: appliedGeneration,
          appliedGeneration,
          sandboxDomain: null,
          idleDeadlineAt: null,
          errorCode: null,
          errorMessage: null,
        });
        if (!stopped) throw new ProjectLostLease();
        await input.usage.settle({ job: input.job, activationRevision });
        return;
      }
    }

    await input.store.updateProjectWorkspaceState({
      job: input.job,
      workerId: input.workerId,
      status: "provisioning",
      errorCode: null,
      errorMessage: null,
    });

    let previousObservation: Awaited<ReturnType<ProjectWorkspaceRuntime["observe"]>> | null = null;
    const previousActivationRevision = activationRevision;
    if (previousActivationRevision > 0) {
      await validateActivationEnvironment();
      previousObservation = await input.runtime.observe(ref, signal);
      providerRunning = previousObservation.state === "running";
      if (providerRunning) {
        activationStartedAt = previousObservation.startedAt?.getTime()
          ?? Math.max(0, (previousObservation.expiresAt?.getTime() ?? Date.now())
            - ref.timeoutMs);
        provisionedUntil = previousObservation.expiresAt?.getTime()
          ?? activationStartedAt + ref.timeoutMs;
      }
    }

    // A crash after the durable admission or provider restore must resume the same idempotent
    // activation revision, not mistake the secretless VM for the prior warm activation.
    const recoveringPendingAdmission = activationAdmissionToken !== null;
    const continuingWarmActivation =
      previousObservation?.state === "running" && !recoveringPendingAdmission;
    if (continuingWarmActivation) {
      if (!authorityRevision) {
        throw new RunRuntimeError("warm Project activation has no authority revision");
      }
      const authority = await input.store.revalidateProjectWorkspaceAuthority({
        job: input.job,
        workerId: input.workerId,
        authorityRevision,
        activationRevision,
      });
      if (authority === "lost_lease") throw new ProjectLostLease();
      if (authority !== "current") throw new ProjectRecycleRequired();
      // This validates that the continuous usage row still exists before touching the provider.
      // No new row is reserved: lease-free wakes remain one billable provider activation.
      const budget = await input.usage.refresh({
        job: input.job,
        activationRevision,
      });
      activationBudgetMs = budget?.limitMs ?? input.config.maxActivationMs;
    } else if (previousObservation && !recoveringPendingAdmission) {
      // A truly stopped/missing VM ends the previous activation. Only its subsequent resume gets
      // a new revision and reservation.
      await input.usage.record({
        job: input.job,
        activationRevision: previousActivationRevision,
        state: previousObservation.state,
        expiresAt: previousObservation.expiresAt,
      });
      await input.usage.settle({
        job: input.job,
        activationRevision: previousActivationRevision,
      });
    }

    if (!continuingWarmActivation) {
      await validateActivationEnvironment();
      const nextActivationRevision = previousActivationRevision + 1;
      const admission = await input.store.beginProjectActivation({
        job: input.job,
        workerId: input.workerId,
        activationRevision: nextActivationRevision,
      });
      activationAdmissionCreatedHere = activationAdmissionToken === null;
      activationAdmissionToken = admission.token;
      const budget = await input.usage.reserve({
        job: input.job,
        activationRevision: nextActivationRevision,
      });
      activationBudgetMs = budget?.limitMs ?? input.config.maxActivationMs;
      usageReserved = true;
      reservedActivationRevision = nextActivationRevision;
      activationRevision = nextActivationRevision;
      // Provider restoration is secretless. For a warm activation this call only kills the old
      // OpenCode server; for a stopped activation it resumes before any new pins are installed.
    }
    ref.timeoutMs = Math.min(
      input.config.sandboxTimeoutMs,
      activationBudgetMs,
    );
    // A signal that committed after begin remains ordered after the durable admission and sets the
    // recycle fence. This last check avoids unnecessary provider churn; prepare below is still the
    // authoritative no-injection boundary if a mutation races after this check.
    await validateActivationEnvironment();
    providerActivationAttempted = true;
    const workspace = await input.runtime.activate({
      ref,
      sourceSnapshotId: input.job.checkpointId ?? input.goldenSnapshotId,
      signal,
    });
    // From this exact point provider cleanup belongs to a lease owner even if the first durable
    // post-restore update loses its fence.
    providerRunning = true;
    if (!continuingWarmActivation) {
      if (!activationAdmissionToken) {
        throw new RunRuntimeError("Project activation lost its admission fence");
      }
      // The previous OpenCode process is now stopped, so advancing DB pins cannot leave an old
      // exposed process outside the new activation's revocation fence.
      const prepared = await input.store.prepareProjectActivation({
        job: input.job,
        workerId: input.workerId,
        activationRevision,
        admissionToken: activationAdmissionToken,
      });
      activationAdmissionToken = null;
      authorityRevision = prepared.authorityRevision;
      activationStartedAt = Date.now();
      provisionedUntil = activationStartedAt + ref.timeoutMs;
      await input.usage.start({
        job: input.job,
        activationRevision,
        runtimeDeadlineAt: new Date(
          activationStartedAt
            + Math.min(input.config.maxActivationMs, activationBudgetMs),
        ),
      });
    }
    if (workspace.restoredFromSnapshot) {
      // `appliedGeneration` describes the last live VM. A reconstructed VM contains only the
      // generation captured by its checkpoint and must be downgraded durably before resync.
      appliedGeneration = plan.checkpointGeneration;
      if (plan.appliedGeneration !== appliedGeneration) {
        const restored = await input.store.updateProjectWorkspaceState({
          job: input.job,
          workerId: input.workerId,
          appliedGeneration,
        });
        if (!restored) throw new ProjectLostLease();
      }
    }
    await input.usage.record({
      job: input.job,
      activationRevision,
      state: "running",
      expiresAt: continuingWarmActivation ? previousObservation?.expiresAt ?? null : null,
    });
    await input.store.updateProjectWorkspaceState({
      job: input.job,
      workerId: input.workerId,
      status: "provisioning",
      sandboxId: workspace.sandboxId,
      sandboxDomain: workspace.domain,
      activationRevision,
    });
    // Re-materialize the exact projection on every activation, even when generation metadata
    // matches. Skills are executable and a previous turn may have drifted their checkpoint copy.
    await input.runtime.syncSkillBundles({
      ref,
      generation: plan.desiredGeneration,
      skills: plan.skills,
      signal,
    });
    if (plan.desiredGeneration !== appliedGeneration) {
      const applied = await input.store.updateProjectWorkspaceState({
        job: input.job,
        workerId: input.workerId,
        appliedGeneration: plan.desiredGeneration,
      });
      if (!applied) throw new ProjectLostLease();
      appliedGeneration = plan.desiredGeneration;
    }
    // S3 metadata is authoritative for the managed files projection. Replace it even when empty:
    // an older restored checkpoint may still contain a path that was durably tombstoned later.
    await input.runtime.syncFiles({
      ref,
      files: await loadStoredFiles({
        files: plan.bootstrapFiles,
        storage: input.storage,
        signal,
      }),
      signal,
    });

    const startServerForPrompts = async (): Promise<void> => {
      if (target && recorder) return;
      const authority = await input.store.revalidateProjectWorkspaceAuthority({
        job: input.job,
        workerId: input.workerId,
        authorityRevision,
        activationRevision,
      });
      if (authority === "lost_lease") throw new ProjectLostLease();
      if (authority !== "current") throw new ProjectRecycleRequired();
      const activation = await input.store.resolveProjectActivationEnvironment({
        job: input.job,
        workerId: input.workerId,
        activationRevision,
        authorityRevision,
      });
      redactor.clear();
      redactor = createRunRedactor(activation.injectedLiterals);
      authorityRevision = activation.authorityRevision;
      target = { domain: workspace.domain, password: activation.serverPassword };
      const exposureFenced = await input.store.markProjectActivationExposureAttempted({
        job: input.job,
        workerId: input.workerId,
        activationRevision,
      });
      if (!exposureFenced) throw new ProjectRecycleRequired();
      // From this durable fence onward, a lost provider response is treated as real exposure.
      // Retain the redactor and force scrub/checkpoint on every failure path.
      activationEnvironmentResolved = true;
      try {
        await input.runtime.startServer({ ref, env: activation.env, signal });
      } finally {
        // Strings cannot be overwritten in V8, but dropping every container reference minimizes
        // their lifetime; the exact values remain only inside the redactor until suspension.
        for (const key of Object.keys(activation.env)) {
          activation.env[key] = "";
          delete activation.env[key];
        }
        activation.injectedLiterals.length = 0;
        activation.serverPassword = "";
      }
      // startServer returns only after the detached process inherited the environment. From this
      // point the pins were truly exposed even if the subsequent health probe fails.
      const markedInjected = await input.store.markProjectActivationInjected({
        job: input.job,
        workerId: input.workerId,
        activationRevision,
      });
      if (!markedInjected) throw new ProjectRecycleRequired();
      await input.runtime.healthCheck({
        ref,
        domain: target.domain,
        password: target.password,
        signal,
      });
      recorder = startProjectRecorder({
        chat: input.chat,
        target,
        store: input.store,
        job: input.job,
        workerId: input.workerId,
        promptByNativeSession,
        redactor,
        parentSignal: signal,
      });
      await recorder.started;
      if (recorder.error()) throw recorder.error();
    };

    let lastActivityAt = input.job.lastActivityAt.getTime();
    let nextMaterializationCheckAt = Date.now() + MATERIALIZATION_POLL_MS;
    let nextBoundaryAuthorityCheckAt = Date.now();
    let promptFailure: Error | null = null;
    const initialized = await input.store.updateProjectWorkspaceState({
      job: input.job,
      workerId: input.workerId,
      status: "ready",
      lastActivityAt: new Date(lastActivityAt),
      idleDeadlineAt: input.job.idleDeadlineAt
        ?? new Date(lastActivityAt + input.config.idleMs),
    });
    if (!initialized) throw new ProjectLostLease();
    let interactiveStatus: "ready" | "running" = "ready";
    const syncInteractiveStatus = async (): Promise<void> => {
      const desired = activePrompts.size > 0 ? "running" : "ready";
      if (desired === interactiveStatus) return;
      const updated = await input.store.updateProjectWorkspaceState({
        job: input.job,
        workerId: input.workerId,
        status: desired,
        lastActivityAt: new Date(lastActivityAt),
        idleDeadlineAt: desired === "running"
          ? null
          : new Date(lastActivityAt + input.config.idleMs),
      });
      if (!updated) throw new ProjectLostLease();
      interactiveStatus = desired;
    };

    while (!signal.aborted) {
      if (promptFailure) throw promptFailure;
      const currentRecorder = recorder as ProjectRecorder | null;
      if (currentRecorder?.error()) throw currentRecorder.error();
      if (skillSyncFailurePending && activePrompts.size === 0) {
        await stopAndSurfaceSkillFailure(signal);
        return;
      }
      // This is intentionally derived from the aggregate in-process prompt set. Individual
      // completions never write `ready`, so one finishing turn cannot hide a concurrent peer from
      // Projects home or make the workspace appear idle.
      await syncInteractiveStatus();

      if (
        authorityRevision
        && activePrompts.size === 0
        && Date.now() >= nextBoundaryAuthorityCheckAt
      ) {
        const authority = await input.store.revalidateProjectWorkspaceAuthority({
          job: input.job,
          workerId: input.workerId,
          authorityRevision,
          activationRevision,
        });
        nextBoundaryAuthorityCheckAt = Date.now()
          + Math.min(MATERIALIZATION_POLL_MS, input.config.heartbeatMs);
        if (authority === "lost_lease") throw new ProjectLostLease();
        if (authority === "immediate") throw new ProjectRecycleRequired();
        if (authority === "boundary") boundaryRecyclePending = true;
      }

      const stops = preclaimedSessionStops.length > 0
        ? preclaimedSessionStops.splice(0)
        : await input.store.claimProjectSessionStops({
            job: input.job,
            workerId: input.workerId,
          });
      for (const session of stops) {
        const active = [...activePrompts.values()]
          .find(({ prompt }) => prompt.sessionId === session.sessionId);
        active?.abort.abort(new ProjectPromptStopped());
        if (target && session.opencodeSessionId) {
          await input.chat.abortSession(target, session.opencodeSessionId, signal);
        }
        await active?.task.catch(() => undefined);
        const transcript = target && session.opencodeSessionId
          ? redactAndBoundProjectTranscript(
              await input.chat.loadItems(target, session.opencodeSessionId, signal),
              redactor,
            )
          : undefined;
        const stopped = await input.store.completeProjectSessionStop({
          job: input.job,
          workerId: input.workerId,
          session,
          transcript,
        });
        if (!stopped) throw new ProjectLostLease();
        lastActivityAt = Date.now();
      }

      if (
        !boundaryRecyclePending
        && activePrompts.size === 0
        && Date.now() >= nextMaterializationCheckAt
      ) {
        const refreshed = await input.store.loadProjectMaterializationPlan({
          job: input.job,
          workerId: input.workerId,
        });
        nextMaterializationCheckAt = Date.now() + MATERIALIZATION_POLL_MS;
        if (refreshed.desiredGeneration !== appliedGeneration) {
          // Reconcile and atomically swap the complete skill tree before claiming another prompt.
          // Core independently fences prompt claims on desired == applied, so a Run-skill attach
          // and its immediately-created session cannot enter the previous projection.
          await (recorder as ProjectRecorder | null)?.stop();
          recorder = null;
          await input.runtime.syncSkillBundles({
            ref,
            generation: refreshed.desiredGeneration,
            skills: refreshed.skills,
            signal,
          });
          const restartServer = Boolean(target);
          if (restartServer) {
            // Re-resolve the exact pinned environment at the boundary and restart the only server.
            clearProjectChatTarget(target);
            target = null;
            await startServerForPrompts();
          }
          plan = refreshed;
          const applied = await input.store.updateProjectWorkspaceState({
            job: input.job,
            workerId: input.workerId,
            appliedGeneration: refreshed.desiredGeneration,
          });
          if (!applied) throw new ProjectLostLease();
          appliedGeneration = refreshed.desiredGeneration;
          lastActivityAt = Date.now();
        }
      }

      const capacity = boundaryRecyclePending
        ? 0
        : Math.max(0, input.config.concurrency - activePrompts.size);
      if (capacity > 0) {
        const prompts = preclaimedPrompts.length > 0
          ? preclaimedPrompts.splice(0, capacity)
          : await input.store.claimProjectPromptJobs({
              job: input.job,
              workerId: input.workerId,
              limit: capacity,
              leaseSeconds: input.config.leaseSeconds,
              excludeSessionIds: [...activeSessionIds],
            });
        for (const prompt of prompts) {
          if (activeSessionIds.has(prompt.sessionId)) {
            await input.store.failProjectPrompt({
              job: input.job,
              prompt,
              workerId: input.workerId,
              errorCode: "project_session_busy",
              errorMessage: "Another prompt in this session is still running",
              retryAt: new Date(Date.now() + input.config.claimIntervalMs),
            });
            continue;
          }
          const admission = await input.store.revalidateProjectWorkspaceAuthority({
            job: input.job,
            workerId: input.workerId,
            authorityRevision,
            activationRevision,
          });
          if (admission === "lost_lease") throw new ProjectLostLease();
          if (admission === "immediate") throw new ProjectRecycleRequired();
          if (admission === "boundary") {
            boundaryRecyclePending = true;
            const requeued = await input.store.requeueProjectPromptAtBoundary({
              job: input.job,
              prompt,
              workerId: input.workerId,
            });
            if (!requeued) throw new ProjectLostLease();
            continue;
          }
          if (!(await checkProjectPromptProvider({
            store: input.store,
            job: input.job,
            prompt,
            workerId: input.workerId,
          }))) {
            continue;
          }
          activeSessionIds.add(prompt.sessionId);
          lastActivityAt = Date.now();
          await startServerForPrompts();
          const promptTarget = target;
          if (!promptTarget) throw new RunRuntimeError("Project OpenCode target is unavailable");
          const promptAbort = new AbortController();
          const promptSignal = AbortSignal.any([signal, promptAbort.signal]);
          const task = processProjectPrompt({
            prompt,
            job: input.job,
            workerId: input.workerId,
            store: input.store,
            runtime: input.runtime,
            chat: input.chat,
            target: promptTarget,
            ref,
            storage: input.storage,
            redactor,
            authorityRevision,
            promptByNativeSession,
            config: input.config,
            activationRevision,
            withFileCommit,
            onBoundary: () => {
              boundaryRecyclePending = true;
            },
            signal: promptSignal,
          }).catch((error: unknown) => {
            if (error instanceof Error) promptFailure = error;
            else promptFailure = new RunRuntimeError("Project prompt failed");
          }).finally(() => {
            activePrompts.delete(prompt.id);
            activeSessionIds.delete(prompt.sessionId);
            lastActivityAt = Date.now();
          });
          activePrompts.set(prompt.id, { prompt, abort: promptAbort, task });
        }
        if (prompts.length === 0 && activePrompts.size === 0) {
          const promptAdmission =
            await input.store.inspectProjectPromptProviderAdmission({
              job: input.job,
              workerId: input.workerId,
            });
          if (promptAdmission === "provider_unavailable") {
            const blocked = await input.store.updateProjectWorkspaceState({
              job: input.job,
              workerId: input.workerId,
              status: "ready",
              lastActivityAt: new Date(lastActivityAt),
              idleDeadlineAt: new Date(lastActivityAt + input.config.idleMs),
              errorCode: "project_provider_unavailable",
              errorMessage: "Reconnect this session's model provider to continue.",
            });
            if (!blocked) throw new ProjectLostLease();
            return;
          }
        }
        await syncInteractiveStatus();
      }

      if (boundaryRecyclePending && activePrompts.size === 0) {
        // Rotations and additions are admitted at the first quiescent boundary. Existing turns are
        // allowed to finish; no newly claimed prompt can cross into the stale environment.
        await input.store.updateProjectWorkspaceState({
          job: input.job,
          workerId: input.workerId,
          status: "stopping",
        });
        await (recorder as ProjectRecorder | null)?.stop();
        recorder = null;
        await persistOrRestoreFileProjection(signal);
        await input.runtime.scrubAgentState(ref, signal);
        const checkpoint = await input.runtime.checkpointAndStop(ref, signal);
        providerStopped = true;
        await input.usage.record({
          job: input.job,
          activationRevision,
          state: "stopped",
          expiresAt: null,
        });
        const updated = await input.store.updateProjectWorkspaceState({
          job: input.job,
          workerId: input.workerId,
          status: "stopped",
          checkpointId: checkpoint.snapshotId,
          checkpointCreatedAt: new Date(),
          checkpointGeneration: appliedGeneration,
          appliedGeneration,
          sandboxDomain: null,
          idleDeadlineAt: null,
          errorCode: null,
          errorMessage: null,
        });
        if (!updated) throw new ProjectLostLease();
        await input.usage.settle({ job: input.job, activationRevision });
        return;
      }

      if (
        activePrompts.size === 0
        && Date.now() - lastActivityAt >= input.config.idleMs
      ) {
        await input.store.updateProjectWorkspaceState({
          job: input.job,
          workerId: input.workerId,
          status: "stopping",
        });
        await (recorder as ProjectRecorder | null)?.stop();
        recorder = null;
        await persistOrRestoreFileProjection(signal);
        await input.runtime.scrubAgentState(ref, signal);
        const checkpoint = await input.runtime.checkpointAndStop(ref, signal);
        providerStopped = true;
        await input.usage.record({
          job: input.job,
          activationRevision,
          state: "stopped",
          expiresAt: null,
        });
        await input.store.updateProjectWorkspaceState({
          job: input.job,
          workerId: input.workerId,
          status: "stopped",
          checkpointId: checkpoint.snapshotId,
          checkpointCreatedAt: new Date(),
          checkpointGeneration: appliedGeneration,
          appliedGeneration,
          sandboxDomain: null,
          idleDeadlineAt: null,
        });
        await input.usage.settle({ job: input.job, activationRevision });
        return;
      }
      if (activePrompts.size === 0 && !boundaryRecyclePending) {
        const control = await input.store.readProjectWorkspaceControl({
          job: input.job,
          workerId: input.workerId,
        });
        if (control.deleteRequestedAt) throw new ProjectDeletionRequested();
        if (control.skillSyncErrorAt) {
          await stopAndSurfaceSkillFailure(signal);
          return;
        }
        // Keep the private VM warm until its durable idle deadline, but release both the workspace
        // lease and this supervisor slot. Claim SQL wakes it only for a prompt, sync/recycle/delete
        // intent, or the deadline that performs the checkpoint.
        await (recorder as ProjectRecorder | null)?.stop();
        recorder = null;
        await input.store.updateProjectWorkspaceState({
          job: input.job,
          workerId: input.workerId,
          status: "ready",
          lastActivityAt: new Date(lastActivityAt),
          idleDeadlineAt: new Date(lastActivityAt + input.config.idleMs),
        });
        return;
      }
      await wait(input.config.claimIntervalMs, signal);
    }
    throw abortReason(signal);
  } catch (error) {
    const reason = signal.aborted ? abortReason(signal) : error;
    const deletion = reason instanceof ProjectDeletionRequested;
    if (deletion) {
      activationAbort.abort(reason);
      if (target) {
        await Promise.allSettled([...promptByNativeSession.keys()].map((sessionId) =>
          input.chat.abortSession(target!, sessionId)));
      }
      await (recorder as ProjectRecorder | null)?.stop();
      recorder = null;
      await Promise.allSettled([...activePrompts.values()].map(({ task }) => task));
      const storageKeys = await input.store.listProjectStorageKeys({
        job: input.job,
        workerId: input.workerId,
      });
      await input.runtime.destroy(ref, input.signal);
      providerStopped = true;
      for (const key of storageKeys) await input.storage.delete(key, input.signal);
      await input.usage.settle({ job: input.job, activationRevision });
      await input.store.completeProjectDeletion({
        job: input.job,
        workerId: input.workerId,
      });
      return;
    }
    if (
      !(reason instanceof ProjectLostLease)
      && !providerRunning
      && !providerActivationAttempted
      && activationAdmissionCreatedHere
      && activationAdmissionToken
    ) {
      const cancelled = await input.store.cancelProjectActivation({
        job: input.job,
        workerId: input.workerId,
        activationRevision:
          reservedActivationRevision
          ?? input.job.activationAdmissionRevision
          ?? input.job.activationRevision + 1,
        admissionToken: activationAdmissionToken,
        resetFreshRecycle: reason instanceof ProjectAuthorityRevokedError,
      }).catch(() => "not_found" as const);
      if (cancelled !== "not_found") {
        activationAdmissionToken = null;
        activationAdmissionCreatedHere = false;
      }
      if (cancelled === "fresh_requeued") {
        if (usageReserved && reservedActivationRevision !== null) {
          await input.usage.settle({
            job: input.job,
            activationRevision: reservedActivationRevision,
          }).catch(() => undefined);
        }
        return;
      }
    }
    const recycle = reason instanceof ProjectRecycleRequired;
    const shutdown = reason instanceof ProjectWorkerShutdown;
    if ((recycle || shutdown) && providerRunning && !providerStopped) {
      // Stop every active turn before the checkpoint boundary so no revoked literal survives in a
      // running process. Snapshotting stops the VM; the next activation injects a newly admitted
      // environment.
      const promptsToRequeue = [...activePrompts.values()].map(({ prompt }) => prompt);
      activationAbort.abort(reason);
      if (target) {
        await Promise.allSettled([...promptByNativeSession.keys()].map((sessionId) =>
          input.chat.abortSession(target!, sessionId)));
      }
      await (recorder as ProjectRecorder | null)?.stop();
      recorder = null;
      await input.store.requeueProjectPrompts({
        job: input.job,
        workerId: input.workerId,
        prompts: promptsToRequeue,
        reason: recycle ? "project_credentials_recycled" : "project_worker_shutdown",
      });
      await Promise.allSettled([...activePrompts.values()].map(({ task }) => task));
      await persistOrRestoreFileProjection(input.signal);
      await input.runtime.scrubAgentState(ref, input.signal);
      const checkpoint = await input.runtime.checkpointAndStop(ref, input.signal);
      providerStopped = true;
      await input.usage.record({
        job: input.job,
        activationRevision,
        state: "stopped",
        expiresAt: null,
      });
      const persisted = recycle
        ? await input.store.completeProjectWorkspaceRecycle({
            job: input.job,
            workerId: input.workerId,
            checkpointId: checkpoint.snapshotId,
            checkpointCreatedAt: new Date(),
            checkpointGeneration: appliedGeneration,
            appliedGeneration,
          })
        : await input.store.updateProjectWorkspaceState({
            job: input.job,
            workerId: input.workerId,
            status: "stopped",
            checkpointId: checkpoint.snapshotId,
            checkpointCreatedAt: new Date(),
            checkpointGeneration: appliedGeneration,
            appliedGeneration,
            sandboxDomain: null,
            errorCode: null,
            errorMessage: null,
          });
      if (!persisted) throw new ProjectLostLease();
      await input.usage.settle({ job: input.job, activationRevision });
      return;
    }
    if (shutdown && !providerRunning) {
      if (usageReserved && !providerActivationAttempted) {
        await input.usage.settle({ job: input.job, activationRevision }).catch(() => undefined);
      }
      return;
    }
    if (!(reason instanceof ProjectLostLease) && providerRunning && !providerStopped) {
      // Any ambiguous worker/runtime failure must not leave a VM containing decrypted credentials
      // running after the lease is released. Mirroring is best-effort in this emergency path, but
      // the checkpoint remains the process-memory erasure boundary.
      activationAbort.abort(reason);
      const safetySignal = AbortSignal.timeout(60_000);
      if (target) {
        await Promise.allSettled([...promptByNativeSession.keys()].map((sessionId) =>
          input.chat.abortSession(target!, sessionId, safetySignal)));
      }
      await (recorder as ProjectRecorder | null)?.stop();
      recorder = null;
      await Promise.allSettled([...activePrompts.values()].map(({ task }) => task));
      await persistOrRestoreFileProjection(safetySignal).catch(() => undefined);
      try {
        await input.runtime.scrubAgentState(ref, safetySignal);
        const checkpoint = await input.runtime.checkpointAndStop(ref, safetySignal);
        providerStopped = true;
        await input.usage.record({
          job: input.job,
          activationRevision,
          state: "stopped",
          expiresAt: null,
        });
        await input.store.updateProjectWorkspaceState({
          job: input.job,
          workerId: input.workerId,
          checkpointId: checkpoint.snapshotId,
          checkpointCreatedAt: new Date(),
          checkpointGeneration: appliedGeneration,
          appliedGeneration,
          sandboxDomain: null,
        });
        await input.usage.settle({ job: input.job, activationRevision });
      } catch {
        // Provider truth is ambiguous. Leave usage unsettled and let the retryable lifecycle state
        // re-observe provider truth on the next fenced attempt.
      }
    }
    if (
      usageReserved
      && reservedActivationRevision !== null
      && !providerActivationAttempted
    ) {
      await input.usage.settle({
        job: input.job,
        activationRevision: reservedActivationRevision,
      }).catch(() => undefined);
    }
    const unrecoverable = reason instanceof ProjectWorkspaceUnrecoverable;
    const invalidEnvironment = reason instanceof ProjectEnvironmentInvalidError;
    await input.store.updateProjectWorkspaceState({
      job: input.job,
      workerId: input.workerId,
      status: reason instanceof ProjectLostLease
        ? undefined
        : unrecoverable
          ? "needs_attention"
          : "error",
      errorCode: reason instanceof ProjectLostLease
        ? "project_lease_lost"
        : unrecoverable
          ? "project_workspace_unrecoverable"
          : invalidEnvironment
            ? "project_environment_invalid"
            : "project_runtime_failed",
      errorMessage: errorMessage(reason),
    }).catch(() => false);
    throw reason;
  } finally {
    heartbeatAbort.abort();
    await heartbeat.catch(() => undefined);
    await (recorder as ProjectRecorder | null)?.stop();
    await Promise.allSettled([...activePrompts.values()].map(({ task }) => task));
    clearProjectChatTarget(target);
    authorityRevision = "";
    redactor.clear();
    await input.store.releaseProjectWorkspaceLease({
      job: input.job,
      workerId: input.workerId,
      delayMs: providerStopped ? 0 : input.config.claimIntervalMs,
    }).catch(() => false);
  }
}

export function projectArchiveMatchesChecksum(
  archive: Buffer,
  expectedChecksum: string,
): boolean {
  return skillChecksum(toTar(archive)) === expectedChecksum;
}

/** Compose the lease-fenced Core services into the provider-neutral supervisor seam. */
export function createCoreProjectWorkspaceStore(input: {
  masterKey: Buffer;
  idleMs: number;
}): ProjectWorkspaceStore {
  return {
    claimProjectWorkspaceJobs: (args) => claimProjectWorkspaceJobs({ ...args, database: db }),
    heartbeatProjectWorkspaceLease: (args) =>
      heartbeatProjectWorkspaceLease({ ...args, database: db }),
    readProjectWorkspaceControl: (args) =>
      readProjectWorkspaceControl({ ...args, database: db }),
    releaseProjectWorkspaceLease: (args) =>
      releaseProjectWorkspaceLease({ ...args, database: db }),
    async loadProjectMaterializationPlan(args) {
      const plan = await loadProjectMaterializationPlan({ ...args, database: db });
      const archiveByPath = new Map<string, Buffer>();
      const bundleBySlug = new Map<string, SkillBundle>();
      for (const skill of [...plan.skills].sort((a, b) => a.mountOrder - b.mountOrder)) {
        const existing = bundleBySlug.get(skill.slug);
        if (existing) {
          if (existing.version !== skill.version) {
            throw new RunRuntimeError(
              `Project dependency closure contains incompatible versions of ${skill.slug}`,
            );
          }
          continue;
        }
        let archive = archiveByPath.get(skill.storagePath);
        if (!archive) {
          archive = await getSkillArchive({ key: skill.storagePath });
          archiveByPath.set(skill.storagePath, archive);
        }
        if (!projectArchiveMatchesChecksum(archive, skill.checksum)) {
          throw new RunRuntimeError(`Project skill archive checksum failed for ${skill.slug}`);
        }
        const bundle = await buildSkillBundle(
          skill.slug,
          skill.version,
          skill.storagePath,
          async () => archive!,
        );
        bundleBySlug.set(skill.slug, bundle);
      }
      return {
        desiredGeneration: plan.desiredGeneration,
        appliedGeneration: plan.appliedGeneration,
        checkpointGeneration: plan.checkpointGeneration,
        skills: [...bundleBySlug.values()],
        bootstrapFiles: plan.bootstrapFiles,
      };
    },
    async prepareProjectActivation(args) {
      const admitted = await prepareProjectActivationInputs({
        ...args,
        database: db,
      });
      const passwordBytes = randomBytes(32);
      const password = passwordBytes.toString("base64url");
      passwordBytes.fill(0);
      const persisted = await setProjectOpencodePassword({
        job: args.job,
        workerId: args.workerId,
        password,
        masterKey: input.masterKey,
        database: db,
      });
      if (!persisted) throw new ProjectLostLease();
      return { authorityRevision: admitted.authorityRevision };
    },
    async validateProjectActivation(args) {
      await validateProjectActivationEnvironment({
        ...args,
        database: db,
      });
    },
    beginProjectActivation: (args) =>
      beginProjectActivationAdmission({
        ...args,
        database: db,
      }),
    cancelProjectActivation: (args) =>
      cancelProjectActivationAdmission({
        ...args,
        database: db,
      }),
    async resolveProjectActivationEnvironment(args) {
      const env = await resolveProjectActivationEnvironment({
        ...args,
        masterKey: input.masterKey,
        database: db,
      });
      const serverPassword = await getProjectOpencodePassword({
        job: args.job,
        workerId: args.workerId,
        masterKey: input.masterKey,
        database: db,
      });
      if (!serverPassword) {
        throw new RunRuntimeError("Project OpenCode credential is unavailable");
      }
      const injectedLiterals = [...new Set([...Object.values(env), serverPassword])]
        .filter(Boolean);
      env.OPENCODE_SERVER_USERNAME = OPENCODE_SERVER_USERNAME;
      env.OPENCODE_SERVER_PASSWORD = serverPassword;
      return {
        env,
        serverPassword,
        injectedLiterals,
        authorityRevision: args.authorityRevision,
      };
    },
    async revalidateProjectWorkspaceAuthority(args) {
      try {
        const state = await revalidateProjectWorkspaceAuthority({
          ...args,
          database: db,
        });
        return state.mode;
      } catch (error) {
        if (error instanceof LostProjectWorkspaceLeaseError) return "lost_lease";
        throw error;
      }
    },
    inspectProjectPromptProviderAdmission: (args) =>
      inspectProjectPromptProviderAdmission({ ...args, database: db }),
    revalidateProjectPromptProviderAdmission: (args) =>
      revalidateProjectPromptProviderAdmission({ ...args, database: db }),
    markProjectActivationInjected: (args) =>
      markProjectActivationInjected({ ...args, database: db }),
    markProjectActivationExposureAttempted: (args) =>
      markProjectActivationExposureAttempted({ ...args, database: db }),
    updateProjectWorkspaceState: (args) =>
      updateProjectWorkspaceState({
        ...args,
        status: args.status as ProjectWorkspaceStatus | undefined,
        database: db,
      }),
    completeProjectDeletion: (args) => completeProjectDeletion({ ...args, database: db }),
    completeProjectWorkspaceRecycle: (args) =>
      completeProjectWorkspaceRecycle({ ...args, database: db }),
    surfaceProjectSkillSyncFailure: (args) =>
      surfaceProjectSkillSyncFailure({ ...args, database: db }),
    claimProjectPromptJobs: (args) => claimProjectPromptJobs({ ...args, database: db }),
    claimProjectSessionStops: (args) => claimProjectSessionStops({ ...args, database: db }),
    completeProjectSessionStop: ({ session, ...args }) =>
      completeProjectSessionStop({
        ...args,
        stop: session,
        database: db,
      }),
    heartbeatProjectPromptLease: (args) =>
      heartbeatProjectPromptLease({ ...args, database: db }),
    loadProjectPromptAttachments: ({ prompt, ...args }) =>
      loadProjectPromptAttachments({
        ...args,
        promptId: prompt.id,
        database: db,
      }),
    loadProjectSessionTranscript: (args) =>
      loadProjectSessionTranscript({ ...args, database: db }),
    rebindProjectSession: (args) =>
      rebindProjectSession({ ...args, database: db }),
    completeProjectPrompt: (args) =>
      completeProjectPrompt({
        ...args,
        idleMs: input.idleMs,
        database: db,
      }),
    async markProjectPromptDispatch(args) {
      return Boolean(await markProjectPromptDispatch({ ...args, database: db }));
    },
    async markProjectPromptSendAttempted(args) {
      return markProjectPromptSendAttempted({ ...args, database: db });
    },
    failProjectPrompt: (args) => failProjectPrompt({ ...args, database: db }),
    requeueProjectPromptAtBoundary: (args) =>
      requeueProjectPromptAtBoundary({ ...args, database: db }),
    async requeueProjectPrompts(args) {
      await interruptProjectPromptsForRecycle({
        job: args.job,
        workerId: args.workerId,
        database: db,
      });
    },
    appendProjectSessionEvent: (args) =>
      appendProjectSessionEvent({
        ...args,
        event: args.event as ProjectSessionEvent,
        database: db,
      }),
    async persistProjectFiles(args) {
      for (const file of args.files) {
        await recordProjectFileVersion({
          job: args.job,
          workerId: args.workerId,
          path: file.path,
          contentType: file.contentType,
          byteSize: file.byteSize,
          checksum: file.checksum,
          storageKey: file.storageKey,
          modifiedBySessionId: file.modifiedBySessionId,
          baseVersion: file.baseVersion,
          database: db,
        });
      }
    },
    async persistProjectFileDeletions(args) {
      for (const file of args.files) {
        await recordProjectFileDeletion({
          job: args.job,
          workerId: args.workerId,
          path: file.path,
          baseVersion: file.baseVersion,
          modifiedBySessionId: file.modifiedBySessionId,
          database: db,
        });
      }
    },
    loadProjectFileBaseline: (args) =>
      captureProjectFileBaseline({ ...args, database: db }),
    reserveProjectFileStorageObject: (args) =>
      reserveProjectFileStorageObject({ ...args, database: db }),
    listProjectStorageKeys: (args) => listProjectStorageKeys({ ...args, database: db }),
  };
}

export function createCoreProjectUsageMeter(
  config: ProjectWorkerConfig,
  workerId: string,
): ProjectUsageMeter {
  const billingConfig = {
    ...billingRuntimeConfig(),
    sandboxMaxSessionMs: config.maxActivationMs,
  };
  const tenant = <T>(
    job: ProjectWorkspaceJob,
    operation: (database: Db) => Promise<T>,
  ) => db.transaction(async (transaction) => {
    const database = transaction as unknown as Db;
    const result = await database.execute(drizzleSql`
      select companion_enter_project_worker_lease(
        ${job.orgId}::uuid,
        ${job.projectId}::uuid,
        ${job.creatorId},
        ${workerId},
        ${job.leaseGeneration}
      ) as entered
    `);
    const row = Array.from(result as unknown as Iterable<{ entered: boolean }>)[0];
    if (row?.entered !== true) throw new ProjectLostLease();
    return operation(database);
  }) as Promise<T>;
  return {
    reserve: ({ job, activationRevision }) =>
      tenant(job, async (database) => {
        await reserveSandboxUsage({
          orgId: job.orgId,
          creatorId: job.creatorId,
          kind: "project",
          sourceId: job.projectId,
          sandboxName: job.sandboxName,
          activationRevision,
          reservationMs: SANDBOX_RUN_ACTIVATION_RESERVATION_MS,
          database,
          config: billingConfig,
        });
        return refreshSandboxUsageReservation({
          orgId: job.orgId,
          sandboxName: job.sandboxName,
          activationRevision,
          database,
          config: billingConfig,
        });
      }),
    start: ({ job, activationRevision, runtimeDeadlineAt }) =>
      tenant(job, async (database) => {
        await startSandboxUsage({
          orgId: job.orgId,
          sandboxName: job.sandboxName,
          activationRevision,
          runtimePolicy: "budgeted",
          runtimeDeadlineAt,
          database,
          config: billingConfig,
        });
      }),
    refresh: ({ job, activationRevision }) =>
      tenant(job, (database) => refreshSandboxUsageReservation({
        orgId: job.orgId,
        sandboxName: job.sandboxName,
        activationRevision,
        database,
        config: billingConfig,
      })),
    record: ({ job, activationRevision, state, expiresAt }) =>
      tenant(job, (database) => recordSandboxRuntimeObservation({
        orgId: job.orgId,
        sandboxName: job.sandboxName,
        activationRevision,
        state,
        expiresAt,
        database,
      })),
    settle: ({ job, activationRevision }) =>
      tenant(job, (database) => settleSandboxUsage({
        orgId: job.orgId,
        sandboxName: job.sandboxName,
        activationRevision,
        database,
        config: billingConfig,
      })),
  };
}

export function createProjectSupervisor(input: {
  store: ProjectWorkspaceStore;
  runtime: ProjectWorkspaceRuntime;
  chat: ProjectChatRuntime;
  usage: ProjectUsageMeter;
  storage?: ProjectFileStorage;
  goldenSnapshotId: string;
  config: ProjectWorkerConfig;
  workerId?: string;
}): Supervisor {
  const workerId = input.workerId ?? randomUUID();
  const abort = new AbortController();
  const active = new Set<Promise<void>>();

  const loop = (async () => {
    while (!abort.signal.aborted) {
      const capacity = Math.max(0, input.config.concurrency - active.size);
      if (capacity > 0) {
        const jobs = await input.store.claimProjectWorkspaceJobs({
          workerId,
          limit: capacity,
          leaseSeconds: input.config.leaseSeconds,
        }).catch(() => []);
        for (const job of jobs) {
          const task = runProjectWorkspaceJob({
            job,
            workerId,
            store: input.store,
            runtime: input.runtime,
            chat: input.chat,
            usage: input.usage,
            storage: input.storage ?? createProjectFileStorage(),
            goldenSnapshotId: input.goldenSnapshotId,
            config: input.config,
            signal: abort.signal,
          }).catch(() => undefined).finally(() => active.delete(task));
          active.add(task);
        }
      }
      await wait(input.config.claimIntervalMs, abort.signal).catch(() => undefined);
    }
  })();

  return {
    async stop() {
      abort.abort(new ProjectWorkerShutdown());
      await loop.catch(() => undefined);
      await Promise.allSettled([...active]);
    },
  };
}

export function createProjectAttachmentRetentionScheduler(input: {
  intervalMs?: number;
  sweep?: typeof sweepProjectAttachmentOrphans;
} = {}): {
  run(): Promise<void>;
  stop(): Promise<void>;
} {
  const intervalMs = input.intervalMs ?? 15 * 60_000;
  const sweep = input.sweep ?? sweepProjectAttachmentOrphans;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const run = async () => {
    if (stopped || inFlight) return inFlight ?? Promise.resolve();
    const operation = sweep().then(() => undefined).catch(() => undefined);
    inFlight = operation;
    await operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
  };
  const timer = setInterval(() => void run(), intervalMs);
  void run();
  return {
    run,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

export async function startProjectSupervisor(): Promise<Supervisor | null> {
  const config = projectWorkerConfig();
  if (!config.enabled) {
    console.info("Project supervisor disabled by COMPANION_PROJECTS_ENABLED");
    return null;
  }
  const vercel = vercelConfigFromEnv();
  const goldenSnapshotId = process.env.COMPANION_GOLDEN_SNAPSHOT_ID?.trim() || null;
  if (!vercel || !goldenSnapshotId) {
    console.info("Project supervisor disabled: Vercel Sandbox or golden snapshot is unavailable");
    return null;
  }
  let masterKey: Buffer;
  try {
    masterKey = loadSecretsMasterKey();
  } catch {
    console.info("Project supervisor disabled: secrets master key is unavailable");
    return null;
  }
  const workerId = `${process.env.HOSTNAME?.trim() || "worker"}:${process.pid}:project:${randomUUID()}`;
  const readinessIntervalMs = Math.min(config.heartbeatMs, 5_000);
  const readinessTtlSeconds = Math.max(
    5,
    Math.min(300, Math.ceil((readinessIntervalMs * 3) / 1_000)),
  );
  try {
    await heartbeatProjectWorker({
      workerId,
      ttlSeconds: readinessTtlSeconds,
      database: db,
    });
  } catch (error) {
    masterKey.fill(0);
    throw error;
  }
  let readinessInFlight: Promise<void> | null = null;
  const advertiseReadiness = () => {
    if (readinessInFlight) return;
    const operation = heartbeatProjectWorker({
      workerId,
      ttlSeconds: readinessTtlSeconds,
      database: db,
    });
    readinessInFlight = operation;
    void operation
      .catch(() => undefined)
      .finally(() => {
        if (readinessInFlight === operation) readinessInFlight = null;
      });
  };
  const readinessTimer = setInterval(advertiseReadiness, readinessIntervalMs);
  const supervisor = createProjectSupervisor({
    store: createCoreProjectWorkspaceStore({ masterKey, idleMs: config.idleMs }),
    runtime: createVercelProjectWorkspaceRuntime(vercel),
    chat: createOpencodeProjectChatRuntime(),
    usage: createCoreProjectUsageMeter(config, workerId),
    goldenSnapshotId,
    config,
    workerId,
  });
  const retention = createProjectAttachmentRetentionScheduler();
  console.info("Project supervisor started", { concurrency: config.concurrency });
  return {
    async stop() {
      clearInterval(readinessTimer);
      await retention.stop();
      await supervisor.stop();
      await readinessInFlight?.catch(() => undefined);
      await removeProjectWorkerHeartbeat({ workerId, database: db }).catch(() => undefined);
      masterKey.fill(0);
    },
  };
}
