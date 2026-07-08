import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { companionHome } from "../lib/paths";

const MAX_LOG_BYTES = 1024 * 1024;

export function agentLogPath(): string {
  return join(companionHome(), "agent.log");
}

export async function appendAgentLog(message: string): Promise<void> {
  await mkdir(companionHome(), { recursive: true });
  const path = agentLogPath();
  try {
    const info = await stat(path);
    if (info.size > MAX_LOG_BYTES) await rename(path, `${path}.1`);
  } catch {
    // Missing log is fine.
  }
  await appendFile(path, `${new Date().toISOString()} ${message}\n`);
}
