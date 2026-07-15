import { APIError, Sandbox } from "@vercel/sandbox";
import {
  RunRuntimeError,
  OPENCODE_SERVER_USERNAME,
  type RunSandboxRuntime,
  type RunWorkspaceFiles,
  type SandboxRef,
  type ServeEnv,
  type SkillBundle,
} from "@companion/core";

/**
 * The Vercel Sandbox implementation of the {@link RunSandboxRuntime} port. One skill run = one
 * named sandbox booted fresh from the golden snapshot (OpenCode + python3 pre-installed). Runs
 * Named sandboxes may be stopped and resumed for the bounded run-reactivation window.
 */

const WORKDIR = "/vercel/sandbox";
const OPENCODE_PORT = 4096;
const OPENCODE_USERNAME = OPENCODE_SERVER_USERNAME;

export interface VercelRuntimeConfig {
  token: string;
  teamId: string;
  projectId: string;
}

export function vercelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VercelRuntimeConfig | null {
  const token = env.VERCEL_TOKEN?.trim();
  const teamId = env.VERCEL_TEAM_ID?.trim();
  const projectId = env.VERCEL_PROJECT_ID?.trim();
  if (!token || !teamId || !projectId) return null;
  return { token, teamId, projectId };
}

function skillFilePayloads(skill: SkillBundle): { path: string; content: Uint8Array; mode?: number }[] {
  return skill.files.map((file) => ({
    path: `${WORKDIR}/.claude/skills/${skill.slug}/${file.path}`,
    content: file.data,
    ...(file.executable ? { mode: 0o755 } : {}),
  }));
}

async function firstOkResponse(
  url: string,
  headers: Record<string, string>,
  opts: { attempts: number; delayMs: number; signal?: AbortSignal },
): Promise<number> {
  let lastError: unknown = null;
  const abortReason = () => opts.signal?.reason instanceof Error
    ? opts.signal.reason
    : new Error("health check aborted");
  for (let attempt = 0; attempt < opts.attempts; attempt += 1) {
    if (opts.signal?.aborted) throw abortReason();
    try {
      const timeout = AbortSignal.timeout(10_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const res = await fetch(url, { headers, redirect: "manual", signal });
      // Any response the OpenCode server produced (2xx-4xx) proves the process is up and routed.
      // 5xx typically means the sandbox router has no live backend yet — keep retrying.
      if (res.status < 500) return res.status;
      lastError = new Error(`upstream responded ${res.status}`);
    } catch (error) {
      if (opts.signal?.aborted) throw abortReason();
      lastError = error;
    }
    const delayMs = opts.delayMs * Math.min(attempt + 1, 5);
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(abortReason());
      };
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  throw new RunRuntimeError("opencode did not report healthy in time", {
    detail: lastError instanceof Error ? lastError.message : null,
  });
}

export function createVercelRuntime(config: VercelRuntimeConfig): RunSandboxRuntime {
  const credentials = { token: config.token, teamId: config.teamId, projectId: config.projectId };

  async function getSandbox(ref: SandboxRef, signal?: AbortSignal): Promise<Sandbox> {
    return Sandbox.get({
      ...credentials,
      name: ref.sandboxName,
      signal,
      ...(signal
        ? {
            fetch: (request: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
              globalThis.fetch(request, {
                ...init,
                signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
              }),
          }
        : {}),
    });
  }

  async function launchServe(sandbox: Sandbox, env: ServeEnv, signal?: AbortSignal): Promise<void> {
    // A restart on a live sandbox must not double-bind :4096.
    await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "pkill -f 'opencode serve' || true"],
      cwd: WORKDIR,
      signal,
      timeoutMs: 10_000,
    });
    await sandbox.runCommand({
      cmd: "sh",
      // `-l` so the login PATH set up by the golden snapshot (npm global bin) resolves `opencode`.
      args: ["-lc", `exec opencode serve --hostname 0.0.0.0 --port ${OPENCODE_PORT}`],
      cwd: WORKDIR,
      env,
      detached: true,
      signal,
    });
  }

  return {
    provider: "vercel",

    async forkFromGolden({ ref, goldenSnapshotId, signal }) {
      try {
        const sandbox = await Sandbox.getOrCreate({
          ...credentials,
          name: ref.sandboxName,
          source: { type: "snapshot", snapshotId: goldenSnapshotId },
          ports: [OPENCODE_PORT],
          timeout: ref.timeoutMs,
          signal,
        });
        // @vercel/sandbox 2.4.0 identifies persistent sandboxes by NAME (no public provider id).
        return { sandboxId: sandbox.name, domain: sandbox.domain(OPENCODE_PORT) };
      } catch (error) {
        throw new RunRuntimeError(
          `fork snapshot: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async pushWorkspace({ ref, files, signal }) {
      const sandbox = await getSandbox(ref, signal);
      const payloads: { path: string; content: Uint8Array; mode?: number }[] = [
        {
          path: `${WORKDIR}/opencode.json`,
          content: Buffer.from(files.opencodeJson, "utf8") as Uint8Array,
        },
        ...files.skills.flatMap(skillFilePayloads),
        ...files.attachments.map((attachment) => ({
          path: `${WORKDIR}/attachments/${attachment.path}`,
          content: attachment.data as Uint8Array,
        })),
      ];
      // Write in chunks: a big skill in one call risks oversized requests.
      const CHUNK = 32;
      for (let i = 0; i < payloads.length; i += CHUNK) {
        await sandbox.writeFiles(payloads.slice(i, i + CHUNK), { signal });
      }
    },

    async startServer({ ref, env, signal }) {
      const sandbox = await getSandbox(ref, signal);
      await launchServe(sandbox, env, signal);
    },

    async healthCheck({ domain, password, signal }) {
      const started = Date.now();
      const auth = Buffer.from(`${OPENCODE_USERNAME}:${password}`).toString("base64");
      await firstOkResponse(
        `${domain}/doc`,
        { authorization: `Basic ${auth}` },
        { attempts: 30, delayMs: 800, signal },
      );
      return { ok: true as const, ms: Date.now() - started };
    },

    async stop(ref, signal) {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name: ref.sandboxName, resume: false, signal });
        await sandbox.stop({ signal });
      } catch (error) {
        // Already stopped or gone is idempotent. Provider outages must remain visible so the
        // worker does not claim a resumable terminal state while code may still be running.
        if (error instanceof APIError && (error.response.status === 404 || error.response.status === 410)) return;
        throw error;
      }
    },

    async destroy(ref, signal) {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name: ref.sandboxName, resume: false, signal });
        await sandbox.delete({ signal });
      } catch (error) {
        // Never provisioned or already deleted — destroy is idempotent. Anything else (API outage,
        // revoked token) must propagate so callers keep the cleanup owed and retry it later.
        if (error instanceof APIError && (error.response.status === 404 || error.response.status === 410)) return;
        throw error;
      }
    },

    async extendTimeout(ref, ms, signal) {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name: ref.sandboxName, resume: false, signal });
        await sandbox.extendTimeout(ms, { signal });
      } catch {
        // Best-effort: a stopped/gone sandbox simply stays frozen.
      }
    },
  };
}
