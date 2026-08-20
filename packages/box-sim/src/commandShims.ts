import { createHash } from "node:crypto";

import type { BoxSimCommandResult, BoxSimPiController } from "./protocol";

export type BoxSimCommandKind =
  | "box-runnable"
  | "warm-daemon-ready"
  | "mkdir-pi-bin"
  | "install-layout"
  | "probe-layout"
  | "mkdir-extensions"
  | "clear-skill-archives"
  | "measure-skill-archives"
  | "join-file-parts"
  | "prepare-skills"
  | "start-or-restart-daemon"
  | "daemon-state"
  | "rpc-command"
  | "extension-ui-response"
  | "daemon-diagnostics"
  | "remove-provider-files"
  | "stop-daemon"
  | "prepare-attachments"
  | "lock-attachments"
  | "clear-outbox"
  | "list-outbox"
  | "read-outbox-chunk"
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
  unknownCommandDigests: string[];
  /**
   * Truncate every outbox chunk to this many raw bytes before encoding it, simulating the command
   * transport's demonstrated habit of mangling large bodies. Null leaves the transport honest.
   */
  mangleOutboxChunkBytes: number | null;
  /** Directories whose write bit was cleared; their entries can no longer be unlinked. */
  readOnlyDirectories: Set<string>;
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
      stderrLog: "",
    },
    layoutInstalled: false,
    extensionDirectoryCreated: false,
    unknownCommandDigests: [],
    mangleOutboxChunkBytes: null,
    readOnlyDirectories: new Set<string>(),
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
  const brokerCommand = extractBrokerJson(command);
  if (brokerCommand?.type === "extension_ui_response") return "extension-ui-response";
  if (brokerCommand) return "rpc-command";
  if (command.includes("companion-pi-journal") && command.includes("companion-pi-restarts")) {
    return "daemon-diagnostics";
  }
  // Activation now waits for the ready/unready marker inside the same Box command. Match its
  // credential and daemon-reload side effects before the narrower read-only status probe.
  if (command.includes("staged_credential_file=") && command.includes("systemctl --user daemon-reload")) {
    return "start-or-restart-daemon";
  }
  if (
    command.includes("companion-pi-broker-ready")
    && command.includes("companion-pi-broker-unready")
  ) {
    return "daemon-state";
  }
  if (command.includes("companion-pi-warm-ready")) return "warm-daemon-ready";
  if (command.includes("companion-box-runnable")) return "box-runnable";
  if (command.includes("Pi daemon is still active after stop")) return "stop-daemon";
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
  if (command.includes("companion-outbox-manifest-begin")) return "list-outbox";
  if (command.includes("companion-outbox-chunk-begin")) return "read-outbox-chunk";
  if (command.includes('dir="$HOME/outbox"') && command.includes("find \"$dir\" -mindepth 1 -delete")) {
    return "clear-outbox";
  }
  if (/rm -rf ['"]attachments/.test(command) && command.includes("mkdir -p")) {
    return "prepare-attachments";
  }
  if (command.includes("chmod a-w") || command.includes("chmod -R a-w")) return "lock-attachments";
  if (command.trim() === 'mkdir -p "$HOME/.companion/bin"') return "mkdir-pi-bin";
  if (command.includes("ensure-pi-layout.sh") && /^\s*bash\s/.test(command)) return "install-layout";
  if (
    command.includes("pi-layout.version")
    && command.includes("companion-layout-unchanged")
    && command.includes("companion-pi-broker.mjs")
  ) return "probe-layout";
  if (command.trim() === 'mkdir -p "$HOME/.companion/pi/extensions"') return "mkdir-extensions";
  return "unsupported";
}

function ok(stdout = ""): BoxSimCommandResult {
  return { success: true, exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string, exitCode = 1, stdout = ""): BoxSimCommandResult {
  return { success: false, exitCode, stdout, stderr };
}

function installedLayout(machine: BoxSimCommandMachine): BoxSimCommandResult {
  const script = machine.persistentFiles.get(".companion/bin/ensure-pi-layout.sh")?.toString("utf8");
  if (!script) return failed("staged Pi layout script is missing");
  const expected = /(?:^|\n)expected_layout='([^']*)'/.exec(script)?.[1];
  const base = /(?:^|\n)base_layout='([^']*)'/.exec(script)?.[1];
  const markerPath = ".companion/runtime/state/pi-layout.version";
  const recorded = machine.persistentFiles.get(markerPath)?.toString("utf8").trim() ?? "";
  const brokerReady = machine.persistentFiles.has(".companion/bin/companion-pi-broker.mjs")
    && machine.persistentFiles.has(".companion/bin/pi-daemon")
    && machine.persistentFiles.has(".config/systemd/user/companion-pi-daemon.service");
  machine.layoutInstalled = true;
  if (expected && recorded === expected && brokerReady) {
    return ok("companion-layout-unchanged\n");
  }
  writeSimulatedLayoutFiles(machine, expected);
  if (expected && base && recorded.split(":overlay=")[0] === base) {
    return ok("companion-layout-overlay\n");
  }
  return ok("companion-layout-base\n");
}

function probedLayout(machine: BoxSimCommandMachine, command: string): BoxSimCommandResult {
  const quoted = /\[ "\$recorded" = ('(?:\\'|[^'])*') \]/.exec(command)?.[1];
  const expected = quoted ? decodeShellQuoted(quoted) : undefined;
  const recorded = machine.persistentFiles.get(".companion/runtime/state/pi-layout.version")
    ?.toString("utf8").trim() ?? "";
  const brokerReady = machine.persistentFiles.has(".companion/bin/companion-pi-broker.mjs")
    && machine.persistentFiles.has(".companion/bin/pi-daemon")
    && machine.persistentFiles.has(".config/systemd/user/companion-pi-daemon.service");
  if (expected && recorded === expected && brokerReady) {
    return ok("companion-layout-unchanged\n");
  }
  return ok();
}

function writeSimulatedLayoutFiles(machine: BoxSimCommandMachine, expected?: string): void {
  machine.persistentFiles.set(".companion/bin/companion-pi-broker.mjs", Buffer.from("broker\n"));
  machine.persistentFiles.set(".companion/bin/pi-daemon", Buffer.from("daemon\n"));
  machine.persistentFiles.set(
    ".config/systemd/user/companion-pi-daemon.service",
    Buffer.from("[Service]\n"),
  );
  if (expected) {
    machine.persistentFiles.set(
      ".companion/runtime/state/pi-layout.version",
      Buffer.from(`${expected}\n`),
    );
  }
}

/** The staged attachment directory a prepare command names, relative to the Box home. */
function attachmentDirectory(command: string): string | null {
  const match = /rm -rf ('(?:[^']|'"'"')*')/.exec(command);
  return match?.[1] ? decodeShellQuoted(match[1]) : null;
}

/** The directory a lock command applies `chmod a-w` to. */
function lockedAttachmentDirectory(command: string): string | null {
  const match = /chmod (?:-R )?a-w ('(?:[^']|'"'"')*')|find ('(?:[^']|'"'"')*') -type f/.exec(command);
  const quoted = match?.[1] ?? match?.[2];
  return quoted ? decodeShellQuoted(quoted) : null;
}

/** The file, chunk index, and chunk size one outbox read command asks for. */
function outboxChunkRequest(
  command: string,
): { name: string; index: number; chunkBytes: number } | null {
  const encoded = /base64 -d\b[\s\S]*?'([A-Za-z0-9+/]+={0,2})'/.exec(command)
    ?? /'([A-Za-z0-9+/]+={0,2})' \| base64 -d/.exec(command);
  const chunk = /bs=(\d+)/.exec(command);
  const skip = /skip=(\d+)/.exec(command);
  if (!encoded?.[1] || !chunk?.[1] || !skip?.[1]) return null;
  return {
    name: Buffer.from(encoded[1], "base64").toString("utf8"),
    index: Number(skip[1]),
    chunkBytes: Number(chunk[1]),
  };
}

/** Decode the exact POSIX single-quote form emitted by boxCompanionRuntime's shellQuote helper. */
export function decodeShellQuoted(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("'") || !trimmed.endsWith("'")) return null;
  return trimmed.slice(1, -1).split("'\"'\"'").join("'");
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
    return ok("active\ncompanion-pi-broker-ready\n");
  }
  if (restart) {
    machine.daemon.restartCount += 1;
    appendPiProcessExit(machine);
  }
  machine.daemon.status = "active";
  machine.daemon.invocationId = nextInvocationId(machine);
  // Match SegmentedCompanionPiJournal.beginInvocation(): a new broker invocation cannot resume
  // the attempt bound by its predecessor, so its remaining records are retired before Pi can emit
  // anything for the new invocation. Without this, the simulator poisons an explicit Retry with a
  // permanently non-empty broker queue even though the production broker starts cleanly.
  machine.daemon.brokerAcknowledgedCursor = brokerTailCursor(machine);
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
  return ok("active\ncompanion-pi-broker-ready\n");
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function executeBrokerControl(
  machine: BoxSimCommandMachine,
  command: Record<string, unknown>,
): Promise<BoxSimCommandResult | null> {
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
    case "runtime_state": {
      let piState: Record<string, unknown> | null;
      try {
        piState = await machine.piController?.handleRpc({
          id: command.id,
          type: "get_state",
        }) ?? responseFor({ id: command.id, type: "get_state" }, {
          model: { input: [] },
          isStreaming: false,
          isCompacting: false,
          pendingMessageCount: 0,
        });
      } catch {
        return ok(`${JSON.stringify(brokerFailureFor(
          command,
          "broker_unavailable",
          "Pi broker command failed",
        ))}\n`);
      }
      const state = piState.success === true ? objectRecord(piState.data) : null;
      if (!state) {
        return ok(`${JSON.stringify(brokerFailureFor(
          command,
          "pi_state_unavailable",
          "Pi state is unavailable",
        ))}\n`);
      }
      const model = objectRecord(state.model);
      const modelInput = Array.isArray(model?.input)
        ? structuredClone(model.input)
        : [];
      return ok(`${JSON.stringify(responseFor(command, {
        invocationId: machine.daemon.invocationId,
        activeAttemptId: machine.daemon.activeAttemptId,
        tailCursor,
        acknowledgedCursor: machine.daemon.brokerAcknowledgedCursor,
        counters: { ...machine.daemon.brokerCounters },
        modelInput,
      }))}\n`);
    }
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
  const brokerControl = await executeBrokerControl(machine, brokerCommand);
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
          invocationId: machine.daemon.invocationId,
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
      return installedLayout(machine);
    case "probe-layout":
      return probedLayout(machine, command);
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
      const marker = machine.daemon.rpcReady
        ? "companion-pi-broker-ready"
        : "companion-pi-broker-unready";
      return ok(`${machine.daemon.status === "active" ? "active" : machine.daemon.status}\n${marker}\n`);
    }
    case "rpc-command":
      return executeRpc(machine, command);
    case "extension-ui-response":
      return executeExtensionResponse(machine, command);
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
    case "prepare-attachments": {
      // The staging root is replaced, not added to, so a retried attempt stages exactly what it was
      // given. A directory whose write bit was cleared cannot have its entries unlinked, which is
      // what makes a re-stage fail on a real Box -- model that rather than deleting unconditionally.
      const directory = attachmentDirectory(command);
      if (!directory) return failed("simulated attachment directory is unreadable");
      for (const locked of machine.readOnlyDirectories) {
        if (locked === directory || locked.startsWith(`${directory}/`)) {
          return failed(`rm: cannot remove '${locked}': Permission denied`);
        }
      }
      for (const path of [...machine.persistentFiles.keys()]) {
        if (path.startsWith(`${directory}/`)) machine.persistentFiles.delete(path);
      }
      return ok();
    }
    case "lock-attachments": {
      // `chmod a-w` over files only leaves the directory writable; a recursive chmod would also
      // clear the directory's own write bit, which is the case this models.
      const directory = lockedAttachmentDirectory(command);
      if (directory && !command.includes("-type f")) machine.readOnlyDirectories.add(directory);
      return ok();
    }
    case "clear-outbox":
      for (const path of [...machine.persistentFiles.keys()]) {
        if (path.startsWith("outbox/")) machine.persistentFiles.delete(path);
      }
      return ok();
    case "list-outbox": {
      const lines = [...machine.persistentFiles.entries()]
        .filter(([path]) => path.startsWith("outbox/") && !path.slice(7).includes("/"))
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([path, bytes]) => [
          sha256(bytes),
          String(bytes.byteLength),
          Buffer.from(path.slice("outbox/".length), "utf8").toString("base64"),
        ].join(" "));
      return ok([
        "companion-outbox-manifest-begin",
        ...lines,
        "companion-outbox-manifest-end",
        "",
      ].join("\n"));
    }
    case "read-outbox-chunk": {
      const request = outboxChunkRequest(command);
      if (!request) return failed("simulated outbox chunk request is unreadable");
      const bytes = machine.persistentFiles.get(`outbox/${request.name}`);
      // `dd` on a missing file writes nothing and this shim answers the same way, so the caller's
      // whole-file digest check is what reports the loss.
      const slice = bytes
        ? bytes.subarray(
            request.index * request.chunkBytes,
            (request.index + 1) * request.chunkBytes,
          )
        : Buffer.alloc(0);
      const encoded = machine.mangleOutboxChunkBytes === null
        ? slice.toString("base64")
        : slice.subarray(0, machine.mangleOutboxChunkBytes).toString("base64");
      return ok([
        "companion-outbox-chunk-begin",
        encoded,
        "companion-outbox-chunk-end",
        "",
      ].join("\n"));
    }
    case "unsupported": {
      const digest = sha256(command);
      machine.unknownCommandDigests.push(digest);
      return failed(`unsupported simulated Box command (${digest.slice(0, 12)})`, 127);
    }
  }
}
