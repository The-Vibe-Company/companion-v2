import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { companionHome } from "../lib/paths";

export const agentStatusSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive().nullable(),
  lastBeatAt: z.string().nullable(),
  nextBeatAt: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
  agentVersion: z.string().nullable(),
  latestAgentVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  intervalSeconds: z.number().int().positive().nullable(),
});

export type AgentStatus = z.infer<typeof agentStatusSchema>;

export function agentStatusPath(): string {
  return join(companionHome(), "agent-status.json");
}

export async function readAgentStatus(): Promise<AgentStatus | null> {
  try {
    return agentStatusSchema.parse(JSON.parse(await readFile(agentStatusPath(), "utf8")));
  } catch {
    return null;
  }
}

export async function writeAgentStatus(status: AgentStatus): Promise<void> {
  await mkdir(companionHome(), { recursive: true });
  await writeFile(agentStatusPath(), JSON.stringify(status, null, 2));
}
