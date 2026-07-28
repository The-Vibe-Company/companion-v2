import type {
  RunChatEvent,
  RunChatHistoryItem,
  RunQuestionProtocol,
} from "@companion/contracts";
import type {
  RunChatMessageState,
  RunChatSessionState,
  ServeEnv,
  SkillBundle,
} from "./runRuntime";

/**
 * Runtime seam for Cowork Projects.
 *
 * This deliberately does not extend RunSandboxRuntime: a Skill Run owns a disposable
 * run-scoped sandbox, while a Project owns one named, persistent filesystem with many OpenCode
 * sessions. Keeping the ports separate prevents either lifecycle from accidentally inheriting the
 * other's retention, billing or cleanup rules.
 */

export const PROJECT_WORKDIR = "/vercel/sandbox";
export const PROJECT_FILES_DIR = "files";
export const PROJECT_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

export interface ProjectWorkspaceRef {
  /** Deterministic creator-private name, e.g. `project-<org8>-<project8>`. */
  sandboxName: string;
  /** Vercel identifies persistent sandboxes by name; retained for provider-neutral persistence. */
  sandboxId: string | null;
  region: string;
  /** Hard provider session budget. Idle suspension is controlled separately by the worker. */
  timeoutMs: number;
}

export type ProjectWorkspaceState = "running" | "stopped" | "missing";

export interface ProjectWorkspaceObservation {
  state: ProjectWorkspaceState;
  /** Provider VM-session start, used to preserve one activation budget across lease-free wakes. */
  startedAt: Date | null;
  expiresAt: Date | null;
  currentSnapshotId: string | null;
}

export interface ProjectManagedFile {
  /** Normalized path relative to the user-visible `files/` directory. */
  path: string;
  data: Buffer;
  executable?: boolean;
}

export interface ProjectFileEntry {
  /** Normalized path relative to the user-visible `files/` directory. */
  path: string;
  byteSize: number;
  modifiedAt: Date;
}

export interface ProjectWorkspaceRuntime {
  readonly provider: "vercel";

  /**
   * Adopt/resume the deterministic sandbox or create it from sourceSnapshotId when it is missing.
   * The caller must pass the last Project checkpoint when one exists; implementations MUST NOT
   * silently fall back to the golden snapshot if that checkpoint cannot be restored.
   */
  activate(input: {
    ref: ProjectWorkspaceRef;
    sourceSnapshotId: string;
    signal?: AbortSignal;
  }): Promise<{
    sandboxId: string;
    domain: string;
    resumed: boolean;
    /** True only when the named sandbox was missing and sourceSnapshotId rebuilt it. */
    restoredFromSnapshot: boolean;
  }>;

  /**
   * Replace the complete projected skill tree between turns. A failed projection leaves the
   * previously applied generation available.
   */
  syncSkillBundles(input: {
    ref: ProjectWorkspaceRef;
    generation: number;
    skills: SkillBundle[];
    signal?: AbortSignal;
  }): Promise<void>;

  /**
   * Replace the complete user-visible `files/` projection from durable storage. This runs after
   * every activation so restoring an older checkpoint cannot resurrect a tombstoned path.
   */
  syncFiles(input: {
    ref: ProjectWorkspaceRef;
    files: ProjectManagedFile[];
    signal?: AbortSignal;
  }): Promise<void>;

  /** Add or replace user-visible Project files under `files/`. */
  pushFiles(input: {
    ref: ProjectWorkspaceRef;
    files: ProjectManagedFile[];
    signal?: AbortSignal;
  }): Promise<void>;

  /** Bounded inventory used to mirror user-visible files into durable object storage. */
  listFiles(input: {
    ref: ProjectWorkspaceRef;
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    signal?: AbortSignal;
  }): Promise<Array<ProjectFileEntry & { data: Buffer }>>;

  /** Launch one detached OpenCode server that hosts every native session in this Project. */
  startServer(input: {
    ref: ProjectWorkspaceRef;
    env: ServeEnv;
    signal?: AbortSignal;
  }): Promise<void>;

  healthCheck(input: {
    ref: ProjectWorkspaceRef;
    domain: string;
    password: string;
    signal?: AbortSignal;
  }): Promise<{ ok: true; ms: number }>;

  /**
   * Remove native OpenCode sessions, tool payloads and logs after Companion has persisted its
   * redacted transcript. Must run before any Project checkpoint is created.
   */
  scrubAgentState(ref: ProjectWorkspaceRef, signal?: AbortSignal): Promise<void>;

  /**
   * Create a non-expiring checkpoint and stop the current VM. Persistent-provider retention keeps
   * the three newest Project checkpoints.
   */
  checkpointAndStop(ref: ProjectWorkspaceRef, signal?: AbortSignal): Promise<{ snapshotId: string }>;

  destroy(ref: ProjectWorkspaceRef, signal?: AbortSignal): Promise<void>;
  observe(ref: ProjectWorkspaceRef, signal?: AbortSignal): Promise<ProjectWorkspaceObservation>;
  /**
   * Extend only the current provider session. The worker must reserve the corresponding usage
   * budget first and enforce its absolute activation ceiling.
   */
  extendTimeout(
    ref: ProjectWorkspaceRef,
    additionalMs: number,
    signal?: AbortSignal,
  ): Promise<ProjectWorkspaceObservation>;
}

export interface ProjectChatTarget {
  domain: string;
  password: string;
}

export interface ProjectChatEventEnvelope {
  sessionId: string;
  event: RunChatEvent;
}

export type ProjectPendingQuestion = Extract<RunChatEvent, { type: "question.asked" }>;

export interface ProjectFileChange {
  /** Path relative to the managed Project cwd (`files/`). */
  path: string;
  status: "added" | "modified" | "deleted";
  /** Message-specific unified patch produced by OpenCode. */
  patch: string;
}

/**
 * OpenCode seam for a shared Project server. Unlike RunChatRuntime, streamEvents subscribes once
 * to the whole server and returns session-tagged events for worker-side demultiplexing.
 */
export interface ProjectChatRuntime {
  findSessionByTitle(
    target: ProjectChatTarget,
    title: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; title: string } | null>;
  createSession(
    target: ProjectChatTarget,
    title: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; title: string }>;
  abortSession(
    target: ProjectChatTarget,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  getSessionState(
    target: ProjectChatTarget,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<RunChatSessionState>;
  getMessageState(
    target: ProjectChatTarget,
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<RunChatMessageState>;
  /**
   * Seed a deterministically recreated native session with the last durable, redacted Companion
   * transcript without asking the model to reply.
   */
  rehydrateSession(
    target: ProjectChatTarget,
    sessionId: string,
    transcript: RunChatHistoryItem[],
    signal?: AbortSignal,
  ): Promise<void>;
  sendPrompt(
    target: ProjectChatTarget,
    sessionId: string,
    text: string,
    messageId: string,
    modelRef: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Read every native question still pending for this exact session. This is the crash-recovery
   * source of truth when an SSE event was emitted before Companion durably recorded it.
   */
  listPendingQuestions(
    target: ProjectChatTarget,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ProjectPendingQuestion[]>;
  /** Deliver a member answer to the exact native question request that paused this turn. */
  replyQuestion(
    target: ProjectChatTarget,
    sessionId: string,
    requestId: string,
    protocol: RunQuestionProtocol,
    answers: string[][],
    signal?: AbortSignal,
  ): Promise<void>;
  /** Reject one native question request without treating it as a tool permission. */
  rejectQuestion(
    target: ProjectChatTarget,
    sessionId: string,
    requestId: string,
    protocol: RunQuestionProtocol,
    signal?: AbortSignal,
  ): Promise<void>;
  loadItems(
    target: ProjectChatTarget,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<RunChatHistoryItem[]>;
  /** Paths changed by one deterministic user message, used for per-session file versioning. */
  getFileChanges(
    target: ProjectChatTarget,
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<ProjectFileChange[]>;
  streamEvents(
    target: ProjectChatTarget,
    signal: AbortSignal,
    onConnected?: () => void,
    cursorKey?: object,
  ): AsyncIterable<ProjectChatEventEnvelope>;
}

export function modelPartsForProject(modelRef: string): {
  providerID: string;
  modelID: string;
} {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) {
    throw new Error("Project model must use provider/model format");
  }
  return {
    providerID: modelRef.slice(0, slash),
    modelID: modelRef.slice(slash + 1),
  };
}
