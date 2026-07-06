import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { companionHome } from "../lib/paths";
import { CliError } from "../lib/errors";

export function agentPidPath(): string {
  return join(companionHome(), "agent.pid");
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(): Promise<number | null> {
  try {
    const value = Number((await readFile(agentPidPath(), "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function writePidExclusive(): Promise<void> {
  const handle = await open(agentPidPath(), "wx", 0o600);
  try {
    await handle.writeFile(`${process.pid}\n`);
  } finally {
    await handle.close();
  }
}

export async function currentAgentPid(): Promise<number | null> {
  const pid = await readPid();
  return pid && isPidAlive(pid) ? pid : null;
}

export async function acquireAgentLock(): Promise<() => Promise<void>> {
  await mkdir(companionHome(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writePidExclusive();
      return async () => {
        const current = await readPid();
        if (current === process.pid) await rm(agentPidPath(), { force: true });
      };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      const pid = await readPid();
      if (pid && isPidAlive(pid)) throw new CliError(`Companion agent is already running with pid ${pid}`, 9);
      await rm(agentPidPath(), { force: true });
    }
  }
  throw new CliError("could not acquire Companion agent lock", 9);
}
