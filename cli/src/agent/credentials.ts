import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { companionHome } from "../lib/paths";

const agentCredentialsSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string(),
  orgId: z.string(),
  apiUrl: z.string(),
  token: z.string(),
  installChannel: z.enum(["notify", "npm", "tarball"]).default("notify"),
  nodePath: z.string(),
  entryPath: z.string(),
  installedAt: z.string(),
});

export type AgentCredentials = z.infer<typeof agentCredentialsSchema>;

export function agentCredentialsPath(): string {
  return join(companionHome(), "agent.json");
}

export async function loadAgentCredentials(): Promise<AgentCredentials | null> {
  try {
    return agentCredentialsSchema.parse(JSON.parse(await readFile(agentCredentialsPath(), "utf8")));
  } catch {
    return null;
  }
}

export async function saveAgentCredentials(credentials: AgentCredentials): Promise<void> {
  const dir = companionHome();
  const path = agentCredentialsPath();
  const tmp = join(dir, `.agent.json.${process.pid}.${Date.now()}.tmp`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(tmp, JSON.stringify(credentials, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeAgentCredentials(): Promise<void> {
  await rm(agentCredentialsPath(), { force: true });
}
