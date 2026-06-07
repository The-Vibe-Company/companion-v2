import { mkdir, readFile, writeFile } from "node:fs/promises";
import { COMPANION_HOME, configPath } from "./paths";
import { CliError } from "./errors";

export interface ProfileConfig {
  url: string;
  anonKey: string;
}
type ConfigFile = Record<string, ProfileConfig>;

async function loadConfig(): Promise<ConfigFile> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

/** Resolve the Supabase URL + anon key for a profile (config file, then env). */
export async function getProfileConfig(profile: string): Promise<ProfileConfig> {
  const cfg = await loadConfig();
  const p = cfg[profile];
  const url =
    p?.url ?? process.env.COMPANION_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey =
    p?.anonKey ??
    process.env.COMPANION_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    "";
  if (!url || !anonKey) {
    throw new CliError(
      "no Supabase URL/anon key configured. Run: companion login --url <url> --anon-key <key>",
      2,
    );
  }
  return { url, anonKey };
}

export async function saveProfileConfig(profile: string, cfg: ProfileConfig): Promise<void> {
  const all = await loadConfig();
  all[profile] = cfg;
  await mkdir(COMPANION_HOME, { recursive: true });
  await writeFile(configPath(), JSON.stringify(all, null, 2));
}
