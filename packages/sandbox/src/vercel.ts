import { Sandbox } from "@vercel/sandbox";
import {
  AgentRuntimeError,
  OPENCODE_SERVER_USERNAME,
  type AgentRuntime,
  type AgentWorkspaceFiles,
  type SandboxRef,
  type ServeEnv,
  type SkillBundle,
} from "@companion/core";

/**
 * The Vercel Sandbox implementation of the {@link AgentRuntime} port. One agent = one named,
 * persistent sandbox booted from the golden snapshot (OpenCode + python3 pre-installed). The
 * filesystem survives sleep (auto-snapshot on stop/timeout); processes do not — every wake
 * relaunches `opencode serve` with a freshly injected env.
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
  opts: { attempts: number; delayMs: number },
): Promise<number> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < opts.attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      // Any response the OpenCode server produced (2xx-4xx) proves the process is up and routed.
      // 5xx typically means the sandbox router has no live backend yet (incl. post-resume
      // router-cache staleness) — keep retrying.
      if (res.status < 500) return res.status;
      lastError = new Error(`upstream responded ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs * Math.min(attempt + 1, 5)));
  }
  throw new AgentRuntimeError("opencode did not report healthy in time", {
    detail: lastError instanceof Error ? lastError.message : null,
  });
}

export function createVercelRuntime(config: VercelRuntimeConfig): AgentRuntime {
  const credentials = { token: config.token, teamId: config.teamId, projectId: config.projectId };

  async function getSandbox(ref: SandboxRef): Promise<Sandbox> {
    return Sandbox.get({ ...credentials, name: ref.sandboxName });
  }

  async function launchServe(sandbox: Sandbox, env: ServeEnv): Promise<void> {
    // Processes never survive resume, but a restart on a live sandbox must not double-bind :4096.
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
        throw new AgentRuntimeError(
          `fork snapshot: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async pushSkills({ ref, files }) {
      const sandbox = await getSandbox(ref);
      const payloads = [
        {
          path: `${WORKDIR}/.opencode/agents/${files.agentSlug}.md`,
          content: Buffer.from(files.agentMarkdown, "utf8") as Uint8Array,
        },
        {
          path: `${WORKDIR}/opencode.json`,
          content: Buffer.from(files.opencodeJson, "utf8") as Uint8Array,
        },
        ...files.skills.flatMap(skillFilePayloads),
      ];
      // Write in chunks: a big skill set in one call risks oversized requests.
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

    async wake({ ref, env }) {
      const started = Date.now();
      const sandbox = await getSandbox(ref); // Sandbox.get resumes a slept sandbox by default.
      await launchServe(sandbox, env);
      const domain = sandbox.domain(OPENCODE_PORT);
      return { domain, resumeMs: Date.now() - started };
    },

    async stop(ref) {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name: ref.sandboxName, resume: false });
        await sandbox.stop();
      } catch {
        // Already stopped or gone — pause is idempotent.
      }
    },

    async destroy(ref) {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name: ref.sandboxName, resume: false });
        await sandbox.delete();
      } catch {
        // Never provisioned or already deleted — destroy is idempotent.
      }
    },

    async replaceSkill({ ref, skill }) {
      const sandbox = await getSandbox(ref);
      const dir = `${WORKDIR}/.claude/skills/${skill.slug}`;
      const rm = await sandbox.runCommand({ cmd: "rm", args: ["-rf", dir], cwd: WORKDIR });
      if (rm.exitCode !== 0) {
        throw new AgentRuntimeError(`replace skill: could not clear ${dir}`, { exitCode: rm.exitCode });
      }
      await sandbox.writeFiles(skillFilePayloads(skill));
    },

    async extendTimeout(ref, ms) {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name: ref.sandboxName, resume: false });
        await sandbox.extendTimeout(ms);
      } catch {
        // Best-effort: a stopped/gone sandbox simply wakes on the next interaction instead.
      }
    },

    async restartServer({ ref, env, domain, password }) {
      const sandbox = await getSandbox(ref);
      await launchServe(sandbox, env);
      const auth = Buffer.from(`${OPENCODE_USERNAME}:${password}`).toString("base64");
      await firstOkResponse(
        `${domain}/doc`,
        { authorization: `Basic ${auth}` },
        { attempts: 20, delayMs: 700 },
      );
    },
  };
}
