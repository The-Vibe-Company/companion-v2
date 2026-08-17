import { createHash } from "node:crypto";

import type { BoxSimCommandResult, BoxSimPiController } from "./protocol";

export type BoxSimCommandKind =
  | "box-runnable"
  | "warm-daemon-ready"
  | "mkdir-pi-bin"
  | "install-layout"
  | "mkdir-extensions"
  | "clear-skill-archives"
  | "measure-skill-archives"
  | "join-file-parts"
  | "prepare-skills"
  | "start-or-restart-daemon"
  | "daemon-state"
  | "rpc-command"
  | "extension-ui-response"
  | "heal-daemon"
  | "daemon-diagnostics"
  | "remove-provider-files"
  | "stop-daemon"
  | "read-events"
  | "capture-desktop-frame"
  | "unsupported";

export interface BoxSimBrokerCounters {
  malformedLines: number;
  oversizedLines: number;
  unterminatedLines: number;
  unknownEvents: number;
  unboundEvents: number;
  orphanResponses: number;
}

export type BoxSimBrokerJournalRecord =
  | {
      sequence: number;
      invocationId: string;
      attemptId: string;
      kind: "pi_event";
      event: Record<string, unknown>;
    }
  | {
      sequence: number;
      invocationId: string;
      attemptId: string;
      kind: "pi_process_exit";
      exit: { code: number | null; signal: string | null };
    };

export interface BoxSimDaemonMachine {
  status: "inactive" | "active" | "failed";
  invocationId: string | null;
  invocationCounter: number;
  rpcReady: boolean;
  activeAttemptId: string | null;
  brokerJournal: BoxSimBrokerJournalRecord[];
  brokerAcknowledgedCursor: number;
  brokerCounters: BoxSimBrokerCounters;
  restartCount: number;
  scenario: string;
  rpcLog: string;
  stderrLog: string;
}

/** In-memory Box disk and the minimum systemd/Pi state required by the production adapter. */
export interface BoxSimCommandMachine {
  readonly boxId: string;
  persistentFiles: Map<string, Buffer>;
  volatileFiles: Map<string, Buffer>;
  daemon: BoxSimDaemonMachine;
  layoutInstalled: boolean;
  extensionDirectoryCreated: boolean;
  desktopFrameDataUrl: string | null;
  unknownCommandDigests: string[];
  piController?: BoxSimPiController;
}

export function createBoxSimCommandMachine(input: {
  boxId: string;
  scenario: string;
}): BoxSimCommandMachine {
  return {
    boxId: input.boxId,
    persistentFiles: new Map(),
    volatileFiles: new Map(),
    daemon: {
      status: "inactive",
      invocationId: null,
      invocationCounter: 0,
      rpcReady: false,
      activeAttemptId: null,
      brokerJournal: [],
      brokerAcknowledgedCursor: 0,
      brokerCounters: emptyBrokerCounters(),
      restartCount: 0,
      scenario: input.scenario,
      rpcLog: "",
      stderrLog: "",
    },
    layoutInstalled: false,
    extensionDirectoryCreated: false,
    desktopFrameDataUrl: null,
    unknownCommandDigests: [],
  };
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeBoxPath(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/");
  normalized = normalized.replace(/^\$HOME\//, "").replace(/^~\//, "").replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("Box path escapes its virtual home");
      parts.pop();
      continue;
    }
    if (part.includes("\0")) throw new Error("Box path contains NUL");
    parts.push(part);
  }
  if (parts.length === 0) throw new Error("Box path is empty");
  return parts.join("/");
}

export function putBoxFile(
  machine: BoxSimCommandMachine,
  path: string,
  bytes: Uint8Array,
  volatile = false,
): void {
  const destination = volatile ? machine.volatileFiles : machine.persistentFiles;
  destination.set(normalizeBoxPath(path), Buffer.from(bytes));
}

export function appendPiEvent(
  machine: BoxSimCommandMachine,
  event: Record<string, unknown> | string,
): void {
  if (typeof event === "string") {
    appendPiFault(
      machine,
      Buffer.byteLength(event, "utf8") > BROKER_MAX_LINE_BYTES ? "oversized" : "malformed",
    );
    return;
  }
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") > BROKER_MAX_LINE_BYTES) {
    incrementBrokerCounter(machine, "oversizedLines");
    return;
  }
  if (event.type === "response") {
    incrementBrokerCounter(machine, "orphanResponses");
    return;
  }
  const eventType = typeof event.type === "string" ? event.type : null;
  if (
    !eventType
    || !BROKER_SUPPORTED_EVENT_TYPES.has(eventType)
    || (eventType === "agent_settled" && Object.keys(event).length !== 1)
  ) {
    incrementBrokerCounter(machine, "unknownEvents");
    return;
  }
  const { activeAttemptId, invocationId } = machine.daemon;
  if (!activeAttemptId || !invocationId) {
    incrementBrokerCounter(machine, "unboundEvents");
    return;
  }
  machine.daemon.brokerJournal.push({
    sequence: brokerTailCursor(machine) + 1,
    invocationId,
    attemptId: activeAttemptId,
    kind: "pi_event",
    event: structuredClone(event),
  });
  // Layout 14 keeps this canonical projection only for the legacy byte-offset reader.
  machine.daemon.rpcLog += `${serialized}\n`;
  if (eventType === "agent_settled" && machine.daemon.activeAttemptId === activeAttemptId) {
    machine.daemon.activeAttemptId = null;
  }
}

/** Record a parser fault without retaining the rejected Pi line or fragment. */
export function appendPiFault(
  machine: BoxSimCommandMachine,
  fault: "malformed" | "oversized" | "unterminated",
): void {
  incrementBrokerCounter(
    machine,
    fault === "malformed"
      ? "malformedLines"
      : fault === "oversized"
        ? "oversizedLines"
        : "unterminatedLines",
  );
}

const BROKER_MAX_LINE_BYTES = 64 * 1024;
const BROKER_READ_LIMIT = 256;
/** Match the production broker's headroom beneath the 256 KiB command response limit. */
const BROKER_READ_BYTES = 224 * 1024;
const BROKER_SUPPORTED_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "extension_ui_request",
  "extension_error",
  "auto_retry_start",
  "auto_retry_end",
  "queue_update",
  "compaction_start",
  "compaction_update",
  "compaction_end",
]);

function emptyBrokerCounters(): BoxSimBrokerCounters {
  return {
    malformedLines: 0,
    oversizedLines: 0,
    unterminatedLines: 0,
    unknownEvents: 0,
    unboundEvents: 0,
    orphanResponses: 0,
  };
}

function incrementBrokerCounter(
  machine: BoxSimCommandMachine,
  counter: keyof BoxSimBrokerCounters,
): void {
  const current = machine.daemon.brokerCounters[counter];
  machine.daemon.brokerCounters[counter] = current >= Number.MAX_SAFE_INTEGER
    ? current
    : current + 1;
}

function brokerTailCursor(machine: BoxSimCommandMachine): number {
  return machine.daemon.brokerJournal.at(-1)?.sequence ?? 0;
}

export function appendPiProcessExit(
  machine: BoxSimCommandMachine,
  exit: { code: number | null; signal: string | null } = { code: null, signal: null },
): void {
  const invocationId = machine.daemon.invocationId;
  const attemptId = machine.daemon.activeAttemptId;
  if (!invocationId || !attemptId) {
    incrementBrokerCounter(machine, "unboundEvents");
    machine.daemon.activeAttemptId = null;
    return;
  }
  machine.daemon.brokerJournal.push({
    sequence: brokerTailCursor(machine) + 1,
    invocationId,
    attemptId,
    kind: "pi_process_exit",
    exit,
  });
  machine.daemon.activeAttemptId = null;
}

/** Classify only known adapter commands. Unknown strings are never delegated to a host shell. */
export function classifyBoxCommand(command: string): BoxSimCommandKind {
  if (command.includes("pi.rpc.ndjson") && command.includes("offset=") && command.includes("head -c")) {
    return "read-events";
  }
  if (command.includes("mktemp -t companion-frame") && command.includes("data:%s;base64")) {
    return "capture-desktop-frame";
  }
  const brokerCommand = extractBrokerJson(command);
  if (brokerCommand?.type === "extension_ui_response") return "extension-ui-response";
  if (brokerCommand) return "rpc-command";
  // Layouts 13 and earlier remain recognized so the simulator can replay captured legacy commands.
  if (command.includes("Pi RPC did not acknowledge") && command.includes("rpc_start_size")) {
    return "rpc-command";
  }
  if (command.includes('> "$fifo"') && command.includes("test -p \"$fifo\"")) {
    return "extension-ui-response";
  }
  if (command.includes("companion-pi-journal") && command.includes("companion-pi-restarts")) {
    return "daemon-diagnostics";
  }
  if (
    command.includes("companion-pi-broker-ready")
    && command.includes("companion-pi-broker-unready")
  ) {
    return "daemon-state";
  }
  if (command.includes("companion-pi-rpc-ready") && command.includes("companion-pi-rpc-unready")) {
    return "daemon-state";
  }
  if (command.includes("companion-pi-warm-ready")) return "warm-daemon-ready";
  if (command.includes("companion-box-runnable")) return "box-runnable";
  if (command.includes("staged_credential_file=") && command.includes("systemctl --user daemon-reload")) {
    return "start-or-restart-daemon";
  }
  if (command.includes("Pi daemon is still active after stop")) return "stop-daemon";
  if (command.includes("reset-failed companion-pi-daemon.service") && command.includes("systemctl --user")) {
    return "heal-daemon";
  }
  if (command.includes('rm -f "$HOME/.companion/runtime/state/providers.env"')) {
    return "remove-provider-files";
  }
  if (command.includes("companion-archive-bytes") && command.includes("wc -c")) {
    return "measure-skill-archives";
  }
  if (command.includes("cat ") && command.includes(".part") && command.includes("; rm -f ")) {
    return "join-file-parts";
  }
  if (command.includes("skills.next") && command.includes("base64 --decode") && command.includes("tar --extract")) {
    return "prepare-skills";
  }
  if (command.includes("state/skill-archives") && command.includes("companion-provider-auth-present")) {
    return "clear-skill-archives";
  }
  if (command.trim() === 'mkdir -p "$HOME/.companion/bin"') return "mkdir-pi-bin";
  if (command.includes("ensure-pi-layout.sh") && /^\s*bash\s/.test(command)) return "install-layout";
  if (command.trim() === 'mkdir -p "$HOME/.companion/pi/extensions"') return "mkdir-extensions";
  return "unsupported";
}

function ok(stdout = ""): BoxSimCommandResult {
  return { success: true, exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string, exitCode = 1, stdout = ""): BoxSimCommandResult {
  return { success: false, exitCode, stdout, stderr };
}

/** Decode the exact POSIX single-quote form emitted by boxCompanionRuntime's shellQuote helper. */
export function decodeShellQuoted(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("'") || !trimmed.endsWith("'")) return null;
  return trimmed.slice(1, -1).split("'\"'\"'").join("'");
}

/** Pull the JSON value from the adapter's one `printf ... > "$fifo"` line. */
export function extractFifoJson(command: string): Record<string, unknown> | null {
  const prefix = "printf '%s\\n' ";
  const suffix = '> "$fifo"';
  const line = command.split(/\r?\n/).find((candidate) => {
    const trimmed = candidate.trim();
    return trimmed.startsWith(prefix) && trimmed.endsWith(suffix);
  });
  if (!line) return null;
  const trimmed = line.trim();
  const quoted = trimmed.slice(prefix.length, -suffix.length).trim();
  const decoded = decodeShellQuoted(quoted);
  if (decoded === null) return null;
  try {
    const parsed = JSON.parse(decoded) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Pull the base64-encoded JSON command from layout 14's owner-only socket client. */
export function extractBrokerJson(command: string): Record<string, unknown> | null {
  const match = /\bCOMPANION_PI_BROKER_COMMAND=('(?:[^']|'"'"')*')/.exec(command);
  const encoded = match?.[1] ? decodeShellQuoted(match[1]) : null;
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nextInvocationId(machine: BoxSimCommandMachine): string {
  machine.daemon.invocationCounter += 1;
  return machine.daemon.invocationCounter.toString(16).padStart(32, "0");
}

async function startDaemon(machine: BoxSimCommandMachine, restart: boolean): Promise<BoxSimCommandResult> {
  const stagedPath = ".companion/runtime/state/providers.env";
  const runtimePath = "run/user/1000/companion/providers.env";
  const staged = machine.persistentFiles.get(stagedPath);
  if (!staged && !machine.volatileFiles.has(runtimePath)) {
    return failed("Companion runtime credentials were not staged");
  }
  if (!machine.persistentFiles.has(".companion/pi/auth.json")) {
    return failed("Companion provider auth file is missing");
  }
  if (staged) {
    machine.persistentFiles.delete(stagedPath);
    machine.volatileFiles.set(runtimePath, Buffer.from(staged));
  }
  if (!restart && machine.daemon.status === "active") {
    // `systemctl start` is idempotent for an already active unit. In particular it does not create
    // a new Pi invocation; configuration changes use the explicit restart path.
    return ok();
  }
  if (restart) {
    machine.daemon.restartCount += 1;
    appendPiProcessExit(machine);
  }
  machine.daemon.status = "active";
  machine.daemon.invocationId = nextInvocationId(machine);
  machine.daemon.rpcReady = true;
  machine.daemon.activeAttemptId = null;
  try {
    if (restart) await machine.piController?.restart();
    else await machine.piController?.start();
  } catch {
    appendPiProcessExit(machine);
    machine.daemon.status = "failed";
    machine.daemon.rpcReady = false;
    machine.daemon.stderrLog += "simulated Pi controller failed to start\n";
    return failed("simulated Pi controller failed to start");
  }
  return ok();
}

function responseFor(command: Record<string, unknown>, data?: Record<string, unknown>): Record<string, unknown> {
  const type = typeof command.type === "string" ? command.type : "unknown";
  const response: Record<string, unknown> = {
    type: "response",
    command: type,
    id: command.id,
    success: true,
  };
  if (data !== undefined) response.data = data;
  return response;
}

function brokerFailureFor(
  command: Record<string, unknown>,
  code: string,
  message: string,
): Record<string, unknown> {
  return {
    ...responseFor(command),
    success: false,
    error: { code, message, ambiguous: false },
  };
}

function brokerNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function validBrokerCorrelationId(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0 && value.length <= 256)
    || (typeof value === "number" && Number.isFinite(value));
}

function executeBrokerControl(
  machine: BoxSimCommandMachine,
  command: Record<string, unknown>,
): BoxSimCommandResult | null {
  const tailCursor = brokerTailCursor(machine);
  switch (command.type) {
    case "broker_state":
      return ok(`${JSON.stringify(responseFor(command, {
        invocationId: machine.daemon.invocationId,
        activeAttemptId: machine.daemon.activeAttemptId,
        tailCursor,
        acknowledgedCursor: machine.daemon.brokerAcknowledgedCursor,
        counters: { ...machine.daemon.brokerCounters },
      }))}\n`);
    case "read_events": {
      const after = brokerNonNegativeInteger(command.after);
      const limit = command.limit === undefined ? BROKER_READ_LIMIT : brokerNonNegativeInteger(command.limit);
      if (
        after === null
        || limit === null
        || limit < 1
        || limit > BROKER_READ_LIMIT
        || after > tailCursor
      ) {
        return ok(`${JSON.stringify(brokerFailureFor(
          command,
          "invalid_command",
          "event journal cursor or limit is invalid",
        ))}\n`);
      }
      const effectiveAfter = Math.max(after, machine.daemon.brokerAcknowledgedCursor);
      const events: BoxSimBrokerJournalRecord[] = [];
      let responseBytes = 0;
      for (const event of machine.daemon.brokerJournal) {
        if (event.sequence <= effectiveAfter) continue;
        const cloned = structuredClone(event);
        const recordBytes = Buffer.byteLength(JSON.stringify(cloned), "utf8") + 1;
        if (events.length > 0 && responseBytes + recordBytes > BROKER_READ_BYTES) break;
        events.push(cloned);
        responseBytes += recordBytes;
        if (events.length === limit || responseBytes >= BROKER_READ_BYTES) break;
      }
      const nextCursor = events.at(-1)?.sequence ?? effectiveAfter;
      return ok(`${JSON.stringify(responseFor(command, {
        events,
        nextCursor,
        acknowledgedCursor: machine.daemon.brokerAcknowledgedCursor,
        hasMore: nextCursor < tailCursor,
      }))}\n`);
    }
    case "ack_events": {
      const through = brokerNonNegativeInteger(command.through);
      if (through === null || through > tailCursor) {
        return ok(`${JSON.stringify(brokerFailureFor(
          command,
          "invalid_command",
          "event acknowledgement cursor is invalid",
        ))}\n`);
      }
      machine.daemon.brokerAcknowledgedCursor = Math.max(
        machine.daemon.brokerAcknowledgedCursor,
        through,
      );
      return ok(`${JSON.stringify(responseFor(command, {
        acknowledgedCursor: machine.daemon.brokerAcknowledgedCursor,
      }))}\n`);
    }
    default:
      return null;
  }
}

async function executeRpc(
  machine: BoxSimCommandMachine,
  commandText: string,
): Promise<BoxSimCommandResult> {
  if (machine.daemon.status !== "active" || !machine.daemon.rpcReady) {
    return failed("Pi RPC is not ready");
  }
  const brokerCommand = extractBrokerJson(commandText);
  if (!brokerCommand) return failed("Pi broker command was not valid JSON");
  const brokerControl = executeBrokerControl(machine, brokerCommand);
  if (brokerControl) return brokerControl;
  if (brokerCommand.type === "prompt" && machine.daemon.activeAttemptId) {
    return ok(`${JSON.stringify(brokerFailureFor(
      brokerCommand,
      "attempt_active",
      "another Pi attempt is already active",
    ))}\n`);
  }
  const promptAttemptId = brokerCommand.type === "prompt"
    && typeof brokerCommand.attemptId === "string"
    ? brokerCommand.attemptId
    : null;
  // The production broker binds before writing to Pi: Pi may emit an event before its correlated
  // command response arrives. Roll this provisional binding back only when Pi proves rejection.
  if (promptAttemptId) machine.daemon.activeAttemptId = promptAttemptId;
  let response: Record<string, unknown> | null;
  try {
    response = await machine.piController?.handleRpc(brokerCommand) ?? null;
  } catch {
    appendPiProcessExit(machine);
    machine.daemon.status = "failed";
    machine.daemon.rpcReady = false;
    machine.daemon.stderrLog += "simulated Pi RPC controller failed\n";
    return failed("simulated Pi RPC controller failed");
  }
  if (!response) {
    response = brokerCommand.type === "get_state"
      ? responseFor(brokerCommand, { isStreaming: false, pendingMessageCount: 0 })
      : responseFor(brokerCommand);
  } else if (response.type !== "response") {
    response = responseFor(brokerCommand, response);
  }
  if (brokerCommand.type === "prompt") {
    response = response.success === true
      ? responseFor(brokerCommand, {
          attemptId: brokerCommand.attemptId,
          piAcknowledged: true,
        })
      : {
          ...responseFor(brokerCommand),
          success: false,
          error: {
            code: "pi_prompt_refused",
            message: "Pi refused the prompt",
            ambiguous: false,
          },
        };
    if (
      response.success !== true
      && promptAttemptId
      && machine.daemon.activeAttemptId === promptAttemptId
    ) {
      machine.daemon.activeAttemptId = null;
    }
  }
  return ok(`${JSON.stringify(response)}\n`);
}

async function executeExtensionResponse(
  machine: BoxSimCommandMachine,
  commandText: string,
): Promise<BoxSimCommandResult> {
  if (machine.daemon.status !== "active" || !machine.daemon.rpcReady) {
    return failed("Pi RPC is not ready");
  }
  const brokerCommand = extractBrokerJson(commandText);
  if (!brokerCommand) return failed("Pi extension response was not valid JSON");
  const requestedAttemptId = typeof brokerCommand.attemptId === "string"
    ? brokerCommand.attemptId
    : machine.daemon.activeAttemptId;
  if (
    (
      !requestedAttemptId
      || (
        brokerCommand.attemptId !== undefined
        && brokerCommand.attemptId !== machine.daemon.activeAttemptId
      )
    )
  ) {
    const code = machine.daemon.activeAttemptId ? "attempt_mismatch" : "no_active_attempt";
    return ok(`${JSON.stringify({
      ...responseFor(brokerCommand),
      success: false,
      error: { code, message: "decision does not match an active Pi attempt", ambiguous: false },
    })}\n`);
  }
  const response = brokerCommand.type === "extension_ui_response"
    && brokerCommand.response !== null
    && typeof brokerCommand.response === "object"
    && !Array.isArray(brokerCommand.response)
    ? brokerCommand.response as Record<string, unknown>
    : null;
  if (
    !response
    || response.type !== "extension_ui_response"
    || !validBrokerCorrelationId(response.id)
  ) {
    return ok(`${JSON.stringify(brokerFailureFor(
      brokerCommand,
      "invalid_command",
      "extension UI response is invalid",
    ))}\n`);
  }
  try {
    await machine.piController?.respondExtensionUi(response);
  } catch {
    return failed("simulated Pi extension response failed");
  }
  return ok(`${JSON.stringify(responseFor(brokerCommand, {
    attemptId: requestedAttemptId!,
    invocationId: machine.daemon.invocationId,
    delivered: true,
  }))}\n`);
}

function joinedFileCommand(machine: BoxSimCommandMachine, command: string): BoxSimCommandResult {
  const match = /\bcat\s+(.+?)\s+>\s+('(?:[^']|'\"'\"')*')\s*;/.exec(command);
  if (!match?.[1] || !match[2]) return failed("simulated file join could not parse command", 2);
  const target = decodeShellQuoted(match[2]);
  const quotedParts = match[1].match(/'(?:[^']|'\"'\"')*'/g) ?? [];
  const parts = quotedParts.map(decodeShellQuoted);
  if (!target || parts.some((part) => part === null)) {
    return failed("simulated file join could not parse paths", 2);
  }
  const chunks: Buffer[] = [];
  for (const part of parts as string[]) {
    const normalized = normalizeBoxPath(part);
    const bytes = machine.persistentFiles.get(normalized);
    if (!bytes) return failed(`simulated file part is missing: ${normalized}`);
    chunks.push(bytes);
  }
  machine.persistentFiles.set(normalizeBoxPath(target), Buffer.concat(chunks));
  for (const part of parts as string[]) machine.persistentFiles.delete(normalizeBoxPath(part));
  return ok();
}

function measuredArchives(machine: BoxSimCommandMachine): BoxSimCommandResult {
  const prefix = ".companion/runtime/state/skill-archives/";
  const lines = [...machine.persistentFiles.entries()]
    .filter(([path]) => path.startsWith(prefix) && path.endsWith(".tar.gz.b64"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes]) => `companion-archive-bytes ${path.slice(prefix.length)} ${bytes.byteLength}`);
  return ok(lines.length ? `${lines.join("\n")}\n` : "");
}

/** Execute one recognized command against virtual state. This function never invokes a shell. */
export async function executeBoxCommand(
  machine: BoxSimCommandMachine,
  command: string,
  _timeoutSeconds = 60,
): Promise<BoxSimCommandResult> {
  if (
    machine.daemon.status === "active"
    && machine.piController?.running === false
  ) {
    appendPiProcessExit(machine);
    machine.daemon.status = "failed";
    machine.daemon.rpcReady = false;
    machine.daemon.stderrLog += "simulated Pi process exited\n";
  }
  switch (classifyBoxCommand(command)) {
    case "box-runnable":
      return ok("companion-box-runnable\n");
    case "warm-daemon-ready": {
      const warm = machine.daemon.status === "active"
        && machine.daemon.rpcReady
        && machine.volatileFiles.has("run/user/1000/companion/providers.env");
      return ok(warm ? "companion-pi-warm-ready\n" : "");
    }
    case "mkdir-pi-bin":
      return ok();
    case "install-layout":
      if (!machine.persistentFiles.has(".companion/bin/ensure-pi-layout.sh")) {
        return failed("staged Pi layout script is missing");
      }
      machine.layoutInstalled = true;
      return ok();
    case "mkdir-extensions":
      machine.extensionDirectoryCreated = true;
      return ok();
    case "clear-skill-archives": {
      const prefix = ".companion/runtime/state/skill-archives/";
      for (const path of machine.persistentFiles.keys()) {
        if (path.startsWith(prefix)) machine.persistentFiles.delete(path);
      }
      return ok(machine.persistentFiles.has(".companion/pi/auth.json")
        ? "companion-provider-auth-present\n"
        : "");
    }
    case "measure-skill-archives":
      return measuredArchives(machine);
    case "join-file-parts":
      return joinedFileCommand(machine, command);
    case "prepare-skills":
      for (const path of machine.persistentFiles.keys()) {
        if (path.startsWith(".companion/runtime/state/skill-archives/")) {
          machine.persistentFiles.delete(path);
        }
      }
      machine.persistentFiles.set(".companion/runtime/skills/.box-sim-prepared", Buffer.alloc(0));
      return ok();
    case "start-or-restart-daemon":
      return startDaemon(machine, command.includes("systemctl --user restart"));
    case "daemon-state": {
      const layout14 = command.includes("companion-pi-broker-ready");
      const marker = layout14
        ? machine.daemon.rpcReady ? "companion-pi-broker-ready" : "companion-pi-broker-unready"
        : machine.daemon.rpcReady ? "companion-pi-rpc-ready" : "companion-pi-rpc-unready";
      return ok(`${machine.daemon.status === "active" ? "active" : machine.daemon.status}\n${marker}\n`);
    }
    case "rpc-command":
      return executeRpc(machine, command);
    case "extension-ui-response":
      return executeExtensionResponse(machine, command);
    case "heal-daemon":
      return startDaemon(machine, machine.daemon.status === "active");
    case "daemon-diagnostics": {
      const status = machine.daemon.status;
      const lines = [
        `companion-pi-state ${status}`,
        `companion-pi-status Active: ${status}`,
        `companion-pi-restarts ${machine.daemon.restartCount}`,
      ];
      const stderr = machine.daemon.stderrLog.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (stderr) lines.push(`companion-pi-stderr ${stderr.replaceAll("providers.env", "[redacted]")}`);
      return ok(`${lines.join("\n")}\n`);
    }
    case "remove-provider-files":
      machine.persistentFiles.delete(".companion/runtime/state/providers.env");
      machine.volatileFiles.delete("run/user/1000/companion/providers.env");
      return ok();
    case "stop-daemon":
      try {
        await machine.piController?.stop();
      } catch {
        return failed("simulated Pi controller failed to stop");
      }
      appendPiProcessExit(machine);
      machine.daemon.status = "inactive";
      machine.daemon.invocationId = null;
      machine.daemon.rpcReady = false;
      machine.daemon.activeAttemptId = null;
      machine.volatileFiles.clear();
      return ok();
    case "read-events": {
      const requested = Number.parseInt(/\boffset=(\d+)/.exec(command)?.[1] ?? "0", 10);
      const log = Buffer.from(machine.daemon.rpcLog, "utf8");
      const offset = requested > log.byteLength ? 0 : requested;
      const chunk = log.subarray(offset, offset + 262_144);
      return ok(Buffer.concat([Buffer.from(`${offset}\n`, "utf8"), chunk]).toString("utf8"));
    }
    case "capture-desktop-frame":
      return ok(machine.desktopFrameDataUrl ? `${machine.desktopFrameDataUrl}\n` : "");
    case "unsupported": {
      const digest = sha256(command);
      machine.unknownCommandDigests.push(digest);
      return failed(`unsupported simulated Box command (${digest.slice(0, 12)})`, 127);
    }
  }
}
