import type { AgentCredentials } from "../credentials";
import { installLaunchd, startLaunchd, stopLaunchd, uninstallLaunchd } from "./launchd";
import { unsupportedService } from "./windows";

function isDarwin(): boolean {
  return process.platform === "darwin";
}

export function supportsServiceManagement(): boolean {
  return isDarwin();
}

export async function installService(credentials: AgentCredentials): Promise<void> {
  if (isDarwin()) return installLaunchd(credentials);
  return unsupportedService();
}

export async function startService(credentials: AgentCredentials): Promise<void> {
  if (isDarwin()) return startLaunchd(credentials);
  return unsupportedService();
}

export async function stopService(): Promise<void> {
  if (isDarwin()) return stopLaunchd();
  return unsupportedService();
}

export async function uninstallService(): Promise<void> {
  if (isDarwin()) return uninstallLaunchd();
  return unsupportedService();
}
