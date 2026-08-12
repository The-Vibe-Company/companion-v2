import { setTimeout as sleep } from "node:timers/promises";
import type {
  CompanionClientSurface,
  CompanionDaemonState,
  CompanionMcpAccount,
  CompanionRuntimeState,
} from "@companion/contracts";
import {
  buildMcpAdapterInjection,
  runtimeSkillArchivePath,
  type CompanionRuntimeSkill,
} from "./companionPiInjection";

const DEFAULT_BOX_API_BASE = "https://ascii.dev/api/box/v1";
const DEFAULT_PI_MCP_ADAPTER_PACKAGE = "npm:pi-mcp-adapter@2.12.1";
export const COMPANION_PI_DISK_LAYOUT_VERSION = 2;
const READY_STATES = new Set<BoxState>(["ready", "idle", "running"]);
const STARTING_STATES = new Set<BoxState>(["init", "provisioning", "provisioned", "cloning"]);

export type BoxState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error";

interface BoxInfo {
  id: string;
  name?: string;
  state: BoxState;
  desktopAvailable: boolean;
  setupStatus?: "pending" | "running" | "done" | "failed" | null;
  setupError?: string | null;
}

interface BoxEnvelope {
  box: BoxInfo;
}

interface BoxListEnvelope {
  boxes: BoxInfo[];
  pageInfo?: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}

interface CommandEnvelope {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface DesktopEnvelope {
  desktopUrl?: string | null;
  provisioning?: boolean;
}

export interface ProviderCredential {
  provider: string;
  envKey: string;
  value: string;
}

export interface CompanionRuntimeObservation {
  boxId: string;
  runtimeState: CompanionRuntimeState;
  daemonState: CompanionDaemonState;
  desktopAvailable: boolean;
}

export interface CompanionBoxRuntime {
  start(input: {
    companionId: string;
    orgId: string;
    boxId: string | null;
    clientSurface: CompanionClientSurface;
    credentials: ProviderCredential[];
    mcpAccounts: CompanionMcpAccount[];
    skills: CompanionRuntimeSkill[];
    onBoxAssigned: (boxId: string) => Promise<void>;
  }): Promise<CompanionRuntimeObservation>;
  stop(input: { boxId: string }): Promise<CompanionRuntimeObservation>;
  status(input: { boxId: string }): Promise<CompanionRuntimeObservation>;
  desktop(input: { boxId: string }): Promise<{ url: string | null; provisioning: boolean }>;
}

export class BoxRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxRuntimeConfigurationError";
  }
}

export class BoxRuntimeProviderError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "BoxRuntimeProviderError";
    this.status = status;
    this.code = code;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function setupScript(installCommand: string | undefined, mcpAdapterPackage: string): string {
  const install = installCommand?.trim()
    ? installCommand
    : "echo 'Pi is not installed; configure COMPANION_PI_INSTALL_COMMAND or preinstall pi in the Box image' >&2; exit 1";
  return `#!/usr/bin/env bash
set -euo pipefail
if ! command -v pi >/dev/null 2>&1; then
  ${install}
fi
command -v pi >/dev/null 2>&1
mkdir -p "$HOME/.companion/bin" "$HOME/.companion/pi" "$HOME/.companion/runtime/sessions" "$HOME/.companion/runtime/state" "$HOME/.companion/runtime/logs" "$HOME/.config/systemd/user"
layout_marker="$HOME/.companion/runtime/state/pi-layout.version"
expected_layout=${shellQuote(`${COMPANION_PI_DISK_LAYOUT_VERSION}:${mcpAdapterPackage}`)}
if [ -f "$layout_marker" ] && [ "$(cat "$layout_marker")" = "$expected_layout" ]; then
  exit 0
fi
PI_CODING_AGENT_DIR="$HOME/.companion/pi" pi install ${shellQuote(mcpAdapterPackage)}
cat > "$HOME/.companion/bin/pi-daemon" <<'COMPANION_PI_DAEMON'
#!/usr/bin/env bash
set -euo pipefail
root="$HOME/.companion/runtime"
mkdir -p "$root/sessions" "$root/state" "$root/logs"
export PI_CODING_AGENT_DIR="$HOME/.companion/pi"
fifo="$root/state/pi.rpc.in"
rm -f "$fifo"
mkfifo -m 600 "$fifo"
exec 3<>"$fifo"
skill_args=(--no-skills)
if find "$root/skills" -type f -name SKILL.md -print -quit 2>/dev/null | grep -q .; then
  skill_args+=(--skill "$root/skills")
fi
exec pi --mode rpc --session-dir "$root/sessions" "\${skill_args[@]}" <&3 >>"$root/logs/pi.rpc.ndjson" 2>>"$root/logs/pi.stderr.log"
COMPANION_PI_DAEMON
chmod 700 "$HOME/.companion/bin/pi-daemon"
cat > "$HOME/.config/systemd/user/companion-pi-daemon.service" <<'COMPANION_PI_SERVICE'
[Unit]
Description=Companion Pi daemon
After=network-online.target

[Service]
Type=simple
ExecStart=%h/.companion/bin/pi-daemon
EnvironmentFile=-%h/.companion/runtime/state/providers.env
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
COMPANION_PI_SERVICE
systemctl --user daemon-reload
printf '%s\n' "$expected_layout" > "$layout_marker"
`;
}

function encodeEnvironmentFile(credentials: ProviderCredential[]): string {
  return credentials
    .map(({ envKey, value }) => `${envKey}=${JSON.stringify(value)}`)
    .join("\n")
    .concat(credentials.length ? "\n" : "");
}

function observation(box: BoxInfo, daemonState: CompanionDaemonState): CompanionRuntimeObservation {
  const runtimeState: CompanionRuntimeState =
    box.state === "archived"
      ? "stopped"
      : box.state === "archiving"
        ? "stopping"
        : box.state === "error"
          ? "error"
          : READY_STATES.has(box.state)
            ? daemonState === "running" ? "running" : "stopped"
            : "provisioning";
  return {
    boxId: box.id,
    runtimeState,
    daemonState,
    desktopAvailable: box.desktopAvailable,
  };
}

export class AsciiBoxCompanionRuntime implements CompanionBoxRuntime {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #environment: string | undefined;
  readonly #ttlSeconds: number;
  readonly #pollIntervalMs: number;
  readonly #readyTimeoutMs: number;
  readonly #installCommand: string | undefined;
  readonly #mcpAdapterPackage: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const apiKey = env.COMPANION_BOX_API_KEY?.trim();
    if (!apiKey) {
      throw new BoxRuntimeConfigurationError(
        "Box runtime is not configured; set COMPANION_BOX_API_KEY",
      );
    }
    this.#apiKey = apiKey;
    this.#baseUrl = (env.COMPANION_BOX_API_BASE?.trim() || DEFAULT_BOX_API_BASE).replace(/\/+$/, "");
    this.#environment = env.COMPANION_BOX_ENVIRONMENT?.trim() || undefined;
    this.#ttlSeconds = positiveInteger(env.COMPANION_BOX_TTL_SECONDS, 3600);
    this.#pollIntervalMs = positiveInteger(env.COMPANION_BOX_POLL_INTERVAL_MS, 1000);
    this.#readyTimeoutMs = positiveInteger(env.COMPANION_BOX_READY_TIMEOUT_MS, 120_000);
    this.#installCommand = env.COMPANION_PI_INSTALL_COMMAND;
    this.#mcpAdapterPackage =
      env.COMPANION_PI_MCP_ADAPTER_PACKAGE?.trim() || DEFAULT_PI_MCP_ADAPTER_PACKAGE;
  }

  async #request<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as
        | { code?: string; message?: string; error?: { message?: string } }
        | null;
      throw new BoxRuntimeProviderError(
        body?.message || body?.error?.message || `Box API request failed with ${response.status}`,
        response.status,
        body?.code,
      );
    }
    return await response.json() as T;
  }

  async #get(boxId: string): Promise<BoxInfo> {
    return (await this.#request<BoxEnvelope>(`/boxes/${encodeURIComponent(boxId)}`)).box;
  }

  async #findCompanionBox(companionId: string): Promise<BoxInfo | null> {
    const name = `Companion ${companionId}`;
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "200", sort: "desc" });
      if (cursor) query.set("cursor", cursor);
      const result = await this.#request<BoxListEnvelope>(`/boxes?${query}`);
      const found = result.boxes.find((box) => box.name === name);
      if (found) return found;
      cursor = result.pageInfo?.hasMore ? result.pageInfo.nextCursor : null;
    } while (cursor);
    return null;
  }

  async #waitReady(boxId: string): Promise<BoxInfo> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    while (Date.now() < deadline) {
      const box = await this.#get(boxId);
      if (READY_STATES.has(box.state) && (box.setupStatus === undefined || box.setupStatus === null || box.setupStatus === "done")) {
        return box;
      }
      if (box.state === "error") throw new BoxRuntimeProviderError("Box entered error state", 502);
      if (box.setupStatus === "failed") {
        throw new BoxRuntimeProviderError(`Box Pi setup failed: ${box.setupError || "unknown error"}`, 502);
      }
      await sleep(this.#pollIntervalMs);
    }
    throw new BoxRuntimeProviderError("Box did not become ready before the configured timeout", 504);
  }

  async #command(
    boxId: string,
    command: string,
    timeoutSeconds = 60,
  ): Promise<CommandEnvelope> {
    return this.#request<CommandEnvelope>(`/boxes/${encodeURIComponent(boxId)}/commands`, {
      method: "POST",
      body: JSON.stringify({ command, timeoutSeconds }),
    }, (timeoutSeconds + 10) * 1_000);
  }

  async #daemonState(boxId: string): Promise<CompanionDaemonState> {
    const result = await this.#command(
      boxId,
      "systemctl --user is-active companion-pi-daemon.service 2>/dev/null || true",
    );
    return result.stdout.trim() === "active" ? "running" : "stopped";
  }

  async #removeProviderFile(boxId: string): Promise<void> {
    await this.#command(
      boxId,
      "rm -f \"$HOME/.companion/runtime/state/providers.env\"",
    );
  }

  async #writeFile(boxId: string, path: string, content: string): Promise<void> {
    await this.#request(`/boxes/${encodeURIComponent(boxId)}/files`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    });
  }

  async #ensurePiLayout(boxId: string): Promise<void> {
    const result = await this.#command(
      boxId,
      setupScript(this.#installCommand, this.#mcpAdapterPackage),
      180,
    );
    if (!result.success) throw new BoxRuntimeProviderError("Pi runtime layout failed to install", 502);
  }

  async #injectPiResources(input: {
    boxId: string;
    clientSurface: CompanionClientSurface;
    credentials: ProviderCredential[];
    mcpAccounts: CompanionMcpAccount[];
    skills: CompanionRuntimeSkill[];
  }): Promise<void> {
    const injectedSkills = input.clientSurface === "native_mobile" ? [] : input.skills;
    const mcp = buildMcpAdapterInjection(input.mcpAccounts);
    const cleared = await this.#command(
      input.boxId,
      "set -e; root=\"$HOME/.companion/runtime\"; rm -rf \"$root/state/skill-archives\"; mkdir -p \"$root/state/skill-archives\"",
    );
    if (!cleared.success) throw new BoxRuntimeProviderError("Pi resource staging failed", 502);
    await this.#writeFile(
      input.boxId,
      ".companion/pi/mcp.json",
      `${JSON.stringify(mcp.config, null, 2)}\n`,
    );
    await this.#writeFile(
      input.boxId,
      ".companion/runtime/state/mcp-accounts.json",
      `${JSON.stringify({ accounts: mcp.accounts }, null, 2)}\n`,
    );
    await this.#writeFile(
      input.boxId,
      ".companion/runtime/state/skills.json",
      `${JSON.stringify({
        client_surface: input.clientSurface,
        skills: injectedSkills.map(({ slug, version, checksum }) => ({ slug, version, checksum })),
      }, null, 2)}\n`,
    );
    for (const skill of injectedSkills) {
      await this.#writeFile(
        input.boxId,
        runtimeSkillArchivePath(skill),
        skill.archive.toString("base64"),
      );
    }
    try {
      await this.#writeFile(
        input.boxId,
        ".companion/runtime/state/providers.env",
        encodeEnvironmentFile(input.credentials),
      );
      const prepared = await this.#command(
        input.boxId,
        "set -euo pipefail; root=\"$HOME/.companion/runtime\"; rm -rf \"$root/skills.next\"; mkdir -p \"$root/skills.next\"; shopt -s nullglob; for archive in \"$root/state/skill-archives\"/*.tar.gz.b64; do slug=\"$(basename \"$archive\" .tar.gz.b64)\"; mkdir -p \"$root/skills.next/$slug\"; base64 --decode \"$archive\" | tar --extract --gzip --file=- --directory=\"$root/skills.next/$slug\" --no-same-owner --no-same-permissions; done; rm -rf \"$root/skills.prev\"; if [ -d \"$root/skills\" ]; then mv \"$root/skills\" \"$root/skills.prev\"; fi; mv \"$root/skills.next\" \"$root/skills\"; rm -rf \"$root/skills.prev\" \"$root/state/skill-archives\"",
        180,
      );
      if (!prepared.success) throw new BoxRuntimeProviderError("Pi resources failed to prepare", 502);
    } catch (error) {
      await this.#removeProviderFile(input.boxId).catch(() => undefined);
      throw error;
    }
  }

  async start(input: {
    companionId: string;
    orgId: string;
    boxId: string | null;
    clientSurface: CompanionClientSurface;
    credentials: ProviderCredential[];
    mcpAccounts: CompanionMcpAccount[];
    skills: CompanionRuntimeSkill[];
    onBoxAssigned: (boxId: string) => Promise<void>;
  }): Promise<CompanionRuntimeObservation> {
    let box: BoxInfo;
    let boxIdPersisted = false;
    if (!input.boxId) {
      const recovered = await this.#findCompanionBox(input.companionId);
      if (recovered) {
        box = recovered;
      } else {
        const created = await this.#request<BoxEnvelope>("/boxes", {
          method: "POST",
          body: JSON.stringify({
            // Bound the cost of the irreducible POST-response/process-crash window. The desired TTL
            // is applied only after the returned id is durable in the control plane.
            ttlSeconds: Math.min(this.#ttlSeconds, 300),
            noEnv: true,
            ...(this.#environment ? { environment: this.#environment } : {}),
            env: {
              COMPANION_ID: input.companionId,
              COMPANION_ORG_ID: input.orgId,
            },
            setupScript: setupScript(this.#installCommand, this.#mcpAdapterPackage),
          }),
        });
        box = created.box;
        try {
          await input.onBoxAssigned(box.id);
          boxIdPersisted = true;
          box = (await this.#request<BoxEnvelope>(
            `/boxes/${encodeURIComponent(box.id)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                name: `Companion ${input.companionId}`,
                ttlSeconds: this.#ttlSeconds,
              }),
            },
          )).box;
        } catch (error) {
          await this.#request(`/boxes/${encodeURIComponent(box.id)}/stop`, {
            method: "POST",
            body: JSON.stringify({ force: false }),
          }).catch(() => undefined);
          throw error;
        }
      }
    } else {
      box = await this.#get(input.boxId);
    }
    if (box.state === "archived") {
      const resumed = await this.#request<BoxEnvelope>(
        `/boxes/${encodeURIComponent(box.id)}/resume`,
        {
          method: "POST",
          body: JSON.stringify({ noEnv: true, ttlSeconds: this.#ttlSeconds }),
        },
      );
      box = resumed.box;
    } else if (box.state === "archiving") {
      throw new BoxRuntimeProviderError("Box is still archiving; retry start after it is archived", 409);
    } else if (!READY_STATES.has(box.state) && !STARTING_STATES.has(box.state)) {
      throw new BoxRuntimeProviderError(`Box cannot start from state ${box.state}`, 409);
    }

    if (!boxIdPersisted) {
      try {
        await input.onBoxAssigned(box.id);
      } catch (error) {
        if (!input.boxId) {
          await this.#request(`/boxes/${encodeURIComponent(box.id)}/stop`, {
            method: "POST",
            body: JSON.stringify({ force: false }),
          }).catch(() => undefined);
        }
        throw error;
      }
    }
    box = await this.#waitReady(box.id);
    await this.#ensurePiLayout(box.id);
    await this.#injectPiResources({
      boxId: box.id,
      clientSurface: input.clientSurface,
      credentials: input.credentials,
      mcpAccounts: input.mcpAccounts,
      skills: input.skills,
    });
    let started: CommandEnvelope;
    try {
      started = await this.#command(
        box.id,
        "set -e; credential_file=\"$HOME/.companion/runtime/state/providers.env\"; trap 'rm -f \"$credential_file\"' EXIT; chmod 600 \"$credential_file\"; systemctl --user daemon-reload; systemctl --user restart companion-pi-daemon.service",
      );
    } catch (error) {
      await this.#removeProviderFile(box.id).catch(() => undefined);
      throw error;
    }
    if (!started.success) {
      await this.#removeProviderFile(box.id).catch(() => undefined);
      throw new BoxRuntimeProviderError("Pi daemon failed to start", 502);
    }
    const daemonState = await this.#daemonState(box.id);
    if (daemonState !== "running") throw new BoxRuntimeProviderError("Pi daemon is not running after start", 502);
    return observation(await this.#get(box.id), daemonState);
  }

  async stop(input: { boxId: string }): Promise<CompanionRuntimeObservation> {
    let box = await this.#get(input.boxId);
    if (READY_STATES.has(box.state)) {
      const stopped = await this.#command(
        input.boxId,
        "systemctl --user stop companion-pi-daemon.service",
      );
      if (!stopped.success) throw new BoxRuntimeProviderError("Pi daemon failed to stop", 502);
    }
    if (box.state !== "archived" && box.state !== "archiving") {
      const response = await this.#request<BoxEnvelope>(
        `/boxes/${encodeURIComponent(input.boxId)}/stop`,
        { method: "POST", body: JSON.stringify({ force: false }) },
      );
      box = response.box;
    }
    return observation(box, "stopped");
  }

  async status(input: { boxId: string }): Promise<CompanionRuntimeObservation> {
    const box = await this.#get(input.boxId);
    const daemonState = READY_STATES.has(box.state) ? await this.#daemonState(input.boxId) : "stopped";
    return observation(box, daemonState);
  }

  async desktop(input: { boxId: string }): Promise<{ url: string | null; provisioning: boolean }> {
    const box = await this.#get(input.boxId);
    if (!READY_STATES.has(box.state)) {
      throw new BoxRuntimeProviderError("Box must already be running before requesting desktop access", 409);
    }
    const result = await this.#request<DesktopEnvelope>(
      `/boxes/${encodeURIComponent(input.boxId)}/desktop?vnc=1`,
      { method: "POST", body: "{}" },
    );
    return { url: result.desktopUrl ?? null, provisioning: result.provisioning === true };
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

