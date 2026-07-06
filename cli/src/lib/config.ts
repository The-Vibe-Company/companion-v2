import { mkdir, readFile, writeFile } from "node:fs/promises";
import { companionHome, configPath } from "./paths";
import { CliError } from "./errors";

export interface ProfileConfig {
  url: string;
  orgId?: string;
}
type ConfigFile = Record<string, ProfileConfig>;

async function loadConfig(): Promise<ConfigFile> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

export async function getProfileConfig(profile: string): Promise<ProfileConfig> {
  const cfg = await loadConfig();
  const url = cfg[profile]?.url ?? process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
  if (!url) throw new CliError("no Companion API URL configured. Run: companion login --url <url>", 2);
  return { url: url.replace(/\/$/, ""), orgId: cfg[profile]?.orgId };
}

export async function saveProfileConfig(profile: string, cfg: ProfileConfig): Promise<void> {
  const all = await loadConfig();
  all[profile] = { url: cfg.url.replace(/\/$/, ""), orgId: cfg.orgId };
  await mkdir(companionHome(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(all, null, 2));
}
