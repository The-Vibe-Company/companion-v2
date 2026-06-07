import { homedir } from "node:os";
import { join } from "node:path";

export const COMPANION_HOME = process.env.COMPANION_HOME ?? join(homedir(), ".companion");

export function configPath(): string {
  return join(COMPANION_HOME, "config.json");
}

export function sessionPath(profile: string): string {
  const suffix = profile === "default" ? "" : `.${profile}`;
  return join(COMPANION_HOME, `session${suffix}.json`);
}
