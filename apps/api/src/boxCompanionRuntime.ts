import { setTimeout as sleep } from "node:timers/promises";
import type { CompanionDaemonState, CompanionRuntimeState } from "@companion/contracts";

const DEFAULT_BOX_API_BASE = "https://ascii.dev/api/box/v1";
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
    credentials: ProviderCredential[];
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

function setupScript(installCommand: string | undefined): string {
  const install = installCommand?.trim()
    ? installCommand
    : "echo 'Pi is not installed; configure COMPANION_PI_INSTALL_COMMAND or preinstall pi in the Box image' >&2; exit 1";
  return `#!/usr/bin/env bash
set -euo pipefail
if ! command -v pi >/dev/null 2>&1; then
  ${install}
fi
command -v pi >/dev/null 2>&1
mkdir -p "$HOME/.companion/bin" "$HOME/.companion/runtime/sessions" "$HOME/.companion/runtime/state" "$HOME/.companion/runtime/logs" "$HOME/.config/systemd/user"
cat > "$HOME/.companion/bin/pi-daemon" <<'COMPANION_PI_DAEMON'
#!/usr/bin/env bash
set -euo pipefail
root="$HOME/.companion/runtime"
mkdir -p "$root/sessions" "$root/state" "$root/logs"
fifo="$root/state/pi.rpc.in"
rm -f "$fifo"
mkfifo -m 600 "$fifo"
exec 3<>"$fifo"
exec pi --mode rpc --session-dir "$root/sessions" <&3 >>"$root/logs/pi.rpc.ndjson" 2>>"$root/logs/pi.stderr.log"
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
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(30_000),
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

  async #command(boxId: string, command: string): Promise<CommandEnvelope> {
    return this.#request<CommandEnvelope>(`/boxes/${encodeURIComponent(boxId)}/commands`, {
      method: "POST",
      body: JSON.stringify({ command, timeoutSeconds: 60 }),
    });
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

  async start(input: {
    companionId: string;
    orgId: string;
    boxId: string | null;
    credentials: ProviderCredential[];
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
            setupScript: setupScript(this.#installCommand),
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
    await this.#request(`/boxes/${encodeURIComponent(box.id)}/files`, {
      method: "PUT",
      body: JSON.stringify({
        path: ".companion/runtime/state/providers.env",
        content: encodeEnvironmentFile(input.credentials),
      }),
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

