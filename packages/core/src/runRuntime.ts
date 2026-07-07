/**
 * The skill-run runtime port — the seam between the control plane (skill_runs rows, the in-process
 * launch job + recorder) and the sandbox provider actually running OpenCode. Types only:
 * `@vercel/sandbox` / `@opencode-ai/sdk` live in `@companion/sandbox`, which apps/api composes and
 * injects into core services the same way `database` is injected. Core stays framework- and
 * SDK-free so the fakeDb test suites can drive the launch pipeline with scripted stubs.
 *
 * Contract notes the implementations must honor:
 * - Every run gets a FRESH sandbox forked from the golden snapshot; there is no wake — once the
 *   sandbox stops, the run is frozen and retry means a new run.
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
  /** Exactly one skill, auto-discovered from `.claude/skills/<slug>/`. */
  skill: SkillBundle;
  /** User-attached files, written under `attachments/`. */
  attachments: Array<{ path: string; data: Buffer }>;
}

export interface RunSandboxRuntime {
  readonly provider: "vercel";
  /** Step 1 — fork/boot the named sandbox from the golden snapshot; returns id + public domain. */
  forkFromGolden(input: { ref: SandboxRef; goldenSnapshotId: string }): Promise<{ sandboxId: string; domain: string }>;
  /** Step 2 — write opencode.json, the skill folder and the attachments into the sandbox FS. */
  pushWorkspace(input: { ref: SandboxRef; files: RunWorkspaceFiles }): Promise<void>;
  /** Step 3 — launch `opencode serve` detached with the injected env. */
  startServer(input: { ref: SandboxRef; env: ServeEnv }): Promise<void>;
  /** Step 4 — poll the server through the public domain (basic auth) until healthy. */
  healthCheck(input: { ref: SandboxRef; domain: string; password: string }): Promise<{ ok: true; ms: number }>;
  /** Stop now (freeze). Idempotent. */
  stop(ref: SandboxRef): Promise<void>;
  /** Delete the sandbox entirely. Idempotent. */
  destroy(ref: SandboxRef): Promise<void>;
  /**
   * Push the sandbox's hard timeout out by `ms` (Vercel's clock runs from boot, NOT from traffic —
   * without this an active conversation dies mid-stream). Optional: best-effort feature.
   */
  extendTimeout?(ref: SandboxRef, ms: number): Promise<void>;
  /**
   * List + read the files of one sandbox directory (artifact collection). Bounded: depth ≤ 3,
   * files above `maxFileBytes` are skipped, traversal stops at `maxFiles`. Paths are relative
   * to `dir`.
   */
  collectFiles(input: {
    ref: SandboxRef;
    dir: string;
    maxFiles: number;
    maxFileBytes: number;
  }): Promise<Array<{ path: string; data: Buffer; byteSize: number }>>;
}

/** Fetches a stored skill archive (tar.gz bytes) by its storage path — wired to S3 in apps/api. */
export type SkillArchiveFetcher = (storagePath: string) => Promise<Buffer>;

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
