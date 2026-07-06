import { hostname, platform } from "node:os";
import { resolve } from "node:path";
import { COMPANION_AGENT_VERSION, type DevicePlatform, type RegisteredDevice } from "@companion/contracts";
import { getClient } from "../lib/client";
import { CliError } from "../lib/errors";
import { emitJson, out, type GlobalOpts } from "../lib/output";
import { agentCredentialsPath, loadAgentCredentials, removeAgentCredentials, saveAgentCredentials } from "../agent/credentials";
import { runAgentDaemon } from "../agent/daemon";
import { currentAgentPid } from "../agent/lock";
import { readAgentStatus } from "../agent/statusFile";
import { installService, startService, stopService, supportsServiceManagement, uninstallService } from "../agent/service";

function nodePlatform(): DevicePlatform {
  const value = platform();
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  throw new CliError(`unsupported platform: ${value}`, 2);
}

function entryPath(): string {
  if (!process.argv[1]) throw new CliError("could not determine CLI entry path", 2);
  return resolve(process.argv[1]);
}

export async function install(opts: { noService?: boolean }, g: GlobalOpts): Promise<void> {
  if (!opts.noService && !supportsServiceManagement()) {
    throw new CliError("agent service install is supported on macOS only. Use: companion agent install --no-service", 2);
  }
  const client = await getClient(g.profile, g.org);
  const registered = await client.request<RegisteredDevice>("/v1/agent/devices", {
    method: "POST",
    body: JSON.stringify({
      name: hostname() || "unknown-host",
      platform: nodePlatform(),
      agent_version: COMPANION_AGENT_VERSION,
    }),
  });
  const credentials = {
    schemaVersion: 1 as const,
    deviceId: registered.device_id,
    orgId: registered.org_id,
    apiUrl: registered.api_url,
    token: registered.device_token,
    installChannel: "notify" as const,
    nodePath: process.execPath,
    entryPath: entryPath(),
    installedAt: new Date().toISOString(),
  };
  await saveAgentCredentials(credentials);
  if (!opts.noService) await installService(credentials);
  if (g.json) {
    emitJson({ ok: true, device_id: credentials.deviceId, path: agentCredentialsPath(), service: !opts.noService });
  } else {
    out(`registered device ${credentials.deviceId}`);
    out(`credentials ${agentCredentialsPath()}`);
    out(opts.noService ? "service skipped" : "service installed and started");
  }
}

export async function start(g: GlobalOpts): Promise<void> {
  const credentials = await loadAgentCredentials();
  if (!credentials) throw new CliError("agent is not installed. Run: companion agent install", 3);
  await startService(credentials);
  if (g.json) emitJson({ ok: true });
  else out("agent started");
}

export async function stop(g: GlobalOpts): Promise<void> {
  await stopService();
  if (g.json) emitJson({ ok: true });
  else out("agent stopped");
}

export async function uninstall(g: GlobalOpts): Promise<void> {
  const credentials = await loadAgentCredentials();
  await uninstallService().catch(() => undefined);
  if (credentials) {
    const client = await getClient(g.profile, g.org).catch(() => null);
    await client?.request(`/v1/devices/${encodeURIComponent(credentials.deviceId)}`, { method: "DELETE" }).catch(() => null);
  }
  await removeAgentCredentials();
  if (g.json) emitJson({ ok: true });
  else out("agent uninstalled");
}

export async function status(g: GlobalOpts): Promise<void> {
  const [credentials, statusFile, pid] = await Promise.all([
    loadAgentCredentials(),
    readAgentStatus(),
    currentAgentPid(),
  ]);
  const data = {
    installed: !!credentials,
    running: !!pid,
    pid,
    device_id: credentials?.deviceId ?? null,
    api_url: credentials?.apiUrl ?? null,
    status: statusFile,
  };
  if (g.json) {
    emitJson(data);
    return;
  }
  out(`installed  ${data.installed ? "yes" : "no"}`);
  out(`running    ${data.running ? `yes (${pid})` : "no"}`);
  out(`device     ${data.device_id ?? "-"}`);
  out(`api        ${data.api_url ?? "-"}`);
  out(`last beat  ${statusFile?.lastBeatAt ?? "-"}`);
  out(`next beat  ${statusFile?.nextBeatAt ?? "-"}`);
  out(`health     ${statusFile ? (statusFile.ok ? "ok" : `error: ${statusFile.error}`) : "-"}`);
  if (statusFile?.updateAvailable) {
    out(`update    ${statusFile.latestAgentVersion} available; reinstall or update the Companion CLI, then run companion agent start`);
  }
}

export async function run(opts: { once?: boolean }, _g: GlobalOpts): Promise<void> {
  await runAgentDaemon({ once: opts.once });
}
