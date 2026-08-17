import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  CompanionClientSurface,
  CompanionDaemonState,
  CompanionDesktopTransport,
  CompanionMcpAccount,
  CompanionMcpCredential,
  CompanionRuntimeState,
} from "@companion/contracts";
import { COMPANION_RUNTIME_ERROR_MAX_LENGTH } from "@companion/core";
import {
  COMPANION_PERMISSION_BROKER_EXTENSION_FILE,
  COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE,
} from "./companionPermissionBroker";
import {
  buildMcpAdapterInjection,
  runtimeSkillArchivePath,
  type CompanionRuntimeSkill,
} from "./companionPiInjection";
import {
  COMPANION_PI_BROKER_JOURNAL_PATH,
  COMPANION_PI_BROKER_SCRIPT_PATH,
  COMPANION_PI_BROKER_SOCKET_PATH,
  COMPANION_PI_BROKER_SOURCE,
  type CompanionPiBrokerCounters,
  type CompanionPiJournalRecord,
} from "./companionPiBroker";

const DEFAULT_BOX_API_BASE = "https://ascii.dev/api/box/v1";
const DEFAULT_PI_MCP_ADAPTER_PACKAGE = "npm:pi-mcp-adapter@2.12.1";
/** First Pi release whose image resize runs outside the RPC event loop. */
const MINIMUM_IMAGE_SAFE_PI_VERSION = "0.84.2";
const MAX_COMPANION_RUNTIME_GENERATION = 2_147_483_647;
// Layout 5 made the daemon wrapper report its own failures. Layout 6 moves MCP credentials off the
// snapshotted Box disk and into the user runtime directory. Layout 7 teaches the daemon wrapper to
// append staged Companion instructions. Layout 8 passes the persisted model through `pi --model`.
// Layout 9 staged the permission broker for shell, file, and question cards. Layout 10 overwrites
// that legacy filename with the ask_user-only extension so shell and file tools run unrestricted.
// Layout 11 bounded every non-interactive execution tool and temporarily refused image reads while
// Pi image decoding could block the event loop. Layout 12 gave shell runs a longer deadline. Layout
// 13 restores image reads only after verifying Pi includes worker-isolated resizing, and binds RPC
// readiness to the current systemd invocation; the same 90-second guard aborts a read that does not
// settle. Layout 14 replaces the shell-held FIFO with the supervised Node broker, an owner-only Unix
// socket, and a segmented acknowledgement journal.
export const COMPANION_PI_DISK_LAYOUT_VERSION = 14;
/** Content bytes the provider's file API refuses in one `PUT /boxes/:id/files` body. */
const BOX_FILE_WRITE_LIMIT_BYTES = 5 * 1024 * 1024;
/**
 * Payload bytes per part of an oversized file. Each part travels base64-encoded, so the request
 * body is a third larger than this and still a megabyte clear of the provider's limit.
 */
const BOX_FILE_PART_BYTES = 3 * 1024 * 1024;
/** A multi-megabyte part takes longer to upload than the short control calls share a budget with. */
const BOX_FILE_PART_TIMEOUT_MS = 120_000;
/**
 * How long a started Pi daemon has to answer `active`. `systemctl --user start` returns once
 * systemd has forked `ExecStart`, and the unit is `Type=simple` with `Restart=on-failure`, so a
 * daemon that is merely slow and one that is crash-looping both answer `activating` for the first
 * seconds. Reading a single probe as the verdict is what turned healthy starts into wake failures.
 */
const PI_DAEMON_ACTIVE_TIMEOUT_MS = 20_000;
/**
 * Pi acknowledges an RPC command as soon as it accepts it. The layout-14 broker forwards that
 * correlated response over its owner-only socket, so a completed Box command proves an application
 * response rather than merely a successful transport write.
 */
const PI_RPC_ACCEPT_TIMEOUT_SECONDS = 8;
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
/** Printed by the probe that proves an explicitly resumed Box is running commands for staging. */
const BOX_RUNNABLE_MARKER = "companion-box-runnable";
/** Printed by the staging command when Pi's auth file already exists on the Box disk. */
const PROVIDER_AUTH_PRESENT_MARKER = "companion-provider-auth-present";
/** Where staged skill archives wait on the Box disk between the file writes and the extract. */
const STAGED_ARCHIVE_DIRECTORY = ".companion/runtime/state/skill-archives";
/** Labels each staged archive's size so one stdout can be read back as a measurement. */
const STAGED_ARCHIVE_SIZE_LABEL = "companion-archive-bytes";
/** How long a start will wait to be told what the Box kept before it gives up asking. */
const STAGED_ARCHIVE_MEASURE_TIMEOUT_SECONDS = 10;
/**
 * How long one desktop mint may spend waiting for Box to finish bringing up the VNC stream of a Box
 * that is already running. The whole budget belongs to VNC: the WebRTC fallback is what a mint
 * settles for once this has run out, never what it takes because it answered sooner. A person is
 * watching a panel for the screen to appear, so the budget is short enough that a stream which is
 * not coming is reported instead of held: the surface says the desktop is still starting and the
 * next join tries again.
 */
const BOX_DESKTOP_MINT_BUDGET_MS = 15_000;
/**
 * Box answers a mint asks again about, rather than answers that say this build has no VNC to give.
 * A desktop the provider is busy with, a request it timed out on, and one it rate-limited are all
 * states the next poll can find resolved; every other refusal of `?vnc=1` is about the flag itself
 * and is the same on every poll, so it is read as the fallback's cue instead of spending the budget.
 */
const VNC_RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);


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

interface CommandEnvelope {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface DesktopEnvelope {
  desktopUrl?: string | null;
  /** Older Box builds name the same field `url`; a mint reads whichever one carries the stream. */
  url?: string | null;
  provisioning?: boolean;
}

/**
 * One freshly minted Box desktop, and which stream carried it. `url` is null only when Box has no
 * stream to give yet, and `provisioning` then says whether it is still bringing one up.
 */
export interface CompanionDesktopMint {
  url: string | null;
  provisioning: boolean;
  transport: CompanionDesktopTransport | null;
}

/** Transient environment value inherited by Pi for one labeled MCP account. */
export type McpRuntimeCredential = CompanionMcpCredential;

export interface CompanionRuntimeObservation {
  boxId: string;
  runtimeState: CompanionRuntimeState;
  daemonState: CompanionDaemonState;
  desktopAvailable: boolean;
}

/** Durable broker cursors and bounded protocol telemetry, observed without sending a command to Pi. */
export interface CompanionPiBrokerState {
  invocationId: string;
  activeAttemptId: string | null;
  tailCursor: number;
  acknowledgedCursor: number;
  counters: CompanionPiBrokerCounters;
  /** Current Pi `get_state.model.input`, preserved for text/vision dispatch validation. */
  modelInput: Array<"text" | "image">;
}

/** One monotonic page from the segmented layout-14 event journal. */
export interface CompanionPiBrokerEventPage {
  events: CompanionPiJournalRecord[];
  nextCursor: number;
  acknowledgedCursor: number;
  hasMore: boolean;
}

/** Prompt dispatch never collapses an ambiguous write into a safe negative acknowledgement. */
export type CompanionPiPromptDispatch =
  | { outcome: "accepted"; attemptId: string; invocationId: string }
  | { outcome: "refused"; code: string; message: string }
  | { outcome: "ambiguous"; code: string; message: string };

export type CompanionPiExtensionUiDispatch = CompanionPiPromptDispatch;

/** Narrow layout-14 Box/Pi port owned exclusively by the dedicated Runtime v2 service. */
export interface CompanionBoxRuntimeV2 {
  /** Read the provider's exact lifecycle state without probing Pi or waking the Box. */
  existingBoxStatus(input: {
    boxId: string;
    signal?: AbortSignal;
  }): Promise<{ boxId: string; state: BoxState }>;
  /** Resume only the exact durable Box. Never searches by name, creates, stages, or starts Pi. */
  resumeExistingBox(input: {
    boxId: string;
    signal?: AbortSignal;
  }): Promise<CompanionRuntimeObservation>;
  /** Archive only the exact durable Box. Pi lifecycle is a separate runtime checkpoint. */
  archiveExistingBox(input: {
    boxId: string;
    recoverArchive?: boolean;
    signal?: AbortSignal;
  }): Promise<{ boxId: string; state: BoxState }>;
  /**
   * Install layout 14 and concrete, already-authorized resources on one runnable Box. It never
   * creates/resumes a Box and never starts Pi; apps/runtime owns decryption and material loading.
   */
  stageExistingBox(input: {
    companionId: string;
    runtimeGeneration: number;
    orgId: string;
    boxId: string;
    clientSurface: CompanionClientSurface;
    providerAuth: Record<string, Record<string, unknown>>;
    replaceProviderAuth: boolean;
    instructions?: string | null;
    modelId: string;
    mcpCredentials: McpRuntimeCredential[];
    mcpAccounts: CompanionMcpAccount[];
    skills: CompanionRuntimeSkill[];
    hubEnv?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{ boxId: string; diskLayoutVersion: typeof COMPANION_PI_DISK_LAYOUT_VERSION }>;
  /** Pi-only lifecycle controls. None may resume/archive/create the Box. */
  startPiDaemon(input: { boxId: string; signal?: AbortSignal }): Promise<{
    state: "idle";
    invocationId: string;
  }>;
  restartPiDaemon(input: { boxId: string; signal?: AbortSignal }): Promise<{
    state: "idle";
    invocationId: string;
  }>;
  stopPiDaemon(input: { boxId: string; signal?: AbortSignal }): Promise<void>;
  piDaemonStatus(input: { boxId: string; signal?: AbortSignal }): Promise<{
    state: "idle" | "running" | "stopped" | "error";
    invocationId: string | null;
  }>;
  /** Dispatch one durable attempt and preserve positive, proven-negative, and ambiguous outcomes. */
  dispatchPrompt(input: {
    boxId: string;
    attemptId: string;
    message: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<CompanionPiPromptDispatch>;
  /** Observe broker identity/cursors and Pi's current model input capabilities in one command. */
  brokerState(input: { boxId: string; signal?: AbortSignal }): Promise<CompanionPiBrokerState>;
  /** Deliver one durable decision without collapsing a lost Box response into a safe refusal. */
  dispatchExtensionUi(input: {
    boxId: string;
    attemptId?: string;
    requestId?: string;
    response: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<CompanionPiExtensionUiDispatch>;
  /** Read the layout-14 journal after an exclusive monotonic cursor. */
  readEvents(input: {
    boxId: string;
    after: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<CompanionPiBrokerEventPage>;
  /** Acknowledge a journal cursor so the broker may retain or prune closed segments safely. */
  ackEvents(input: {
    boxId: string;
    through: number;
    signal?: AbortSignal;
  }): Promise<{ acknowledgedCursor: number }>;
  /** Reset the provider's idle clock after Pi accepts one durable attempt. */
  refreshTtl(input: { boxId: string; ttlSeconds?: number; signal?: AbortSignal }): Promise<void>;
  /** Mint one fresh desktop URL for a Box that is already running; never creates or resumes one. */
  desktop(input: { boxId: string; signal?: AbortSignal }): Promise<CompanionDesktopMint>;
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
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function brokerSafeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function brokerSafeMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.slice(0, COMPANION_RUNTIME_ERROR_MAX_LENGTH) : fallback;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function opaqueBrokerId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

const BROKER_COUNTER_KEYS = [
  "malformedLines",
  "oversizedLines",
  "unterminatedLines",
  "unknownEvents",
  "unboundEvents",
  "orphanResponses",
] as const satisfies readonly (keyof CompanionPiBrokerCounters)[];

function parseBrokerCounters(value: unknown): CompanionPiBrokerCounters | null {
  if (!isJsonObject(value)) return null;
  const counters = {} as CompanionPiBrokerCounters;
  for (const key of BROKER_COUNTER_KEYS) {
    if (!nonNegativeSafeInteger(value[key])) return null;
    counters[key] = value[key];
  }
  return counters;
}

function parseBrokerJournalRecord(value: unknown): CompanionPiJournalRecord | null {
  if (
    !isJsonObject(value)
    || !positiveSafeInteger(value.sequence)
    || !opaqueBrokerId(value.invocationId)
  ) return null;
  if (value.kind === "pi_event") {
    if (!opaqueBrokerId(value.attemptId) || !isJsonObject(value.event)) return null;
    return {
      sequence: value.sequence,
      invocationId: value.invocationId,
      attemptId: value.attemptId,
      kind: "pi_event",
      event: value.event,
    };
  }
  if (value.kind !== "pi_process_exit" || !isJsonObject(value.exit)) return null;
  const code = value.exit.code;
  const signal = value.exit.signal;
  if (
    (code !== null && !Number.isSafeInteger(code))
    || (signal !== null && (typeof signal !== "string" || signal.length > 32))
    || !opaqueBrokerId(value.attemptId)
  ) return null;
  return {
    sequence: value.sequence,
    invocationId: value.invocationId,
    attemptId: value.attemptId,
    kind: "pi_process_exit",
    exit: { code: code as number | null, signal: signal as string | null },
  };
}

/** Where the layout script is staged on the Box disk so it runs as a file, never as a command. */
const PI_LAYOUT_SCRIPT_PATH = ".companion/bin/ensure-pi-layout.sh";

function setupScript(installCommand: string | undefined, mcpAdapterPackage: string): string {
  const configuredInstall = installCommand?.trim();
  const encodedBrokerSource = Buffer.from(COMPANION_PI_BROKER_SOURCE, "utf8").toString("base64");
  const encodedInstallScript = configuredInstall
    ? Buffer.from(`#!/usr/bin/env bash
set -euo pipefail
${configuredInstall}
printf '%s' "$PATH" > "$COMPANION_PI_INSTALL_PATH_FILE"
`).toString("base64")
    : undefined;
  const ensureInstalled = configuredInstall
    ? `pi_install_log="$(mktemp)"
pi_install_script="$(mktemp)"
pi_install_path_file="$(mktemp)"
companion_pi_install_cleanup() {
  rm -f "$pi_install_log" "$pi_install_script" "$pi_install_path_file"
}
trap companion_pi_install_cleanup EXIT
printf '%s' ${shellQuote(encodedInstallScript!)} | base64 --decode > "$pi_install_script"
chmod 700 "$pi_install_script"
set +e
COMPANION_PI_INSTALL_PATH_FILE="$pi_install_path_file" bash "$pi_install_script" >"$pi_install_log" 2>&1
pi_install_status=$?
set -e
# Box promotes setup stderr to setupError even when the command succeeds. Keep warnings in the
# setup log without letting one become the reason a later version gate reports for the failure.
cat "$pi_install_log"
if [ "$pi_install_status" -ne 0 ]; then
  pi_install_detail="$(awk 'NF { line=$0 } END { print line }' "$pi_install_log")"
  if [ -n "$pi_install_detail" ]; then
    printf 'Pi install command failed (exit %s): %s\\n' "$pi_install_status" "$pi_install_detail" >&2
  else
    printf 'Pi install command failed (exit %s)\\n' "$pi_install_status" >&2
  fi
  exit "$pi_install_status"
fi
if [ -s "$pi_install_path_file" ]; then
  # Keep the Box's system tools reachable even when an installer exports only its own prefix.
  # The installed prefix stays first so a newly installed Pi wins over an older image copy.
  PATH="$(cat "$pi_install_path_file"):$PATH"
  export PATH
fi
companion_pi_install_cleanup
trap - EXIT`
    : `if ! command -v pi >/dev/null 2>&1; then
  echo 'Pi is not installed; configure COMPANION_PI_INSTALL_COMMAND or preinstall pi in the Box image' >&2
  exit 1
fi`;
  return `#!/usr/bin/env bash
set -euo pipefail
# An already-laid-out disk short-circuits before anything else, so repairing the layout on a Box that
# is already correct costs one file read and cannot fail on a dependency it does not need.
layout_marker="$HOME/.companion/runtime/state/pi-layout.version"
expected_layout=${shellQuote(`${COMPANION_PI_DISK_LAYOUT_VERSION}:${mcpAdapterPackage}:pi>=${MINIMUM_IMAGE_SAFE_PI_VERSION}`)}
if [ -f "$layout_marker" ] \
  && [ "$(cat "$layout_marker")" = "$expected_layout" ] \
  && [ -x "$HOME/${COMPANION_PI_BROKER_SCRIPT_PATH}" ] \
  && [ -x "$HOME/.companion/bin/pi-daemon" ] \
  && [ -f "$HOME/.config/systemd/user/companion-pi-daemon.service" ]; then
  exit 0
fi
${ensureInstalled}
command -v pi >/dev/null 2>&1
command -v node >/dev/null 2>&1
mkdir -p "$HOME/.companion/bin" "$HOME/.companion/pi" "$HOME/.companion/pi/extensions" "$HOME/.companion/runtime/sessions" "$HOME/.companion/runtime/state" "$HOME/.companion/runtime/logs" "$HOME/${COMPANION_PI_BROKER_JOURNAL_PATH}" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.companion/runtime" "$HOME/.companion/runtime/state" "$HOME/.companion/runtime/logs" "$HOME/${COMPANION_PI_BROKER_JOURNAL_PATH}"
# Resolve Pi's absolute path now so the daemon does not depend on a login-shell PATH it will never
# have under the minimal systemd user manager environment.
pi_bin="$(command -v pi)"
node_bin="$(command -v node)"
pi_version="$($pi_bin --version 2>/dev/null || true)"
"$node_bin" - "$pi_version" ${shellQuote(MINIMUM_IMAGE_SAFE_PI_VERSION)} <<'COMPANION_PI_VERSION'
const actualText = process.argv[2] ?? "";
const minimumText = process.argv[3] ?? "";
const parse = (value) => {
  const match = value.match(/(\\d+)\\.(\\d+)\\.(\\d+)/);
  return match ? match.slice(1).map(Number) : null;
};
const actual = parse(actualText);
const minimum = parse(minimumText);
const currentEnough = actual && minimum && (
  actual.every((part, index) => part === minimum[index])
  || actual.some((part, index) =>
    part > minimum[index]
    && actual.slice(0, index).every((prior, priorIndex) => prior === minimum[priorIndex]))
);
if (!currentEnough) {
  console.error(
    \`Pi \${minimumText} or newer is required for bounded image reads; found \${actualText || "an unknown version"}\`,
  );
  process.exit(1);
}
COMPANION_PI_VERSION
pi_bin_dir="$(dirname "$pi_bin")"
PI_CODING_AGENT_DIR="$HOME/.companion/pi" "$pi_bin" install ${shellQuote(mcpAdapterPackage)}
# The broker is an autonomous ESM program. Encoding it keeps arbitrary JavaScript out of the shell
# grammar while preserving one identical setup script for Box create and in-place layout repair.
printf '%s' ${shellQuote(encodedBrokerSource)} | base64 --decode > "$HOME/${COMPANION_PI_BROKER_SCRIPT_PATH}"
chmod 700 "$HOME/${COMPANION_PI_BROKER_SCRIPT_PATH}"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf 'PI_BIN=%q\n' "$pi_bin"
  printf 'NODE_BIN=%q\n' "$node_bin"
  printf 'MINIMUM_IMAGE_SAFE_PI_VERSION=%q\n' ${shellQuote(MINIMUM_IMAGE_SAFE_PI_VERSION)}
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
# start failed. The broker records Pi's process exit separately in its event journal; this log is the
# bounded operator diagnostic for failures before the broker can do so.
exec 2>>"$stderr_log"
trap 'companion_status=$?; printf "pi-daemon: line %s: %s failed with status %s\\n" "$LINENO" "$BASH_COMMAND" "$companion_status" >&2' ERR
export PI_CODING_AGENT_DIR="$HOME/.companion/pi"
broker_socket="$HOME/${COMPANION_PI_BROKER_SOCKET_PATH}"
broker_journal="$HOME/${COMPANION_PI_BROKER_JOURNAL_PATH}"
rm -f "$broker_socket"
mkdir -p "$broker_journal"
chmod 700 "$root" "$root/state" "$root/logs" "$broker_journal"
pi_version="$("$PI_BIN" --version 2>/dev/null || true)"
"$NODE_BIN" - "$pi_version" "$MINIMUM_IMAGE_SAFE_PI_VERSION" <<'COMPANION_PI_DAEMON_VERSION'
const actualText = process.argv[2] ?? "";
const minimumText = process.argv[3] ?? "";
const parse = (value) => {
  const match = value.match(/(\\d+)\\.(\\d+)\\.(\\d+)/);
  return match ? match.slice(1).map(Number) : null;
};
const actual = parse(actualText);
const minimum = parse(minimumText);
const currentEnough = actual && minimum && (
  actual.every((part, index) => part === minimum[index])
  || actual.some((part, index) =>
    part > minimum[index]
    && actual.slice(0, index).every((prior, priorIndex) => prior === minimum[priorIndex]))
);
if (!currentEnough) {
  console.error(
    "Pi " + minimumText + " or newer is required for bounded image reads; found "
      + (actualText || "an unknown version"),
  );
  process.exit(1);
}
COMPANION_PI_DAEMON_VERSION
if [ -z "\${INVOCATION_ID:-}" ]; then
  echo 'pi-broker: systemd invocation id is missing' >&2
  exit 1
fi
export COMPANION_PI_BIN="$PI_BIN"
export COMPANION_PI_ROOT="$root"
export COMPANION_PI_INVOCATION_ID="$INVOCATION_ID"
export COMPANION_PI_SOCKET_PATH="$broker_socket"
export COMPANION_PI_JOURNAL_PATH="$broker_journal"
# One line per start leaves an attributable breadcrumb even if the broker dies before it records
# Pi's process exit. It deliberately contains no arguments, credentials, or provider output.
printf 'pi-broker: starting invocation %s\\n' "$INVOCATION_ID" >&2
exec "$NODE_BIN" "$HOME/${COMPANION_PI_BROKER_SCRIPT_PATH}"
COMPANION_PI_DAEMON
} > "$HOME/.companion/bin/pi-daemon"
chmod 700 "$HOME/.companion/bin/pi-daemon"
{
  cat <<'COMPANION_PI_SERVICE_HEAD'
[Unit]
Description=Companion Pi broker
After=network-online.target

[Service]
Type=simple
UMask=0077
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
KillMode=control-group

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

/** Prove an explicitly resumed Box runs commands before staging layout or credential material. */
const BOX_RUNNABLE_COMMAND = `printf '%s\\n' ${shellQuote(BOX_RUNNABLE_MARKER)}`;

function encodeEnvironmentFile(
  credentials: McpRuntimeCredential[],
  extra: Record<string, string> = {},
): string {
  const lines = [
    ...credentials.map(({ env_key: envKey, value }) => `${envKey}=${JSON.stringify(value)}`),
    ...Object.entries(extra).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
  ];
  return lines.join("\n").concat(lines.length ? "\n" : "");
}

function companionBoxName(companionId: string, runtimeGeneration?: number): string {
  if (runtimeGeneration === undefined) return `Companion ${companionId}`;
  if (
    !Number.isSafeInteger(runtimeGeneration)
    || runtimeGeneration < 1
    || runtimeGeneration > MAX_COMPANION_RUNTIME_GENERATION
  ) {
    throw new BoxRuntimeConfigurationError("Companion runtime generation must be a positive integer");
  }
  return `Companion ${companionId} g${runtimeGeneration}`;
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
function isCompanionOwnBox(
  box: BoxInfo,
  companionId: string,
  runtimeGeneration?: number,
): boolean {
  const name = box.name?.trim() ?? "";
  if (isSharedScopeBoxName(name)) return false;
  return name === "" || name === companionBoxName(companionId, runtimeGeneration);
}

/**
 * Box setup runs once per disk, so a Box whose Pi setup failed can never run Pi, and neither can one
 * in the terminal error state. Waking such a Box again only repeats the same failure, so the
 * Companion has to be moved onto a new Box instead.
 */

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

/** The stream URL one desktop answer carries, whichever of the two names Box gave it. */
function desktopEnvelopeUrl(envelope: DesktopEnvelope): string | null {
  const url = (envelope.desktopUrl ?? envelope.url ?? "").trim();
  return url || null;
}

/**
 * Whether one failed `?vnc=1` call means this Box has no VNC stream to offer at all.
 *
 * Only the provider's own refusals are read that way, and only the ones that say something about
 * the request rather than about the moment it arrived: a build that does not know the flag answers
 * the same way however long a mint keeps asking, so spending the budget on it only delays the
 * fallback. Everything else — a transport fault, a timeout, a server error, a retryable status —
 * is one bad moment inside a budget that still has room to ask again, and reading those as a
 * refusal is what would hand a panel a WebRTC URL over a VNC stream that was about to work.
 */
function isVncRefusal(error: unknown): boolean {
  if (!(error instanceof BoxRuntimeProviderError)) return false;
  return error.status < 500 && !VNC_RETRYABLE_STATUSES.has(error.status);
}

/**
 * Mint one fresh desktop URL for a Box that is already running.
 *
 * The stream token rotates on every Box state change, so there is no such thing as a desktop URL
 * worth keeping: each join mints its own, and none of them is ever stored. VNC is asked for first
 * because it is a plain WebSocket stream that still reaches a Box from a network which blocks
 * peer-to-peer traffic, and it is the stream the panel can actually show.
 *
 * VNC is not merely asked first, it is preferred for the whole budget: a read with no URL in it is
 * a stream Box has not finished bringing up, whether or not that read also says `provisioning`, so
 * it is polled rather than read as a Box with no VNC. Production proved why the flag alone cannot
 * decide it — a first join was handed WebRTC, whose URL arrives at once and then never becomes a
 * picture, while the reconnect a moment later got the VNC stream that had been coming all along.
 *
 * WebRTC is what a mint settles for, never what it prefers, so it is asked exactly twice over: once
 * when the provider refuses `?vnc=1` outright, because a build that does not know the flag must not
 * take computer use down with it, and once when the budget runs out with no VNC URL to show for it.
 * A URL it returns before either of those has happened is a URL this mint never asked for.
 *
 * This is a decision about two answers and a clock rather than about Box itself, so the calls, the
 * poll interval, and the budget are all handed in: the arithmetic has to hold for a stream that
 * arrives at once, one that arrives late, one that never arrives, and a flag the provider refuses.
 */
export async function mintBoxDesktopUrl(input: {
  vnc: () => Promise<DesktopEnvelope>;
  webrtc: () => Promise<DesktopEnvelope>;
  budgetMs: number;
  pause: () => Promise<void>;
  now?: () => number;
}): Promise<CompanionDesktopMint> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.budgetMs;
  let provisioning = false;
  let vncFailure: unknown;
  for (;;) {
    try {
      const read = await input.vnc();
      const url = desktopEnvelopeUrl(read);
      if (url) return { url, provisioning: false, transport: "vnc" };
      // A Box that said it is bringing a stream up said so about this join, so the surface is told
      // the desktop is still starting even if a later read stopped saying it.
      provisioning ||= read.provisioning === true;
      // This poll reached Box and was answered, so whatever an earlier poll failed with is no
      // longer this mint's reason for anything.
      vncFailure = undefined;
    } catch (error) {
      vncFailure = error;
      if (isVncRefusal(error)) break;
    }
    await input.pause();
    // The budget is spent by waiting, so it is checked after the wait: a poll is never made past a
    // deadline the previous interval already crossed.
    if (now() >= deadline) break;
  }
  const fallback = await input.webrtc().catch((error: unknown) => {
    // Two refusals, one report: the VNC one is the reason this mint went looking for a fallback.
    throw vncFailure ?? error;
  });
  const url = desktopEnvelopeUrl(fallback);
  if (url) return { url, provisioning: false, transport: "webrtc" };
  if (vncFailure) throw vncFailure;
  return {
    url: null,
    provisioning: provisioning || fallback.provisioning === true,
    transport: null,
  };
}

export class AsciiBoxCompanionRuntime implements CompanionBoxRuntimeV2 {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #ttlSeconds: number;
  readonly #pollIntervalMs: number;
  readonly #readyTimeoutMs: number;
  readonly #desktopMintBudgetMs: number;
  readonly #daemonActiveTimeoutMs: number;
  readonly #installCommand: string | undefined;
  readonly #mcpAdapterPackage: string;
  /**
   * The current staging call's budget. Private file/command helpers share it so cancellation covers
   * the whole layout transaction without leaking into a later adapter call.
   */
  #stagingSignal: AbortSignal | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const apiKey = env.COMPANION_BOX_API_KEY?.trim();
    if (!apiKey) {
      throw new BoxRuntimeConfigurationError(
        "Box runtime is not configured; set COMPANION_BOX_API_KEY",
      );
    }
    this.#apiKey = apiKey;
    this.#baseUrl = (env.COMPANION_BOX_API_BASE?.trim() || DEFAULT_BOX_API_BASE).replace(/\/+$/, "");
    this.#ttlSeconds = positiveInteger(env.COMPANION_BOX_TTL_SECONDS, 21_600);
    this.#pollIntervalMs = positiveInteger(env.COMPANION_BOX_POLL_INTERVAL_MS, 1000);
    this.#readyTimeoutMs = positiveInteger(env.COMPANION_BOX_READY_TIMEOUT_MS, 120_000);
    this.#desktopMintBudgetMs = positiveInteger(
      env.COMPANION_BOX_DESKTOP_MINT_BUDGET_MS,
      BOX_DESKTOP_MINT_BUDGET_MS,
    );
    this.#daemonActiveTimeoutMs = positiveInteger(
      env.COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS,
      PI_DAEMON_ACTIVE_TIMEOUT_MS,
    );
    this.#installCommand = env.COMPANION_PI_INSTALL_COMMAND;
    this.#mcpAdapterPackage =
      env.COMPANION_PI_MCP_ADAPTER_PACKAGE?.trim() || DEFAULT_PI_MCP_ADAPTER_PACKAGE;
  }

  /**
   * What ends one Box request: its own timeout, whatever the caller passed, and the running staging
   * budget. The shared budget bounds the full multi-call layout transaction.
   */
  #requestSignal(
    timeoutMs: number,
    callerSignal?: AbortSignal | null,
    budget?: AbortSignal | null,
  ): AbortSignal {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (callerSignal) signals.push(callerSignal);
    if (budget) signals.push(budget);
    return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
  }

  async #request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs = 30_000,
    budget: AbortSignal | null = this.#stagingSignal ?? null,
  ): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: this.#requestSignal(timeoutMs, init?.signal, budget),
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

  async #get(boxId: string, signal?: AbortSignal): Promise<BoxInfo> {
    return (await this.#request<BoxEnvelope>(
      `/boxes/${encodeURIComponent(boxId)}`,
      signal ? { signal } : undefined,
    )).box;
  }


  /** One poll interval, ended early by the running staging budget. */
  async #pause(signal: AbortSignal | undefined = this.#stagingSignal): Promise<void> {
    await sleep(this.#pollIntervalMs, undefined, { signal });
  }

  async #waitReady(boxId: string, signal?: AbortSignal): Promise<BoxInfo> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    while (Date.now() < deadline) {
      const box = await this.#get(boxId, signal);
      if (READY_STATES.has(box.state) && (box.setupStatus === undefined || box.setupStatus === null || box.setupStatus === "done")) {
        return box;
      }
      if (box.state === "error") throw new BoxRuntimeProviderError("Box entered error state", 502);
      if (box.setupStatus === "failed") {
        throw new BoxRuntimeProviderError(`Box Pi setup failed: ${box.setupError || "unknown error"}`, 502);
      }
      await this.#pause(signal);
    }
    throw new BoxRuntimeProviderError("Box did not become ready before the configured timeout", 504);
  }


  async #resume(boxId: string, signal?: AbortSignal): Promise<BoxInfo> {
    const resumed = await this.#request<BoxEnvelope>(
      `/boxes/${encodeURIComponent(boxId)}/resume`,
      {
        method: "POST",
        body: JSON.stringify({ noEnv: true, ttlSeconds: this.#ttlSeconds }),
        ...(signal ? { signal } : {}),
      },
    );
    return resumed.box;
  }

  async #assertBoxRunnable(box: BoxInfo): Promise<void> {
    const result = await this.#command(box.id, BOX_RUNNABLE_COMMAND);
    if (!result.success) {
      throw new BoxRuntimeProviderError(
        `Box in state ${box.state} did not run the staging probe${commandFailureDetail(result)}`,
        409,
      );
    }
  }

  async #command(
    boxId: string,
    command: string,
    timeoutSeconds = 60,
    signal?: AbortSignal,
  ): Promise<CommandEnvelope> {
    return this.#request<CommandEnvelope>(`/boxes/${encodeURIComponent(boxId)}/commands`, {
      method: "POST",
      body: JSON.stringify({ command, timeoutSeconds }),
      ...(signal ? { signal } : {}),
    }, (timeoutSeconds + 10) * 1_000);
  }

  async #daemonState(boxId: string, signal?: AbortSignal): Promise<CompanionDaemonState> {
    const result = await this.#command(
      boxId,
      `${USER_BUS_ENVIRONMENT}
companion_pi_state="$(systemctl --user is-active companion-pi-daemon.service 2>/dev/null || true)"
printf '%s\n' "$companion_pi_state"
companion_pi_invocation="$(systemctl --user show companion-pi-daemon.service -p InvocationID --value 2>/dev/null || true)"
companion_pi_socket="$HOME/${COMPANION_PI_BROKER_SOCKET_PATH}"
companion_pi_socket_mode="$(stat -c '%a' "$companion_pi_socket" 2>/dev/null || true)"
if [ "$companion_pi_state" = active ] &&
  [ -n "$companion_pi_invocation" ] &&
  [ -S "$companion_pi_socket" ] &&
  [ "$companion_pi_socket_mode" = 600 ]; then
  printf '%s\n' companion-pi-broker-ready
else
  printf '%s\n' companion-pi-broker-unready
fi`,
      60,
      signal,
    );
    const lines = result.stdout.trim().split(/\r?\n/);
    // Exact `active` remains accepted for older Box command fakes. The real probe always prints an
    // RPC marker, and an explicit unready marker prevents systemd Type=simple from becoming Online
    // before the broker has bound and permissioned the command socket.
    return lines[0] === "active"
      && !lines.includes("companion-pi-broker-unready")
      && !lines.includes("companion-pi-rpc-unready")
      ? "running"
      : "stopped";
  }

  /**
   * Wait for the started unit and its RPC input to actually be ready. A successful `start` only
   * means systemd accepted the job, and Type=simple becomes active before the broker binds its
   * socket, so the wait ends only when both signals say the protocol boundary is ready.
   */
  async #waitDaemonActive(
    boxId: string,
    signal?: AbortSignal,
  ): Promise<CompanionDaemonState> {
    const deadline = Date.now() + this.#daemonActiveTimeoutMs;
    let daemonState = await this.#daemonState(boxId, signal);
    while (daemonState !== "running" && Date.now() < deadline) {
      await this.#pause(signal);
      daemonState = await this.#daemonState(boxId, signal);
    }
    return daemonState;
  }

  /**
   * Send one command over the layout-14 owner-only socket and wait for its correlated response.
   * One connection carries exactly one LF-terminated request and response, so a transport close or
   * timeout is ambiguous rather than inferred from unrelated output in the event journal.
   */
  async #rpcCommandResponse(input: {
    boxId: string;
    command: Record<string, unknown> & { id: string };
    responseCommand: string;
    acceptTimeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown> | null> {
    const encodedCommand = Buffer.from(JSON.stringify(input.command), "utf8").toString("base64");
    const acceptTimeoutSeconds = Math.max(
      1,
      Math.min(
        PI_RPC_ACCEPT_TIMEOUT_SECONDS,
        Math.ceil(input.acceptTimeoutSeconds ?? PI_RPC_ACCEPT_TIMEOUT_SECONDS),
      ),
    );
    const result = await this.#command(
      input.boxId,
      `set -euo pipefail
${USER_BUS_ENVIRONMENT}
broker_socket="$HOME/${COMPANION_PI_BROKER_SOCKET_PATH}"
systemctl --user is-active --quiet companion-pi-daemon.service
test -S "$broker_socket"
[ "$(stat -c '%a' "$broker_socket" 2>/dev/null || true)" = 600 ]
COMPANION_PI_BROKER_SOCKET="$broker_socket" \
COMPANION_PI_BROKER_COMMAND=${shellQuote(encodedCommand)} \
COMPANION_PI_BROKER_TIMEOUT_MS=${acceptTimeoutSeconds * 1_000} \
node <<'COMPANION_PI_BROKER_CLIENT'
const net = require("node:net");
const request = Buffer.from(process.env.COMPANION_PI_BROKER_COMMAND || "", "base64").toString("utf8");
const timeoutMs = Number(process.env.COMPANION_PI_BROKER_TIMEOUT_MS || "8000");
let buffer = "";
let settled = false;
let timer;
const socket = net.createConnection({ path: process.env.COMPANION_PI_BROKER_SOCKET });
const fail = (message) => {
  if (settled) return;
  settled = true;
  if (timer) clearTimeout(timer);
  socket.destroy();
  process.stderr.write(message + "\\n");
  process.exitCode = 1;
};
timer = setTimeout(() => fail("Pi broker did not acknowledge the command"), timeoutMs);
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(request + "\\n"));
socket.on("data", (chunk) => {
  if (settled) return;
  buffer += chunk;
  if (Buffer.byteLength(buffer, "utf8") > 262144) {
    fail("Pi broker response exceeded the safe limit");
    return;
  }
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  clearTimeout(timer);
  settled = true;
  process.stdout.write(buffer.slice(0, newline) + "\\n");
  socket.end();
});
socket.on("end", () => {
  if (!settled) fail("Pi broker closed without a response");
});
socket.on("error", () => fail("Pi broker command transport failed"));
COMPANION_PI_BROKER_CLIENT`,
      acceptTimeoutSeconds + 5,
      input.signal,
    );
    if (!result.success) return null;
    for (const line of result.stdout.trim().split(/[\r\n]+/).reverse()) {
      try {
        const response = JSON.parse(line) as Record<string, unknown>;
        if (
          response.type === "response"
          && response.command === input.responseCommand
          && response.id === input.command.id
        ) return response;
      } catch {
        // Provider command output may include harmless shell noise; only correlated JSON counts.
      }
    }
    return null;
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

  /**
   * Rewrite any staged archive the Box is holding short of what was sent.
   *
   * A write the file API accepted is not the same as a file that landed whole. The reported wake died
   * extracting an archive on a Box the provider had just brought back from `idle`, and the identical
   * payload extracted on the next attempt against that same Box — which is a transfer that did not
   * land, not a package that cannot be read. The control plane knows exactly how many bytes it sent,
   * so it can notice that and send them again, which is all the second attempt was doing by hand.
   *
   * This is advisory on purpose. A measurement is only ever used to repair, never to fail: a Box that
   * will not report sizes, or does not report one for some archive, is left to the extract step
   * exactly as before, because a new command that can refuse is not allowed to break a wake that
   * works today. An archive that is still wrong after the rewrite fails extraction, naming itself.
   */
  async #repairShortStagedArchives(boxId: string, staged: Map<string, string>): Promise<void> {
    if (staged.size === 0) return;
    const measured = await this.#stagedArchiveSizes(boxId);
    if (!measured) return;
    for (const [path, content] of staged) {
      const bytes = measured.get(path);
      // An archive the Box did not report is not an archive known to be short.
      if (bytes === undefined || bytes === Buffer.byteLength(content, "utf8")) continue;
      // A rewrite that will not land is not a reason to stop: the extract that follows is a better
      // judge of whether the tree can be built than a repair that was only ever an attempt.
      await this.#writeFile(boxId, path, content).catch(() => undefined);
    }
  }

  /**
   * Bytes the Box holds for each staged archive, keyed by the path it was written to, or `null` when
   * the Box would not say. Nothing here is load-bearing enough to fail a start over.
   */
  async #stagedArchiveSizes(boxId: string): Promise<Map<string, number> | null> {
    const listed = await this.#command(
      boxId,
      `set -e; cd "$HOME/${STAGED_ARCHIVE_DIRECTORY}" 2>/dev/null || exit 0;`
      + ` for archive in *.tar.gz.b64; do [ -e "$archive" ] || continue;`
      + ` printf '${STAGED_ARCHIVE_SIZE_LABEL} %s %s\\n' "$archive" "$(wc -c < "$archive")"; done`,
      // Counting bytes already on the disk is the cheapest thing a start asks for, so it is given a
      // short window rather than the default minute: a Box slow enough to miss this would otherwise
      // spend a chunk of the wake's whole budget on a step whose answer is optional.
      STAGED_ARCHIVE_MEASURE_TIMEOUT_SECONDS,
    ).catch(() => null);
    if (!listed?.success) return null;
    const sizes = new Map<string, number>();
    for (const line of labeledDiagnosticLines(listed.stdout, STAGED_ARCHIVE_SIZE_LABEL)) {
      // The name cannot carry a space: it is `<slug>.tar.gz.b64`, and a slug is slug-shaped.
      const [name, bytes] = line.split(/\s+/);
      if (name && bytes && /^\d+$/.test(bytes)) {
        sizes.set(`${STAGED_ARCHIVE_DIRECTORY}/${name}`, Number(bytes));
      }
    }
    return sizes;
  }

  /**
   * Replace the legacy approval broker and stage the bounded guard before layout 11 is published.
   * If Pi restarts during migration, it can only load the current unrestricted extension from disk.
   */
  async #stageCompanionInteractionExtension(boxId: string): Promise<void> {
    await this.#command(
      boxId,
      'mkdir -p "$HOME/.companion/pi/extensions"',
    );
    await this.#writeFile(
      boxId,
      `.companion/pi/extensions/${COMPANION_PERMISSION_BROKER_EXTENSION_FILE}`,
      COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE.endsWith("\n")
        ? COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE
        : `${COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE}\n`,
    );
  }

  async #injectPiResources(input: {
    boxId: string;
    clientSurface: CompanionClientSurface;
    providerAuth: Record<string, Record<string, unknown>>;
    replaceProviderAuth: boolean;
    modelId: string;
    instructions?: string | null;
    mcpCredentials: McpRuntimeCredential[];
    mcpAccounts: CompanionMcpAccount[];
    skills: CompanionRuntimeSkill[];
    hubEnv?: Record<string, string>;
  }): Promise<void> {
    const injectedSkills = input.clientSurface === "native_mobile" ? [] : input.skills;
    const mcp = buildMcpAdapterInjection(input.mcpAccounts);
    const cleared = await this.#command(
      input.boxId,
      `set -e; root="$HOME/.companion/runtime"; rm -rf "$root/state/skill-archives"; mkdir -p "$root/state/skill-archives"; if [ -f "$HOME/.companion/pi/auth.json" ]; then printf '%s\\n' ${shellQuote(PROVIDER_AUTH_PRESENT_MARKER)}; fi`,
    );
    if (!cleared.success) {
      throw new BoxRuntimeProviderError(
        `Pi resource staging failed${commandFailureDetail(cleared)}`,
        502,
      );
    }
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
    await this.#writeFile(
      input.boxId,
      ".companion/runtime/state/instructions.txt",
      input.instructions?.trim() ? `${input.instructions.trim()}\n` : "",
    );
    await this.#writeFile(
      input.boxId,
      ".companion/runtime/state/model.txt",
      `${input.modelId}\n`,
    );
    const staged = new Map<string, string>();
    for (const skill of injectedSkills) {
      const path = runtimeSkillArchivePath(skill);
      const content = skill.archive.toString("base64");
      staged.set(path, content);
      await this.#writeFile(input.boxId, path, content);
    }
    await this.#repairShortStagedArchives(input.boxId, staged);
    try {
      await this.#writeFile(
        input.boxId,
        ".companion/runtime/state/providers.env",
        encodeEnvironmentFile(input.mcpCredentials, input.hubEnv),
      );
      const prepared = await this.#command(
        input.boxId,
        // One archive that will not decode or extract has to name itself. `tar` reports a failed
        // member over three lines and ends on `Error is not recoverable`, which is the one line a
        // stored reason has room for and the only one that says nothing, so the loop appends the slug
        // it was working on after tar has finished complaining.
        "set -euo pipefail; root=\"$HOME/.companion/runtime\"; rm -rf \"$root/skills.next\"; mkdir -p \"$root/skills.next\"; shopt -s nullglob; for archive in \"$root/state/skill-archives\"/*.tar.gz.b64; do slug=\"$(basename \"$archive\" .tar.gz.b64)\"; mkdir -p \"$root/skills.next/$slug\"; if ! base64 --decode \"$archive\" | tar --extract --gzip --file=- --directory=\"$root/skills.next/$slug\" --no-same-owner --no-same-permissions; then echo \"skill package $slug did not extract\" >&2; exit 1; fi; done; rm -rf \"$root/skills.prev\"; if [ -d \"$root/skills\" ]; then mv \"$root/skills\" \"$root/skills.prev\"; fi; mv \"$root/skills.next\" \"$root/skills\"; rm -rf \"$root/skills.prev\" \"$root/state/skill-archives\"",
        180,
      );
      // Production read this failure as the bare sentence, which named the step and nothing else: the
      // same wake could have died decoding a staged archive, extracting one, or swapping the tree in,
      // and every one of those is a different fault. The failing line travels with it for the same
      // reason it travels with a failed layout install.
      if (!prepared.success) {
        throw new BoxRuntimeProviderError(
          `Pi resources failed to prepare${commandFailureDetail(prepared)}`,
          502,
        );
      }
    } catch (error) {
      await this.#removeProviderFile(input.boxId).catch(() => undefined);
      throw error;
    }
  }

  async #activatePiDaemon(input: {
    boxId: string;
    restart: boolean;
    signal?: AbortSignal;
  }): Promise<{ state: "idle"; invocationId: string }> {
    let started: CommandEnvelope;
    try {
      started = await this.#command(
        input.boxId,
        `set -e
staged_credential_file="$HOME/.companion/runtime/state/providers.env"
runtime_credential_file="/run/user/$(id -u)/companion/providers.env"
trap 'rm -f "$staged_credential_file" "$runtime_credential_file"' EXIT
auth_file="$HOME/.companion/pi/auth.json"
if [ ! -f "$auth_file" ]; then echo 'Companion provider auth file is missing' >&2; exit 1; fi
chmod 700 "$HOME/.companion/pi"
chmod 600 "$auth_file"
${PREPARE_USER_BUS}
runtime_credential_dir="$XDG_RUNTIME_DIR/companion"
runtime_credential_file="$runtime_credential_dir/providers.env"
mkdir -p "$runtime_credential_dir"
chmod 700 "$runtime_credential_dir"
if [ -f "$staged_credential_file" ]; then
  mv -f "$staged_credential_file" "$runtime_credential_file"
fi
if [ ! -f "$runtime_credential_file" ]; then
  echo 'Companion runtime credentials are missing' >&2
  exit 1
fi
chmod 600 "$runtime_credential_file"
systemctl --user daemon-reload
systemctl --user reset-failed companion-pi-daemon.service >/dev/null 2>&1 || true
systemctl --user ${input.restart ? "restart" : "start"} companion-pi-daemon.service
trap - EXIT`,
        120,
        input.signal,
      );
    } catch (error) {
      await this.#removeProviderFile(input.boxId).catch(() => undefined);
      throw error;
    }
    if (!started.success) {
      await this.#removeProviderFile(input.boxId).catch(() => undefined);
      throw new BoxRuntimeProviderError(
        `Pi daemon failed to start${commandFailureDetail(started)}`,
        502,
      );
    }
    const daemonState = await this.#waitDaemonActive(input.boxId, input.signal);
    if (daemonState !== "running") {
      throw new BoxRuntimeProviderError(
        `${PI_DAEMON_FAILURE_MESSAGE}${await this.#daemonFailureDetail(input.boxId)}`,
        502,
      );
    }
    const broker = await this.brokerState({ boxId: input.boxId, signal: input.signal });
    if (broker.activeAttemptId !== null) {
      throw new BoxRuntimeProviderError("Pi became active with an unexpected turn", 409);
    }
    return { state: "idle", invocationId: broker.invocationId };
  }

  async #deactivatePiDaemon(input: { boxId: string; signal?: AbortSignal }): Promise<void> {
    const stopped = await this.#command(
      input.boxId,
      `${USER_BUS_ENVIRONMENT}
if systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user stop companion-pi-daemon.service >/dev/null 2>&1 || true
  if systemctl --user is-active --quiet companion-pi-daemon.service; then
    echo 'Pi daemon is still active after stop' >&2
    exit 1
  fi
fi
rm -f "/run/user/$(id -u)/companion/providers.env" \
  "$HOME/${COMPANION_PI_BROKER_SOCKET_PATH}"`,
      60,
      input.signal,
    );
    if (!stopped.success) throw new BoxRuntimeProviderError("Pi daemon failed to stop", 502);
  }

  async resumeExistingBox(input: {
    boxId: string;
    signal?: AbortSignal;
  }): Promise<CompanionRuntimeObservation> {
    let box = await this.#get(input.boxId, input.signal);
    if (box.state === "archiving") {
      throw new BoxRuntimeProviderError("Box is still archiving", 409, "box_already_stopping");
    }
    if (box.state === "archived") {
      box = await this.#resume(input.boxId, input.signal);
    }
    if (STARTING_STATES.has(box.state)) {
      box = await this.#waitReady(input.boxId, input.signal);
    }
    if (!READY_STATES.has(box.state)) {
      throw new BoxRuntimeProviderError(`Box cannot resume from state ${box.state}`, 409);
    }
    const daemonState = await this.#daemonState(input.boxId, input.signal).catch((error: unknown) => {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      return "stopped" as const;
    });
    return observation(box, daemonState);
  }

  async existingBoxStatus(input: {
    boxId: string;
    signal?: AbortSignal;
  }): Promise<{ boxId: string; state: BoxState }> {
    const box = await this.#get(input.boxId, input.signal);
    return { boxId: box.id, state: box.state };
  }

  async archiveExistingBox(input: {
    boxId: string;
    recoverArchive?: boolean;
    signal?: AbortSignal;
  }): Promise<{ boxId: string; state: BoxState }> {
    return await this.#archiveBox(input);
  }

  async #archiveBox(input: {
    boxId: string;
    recoverArchive?: boolean;
    signal?: AbortSignal;
  }, observed?: BoxInfo): Promise<{ boxId: string; state: BoxState }> {
    let box = observed ?? await this.#get(input.boxId, input.signal);
    if (box.state !== "archived" && box.state !== "archiving") {
      try {
        const response = await this.#request<BoxEnvelope>(
          `/boxes/${encodeURIComponent(input.boxId)}/stop`,
          {
            method: "POST",
            body: JSON.stringify({ force: false }),
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
        box = response.box;
      } catch (error) {
        if (
          input.recoverArchive !== true
          || !(error instanceof BoxRuntimeProviderError)
          || error.status !== 409
        ) throw error;
        box = await this.#get(input.boxId, input.signal);
      }
    }
    return { boxId: box.id, state: box.state };
  }

  async stageExistingBox(input: {
    companionId: string;
    runtimeGeneration: number;
    orgId: string;
    boxId: string;
    clientSurface: CompanionClientSurface;
    providerAuth: Record<string, Record<string, unknown>>;
    replaceProviderAuth: boolean;
    instructions?: string | null;
    modelId: string;
    mcpCredentials: McpRuntimeCredential[];
    mcpAccounts: CompanionMcpAccount[];
    skills: CompanionRuntimeSkill[];
    hubEnv?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{ boxId: string; diskLayoutVersion: typeof COMPANION_PI_DISK_LAYOUT_VERSION }> {
    companionBoxName(input.companionId, input.runtimeGeneration);
    this.#stagingSignal = input.signal;
    try {
      const box = await this.#get(input.boxId, input.signal);
      if (!isCompanionOwnBox(box, input.companionId, input.runtimeGeneration)) {
        throw new BoxRuntimeProviderError("The durable Box identity does not match this Companion", 409);
      }
      if (!READY_STATES.has(box.state)) {
        throw new BoxRuntimeProviderError("Box must be resumed before staging runtime resources", 409);
      }
      await this.#assertBoxRunnable(box);
      await this.#ensurePiLayout(box.id);
      await this.#stageCompanionInteractionExtension(box.id);
      await this.#injectPiResources({
        boxId: box.id,
        clientSurface: input.clientSurface,
        providerAuth: input.providerAuth,
        replaceProviderAuth: input.replaceProviderAuth,
        modelId: input.modelId,
        instructions: input.instructions,
        mcpCredentials: input.mcpCredentials,
        mcpAccounts: input.mcpAccounts,
        skills: input.skills,
        hubEnv: input.hubEnv,
      });
      return { boxId: box.id, diskLayoutVersion: COMPANION_PI_DISK_LAYOUT_VERSION };
    } finally {
      this.#stagingSignal = undefined;
    }
  }

  async startPiDaemon(input: { boxId: string; signal?: AbortSignal }): Promise<{
    state: "idle";
    invocationId: string;
  }> {
    return await this.#activatePiDaemon({ ...input, restart: false });
  }

  async restartPiDaemon(input: { boxId: string; signal?: AbortSignal }): Promise<{
    state: "idle";
    invocationId: string;
  }> {
    return await this.#activatePiDaemon({ ...input, restart: true });
  }

  async stopPiDaemon(input: { boxId: string; signal?: AbortSignal }): Promise<void> {
    await this.#deactivatePiDaemon(input);
  }

  async piDaemonStatus(input: { boxId: string; signal?: AbortSignal }): Promise<{
    state: "idle" | "running" | "stopped" | "error";
    invocationId: string | null;
  }> {
    const state = await this.#daemonState(input.boxId, input.signal);
    if (state !== "running") return { state: "stopped", invocationId: null };
    try {
      const broker = await this.brokerState({ boxId: input.boxId, signal: input.signal });
      return {
        state: broker.activeAttemptId === null ? "idle" : "running",
        invocationId: broker.invocationId,
      };
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      return { state: "error", invocationId: null };
    }
  }

  async dispatchPrompt(input: {
    boxId: string;
    attemptId: string;
    message: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<CompanionPiPromptDispatch> {
    let response: Record<string, unknown> | null;
    try {
      response = await this.#rpcCommandResponse({
        boxId: input.boxId,
        responseCommand: "prompt",
        command: {
          id: input.requestId ?? `companion-dispatch:${randomUUID()}`,
          type: "prompt",
          attemptId: input.attemptId,
          message: input.message,
        },
        signal: input.signal,
      });
    } catch {
      // The Box command can have written the prompt and lost its HTTP response. Conservatively keep
      // that indistinguishable transport failure out of every automatic replay path.
      response = null;
    }
    if (!response) {
      return {
        outcome: "ambiguous",
        code: "pi_ack_ambiguous",
        message: "Pi prompt acknowledgement is unavailable",
      };
    }
    if (response.success === true) {
      const data = isJsonObject(response.data) ? response.data : null;
      if (
        data?.piAcknowledged === true
        && data.attemptId === input.attemptId
        && opaqueBrokerId(data.invocationId)
      ) {
        return {
          outcome: "accepted",
          attemptId: input.attemptId,
          invocationId: data.invocationId,
        };
      }
      return {
        outcome: "ambiguous",
        code: "broker_protocol",
        message: "Pi broker returned an invalid prompt acknowledgement",
      };
    }
    const error = isJsonObject(response.error) ? response.error : {};
    const ambiguous = error.ambiguous === true;
    return {
      outcome: ambiguous ? "ambiguous" : "refused",
      code: brokerSafeCode(error.code, ambiguous ? "pi_ack_ambiguous" : "pi_prompt_refused"),
      message: brokerSafeMessage(
        error.message,
        ambiguous ? "Pi prompt acknowledgement is unavailable" : "Pi refused the prompt",
      ),
    };
  }

  async brokerState(input: {
    boxId: string;
    signal?: AbortSignal;
  }): Promise<CompanionPiBrokerState> {
    const response = await this.#rpcCommandResponse({
      boxId: input.boxId,
      responseCommand: "runtime_state",
      command: { id: `companion-runtime-state:${randomUUID()}`, type: "runtime_state" },
      signal: input.signal,
    });
    const data = response?.success === true && isJsonObject(response.data) ? response.data : null;
    const counters = parseBrokerCounters(data?.counters);
    const modelInput = Array.isArray(data?.modelInput)
      && data.modelInput.every((item) => item === "text" || item === "image")
      ? [...new Set(data.modelInput)] as Array<"text" | "image">
      : null;
    if (
      !data
      || !opaqueBrokerId(data.invocationId)
      || (data.activeAttemptId !== null && !opaqueBrokerId(data.activeAttemptId))
      || !nonNegativeSafeInteger(data.tailCursor)
      || !nonNegativeSafeInteger(data.acknowledgedCursor)
      || data.acknowledgedCursor > data.tailCursor
      || !counters
      || !modelInput
    ) {
      throw new BoxRuntimeProviderError("Pi broker state is unavailable", 502);
    }
    return {
      invocationId: data.invocationId,
      activeAttemptId: data.activeAttemptId,
      tailCursor: data.tailCursor,
      acknowledgedCursor: data.acknowledgedCursor,
      counters,
      modelInput,
    };
  }

  async dispatchExtensionUi(input: {
    boxId: string;
    attemptId?: string;
    requestId?: string;
    response: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<CompanionPiExtensionUiDispatch> {
    let response: Record<string, unknown> | null;
    try {
      response = await this.#rpcCommandResponse({
        boxId: input.boxId,
        responseCommand: "extension_ui_response",
        command: {
          id: input.requestId ?? `companion-decision:${randomUUID()}`,
          type: "extension_ui_response",
          ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
          response: input.response,
        },
        signal: input.signal,
      });
    } catch {
      response = null;
    }
    if (!response) {
      return {
        outcome: "ambiguous",
        code: "decision_delivery_ambiguous",
        message: "Pi decision acknowledgement is unavailable",
      };
    }
    if (response.success === true) {
      const data = isJsonObject(response.data) ? response.data : null;
      if (
        data?.delivered === true
        && opaqueBrokerId(data.attemptId)
        && opaqueBrokerId(data.invocationId)
        && (input.attemptId === undefined || data.attemptId === input.attemptId)
      ) {
        return {
          outcome: "accepted",
          attemptId: data.attemptId,
          invocationId: data.invocationId,
        };
      }
      return {
        outcome: "ambiguous",
        code: "broker_protocol",
        message: "Pi broker returned an invalid decision acknowledgement",
      };
    }
    const error = isJsonObject(response.error) ? response.error : {};
    const ambiguous = error.ambiguous === true;
    return {
      outcome: ambiguous ? "ambiguous" : "refused",
      code: brokerSafeCode(
        error.code,
        ambiguous ? "decision_delivery_ambiguous" : "decision_refused",
      ),
      message: brokerSafeMessage(
        error.message,
        ambiguous ? "Pi decision acknowledgement is unavailable" : "Pi refused the decision",
      ),
    };
  }

  async refreshTtl(input: {
    boxId: string;
    ttlSeconds?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.#request(`/boxes/${encodeURIComponent(input.boxId)}`, {
      method: "PATCH",
      body: JSON.stringify({ ttlSeconds: input.ttlSeconds ?? this.#ttlSeconds }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async ackEvents(input: {
    boxId: string;
    through: number;
    signal?: AbortSignal;
  }): Promise<{ acknowledgedCursor: number }> {
    const response = await this.#rpcCommandResponse({
      boxId: input.boxId,
      responseCommand: "ack_events",
      command: {
        id: `companion-ack-events:${randomUUID()}`,
        type: "ack_events",
        through: input.through,
      },
      signal: input.signal,
    });
    const data = response?.success === true && isJsonObject(response.data) ? response.data : null;
    if (!data || !nonNegativeSafeInteger(data.acknowledgedCursor)) {
      throw new BoxRuntimeProviderError("Pi broker event acknowledgement failed", 502);
    }
    return { acknowledgedCursor: data.acknowledgedCursor };
  }

  async readEvents(input: {
    boxId: string;
    after: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<CompanionPiBrokerEventPage> {
    const response = await this.#rpcCommandResponse({
      boxId: input.boxId,
      responseCommand: "read_events",
      command: {
        id: `companion-read-events:${randomUUID()}`,
        type: "read_events",
        after: input.after,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      signal: input.signal,
    });
    const data = response?.success === true && isJsonObject(response.data) ? response.data : null;
    const events = Array.isArray(data?.events)
      ? data.events.map(parseBrokerJournalRecord)
      : null;
    if (
      !data
      || !events
      || events.some((event) => event === null)
      || !nonNegativeSafeInteger(data.nextCursor)
      || !nonNegativeSafeInteger(data.acknowledgedCursor)
      || typeof data.hasMore !== "boolean"
    ) {
      throw new BoxRuntimeProviderError("Pi broker event journal could not be read", 502);
    }
    let prior = Math.max(input.after, data.acknowledgedCursor);
    for (const event of events as CompanionPiJournalRecord[]) {
      if (event.sequence <= prior || event.sequence > data.nextCursor) {
        throw new BoxRuntimeProviderError("Pi broker event journal is not monotonic", 502);
      }
      prior = event.sequence;
    }
    if (events.length > 0 && prior !== data.nextCursor) {
      throw new BoxRuntimeProviderError("Pi broker event cursor does not match its page", 502);
    }
    return {
      events: events as CompanionPiJournalRecord[],
      nextCursor: data.nextCursor,
      acknowledgedCursor: data.acknowledgedCursor,
      hasMore: data.hasMore,
    };
  }


  /**
   * A fresh desktop URL for a Box that is already running. Reaching a desktop observes a Box; it
   * never creates or resumes one, which is what keeps a panel that opens on a sleeping Box — or a
   * join a Viewer could reach — from being a wake.
   */
  async desktop(input: { boxId: string; signal?: AbortSignal }): Promise<CompanionDesktopMint> {
    const box = await this.#get(input.boxId, input.signal);
    if (!READY_STATES.has(box.state)) {
      throw new BoxRuntimeProviderError("Box must already be running before requesting desktop access", 409);
    }
    const desktopPath = `/boxes/${encodeURIComponent(input.boxId)}/desktop`;
    return mintBoxDesktopUrl({
      vnc: () => this.#request<DesktopEnvelope>(`${desktopPath}?vnc=1`, {
        method: "POST",
        body: "{}",
        ...(input.signal ? { signal: input.signal } : {}),
      }),
      webrtc: () => this.#request<DesktopEnvelope>(desktopPath, {
        method: "POST",
        body: "{}",
        ...(input.signal ? { signal: input.signal } : {}),
      }),
      budgetMs: this.#desktopMintBudgetMs,
      pause: () => this.#pause(input.signal),
    });
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
