/**
 * The Companion Agents runtime port — the seam between the control plane (declared agent rows,
 * provisioning state machine) and the sandbox provider actually running OpenCode. Types only:
 * `@vercel/sandbox` / `@opencode-ai/sdk` live in `@companion/sandbox`, which apps/api composes and
 * injects into core services the same way `database` is injected. Core stays framework- and
 * SDK-free so the fakeDb test suites can drive the provisioning executor with scripted stubs.
 *
 * Contract notes the implementations must honor:
 * - Every step is safe to re-run (fresh-fork retries key the sandbox name by attempt).
 * - Sandbox processes DO NOT survive a snapshot resume — `wake` must relaunch the server with a
 *   freshly decrypted env; env values are never written to the sandbox filesystem.
 * - `destroy`/`stop` swallow "not found" (idempotent teardown).
 */

/** Basic-auth username every agent's OpenCode server is configured with. */
export const OPENCODE_SERVER_USERNAME = "companion";

export interface SandboxRef {
  /** Deterministic per-attempt name, e.g. `cmp-<org8>-<slug>-a<attempt>` (unique per project). */
  sandboxName: string;
  /** Provider id (sb-…) once known; null before the fork step completes. */
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
 * Env injected at serve launch (and on every wake/restart). Carries the per-agent
 * OPENCODE_SERVER_PASSWORD, the chosen model provider's API key(s), and the user's skill secrets —
 * decrypted immediately before the call and never persisted.
 */
export type ServeEnv = Record<string, string>;

export interface AgentWorkspaceFiles {
  /** `.opencode/agents/<slug>.md` — the agent definition (instructions, mode, model). */
  agentMarkdown: string;
  agentSlug: string;
  /** `opencode.json` — model + permissions config. */
  opencodeJson: string;
  skills: SkillBundle[];
}

export interface AgentRuntime {
  readonly provider: "vercel";
  /** Step 1 — fork/boot the named sandbox from the golden snapshot; returns id + public domain. */
  forkFromGolden(input: { ref: SandboxRef; goldenSnapshotId: string }): Promise<{ sandboxId: string; domain: string }>;
  /** Step 2 — write the agent definition, opencode.json and skill folders into the sandbox FS. */
  pushSkills(input: { ref: SandboxRef; files: AgentWorkspaceFiles }): Promise<void>;
  /** Step 3 — (re)launch `opencode serve` detached with the injected env. */
  startServer(input: { ref: SandboxRef; env: ServeEnv }): Promise<void>;
  /** Step 4 — poll the server through the public domain (basic auth) until healthy. */
  healthCheck(input: { ref: SandboxRef; domain: string; password: string }): Promise<{ ok: true; ms: number }>;
  /** Resume a slept sandbox, relaunch serve, re-read the domain; returns measured resume latency. */
  wake(input: { ref: SandboxRef; env: ServeEnv }): Promise<{ domain: string; resumeMs: number }>;
  /** Stop now (filesystem auto-snapshots); used by Pause. Idempotent. */
  stop(ref: SandboxRef): Promise<void>;
  /** Delete the sandbox entirely (danger zone / fresh-fork retry cleanup). Idempotent. */
  destroy(ref: SandboxRef): Promise<void>;
  /** Replace one skill folder in place (rm -rf + write) — the skill-update push. */
  replaceSkill(input: { ref: SandboxRef; skill: SkillBundle }): Promise<void>;
  /** Kill + relaunch serve so replaced skills are re-discovered, then wait healthy. */
  restartServer(input: { ref: SandboxRef; env: ServeEnv; domain: string; password: string }): Promise<void>;
}

/** Fetches a stored skill archive (tar.gz bytes) by its storage path — wired to S3 in apps/api. */
export type SkillArchiveFetcher = (storagePath: string) => Promise<Buffer>;

/** Provider error with the fields the provisioning error block renders. */
export class AgentRuntimeError extends Error {
  readonly exitCode: number | null;
  readonly detail: string | null;

  constructor(message: string, opts: { exitCode?: number | null; detail?: string | null } = {}) {
    super(message);
    this.exitCode = opts.exitCode ?? null;
    this.detail = opts.detail ?? null;
  }
}
