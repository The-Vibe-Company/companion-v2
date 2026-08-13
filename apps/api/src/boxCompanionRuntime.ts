import { setTimeout as sleep } from "node:timers/promises";
import type {
  CompanionClientSurface,
  CompanionDaemonState,
  CompanionMcpAccount,
  CompanionMcpCredential,
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
/** Content bytes the provider's file API refuses in one `PUT /boxes/:id/files` body. */
const BOX_FILE_WRITE_LIMIT_BYTES = 5 * 1024 * 1024;
/**
 * Payload bytes per part of an oversized file. Each part travels base64-encoded, so the request
 * body is a third larger than this and still a megabyte clear of the provider's limit.
 */
const BOX_FILE_PART_BYTES = 3 * 1024 * 1024;
/** A multi-megabyte part takes longer to upload than the short control calls share a budget with. */
const BOX_FILE_PART_TIMEOUT_MS = 120_000;
/** Bytes of Pi RPC output one control-plane sync may pull; the rest is read by the next sync. */
const COMPANION_PI_EVENT_READ_LIMIT = 262_144;
/**
 * How long a restarted Pi daemon has to answer `active`. `systemctl --user restart` returns once
 * systemd has forked `ExecStart`, and the unit is `Type=simple` with `Restart=on-failure`, so a
 * daemon that is merely slow and one that is crash-looping both answer `activating` for the first
 * seconds. Reading a single probe as the verdict is what turned healthy starts into wake failures.
 */
const PI_DAEMON_ACTIVE_TIMEOUT_MS = 20_000;
/** Labels the diagnostic command prints so each fragment can be recovered from one stdout. */
const PI_DAEMON_DIAGNOSTIC_LABELS = {
  state: "companion-pi-state",
  status: "companion-pi-status",
  stderr: "companion-pi-stderr",
} as const;
/**
 * Characters each diagnostic fragment may spend. `companions.last_error` keeps one sanitized line
 * of bounded length, so the three fragments and their labels have to fit it together: a status line
 * long enough on its own would push out the Pi stderr line the diagnostic exists to surface.
 */
const PI_DAEMON_DIAGNOSTIC_BUDGETS = { state: 16, status: 82, stderr: 74 } as const;
const READY_STATES = new Set<BoxState>(["ready", "idle", "running"]);
const STARTING_STATES = new Set<BoxState>(["init", "provisioning", "provisioned", "cloning"]);
const ARCHIVED_STATES = new Set<BoxState>(["archiving", "archived"]);
/** Printed by the staging command when Pi's auth file already exists on the Box disk. */
const PROVIDER_AUTH_PRESENT_MARKER = "companion-provider-auth-present";

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

/** Transient environment value inherited by Pi for one labeled MCP account. */
export type McpRuntimeCredential = CompanionMcpCredential;

export interface CompanionRuntimeObservation {
  boxId: string;
  runtimeState: CompanionRuntimeState;
  daemonState: CompanionDaemonState;
  desktopAvailable: boolean;
}

/** A byte range of the Pi RPC log; `offset` is where the next read must resume. */
export interface CompanionPiEventChunk {
  chunk: string;
  offset: number;
}

export interface CompanionBoxRuntime {
  start(input: {
    companionId: string;
    orgId: string;
    boxId: string | null;
    clientSurface: CompanionClientSurface;
    providerAuth: Record<string, Record<string, unknown>>;
    replaceProviderAuth: boolean;
    mcpCredentials: McpRuntimeCredential[];
    mcpAccounts: CompanionMcpAccount[];
    skills: CompanionRuntimeSkill[];
    onBoxAssigned: (boxId: string) => Promise<void>;
  }): Promise<CompanionRuntimeObservation>;
  stop(input: { boxId: string }): Promise<CompanionRuntimeObservation>;
  status(input: { boxId: string }): Promise<CompanionRuntimeObservation>;
  desktop(input: { boxId: string }): Promise<{ url: string | null; provisioning: boolean }>;
  /** Hand one chat message to the already running Pi daemon; never creates or resumes a Box. */
  prompt(input: { boxId: string; message: string; requestId: string }): Promise<void>;
  /** Read Pi RPC output from `offset` so the control plane can project new events. */
  readEvents(input: { boxId: string; offset: number }): Promise<CompanionPiEventChunk>;
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

/**
 * Keep one Box command failure readable as a single stored line. The control plane sanitizes and
 * truncates whatever it records, so the useful part is the last thing the shell complained about
 * rather than the transcript, which is the difference between "Pi runtime layout failed to install"
 * and a message that names the failing line.
 */
function commandFailureDetail(result: CommandEnvelope): string {
  const lastLine = (text: string | undefined): string | undefined =>
    (text ?? "").split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean).at(-1);
  const output = lastLine(result.stderr) ?? lastLine(result.stdout);
  const exit = result.exitCode === null ? "" : ` (exit ${result.exitCode})`;
  return output ? `${exit}: ${output}` : exit;
}

/**
 * Recover the lines the diagnostic command tagged with one label. Each fragment is emitted on its
 * own line so a status line and a Pi stderr line can be told apart without parsing systemctl's
 * layout, and anything the Box printed unlabeled is discarded rather than guessed at.
 */
function labeledDiagnosticLines(stdout: string, label: string): string[] {
  return stdout
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${label} `))
    .map((line) => line.slice(label.length + 1).trim())
    .filter(Boolean);
}

/**
 * Keep one diagnostic fragment short. The control plane stores a single sanitized line of bounded
 * length, so a status line and a stderr line that both ran long would push each other out of it.
 */
function clampDiagnostic(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

/** Where the layout script is staged on the Box disk so it runs as a file, never as a command. */
const PI_LAYOUT_SCRIPT_PATH = ".companion/bin/ensure-pi-layout.sh";

function setupScript(installCommand: string | undefined, mcpAdapterPackage: string): string {
  const install = installCommand?.trim()
    ? installCommand
    : "echo 'Pi is not installed; configure COMPANION_PI_INSTALL_COMMAND or preinstall pi in the Box image' >&2; exit 1";
  return `#!/usr/bin/env bash
set -euo pipefail
# An already-laid-out disk short-circuits before anything else, so repairing the layout on a Box that
# is already correct costs one file read and cannot fail on a dependency it does not need.
layout_marker="$HOME/.companion/runtime/state/pi-layout.version"
expected_layout=${shellQuote(`${COMPANION_PI_DISK_LAYOUT_VERSION}:${mcpAdapterPackage}`)}
if [ -f "$layout_marker" ] && [ "$(cat "$layout_marker")" = "$expected_layout" ]; then
  exit 0
fi
if ! command -v pi >/dev/null 2>&1; then
  ${install}
fi
command -v pi >/dev/null 2>&1
mkdir -p "$HOME/.companion/bin" "$HOME/.companion/pi" "$HOME/.companion/runtime/sessions" "$HOME/.companion/runtime/state" "$HOME/.companion/runtime/logs" "$HOME/.config/systemd/user"
# Resolve Pi's absolute path now so the daemon does not depend on a login-shell PATH it will never
# have under the minimal systemd user manager environment.
pi_bin="$(command -v pi)"
pi_bin_dir="$(dirname "$pi_bin")"
PI_CODING_AGENT_DIR="$HOME/.companion/pi" "$pi_bin" install ${shellQuote(mcpAdapterPackage)}
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf 'PI_BIN=%q\n' "$pi_bin"
  printf 'PATH=%q:"$PATH"\n' "$pi_bin_dir"
  printf '%s\n' 'export PATH'
  cat <<'COMPANION_PI_DAEMON'
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
exec "$PI_BIN" --mode rpc --session-dir "$root/sessions" "\${skill_args[@]}" <&3 >>"$root/logs/pi.rpc.ndjson" 2>>"$root/logs/pi.stderr.log"
COMPANION_PI_DAEMON
} > "$HOME/.companion/bin/pi-daemon"
chmod 700 "$HOME/.companion/bin/pi-daemon"
{
  cat <<'COMPANION_PI_SERVICE_HEAD'
[Unit]
Description=Companion Pi daemon
After=network-online.target

[Service]
Type=simple
COMPANION_PI_SERVICE_HEAD
  # Pin the systemd user unit's PATH to the resolved Pi bin directory so the daemon starts without a
  # login-shell PATH, matching the absolute path baked into the wrapper above.
  printf 'Environment=PATH=%s:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n' "$pi_bin_dir"
  cat <<'COMPANION_PI_SERVICE_TAIL'
ExecStart=%h/.companion/bin/pi-daemon
EnvironmentFile=-%h/.companion/runtime/state/providers.env
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
COMPANION_PI_SERVICE_TAIL
} > "$HOME/.config/systemd/user/companion-pi-daemon.service"
# A Box running its create setupScript has no user D-Bus session yet, so no user-manager command
# belongs here: it would fail with "Failed to connect to bus" and mark the whole setup failed even
# though Pi installed correctly. The unit is loaded by the post-ready control-plane command instead.
printf '%s\n' "$expected_layout" > "$layout_marker"
`;
}

/**
 * Point `systemctl --user` at the caller's bus. Every Box command runs in its own shell, so any
 * command that talks to the user manager has to locate the bus again.
 */
const USER_BUS_ENVIRONMENT = `companion_export_user_bus() {
  companion_user_runtime_dir="/run/user/$(id -u)"
  if [ -d "$companion_user_runtime_dir" ]; then
    export XDG_RUNTIME_DIR="$companion_user_runtime_dir"
    if [ -S "$XDG_RUNTIME_DIR/bus" ]; then
      export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
    else
      unset DBUS_SESSION_BUS_ADDRESS
    fi
  fi
}
companion_export_user_bus`;

/**
 * Bring up the systemd user manager the Pi unit needs. A Box that never had an interactive login has
 * no `/run/user/<uid>` and no user bus, which is exactly what breaks `systemctl --user` at create
 * time, so the daemon start enables lingering for the account and waits for the manager to answer.
 */
const PREPARE_USER_BUS = `${USER_BUS_ENVIRONMENT}
companion_uid="$(id -u)"
if ! systemctl --user show-environment >/dev/null 2>&1; then
  if command -v loginctl >/dev/null 2>&1; then
    if [ "$companion_uid" = 0 ]; then
      loginctl enable-linger "$companion_uid" >/dev/null 2>&1 || true
    elif command -v sudo >/dev/null 2>&1; then
      sudo -n loginctl enable-linger "$companion_uid" >/dev/null 2>&1 || true
    fi
  fi
  if [ "$companion_uid" = 0 ]; then
    systemctl start "user@$companion_uid.service" >/dev/null 2>&1 || true
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n systemctl start "user@$companion_uid.service" >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 20); do
    companion_export_user_bus
    if systemctl --user show-environment >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi
companion_export_user_bus
if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo 'Companion cannot reach the systemd user bus on this Box' >&2
  exit 1
fi`;

function encodeEnvironmentFile(credentials: McpRuntimeCredential[]): string {
  return credentials
    .map(({ env_key: envKey, value }) => `${envKey}=${JSON.stringify(value)}`)
    .join("\n")
    .concat(credentials.length ? "\n" : "");
}

function companionBoxName(companionId: string): string {
  return `Companion ${companionId}`;
}

/**
 * Box setup runs once per disk, so a Box whose Pi setup failed can never run Pi, and neither can one
 * in the terminal error state. Waking such a Box again only repeats the same failure, so the
 * Companion has to be moved onto a new Box instead.
 */
function isBeyondRecovery(box: BoxInfo): boolean {
  return box.state === "error" || box.setupStatus === "failed";
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
  readonly #daemonActiveTimeoutMs: number;
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
    this.#daemonActiveTimeoutMs = positiveInteger(
      env.COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS,
      PI_DAEMON_ACTIVE_TIMEOUT_MS,
    );
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

  /** A Box the provider no longer knows about is reported as missing so the start can replace it. */
  async #getAssignedBox(boxId: string): Promise<BoxInfo | null> {
    try {
      return await this.#get(boxId);
    } catch (error) {
      if (error instanceof BoxRuntimeProviderError && error.status === 404) return null;
      throw error;
    }
  }

  async #findCompanionBox(companionId: string): Promise<BoxInfo | null> {
    const name = companionBoxName(companionId);
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

  /**
   * Create the Box for one Companion and persist its id before the configured TTL and deterministic
   * name are applied, so a crash between the two can only leak a short-lived, unnamed Box.
   */
  async #createCompanionBox(input: {
    companionId: string;
    orgId: string;
    onBoxAssigned: (boxId: string) => Promise<void>;
  }): Promise<BoxInfo> {
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
    try {
      await input.onBoxAssigned(created.box.id);
      return (await this.#request<BoxEnvelope>(
        `/boxes/${encodeURIComponent(created.box.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: companionBoxName(input.companionId),
            ttlSeconds: this.#ttlSeconds,
          }),
        },
      )).box;
    } catch (error) {
      await this.#request(`/boxes/${encodeURIComponent(created.box.id)}/stop`, {
        method: "POST",
        body: JSON.stringify({ force: false }),
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Release a Box that can never run Pi again. Renaming it first frees the deterministic Companion
   * name so the replacement Box owns it and no later start re-adopts the broken disk. Both calls are
   * best-effort: a Box the provider will not rename or stop must not keep the Companion un-wakeable.
   */
  async #retireBox(box: BoxInfo, companionId: string): Promise<void> {
    await this.#request(`/boxes/${encodeURIComponent(box.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: `Retired ${companionBoxName(companionId)} ${Date.now()}` }),
    }).catch(() => undefined);
    if (!ARCHIVED_STATES.has(box.state)) {
      await this.#request(`/boxes/${encodeURIComponent(box.id)}/stop`, {
        method: "POST",
        // The disk is unusable, so it is discarded instead of snapshotted for a later resume.
        body: JSON.stringify({ force: true }),
      }).catch(() => undefined);
    }
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
      `${USER_BUS_ENVIRONMENT}
systemctl --user is-active companion-pi-daemon.service 2>/dev/null || true`,
    );
    return result.stdout.trim() === "active" ? "running" : "stopped";
  }

  /**
   * Wait for the restarted unit to actually be running. A successful `restart` only means systemd
   * accepted the job, so the daemon is given the whole window to reach `active` and the wait ends
   * on the first probe that says it did.
   */
  async #waitDaemonActive(boxId: string): Promise<CompanionDaemonState> {
    const deadline = Date.now() + this.#daemonActiveTimeoutMs;
    let daemonState = await this.#daemonState(boxId);
    while (daemonState !== "running" && Date.now() < deadline) {
      await sleep(this.#pollIntervalMs);
      daemonState = await this.#daemonState(boxId);
    }
    return daemonState;
  }

  /**
   * Say why Pi is not running. A daemon that never reached `active` is either still starting, dead,
   * or restarting on failure, and the generic sentence cannot tell those apart, so the unit's own
   * verdict and the last line Pi wrote to its stderr log travel with the failure. Only systemd's
   * summary lines and that log are read: the provider auth file and the transient MCP credential
   * file are never opened, and the control plane redacts and truncates whatever is stored anyway.
   */
  async #daemonFailureDetail(boxId: string): Promise<string> {
    const result = await this.#command(
      boxId,
      `${USER_BUS_ENVIRONMENT}
companion_label() { while IFS= read -r line; do printf '%s %s\\n' "$1" "$line"; done; }
systemctl --user is-active companion-pi-daemon.service 2>&1 | tail -n 1 | companion_label ${PI_DAEMON_DIAGNOSTIC_LABELS.state}
systemctl --user status --no-pager --full companion-pi-daemon.service 2>&1 | grep -E '^ *(Active|Process|Main PID):' | head -n 2 | companion_label ${PI_DAEMON_DIAGNOSTIC_LABELS.status}
tail -n 20 "$HOME/.companion/runtime/logs/pi.stderr.log" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 1 | companion_label ${PI_DAEMON_DIAGNOSTIC_LABELS.stderr}
exit 0`,
      30,
    ).catch(() => null);
    if (!result) return "";
    const lines = (label: string): string[] => labeledDiagnosticLines(result.stdout, label);
    const fragments: string[] = [];
    const state = lines(PI_DAEMON_DIAGNOSTIC_LABELS.state).at(-1);
    // `Active:` is systemd's own verdict and is printed before the process detail, so it leads.
    const status = lines(PI_DAEMON_DIAGNOSTIC_LABELS.status).at(0);
    const stderr = lines(PI_DAEMON_DIAGNOSTIC_LABELS.stderr).at(-1);
    if (state) fragments.push(`is-active: ${clampDiagnostic(state, PI_DAEMON_DIAGNOSTIC_BUDGETS.state)}`);
    if (status) fragments.push(clampDiagnostic(status, PI_DAEMON_DIAGNOSTIC_BUDGETS.status));
    if (stderr) {
      fragments.push(`pi.stderr.log: ${clampDiagnostic(stderr, PI_DAEMON_DIAGNOSTIC_BUDGETS.stderr)}`);
    }
    return fragments.length ? `: ${fragments.join("; ")}` : "";
  }

  async #removeProviderFile(boxId: string): Promise<void> {
    await this.#command(
      boxId,
      "rm -f \"$HOME/.companion/runtime/state/providers.env\"",
    );
  }

  /**
   * One `PUT /boxes/:id/files` request. The provider names the byte limit it enforced but not the
   * file it rejected, so the path travels with the failure: `last_error` has to say which payload
   * overflowed, not only that something did.
   */
  async #putFile(
    boxId: string,
    path: string,
    content: string,
    options?: { encoding?: "base64"; timeoutMs?: number },
  ): Promise<void> {
    try {
      await this.#request(
        `/boxes/${encodeURIComponent(boxId)}/files`,
        {
          method: "PUT",
          body: JSON.stringify({
            path,
            content,
            ...(options?.encoding ? { encoding: options.encoding } : {}),
          }),
        },
        options?.timeoutMs,
      );
    } catch (error) {
      if (error instanceof BoxRuntimeProviderError) {
        throw new BoxRuntimeProviderError(
          `Box rejected the write of ${path}: ${error.message}`,
          error.status,
          error.code,
        );
      }
      throw error;
    }
  }

  /**
   * Land one file on the Box disk whatever its size. The file API takes the whole body in a single
   * JSON request, rejects content over `BOX_FILE_WRITE_LIMIT_BYTES`, and offers no append,
   * multipart, or streaming write, so a base64 skill archive of a few megabytes cannot be written
   * at all in one call. An oversized payload therefore lands as numbered parts that one short
   * command concatenates back into place. The payload itself never travels as a command string:
   * that transport already proved it mangles bodies far smaller than an archive.
   */
  async #writeFile(boxId: string, path: string, content: string): Promise<void> {
    const payload = Buffer.from(content, "utf8");
    if (payload.byteLength < BOX_FILE_WRITE_LIMIT_BYTES) {
      await this.#putFile(boxId, path, content);
      return;
    }
    const parts: string[] = [];
    for (let offset = 0; offset < payload.byteLength; offset += BOX_FILE_PART_BYTES) {
      const part = `${path}.part${parts.length}`;
      // Parts are split on byte boundaries and sent base64, so a payload that is not plain ASCII
      // cannot lose a multi-byte character to the split.
      await this.#putFile(
        boxId,
        part,
        payload.subarray(offset, offset + BOX_FILE_PART_BYTES).toString("base64"),
        { encoding: "base64", timeoutMs: BOX_FILE_PART_TIMEOUT_MS },
      );
      parts.push(part);
    }
    const quoted = parts.map(shellQuote).join(" ");
    const joined = await this.#command(
      boxId,
      `set -e; cd "$HOME"; cat ${quoted} > ${shellQuote(path)}; rm -f ${quoted}`,
      120,
    );
    if (!joined.success) {
      throw new BoxRuntimeProviderError(
        `Box could not join the ${parts.length} staged parts of ${path}`
        + commandFailureDetail(joined),
        502,
      );
    }
  }

  /**
   * Repair the Pi layout on a Box that already exists.
   *
   * The identical script installs Pi correctly as the create `setupScript`, which the provider runs
   * as a file with its shebang, and fails when it is sent as a command string instead: the payload
   * carries heredocs, nested single and double quotes, and several kilobytes, none of which survive
   * the command transport intact. So this stages the script through the file API the same way the
   * create path gets it, and the command it does send is one short, quote-light line.
   */
  async #ensurePiLayout(boxId: string): Promise<void> {
    const prepared = await this.#command(boxId, 'mkdir -p "$HOME/.companion/bin"');
    if (!prepared.success) {
      throw new BoxRuntimeProviderError(
        `Pi runtime layout failed to install${commandFailureDetail(prepared)}`,
        502,
      );
    }
    await this.#writeFile(
      boxId,
      PI_LAYOUT_SCRIPT_PATH,
      setupScript(this.#installCommand, this.#mcpAdapterPackage),
    );
    const result = await this.#command(boxId, `bash "$HOME/${PI_LAYOUT_SCRIPT_PATH}"`, 180);
    if (!result.success) {
      // The bare message cost a production probe to diagnose, so the failing line travels with it.
      throw new BoxRuntimeProviderError(
        `Pi runtime layout failed to install${commandFailureDetail(result)}`,
        502,
      );
    }
  }

  async #injectPiResources(input: {
    boxId: string;
    clientSurface: CompanionClientSurface;
    providerAuth: Record<string, Record<string, unknown>>;
    replaceProviderAuth: boolean;
    mcpCredentials: McpRuntimeCredential[];
    mcpAccounts: CompanionMcpAccount[];
    skills: CompanionRuntimeSkill[];
  }): Promise<void> {
    const injectedSkills = input.clientSurface === "native_mobile" ? [] : input.skills;
    const mcp = buildMcpAdapterInjection(input.mcpAccounts);
    const cleared = await this.#command(
      input.boxId,
      `set -e; root="$HOME/.companion/runtime"; rm -rf "$root/state/skill-archives"; mkdir -p "$root/state/skill-archives"; if [ -f "$HOME/.companion/pi/auth.json" ]; then printf '%s\\n' ${shellQuote(PROVIDER_AUTH_PRESENT_MARKER)}; fi`,
    );
    if (!cleared.success) throw new BoxRuntimeProviderError("Pi resource staging failed", 502);
    // Pi keeps refreshed subscription tokens in its own agent directory, so the auth file is
    // replaced only when the encrypted workspace connection generation changes. The disk itself is
    // the authority on whether the file exists: a Box the control plane recorded at the current
    // generation can still be a replacement disk that never received it, for example when an earlier
    // start failed after the new Box id was persisted.
    if (input.replaceProviderAuth || !cleared.stdout.includes(PROVIDER_AUTH_PRESENT_MARKER)) {
      await this.#writeFile(
        input.boxId,
        ".companion/pi/auth.json",
        `${JSON.stringify(input.providerAuth)}\n`,
      );
    }
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
        encodeEnvironmentFile(input.mcpCredentials),
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
    providerAuth: Record<string, Record<string, unknown>>;
    replaceProviderAuth: boolean;
    mcpCredentials: McpRuntimeCredential[];
    mcpAccounts: CompanionMcpAccount[];
    skills: CompanionRuntimeSkill[];
    onBoxAssigned: (boxId: string) => Promise<void>;
  }): Promise<CompanionRuntimeObservation> {
    let box = input.boxId ? await this.#getAssignedBox(input.boxId) : null;
    if (!box) box = await this.#findCompanionBox(input.companionId);
    if (box && isBeyondRecovery(box)) {
      // The assigned Box failed setup or died, so the Companion moves onto a new Box instead of
      // failing every future wake against the same broken disk.
      await this.#retireBox(box, input.companionId);
      box = null;
    }
    let boxIdPersisted = false;
    let replaceProviderAuth = input.replaceProviderAuth;
    if (!box) {
      box = await this.#createCompanionBox(input);
      boxIdPersisted = true;
      // Pi's auth file lives on the Box disk, so a new disk needs it written whatever generation the
      // control plane recorded for the Box this start replaced.
      replaceProviderAuth = true;
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
      providerAuth: input.providerAuth,
      replaceProviderAuth,
      mcpCredentials: input.mcpCredentials,
      mcpAccounts: input.mcpAccounts,
      skills: input.skills,
    });
    let started: CommandEnvelope;
    try {
      started = await this.#command(
        box.id,
        `set -e
credential_file="$HOME/.companion/runtime/state/providers.env"
trap 'rm -f "$credential_file"' EXIT
chmod 600 "$credential_file"
auth_file="$HOME/.companion/pi/auth.json"
if [ ! -f "$auth_file" ]; then echo 'Companion provider auth file is missing' >&2; exit 1; fi
chmod 700 "$HOME/.companion/pi"
chmod 600 "$auth_file"
${PREPARE_USER_BUS}
# The create setupScript only writes the unit file, so this is the first load of the Pi daemon unit.
systemctl --user daemon-reload
systemctl --user restart companion-pi-daemon.service
# restart waits until systemd has read EnvironmentFile; remove transient MCP credentials immediately after.
rm -f "$credential_file"
trap - EXIT`,
        120,
      );
    } catch (error) {
      await this.#removeProviderFile(box.id).catch(() => undefined);
      throw error;
    }
    if (!started.success) {
      await this.#removeProviderFile(box.id).catch(() => undefined);
      throw new BoxRuntimeProviderError(
        `Pi daemon failed to start${commandFailureDetail(started)}`,
        502,
      );
    }
    const daemonState = await this.#waitDaemonActive(box.id);
    if (daemonState !== "running") {
      throw new BoxRuntimeProviderError(
        `Pi daemon is not running after start${await this.#daemonFailureDetail(box.id)}`,
        502,
      );
    }
    return observation(await this.#get(box.id), daemonState);
  }

  async stop(input: { boxId: string }): Promise<CompanionRuntimeObservation> {
    let box = await this.#get(input.boxId);
    if (READY_STATES.has(box.state)) {
      const stopped = await this.#command(
        input.boxId,
        // The unit is loaded by the first start, so a Box that never started Pi has nothing to stop.
        // Only a daemon still active after the stop attempt is a failure worth reporting.
        `${USER_BUS_ENVIRONMENT}
if ! systemctl --user show-environment >/dev/null 2>&1; then exit 0; fi
systemctl --user stop companion-pi-daemon.service >/dev/null 2>&1 || true
if systemctl --user is-active --quiet companion-pi-daemon.service; then
  echo 'Pi daemon is still active after stop' >&2
  exit 1
fi`,
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

  async prompt(input: { boxId: string; message: string; requestId: string }): Promise<void> {
    const command = JSON.stringify({
      id: input.requestId,
      type: "prompt",
      message: input.message,
      streamingBehavior: "followUp",
    });
    const result = await this.#command(
      input.boxId,
      `set -euo pipefail
${USER_BUS_ENVIRONMENT}
fifo="$HOME/.companion/runtime/state/pi.rpc.in"
systemctl --user is-active --quiet companion-pi-daemon.service
test -p "$fifo"
printf '%s\\n' ${shellQuote(command)} > "$fifo"`,
      20,
    );
    if (!result.success) {
      throw new BoxRuntimeProviderError("Pi did not accept the message; wake the Companion and retry", 409);
    }
  }

  async readEvents(input: { boxId: string; offset: number }): Promise<CompanionPiEventChunk> {
    const result = await this.#command(
      input.boxId,
      `set -euo pipefail
log="$HOME/.companion/runtime/logs/pi.rpc.ndjson"
offset=${Math.max(0, Math.trunc(input.offset))}
if [ ! -f "$log" ]; then printf '%s\\n' 0; exit 0; fi
size="$(wc -c < "$log")"
# A resumed Box keeps the log, but a rebuilt disk can shrink it; restart from the top instead of
# reading a stale byte range.
if [ "$size" -lt "$offset" ]; then offset=0; fi
printf '%s\\n' "$offset"
tail -c "+$((offset + 1))" "$log" | head -c ${COMPANION_PI_EVENT_READ_LIMIT}`,
      30,
    );
    if (!result.success) {
      throw new BoxRuntimeProviderError("Pi event log could not be read from Box", 502);
    }
    const separator = result.stdout.indexOf("\n");
    if (separator < 0) return { chunk: "", offset: input.offset };
    const parsedOffset = Number.parseInt(result.stdout.slice(0, separator), 10);
    return {
      chunk: result.stdout.slice(separator + 1),
      offset: Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
    };
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

