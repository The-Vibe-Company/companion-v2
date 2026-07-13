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
 * never wake: when the sandbox stops (freeze or timeout), the run becomes a read-only transcript.
 */

const WORKDIR = "/vercel/sandbox";
const OPENCODE_PORT = 4096;
const OPENCODE_USERNAME = OPENCODE_SERVER_USERNAME;
const COLLECT_MAX_DEPTH = 3;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("sandbox operation aborted");
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

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
        // Materialize artifacts/ so the composed prompt's "save into ./artifacts/" always resolves.
        { path: `${WORKDIR}/artifacts/.keep`, content: Buffer.alloc(0) as Uint8Array },
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
      } catch {
        // Already stopped or gone — freeze is idempotent.
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

    async collectFiles({ ref, dir, maxFiles, maxFileBytes, signal }) {
      const sandbox = await getSandbox(ref, signal);
      const collected: Array<{ path: string; data: Buffer; byteSize: number }> = [];
      // BFS over (absolute dir, depth) pairs so nested deliverables (e.g. site/index.html) publish.
      const queue: Array<{ abs: string; depth: number }> = [{ abs: dir, depth: 0 }];
      while (queue.length > 0 && collected.length < maxFiles) {
        const { abs, depth } = queue.shift()!;
        let entries;
        try {
          entries = await abortable(sandbox.fs.readdir(abs, { withFileTypes: true, signal }), signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          // Directory vanished or was never created — nothing to collect.
          continue;
        }
        for (const entry of entries) {
          if (collected.length >= maxFiles) break;
          const name = entry.name;
          // Skip dotfiles (incl. the .keep placeholder) — deliverables only.
          if (!name || name.startsWith(".")) continue;
          const entryAbs = `${abs}/${name}`;
          if (entry.isDirectory()) {
            if (depth + 1 <= COLLECT_MAX_DEPTH) queue.push({ abs: entryAbs, depth: depth + 1 });
            continue;
          }
          if (!entry.isFile()) continue;
          try {
            // stat first: never pull oversized bytes across the wire.
            const stats = await abortable(sandbox.fs.stat(entryAbs, { signal }), signal);
            if (stats.size > maxFileBytes) continue;
            const data = await abortable(sandbox.fs.readFile(entryAbs, { signal }), signal);
            if (data.length > maxFileBytes) continue;
            const rel = entryAbs.slice(dir.length).replace(/^\/+/, "");
            collected.push({ path: rel, data, byteSize: data.length });
          } catch (error) {
            if (signal?.aborted) throw error;
            // File vanished between listing and read — skip it.
            continue;
          }
        }
      }
      return collected;
    },
  };
}
