import { homedir } from "node:os";
import { join } from "node:path";

export function companionHome(): string {
  return process.env.COMPANION_HOME ?? join(homedir(), ".companion");
}

export const COMPANION_HOME = companionHome();

export function configPath(): string {
  return join(companionHome(), "config.json");
}

export function sessionPath(profile: string): string {
  const suffix = profile === "default" ? "" : `.${profile}`;
  return join(companionHome(), `session${suffix}.json`);
}
