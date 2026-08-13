import { setTimeout as sleep } from "node:timers/promises";
import type {
  CompanionClientSurface,
  CompanionDaemonState,
  CompanionMcpAccount,
  CompanionMcpCredential,
  CompanionRuntimeState,
} from "@companion/contracts";
import { COMPANION_RUNTIME_ERROR_MAX_LENGTH } from "@companion/core";
import {
  buildMcpAdapterInjection,
  runtimeSkillArchivePath,
  type CompanionRuntimeSkill,
} from "./companionPiInjection";

const DEFAULT_BOX_API_BASE = "https://ascii.dev/api/box/v1";
const DEFAULT_PI_MCP_ADAPTER_PACKAGE = "npm:pi-mcp-adapter@2.12.1";
// Layout 5 made the daemon wrapper report its own failures. Layout 6 moves MCP credentials off the
// snapshotted Box disk and into the user runtime directory: systemd can reread them for an automatic
// restart, but Box stop/reboot still destroys them with the tmpfs that held them.
export const COMPANION_PI_DISK_LAYOUT_VERSION = 6;
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
export const COMPANION_PI_EVENT_READ_LIMIT = 262_144;
/**
 * How long a started Pi daemon has to answer `active`. `systemctl --user start` returns once
 * systemd has forked `ExecStart`, and the unit is `Type=simple` with `Restart=on-failure`, so a
 * daemon that is merely slow and one that is crash-looping both answer `activating` for the first
 * seconds. Reading a single probe as the verdict is what turned healthy starts into wake failures.
 */
const PI_DAEMON_ACTIVE_TIMEOUT_MS = 20_000;
/** Labels the diagnostic command prints so each fragment can be recovered from one stdout. */
const PI_DAEMON_DIAGNOSTIC_LABELS = {
  state: "companion-pi-state",
  status: "companion-pi-status",
  restarts: "companion-pi-restarts",
  stderr: "companion-pi-stderr",
  journal: "companion-pi-journal",
} as const;
/** The sentence a failed wait reports, and the room its fragments have left inside the stored line. */
export const PI_DAEMON_FAILURE_MESSAGE = "Pi daemon is not running after start";
/**
 * What each diagnostic fragment may spend, in the order fragments are allowed to claim it.
 * `companions.last_error` keeps one sanitized line of bounded length, so the fragments have to fit
 * it together and a fragment the Box had nothing to say for spends nothing.
 *
 * systemd's own account leads because it is the only account that always exists: `Active:` says
 * whether the unit is starting, dead, or back in the restart queue, the exit status says what Pi
 * died of, and the restart count is what separates a slow first start from a crash loop. Pi's own
 * words come next, and the journal claims whatever is left, because the journal is the only account
 * left for a failure the wrapper could not write down itself.
 */
const PI_DAEMON_DIAGNOSTIC_BUDGETS = [
  { key: "active", prefix: "", limit: 64 },
  { key: "state", prefix: "is-active: ", limit: 16 },
  { key: "exit", prefix: "exit: ", limit: 40 },
  // A count says all of what it has to say in its digits, so unlike the quoted fragments it is worth
  // storing at any length that fits.
  { key: "restarts", prefix: "restarts: ", limit: 4, minimum: 1 },
  { key: "stderr", prefix: "pi.stderr.log: ", limit: 74 },
  { key: "journal", prefix: "journal: ", limit: 74 },
] as const;
/**
 * How recently Pi's stderr log must have been written to be read as this failure's reason. The log
 * outlives the start that wrote it, so an untouched one holds whatever an earlier run left behind:
 * without this window a line from hours ago would be reported as the reason a wake just failed.
 */
const PI_DAEMON_STDERR_FRESH_MINUTES = 2;
/**
 * How large Pi's stderr log may grow before the daemon rolls it aside on its next start. A crash
 * loop restarts every couple of seconds for as long as it goes unnoticed, and the wrapper now writes
 * a line for each of those starts, so the log needs a ceiling that is still far more history than
 * one failure diagnosis reads.
 */
const PI_DAEMON_STDERR_ROLL_KILOBYTES = 1024;
/**
 * How far back the journal is read for this start's reason. systemd keeps the unit's whole history,
 * so without a window the line that explains a wake could be one from a wake hours ago; this is the
 * same reasoning as the stderr log's freshness window.
 */
const PI_DAEMON_JOURNAL_FRESH_MINUTES = 2;
/** A quoted fragment clamped shorter than this says less than the characters it costs. */
const PI_DAEMON_DIAGNOSTIC_MINIMUM = 12;
const PI_DAEMON_DIAGNOSTIC_SEPARATOR = "; ";
type PiDaemonDiagnosticKey = (typeof PI_DAEMON_DIAGNOSTIC_BUDGETS)[number]["key"];
const READY_STATES = new Set<BoxState>(["ready", "idle", "running"]);
const STARTING_STATES = new Set<BoxState>(["init", "provisioning", "provisioned", "cloning"]);
const ARCHIVED_STATES = new Set<BoxState>(["archiving", "archived"]);
/** Printed by the staging command when Pi's auth file already exists on the Box disk. */
const PROVIDER_AUTH_PRESENT_MARKER = "companion-provider-auth-present";
/** Printed only when a warm Box already has everything an automatic Pi restart needs. */
const WARM_DAEMON_READY_MARKER = "companion-pi-warm-ready";

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
    /** Record which Box backs this Companion, or `null` when the recorded one is not its own. */
    onBoxAssigned: (boxId: string | null) => Promise<void>;
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
 * The part of a systemd `Process:` or `Main PID:` line worth storing. The line opens with the full
 * ExecStart path and closes with the exit code, so clamping its head would spend the budget on a
 * path the control plane already knows and drop the status Pi actually died with. A daemon that is
 * merely slow has a live main process and no exit code, and reports nothing here.
 */
function daemonExitDetail(line: string | undefined): string | undefined {
  return line ? /\((code=[^)]*)\)/.exec(line)?.[1] : undefined;
}

/**
 * The part of systemd's `Active:` line worth storing. Its tail is the clock time the unit entered
 * that state, which the control plane already knows from when it asked, so the timestamp is dropped
 * and the room it was spending goes to whatever said why the start failed.
 */
function daemonActiveDetail(line: string | undefined): string | undefined {
  return line?.replace(/\s+since\s+.*$/i, "").trim() || undefined;
}

/**
 * How many times systemd has restarted the unit, and only when it has. A restart count is what tells
 * a Pi that is merely slow to start from one that keeps dying and being brought back, so a zero — or
 * a unit whose count the Box would not report — says nothing worth spending the line on.
 */
function daemonRestartDetail(value: string | undefined): string | undefined {
  const restarts = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(restarts) && restarts > 0 ? String(restarts) : undefined;
}

/**
 * Keep one diagnostic fragment short. The control plane stores a single sanitized line of bounded
 * length, so a status line and a stderr line that both ran long would push each other out of it.
 */
function clampDiagnostic(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Turn one diagnostic stdout into the detail the failure sentence carries. Reading the labels and
 * spending the shared allowance is a decision about text alone, so it stays out of the Box call:
 * the arithmetic has to hold for every combination of present, absent, short, and overlong
 * fragments, and that is a sweep over strings rather than over wakes.
 */
export function composeDaemonFailureDetail(stdout: string): string {
  const lines = (label: string): string[] => labeledDiagnosticLines(stdout, label);
  const status = lines(PI_DAEMON_DIAGNOSTIC_LABELS.status);
  // Both come from the same grep, so each is picked by what it says rather than by where it landed:
  // a unit that prints only one of them must not have it read as the other.
  const active = daemonActiveDetail(status.find((line) => line.startsWith("Active:")));
  const values: Record<PiDaemonDiagnosticKey, string | undefined> = {
    active,
    // `is-active` prints the same word `Active:` opens with, so it is the account for a unit whose
    // status the Box would not print rather than a second copy of one it did.
    state: active ? undefined : lines(PI_DAEMON_DIAGNOSTIC_LABELS.state).at(-1),
    exit: status.map(daemonExitDetail).find(Boolean),
    restarts: daemonRestartDetail(lines(PI_DAEMON_DIAGNOSTIC_LABELS.restarts).at(-1)),
    stderr: lines(PI_DAEMON_DIAGNOSTIC_LABELS.stderr).at(-1),
    journal: lines(PI_DAEMON_DIAGNOSTIC_LABELS.journal).at(-1),
  };
  const fragments: string[] = [];
  let remaining =
    COMPANION_RUNTIME_ERROR_MAX_LENGTH - PI_DAEMON_FAILURE_MESSAGE.length - ": ".length;
  for (const budget of PI_DAEMON_DIAGNOSTIC_BUDGETS) {
    const value = values[budget.key];
    if (!value) continue;
    const separator = fragments.length ? PI_DAEMON_DIAGNOSTIC_SEPARATOR.length : 0;
    const room = Math.min(budget.limit, remaining - separator - budget.prefix.length);
    if (room < ("minimum" in budget ? budget.minimum : PI_DAEMON_DIAGNOSTIC_MINIMUM)) continue;
    const fragment = `${budget.prefix}${clampDiagnostic(value, room)}`;
    fragments.push(fragment);
    remaining -= separator + fragment.length;
  }
  return fragments.length ? `: ${fragments.join(PI_DAEMON_DIAGNOSTIC_SEPARATOR)}` : "";
}

/**
 * The chunk one Pi event read produced, or `null` when what the Box printed carries no resume point.
 * The read opens with the byte offset its bytes start at, so that line is the whole proof a read
 * happened: without it there is nothing to project and nothing to resume from, and with it the
 * remainder is projectable whether the reader ran to the read limit or was cut short.
 */
function parsePiEventChunk(stdout: string): CompanionPiEventChunk | null {
  const separator = stdout.indexOf("\n");
  if (separator < 0) return null;
  const offset = Number.parseInt(stdout.slice(0, separator), 10);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return { chunk: stdout.slice(separator + 1), offset };
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
stderr_log="$root/logs/pi.stderr.log"
mkdir -p "$root/sessions" "$root/state" "$root/logs"
# A crash loop appends one line every couple of seconds for as long as it runs, so the log is rolled
# once instead of growing until the Box disk notices.
if [ -f "$stderr_log" ] && [ -n "$(find "$stderr_log" -size +${PI_DAEMON_STDERR_ROLL_KILOBYTES}k 2>/dev/null)" ]; then
  mv -f "$stderr_log" "$stderr_log.1" 2>/dev/null || true
fi
# Everything this wrapper says from here on lands in the log the control plane reads for the reason a
# start failed. Redirecting only Pi left every failure before the final 'exec' — a directory it could
# not create, a FIFO it could not replace, a Pi binary it could not run — in the journal alone, with
# the log's timestamp untouched, so the wake reported systemd's exit status and no reason.
exec 2>>"$stderr_log"
trap 'companion_status=$?; printf "pi-daemon: line %s: %s failed with status %s\\n" "$LINENO" "$BASH_COMMAND" "$companion_status" >&2' ERR
export PI_CODING_AGENT_DIR="$HOME/.companion/pi"
fifo="$root/state/pi.rpc.in"
rm -f "$fifo"
mkfifo -m 600 "$fifo"
exec 3<>"$fifo"
skill_args=(--no-skills)
if find "$root/skills" -type f -name SKILL.md -print -quit 2>/dev/null | grep -q .; then
  skill_args+=(--skill "$root/skills")
fi
# One line per start, so the log always carries this start's timestamp and the invocation it made:
# a Pi that dies without complaining is then reported as the command it was, not as silence.
printf 'pi-daemon: starting %s %s\\n' "$PI_BIN" "\${skill_args[*]}" >&2
exec "$PI_BIN" --mode rpc --session-dir "$root/sessions" "\${skill_args[@]}" <&3 >>"$root/logs/pi.rpc.ndjson" 2>>"$stderr_log"
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
# The user runtime directory is tmpfs: credentials survive Pi's on-failure restart, but are neither
# snapshotted with the Box disk nor left behind after the Box stops.
EnvironmentFile=-%t/companion/providers.env
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
 * The names THE-330 gave the Boxes a whole workspace shared. They are recognized here so the Box that
 * backed a scope can never become the Box that backs one Companion.
 */
const SHARED_SCOPE_BOX_NAME_PREFIXES = ["Companion org ", "Companion personal "];

function isSharedScopeBoxName(name: string): boolean {
  return SHARED_SCOPE_BOX_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Whether one Box is this Companion's own machine. 1 Companion = 1 Box = 1 Pi, and the deterministic
 * name is the only evidence of that: THE-330 pointed every Companion in a workspace at one shared Box
 * and the restore that undid it copied that shared id onto every Companion row, so an id the control
 * plane recorded can still name a machine that belongs to a scope or to a sibling. Waking it would
 * start one Pi for several Companions.
 *
 * A Box with no name is this Companion's own creation caught between the two writes of the create
 * path, which names a Box only once its id is durable, so it stays adoptable. A shared-scope name is
 * refused whatever id is asked about, because the caller's identifier is not this adapter's to trust.
 */
function isCompanionOwnBox(box: BoxInfo, companionId: string): boolean {
  const name = box.name?.trim() ?? "";
  if (isSharedScopeBoxName(name)) return false;
  return name === "" || name === companionBoxName(companionId);
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

  /**
   * The Box already carrying this Companion's name, if the provider has one. Ownership is decided by
   * the same predicate the recorded id goes through, so neither route can adopt what the other
   * refuses; a Box with no name is not a match here, because a name lookup must not answer with a Box
   * that has yet to be named.
   */
  async #findCompanionBox(companionId: string): Promise<BoxInfo | null> {
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "200", sort: "desc" });
      if (cursor) query.set("cursor", cursor);
      const result = await this.#request<BoxListEnvelope>(`/boxes?${query}`);
      const found = result.boxes.find((candidate) =>
        (candidate.name?.trim() ?? "") !== "" && isCompanionOwnBox(candidate, companionId));
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
   * A current-layout active daemon with its runtime credential file is already fully started.
   * Returning from that state avoids replacing Skills/MCP files underneath an in-flight turn and,
   * most importantly, avoids killing that turn with an unnecessary systemd restart.
   */
  async #warmDaemonReady(boxId: string): Promise<boolean> {
    const result = await this.#command(
      boxId,
      `${USER_BUS_ENVIRONMENT}
if systemctl --user show-environment >/dev/null 2>&1 &&
  systemctl --user is-active --quiet companion-pi-daemon.service &&
  [ -f "$XDG_RUNTIME_DIR/companion/providers.env" ]; then
  printf '%s\\n' ${shellQuote(WARM_DAEMON_READY_MARKER)}
fi`,
    );
    return result.success && result.stdout.split(/[\r\n]+/).includes(WARM_DAEMON_READY_MARKER);
  }

  /**
   * Wait for the started unit to actually be running. A successful `start` only means systemd
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
   * or restarting on failure, and the generic sentence cannot tell those apart, so systemd's verdict,
   * the exit status it recorded, and how many times it has already restarted the unit travel with
   * the failure. Pi's stderr log is read only when it was written during this start, because an
   * untouched log describes an earlier one. The journal is read last and for the same window,
   * because it is the only account of a failure that happened before the daemon wrapper could write
   * anything down — a unit systemd refused to execute, a process the kernel killed, or a restart
   * loop systemd gave up on. Only those systemd records and that log are read: the provider auth
   * file and the transient MCP credential file are never opened, and the control plane redacts and
   * truncates what it stores.
   */
  async #daemonFailureDetail(boxId: string): Promise<string> {
    const result = await this.#command(
      boxId,
      `${USER_BUS_ENVIRONMENT}
# The status fields are matched by name here and read by name again by the caller, so the Box
# reports them in the one language both sides agree on rather than in its own locale.
LC_ALL=C
export LC_ALL
companion_label() { while IFS= read -r line; do printf '%s %s\\n' "$1" "$line"; done; }
systemctl --user is-active companion-pi-daemon.service 2>&1 | tail -n 1 | companion_label ${PI_DAEMON_DIAGNOSTIC_LABELS.state}
systemctl --user status --no-pager --full companion-pi-daemon.service 2>&1 | grep -E '^ *(Active|Process|Main PID):' | head -n 2 | companion_label ${PI_DAEMON_DIAGNOSTIC_LABELS.status}
systemctl --user show --property=NRestarts --value companion-pi-daemon.service 2>/dev/null | tail -n 1 | companion_label ${PI_DAEMON_DIAGNOSTIC_LABELS.restarts}
companion_log="$HOME/.companion/runtime/logs/pi.stderr.log"
if [ -n "$(find "$companion_log" -mmin -${PI_DAEMON_STDERR_FRESH_MINUTES} 2>/dev/null)" ]; then
  tail -n 20 "$companion_log" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 1 | companion_label ${PI_DAEMON_DIAGNOSTIC_LABELS.stderr}
fi
if command -v journalctl >/dev/null 2>&1; then
  # systemd narrates every start and stop of the unit, so those lines are dropped and the last thing
  # left is the last thing that went wrong rather than the last thing that happened.
  journalctl --user --unit companion-pi-daemon.service --since=-${PI_DAEMON_JOURNAL_FRESH_MINUTES}min --no-pager --output=cat --lines=25 2>/dev/null | grep -Ev '^(Started|Starting|Stopping|Stopped|Deactivated|Succeeded|Consumed|Scheduled restart job|[[:space:]]*$)' | tail -n 1 | companion_label ${PI_DAEMON_DIAGNOSTIC_LABELS.journal}
fi
exit 0`,
      30,
    ).catch(() => null);
    return result ? composeDaemonFailureDetail(result.stdout) : "";
  }

  async #removeProviderFile(boxId: string): Promise<void> {
    await this.#command(
      boxId,
      `rm -f "$HOME/.companion/runtime/state/providers.env" \
"/run/user/$(id -u)/companion/providers.env"`,
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
    onBoxAssigned: (boxId: string | null) => Promise<void>;
  }): Promise<CompanionRuntimeObservation> {
    const assigned = input.boxId ? await this.#getAssignedBox(input.boxId) : null;
    // A recorded id that names a machine this Companion does not own is treated as no assignment at
    // all, and the row is cleared so nothing else — a stop, a live status, a thread sync — reaches
    // that machine either. The Box itself is left untouched: it is not this Companion's to rename or
    // archive, and another Companion's row may still be pointing at it.
    let box = assigned && isCompanionOwnBox(assigned, input.companionId) ? assigned : null;
    const keptAssignment = box !== null;
    if (assigned && !keptAssignment) await input.onBoxAssigned(null);
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
        // A Box recovered by name is recorded nowhere until this write lands, so a write that fails
        // would leave it awake with nothing pointing at it. It is put to sleep the ordinary way, which
        // snapshots the disk rather than discarding it, and it still carries the deterministic name, so
        // the next start finds the same disk and resumes it. The Box the control plane already had
        // recorded stays awake and stays recorded.
        if (!keptAssignment) {
          await this.#request(`/boxes/${encodeURIComponent(box.id)}/stop`, {
            method: "POST",
            body: JSON.stringify({ force: false }),
          }).catch(() => undefined);
        }
        throw error;
      }
    }
    box = await this.#waitReady(box.id);
    // `replaceProviderAuth=false` proves the control-plane row already records this layout and the
    // current provider generation. The runtime-file probe supplies the missing volatile half of the
    // proof: a later systemd auto-restart can still inherit this daemon's MCP credentials.
    if (!replaceProviderAuth && await this.#warmDaemonReady(box.id)) {
      return observation(await this.#get(box.id), "running");
    }
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
staged_credential_file="$HOME/.companion/runtime/state/providers.env"
runtime_credential_file="/run/user/$(id -u)/companion/providers.env"
trap 'rm -f "$staged_credential_file" "$runtime_credential_file"' EXIT
chmod 600 "$staged_credential_file"
auth_file="$HOME/.companion/pi/auth.json"
if [ ! -f "$auth_file" ]; then echo 'Companion provider auth file is missing' >&2; exit 1; fi
chmod 700 "$HOME/.companion/pi"
chmod 600 "$auth_file"
${PREPARE_USER_BUS}
runtime_credential_dir="$XDG_RUNTIME_DIR/companion"
runtime_credential_file="$runtime_credential_dir/providers.env"
mkdir -p "$runtime_credential_dir"
chmod 700 "$runtime_credential_dir"
mv -f "$staged_credential_file" "$runtime_credential_file"
chmod 600 "$runtime_credential_file"
# The create setupScript only writes the unit file, so this is the first load of the Pi daemon unit.
systemctl --user daemon-reload
# A unit that crash-looped past systemd's start limit refuses every later start until its failure is
# cleared, so a Companion that once crash-looped would answer the next wake with "Start request
# repeated too quickly" instead of starting Pi — even after whatever broke Pi was fixed. Clearing the
# latched failure first makes this a real start attempt again; a unit with nothing latched is
# unaffected, and a Box that will not clear it still gets its start attempt.
systemctl --user reset-failed companion-pi-daemon.service >/dev/null 2>&1 || true
# systemctl start is deliberately idempotent for an active unit. A first post-upgrade start refreshes
# the tmpfs credential file and unit definition without killing a turn that is already in flight.
systemctl --user start companion-pi-daemon.service
# Keep the tmpfs file while the Box is awake so Restart=on-failure can reread the same credentials.
# Box stop/reboot destroys /run, and the explicit stop path removes it as soon as Pi is down.
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
        `${PI_DAEMON_FAILURE_MESSAGE}${await this.#daemonFailureDetail(box.id)}`,
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
if systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user stop companion-pi-daemon.service >/dev/null 2>&1 || true
  if systemctl --user is-active --quiet companion-pi-daemon.service; then
    echo 'Pi daemon is still active after stop' >&2
    exit 1
  fi
fi
rm -f "/run/user/$(id -u)/companion/providers.env"`,
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

  /**
   * Read the next slice of this Box's Pi event log. A log that is missing, unreadable, of unreadable
   * size, or longer than the read limit is a normal read that returns a chunk and the offset to
   * resume from, because none of those mean the thread is broken. Only a Box that could not run the
   * read at all fails, and that failure carries the exit status and the last line the Box printed.
   */
  async readEvents(input: { boxId: string; offset: number }): Promise<CompanionPiEventChunk> {
    const result = await this.#command(
      input.boxId,
      `set -eu
log="$HOME/.companion/runtime/logs/pi.rpc.ndjson"
offset=${Math.max(0, Math.trunc(input.offset))}
# A Companion that has not spoken yet has no log at all, so an absent log reads as empty from the top.
if [ ! -e "$log" ]; then printf '%s\\n' 0; exit 0; fi
# A log this Box will not size, whether unreadable or not a byte stream at all, is an empty read at
# the offset this sync came in with. Rewinding to 0 would reproject the whole transcript once it can
# be read again, and failing would report a broken thread over a file that is merely unreadable.
# 'wc' still prints a 0 on the way out when it cannot size what it was handed, so its exit status
# decides whether that 0 is the log's length or the reason there isn't one.
if size="$(wc -c < "$log" 2>/dev/null)"; then size="$(printf '%s' "$size" | tr -cd '0-9')"; else size=""; fi
case "$size" in ''|*[!0-9]*) printf '%s\\n' "$offset"; exit 0 ;; esac
# A resumed Box keeps the log, but a rebuilt disk can shrink it; restart from the top instead of
# reading a stale byte range.
if [ "$size" -lt "$offset" ]; then offset=0; fi
printf '%s\\n' "$offset"
# Deliberately no 'pipefail' on this read, and the pipeline's own status is discarded. 'head' closes
# the pipe the moment it has the read limit, so 'tail' dies of SIGPIPE and exits 141; under 'pipefail'
# that failed the whole read and told the operator a healthy thread could not be read as soon as its
# log outgrew one chunk. 'head' then fails the same way on its own stdout when whatever captures this
# command's output stops accepting bytes before the read limit, and under 'set -e' that skipped the
# 'exit 0' below and reported the chunk's last event line as the reason the log could not be read. A
# reader that stops partway has still produced bytes and the offset they start at, so the read is
# capped rather than broken and the rest is read by the next sync.
tail -c "+$((offset + 1))" "$log" 2>/dev/null | head -c ${COMPANION_PI_EVENT_READ_LIMIT} || true
exit 0`,
      30,
    );
    const read = parsePiEventChunk(result.stdout);
    // A read that printed the offset its bytes start at produced a chunk, whatever status came back
    // with it: the reader can stop partway when the transport capturing this command's output caps it
    // below the read limit, and those bytes plus that offset are exactly what the next sync resumes
    // from. Only output with no resume point in it means the Box never ran the read, and only then is
    // the sync a failure that names the exit status and the last line the Box printed.
    if (read) return read;
    if (!result.success) {
      throw new BoxRuntimeProviderError(
        `Pi event log could not be read from Box${commandFailureDetail(result)}`,
        502,
      );
    }
    return { chunk: "", offset: input.offset };
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

