/**
 * The skill-run runtime port — the seam between the durable PostgreSQL worker and the sandbox
 * provider actually running OpenCode. Types only:
 * `@vercel/sandbox` / `@opencode-ai/sdk` live in `@companion/sandbox`, which apps/worker composes and
 * injects into core services the same way `database` is injected. Core stays framework- and
 * SDK-free so the fakeDb test suites can drive the launch pipeline with scripted stubs.
 *
 * Contract notes the implementations must honor:
 * - Every run gets a deterministic sandbox name. A retry first looks that sandbox up through the
 *   provider's idempotent get-or-create operation, so a worker crash cannot double-provision it.
 * - `destroy`/`stop` swallow "not found" (idempotent teardown).
 * - Env values (server password, provider keys) are injected at serve launch and never written to
 *   the sandbox filesystem.
 */

/** Basic-auth username every run's OpenCode server is configured with. */
export const OPENCODE_SERVER_USERNAME = "companion";

export interface SandboxRef {
  /** Deterministic per-run name, e.g. `run-<org8>-<run8>` (unique per project). */
  sandboxName: string;
  /** Provider id once known; null before the fork step completes. */
  sandboxId: string | null;
  region: string;
  timeoutMs: number;
}

export interface SkillBundleFile {
  /** Path relative to the skill root (e.g. `SKILL.md`, `scripts/run.py`). */
  path: string;
  data: Buffer;
  executable: boolean;
}

export interface SkillBundle {
  slug: string;
  version: string;
  files: SkillBundleFile[];
}

/**
 * Env injected at serve launch. Carries the per-run OPENCODE_SERVER_PASSWORD and the chosen model
 * provider's API key(s) — decrypted immediately before the call and never persisted.
 */
export type ServeEnv = Record<string, string>;

export interface RunWorkspaceFiles {
  /** `opencode.json` — model + permissions config. */
  opencodeJson: string;
  /** Root skill first, followed by its complete pinned dependency closure. */
  skills: SkillBundle[];
  /** User-attached files, written under `attachments/`. */
  attachments: Array<{ path: string; data: Buffer }>;
}

export interface RunSandboxRuntime {
  readonly provider: "vercel";
  /** Step 1 — fork/boot the named sandbox from the golden snapshot; returns id + public domain. */
  forkFromGolden(input: {
    ref: SandboxRef;
    goldenSnapshotId: string;
    signal?: AbortSignal;
  }): Promise<{ sandboxId: string; domain: string }>;
  /** Step 2 — write opencode.json, the skill folder and the attachments into the sandbox FS. */
  pushWorkspace(input: { ref: SandboxRef; files: RunWorkspaceFiles; signal?: AbortSignal }): Promise<void>;
  /** Step 3 — launch `opencode serve` detached with the injected env. */
  startServer(input: {
    ref: SandboxRef;
    env: ServeEnv;
    /** Abort before/during credential injection when run authority changes. */
    signal?: AbortSignal;
  }): Promise<void>;
  /** Step 4 — poll the server through the public domain (basic auth) until healthy. */
  healthCheck(input: {
    ref: SandboxRef;
    domain: string;
    password: string;
    /** Abort promptly when cancellation, membership, or secret ACL changes while probing. */
    signal?: AbortSignal;
  }): Promise<{ ok: true; ms: number }>;
  /** Stop now (freeze). Idempotent. */
  stop(ref: SandboxRef, signal?: AbortSignal): Promise<void>;
  /**
   * Delete the sandbox entirely. Idempotent (a missing/already-deleted sandbox is success), but
   * MUST throw on transient provider failures so callers keep the cleanup owed and retry later.
   */
  destroy(ref: SandboxRef, signal?: AbortSignal): Promise<void>;
  /**
   * Push the sandbox's hard timeout out by `ms` (Vercel's clock runs from boot, NOT from traffic —
   * without this an active conversation dies mid-stream). Optional: best-effort feature.
   */
  extendTimeout?(ref: SandboxRef, ms: number, signal?: AbortSignal): Promise<void>;
}

/** Basic-auth target for the OpenCode instance running inside a sandbox. */
export interface RunChatTarget {
  domain: string;
  password: string;
}

export type RunChatSessionState = "idle" | "busy" | "retry" | "missing";
export type RunChatMessageState = "missing" | "pending" | "completed" | "error";

/**
 * OpenCode port consumed by the durable worker. Implementations own all SDK-specific types and
 * normalize them into the stable contracts package. `messageId` is persisted before dispatch and
 * must be forwarded as OpenCode's `messageID`, making prompt retries idempotent.
 */
export interface RunChatRuntime {
  /** Find a session created by an earlier worker attempt using its deterministic title. */
  findSessionByTitle(target: RunChatTarget, title: string, signal?: AbortSignal): Promise<{ id: string; title: string } | null>;
  createSession(target: RunChatTarget, title: string, signal?: AbortSignal): Promise<{ id: string; title: string }>;
  /** Reconcile one persisted session after worker crash or recorder reconnect. */
  getSessionState(target: RunChatTarget, sessionId: string, signal?: AbortSignal): Promise<RunChatSessionState>;
  /** Exact deterministic user-message + assistant-parent state used for crash-safe completion. */
  getMessageState(target: RunChatTarget, sessionId: string, messageId: string, signal?: AbortSignal): Promise<RunChatMessageState>;
  sendPrompt(target: RunChatTarget, sessionId: string, text: string, messageId: string, signal?: AbortSignal): Promise<void>;
  loadItems(target: RunChatTarget, sessionId: string, signal?: AbortSignal): Promise<import("@companion/contracts").RunChatHistoryItem[]>;
  streamEvents(
    target: RunChatTarget,
    sessionId: string,
    signal: AbortSignal,
    /** Called only after the SDK has established the upstream event subscription. */
    onConnected?: () => void,
    /** Stable recorder-local identity used to preserve cumulative cursors across reconnects. */
    cursorKey?: object,
  ): AsyncIterable<import("@companion/contracts").RunChatEvent>;
}

/** Fetches a stored skill archive (tar.gz bytes) by its storage path — wired to S3 in apps/worker. */
export type SkillArchiveFetcher = (storagePath: string, signal?: AbortSignal) => Promise<Buffer>;

/** Provider error with the fields the run error state renders. */
export class RunRuntimeError extends Error {
  readonly exitCode: number | null;
  readonly detail: string | null;

  constructor(message: string, opts: { exitCode?: number | null; detail?: string | null } = {}) {
    super(message);
    this.exitCode = opts.exitCode ?? null;
    this.detail = opts.detail ?? null;
  }
}
