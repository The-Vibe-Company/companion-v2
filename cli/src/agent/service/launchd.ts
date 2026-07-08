import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { agentLogPath } from "../log";
import type { AgentCredentials } from "../credentials";

const execFileAsync = promisify(execFile);
const LABEL = "co.thevibecompany.companion.agent";

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function launchdPlist(credentials: AgentCredentials): string {
  const logPath = agentLogPath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(credentials.nodePath)}</string>
    <string>${escapeXml(credentials.entryPath)}</string>
    <string>agent</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

async function launchctl(args: string[]): Promise<void> {
  await execFileAsync("launchctl", args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`launchctl ${args.join(" ")} failed: ${message}`);
  });
}

function guiTarget(): string {
  return `gui/${userInfo().uid}`;
}

export async function installLaunchd(credentials: AgentCredentials): Promise<void> {
  const path = launchdPlistPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, launchdPlist(credentials), "utf8");
  await execFileAsync("launchctl", ["bootout", guiTarget(), path]).catch(() => undefined);
  await launchctl(["bootstrap", guiTarget(), path]);
  await launchctl(["kickstart", "-k", `${guiTarget()}/${LABEL}`]);
}

export async function startLaunchd(credentials: AgentCredentials): Promise<void> {
  const path = launchdPlistPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, launchdPlist(credentials), "utf8");
  await execFileAsync("launchctl", ["bootout", guiTarget(), path]).catch(() => undefined);
  await launchctl(["bootstrap", guiTarget(), path]);
  await launchctl(["kickstart", "-k", `${guiTarget()}/${LABEL}`]);
}

export async function stopLaunchd(): Promise<void> {
  await execFileAsync("launchctl", ["bootout", guiTarget(), launchdPlistPath()]).catch(() => undefined);
}

export async function uninstallLaunchd(): Promise<void> {
  await stopLaunchd();
  await rm(launchdPlistPath(), { force: true });
}
