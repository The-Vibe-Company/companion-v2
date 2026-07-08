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
  opts: { attempts: number; delayMs: number },
): Promise<number> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < opts.attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      // Any response the OpenCode server produced (2xx-4xx) proves the process is up and routed.
      // 5xx typically means the sandbox router has no live backend yet — keep retrying.
      if (res.status < 500) return res.status;
      lastError = new Error(`upstream responded ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs * Math.min(attempt + 1, 5)));
  }
  throw new RunRuntimeError("opencode did not report healthy in time", {
    detail: lastError instanceof Error ? lastError.message : null,
  });
}

export function createVercelRuntime(config: VercelRuntimeConfig): RunSandboxRuntime {
  const credentials = { token: config.token, teamId: config.teamId, projectId: config.projectId };

  async function getSandbox(ref: SandboxRef): Promise<Sandbox> {
    return Sandbox.get({ ...credentials, name: ref.sandboxName });
  }

  async function launchServe(sandbox: Sandbox, env: ServeEnv): Promise<void> {
    // A restart on a live sandbox must not double-bind :4096.
    await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "pkill -f 'opencode serve' || true"],
      cwd: WORKDIR,
    });
    await sandbox.runCommand({
      cmd: "sh",
      // `-l` so the login PATH set up by the golden snapshot (npm global bin) resolves `opencode`.
      args: ["-lc", `exec opencode serve --hostname 0.0.0.0 --port ${OPENCODE_PORT}`],
      cwd: WORKDIR,
      env,
      detached: true,
    });
  }

  return {
    provider: "vercel",

    async forkFromGolden({ ref, goldenSnapshotId }) {
      try {
        const sandbox = await Sandbox.getOrCreate({
          ...credentials,
          name: ref.sandboxName,
          source: { type: "snapshot", snapshotId: goldenSnapshotId },
          ports: [OPENCODE_PORT],
          timeout: ref.timeoutMs,
        });
        // @vercel/sandbox 2.4.0 identifies persistent sandboxes by NAME (no public provider id).
        return { sandboxId: sandbox.name, domain: sandbox.domain(OPENCODE_PORT) };
      } catch (error) {
        throw new RunRuntimeError(
          `fork snapshot: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async pushWorkspace({ ref, files }) {
      const sandbox = await getSandbox(ref);
      const payloads: { path: string; content: Uint8Array; mode?: number }[] = [
        {
          path: `${WORKDIR}/opencode.json`,
          content: Buffer.from(files.opencodeJson, "utf8") as Uint8Array,
        },
        ...skillFilePayloads(files.skill),
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
        await sandbox.writeFiles(payloads.slice(i, i + CHUNK));
      }
    },

    async startServer({ ref, env }) {
      const sandbox = await getSandbox(ref);
      await launchServe(sandbox, env);
    },

    async healthCheck({ domain, password }) {
      const started = Date.now();
      const auth = Buffer.from(`${OPENCODE_USERNAME}:${password}`).toString("base64");
      await firstOkResponse(
        `${domain}/doc`,
        { authorization: `Basic ${auth}` },
        { attempts: 30, delayMs: 800 },
      );
      return { ok: true as const, ms: Date.now() - started };
    },

    async stop(ref) {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name: ref.sandboxName, resume: false });
        await sandbox.stop();
      } catch {
        // Already stopped or gone — freeze is idempotent.
      }
    },

    async destroy(ref) {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name: ref.sandboxName, resume: false });
        await sandbox.delete();
      } catch (error) {
        // Never provisioned or already deleted — destroy is idempotent. Anything else (API outage,
        // revoked token) must propagate so callers keep the cleanup owed and retry it later.
        if (error instanceof APIError && (error.response.status === 404 || error.response.status === 410)) return;
        throw error;
      }
    },

    async extendTimeout(ref, ms) {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name: ref.sandboxName, resume: false });
        await sandbox.extendTimeout(ms);
      } catch {
        // Best-effort: a stopped/gone sandbox simply stays frozen.
      }
    },

    async collectFiles({ ref, dir, maxFiles, maxFileBytes }) {
      const sandbox = await getSandbox(ref);
      const collected: Array<{ path: string; data: Buffer; byteSize: number }> = [];
      // BFS over (absolute dir, depth) pairs so nested deliverables (e.g. site/index.html) publish.
      const queue: Array<{ abs: string; depth: number }> = [{ abs: dir, depth: 0 }];
      while (queue.length > 0 && collected.length < maxFiles) {
        const { abs, depth } = queue.shift()!;
        let entries;
        try {
          entries = await sandbox.fs.readdir(abs, { withFileTypes: true });
        } catch {
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
            const stats = await sandbox.fs.stat(entryAbs);
            if (stats.size > maxFileBytes) continue;
            const data = await sandbox.fs.readFile(entryAbs);
            if (data.length > maxFileBytes) continue;
            const rel = entryAbs.slice(dir.length).replace(/^\/+/, "");
            collected.push({ path: rel, data, byteSize: data.length });
          } catch {
            // File vanished between listing and read — skip it.
            continue;
          }
        }
      }
      return collected;
    },
  };
}
