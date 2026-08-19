import { createHash } from "node:crypto";
import {
  companionConfigProposalMessageSchema,
  companionRoutineProposalMessageSchema,
  companionToolRunKind,
  type CompanionConfigProposal,
  type CompanionRoutineProposal,
  type CompanionToolRunKind,
} from "@companion/contracts";
import {
  genericRuntimeVisibleTextRedactor,
  type RuntimeVisibleTextRedactor,
} from "./projectionRedaction";

const SUPPORTED_EVENT_TYPES = new Set([
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

const ACTIVITY_EVENT_TYPES = new Set([
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
]);

export interface PiBrokerCounters {
  malformedLines: number;
  oversizedLines: number;
  unterminatedLines: number;
  unknownEvents: number;
  unboundEvents: number;
  orphanResponses: number;
}

export type ValidatedPiJournalRecord =
  | {
    sequence: bigint;
    invocationId: string;
    attemptId: string;
    kind: "pi_event";
    event: Record<string, unknown>;
  }
  | {
    sequence: bigint;
    invocationId: string;
    attemptId: string;
    kind: "pi_process_exit";
    exit: { code: number | null; signal: string | null };
  };

export interface ValidatedPiJournalRead {
  events: ValidatedPiJournalRecord[];
  nextCursor: bigint;
  acknowledgedCursor: bigint;
  hasMore: boolean;
}

export type RuntimePiProjection =
  | {
    sequence: bigint;
    type: "assistant";
    entry_key: string;
    content: string;
    reasoning?: string;
  }
  | {
    sequence: bigint;
    type: "tool";
    entry_key: string;
    content: string;
    tool: {
      call_id: string | null;
      kind: CompanionToolRunKind;
      name: string;
      /** Empty inherits the stored title, so a progress update never overwrites what started. */
      title: string;
      status: "running" | "ok" | "error" | "timeout";
      /** Null inherits the stored detail, so a settlement keeps the last progress it followed. */
      detail: string | null;
      screenshot: null;
    };
  }
  | {
    sequence: bigint;
    type: "decision";
    entry_key: string;
    request_key: string;
    request_kind: "question" | "confirmation" | "config_proposal" | "routine_proposal";
    content: string;
    proposal?: CompanionConfigProposal | CompanionRoutineProposal;
    decision: {
      request_id: string;
      kind: "shell" | "file" | "question" | "config" | "routine";
      name: string;
      title: string;
      detail: string | null;
      status: "pending";
      answer: null;
      decided_by_id: null;
      decided_by_name: null;
      decided_at: null;
      expires_at: string;
      proposal: CompanionConfigProposal | CompanionRoutineProposal | null;
    };
    expires_at: string;
  }
  | { sequence: bigint; type: "activity"; event_type: string }
  | { sequence: bigint; type: "settled" }
  | { sequence: bigint; type: "process_exit"; code: number | null; signal: string | null };

export interface ClassifiedPiJournalPage {
  projections: RuntimePiProjection[];
  throughCursor: bigint;
  unknownEvents: number;
  activity: boolean;
  needsInput: boolean;
  settled: boolean;
  processExit: { code: number | null; signal: string | null } | null;
}

export class PiJournalValidationError extends Error {
  constructor(message = "Pi broker returned an invalid journal page") {
    super(message);
    this.name = "PiJournalValidationError";
  }
}

export class PiJournalCorrelationError extends Error {
  constructor() {
    super("Pi broker journal correlation did not match the active attempt");
    this.name = "PiJournalCorrelationError";
  }
}

export class PiProjectionSecurityError extends Error {
  constructor() {
    super("Pi emitted a decision identifier that cannot be persisted safely");
    this.name = "PiProjectionSecurityError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PiJournalValidationError();
  }
  return value as Record<string, unknown>;
}

function safeCursor(value: unknown): bigint {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PiJournalValidationError();
  return BigInt(value as number);
}

function opaqueId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) throw new PiJournalValidationError();
  return value;
}

function nullableExitCode(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new PiJournalValidationError();
  return value as number;
}

function nullableSignal(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64 || /[\r\n]/.test(value)) {
    throw new PiJournalValidationError();
  }
  return value;
}

export function validatePiJournalRead(input: {
  value: unknown;
  after: bigint;
  attemptId: string;
  invocationId: string;
}): ValidatedPiJournalRead {
  const page = object(input.value);
  if (!Array.isArray(page.events) || typeof page.hasMore !== "boolean") {
    throw new PiJournalValidationError();
  }
  if (page.events.length > 256) throw new PiJournalValidationError();
  const nextCursor = safeCursor(page.nextCursor);
  const acknowledgedCursor = safeCursor(page.acknowledgedCursor);
  if (
    acknowledgedCursor > nextCursor
    || acknowledgedCursor > input.after
    || nextCursor < input.after
  ) {
    throw new PiJournalValidationError();
  }

  let previous = input.after;
  const events = page.events.map((raw): ValidatedPiJournalRecord => {
    const row = object(raw);
    const sequence = safeCursor(row.sequence);
    if (sequence <= previous || sequence > nextCursor) throw new PiJournalValidationError();
    previous = sequence;
    const invocationId = opaqueId(row.invocationId);
    const attemptId = opaqueId(row.attemptId);
    if (invocationId !== input.invocationId || attemptId !== input.attemptId) {
      throw new PiJournalCorrelationError();
    }
    if (row.kind === "pi_event") {
      const event = object(row.event);
      return { sequence, invocationId, attemptId, kind: "pi_event", event };
    }
    if (row.kind === "pi_process_exit") {
      const exit = object(row.exit);
      return {
        sequence,
        invocationId,
        attemptId,
        kind: "pi_process_exit",
        exit: { code: nullableExitCode(exit.code), signal: nullableSignal(exit.signal) },
      };
    }
    throw new PiJournalValidationError();
  });
  if (
    (events.length === 0 && nextCursor !== input.after)
    || (events.length > 0 && events.at(-1)?.sequence !== nextCursor)
  ) {
    throw new PiJournalValidationError();
  }
  return { events, nextCursor, acknowledgedCursor, hasMore: page.hasMore };
}

const DECISION_TITLE = /^companion:(shell|file|question|config|routine):([A-Za-z0-9._-]{1,120})$/;
const MAX_ASSISTANT = 100_000;
const MAX_REASONING = 16_000;
const MAX_REASONING_BYTES = 48_000;
const MAX_DECISION_DETAIL = 8_000;
/** A delegated run's task, and then its progress, are the only tool payloads a transcript keeps. */
const MAX_SUBAGENT_DETAIL = 8_000;
/** One line naming the child agent. Anything longer is a payload, not a name. */
const MAX_SUBAGENT_AGENT = 120;
const MAX_TITLE = 300;
const DEFAULT_DECISION_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Every cut here lands on a JavaScript code unit, and an emoji is two of them. Half a surrogate pair
 * is not text PostgreSQL will accept inside `jsonb`, so a cut through one would fail the whole event
 * batch — deterministically, on every re-read of the same journal page, until the turn stalls.
 * Dropping the orphan costs one character of provider output and cannot fail.
 */
function withoutOrphanSurrogate(value: string, edge: "start" | "end"): string {
  if (edge === "end") {
    const last = value.charCodeAt(value.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
  }
  const first = value.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? value.slice(1) : value;
}

function bounded(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const head = withoutOrphanSurrogate(value.slice(0, Math.max(0, maximum - 12)), "end");
  return `${head}\n[truncated]`;
}

/** Progress is read from its end: the newest line is the one that says where a run has got to. */
function boundedTail(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const tail = withoutOrphanSurrogate(
    value.slice(value.length - Math.max(0, maximum - 12)),
    "start",
  );
  return `[truncated]\n${tail}`;
}

function boundedReasoning(value: string): string {
  const byCharacters = bounded(value, MAX_REASONING);
  if (Buffer.byteLength(byCharacters, "utf8") <= MAX_REASONING_BYTES) return byCharacters;
  let low = 0;
  let high = byCharacters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(`${byCharacters.slice(0, middle)}\n[truncated]`, "utf8") <= MAX_REASONING_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${byCharacters.slice(0, low)}\n[truncated]`;
}

function optionalId(value: unknown, maximum = 200): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) return null;
  return normalized.slice(0, maximum);
}

function decisionRequestKey(
  value: unknown,
  redact: RuntimeVisibleTextRedactor,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) return null;
  // Decision ids are round-tripped back to Pi. Never truncate provider input: doing so can both
  // break correlation and turn a full credential value into an undetectable persisted prefix.
  if (normalized.length > 200 || redact(normalized) !== normalized) {
    throw new PiProjectionSecurityError();
  }
  return normalized;
}

function toolKind(name: string): CompanionToolRunKind {
  return companionToolRunKind(name);
}

function safeToolMetadata(kind: CompanionToolRunKind): { name: string; title: string } {
  switch (kind) {
    case "shell": return { name: "shell", title: "Shell command" };
    case "file": return { name: "file", title: "File operation" };
    case "browse": return { name: "browse", title: "Browser operation" };
    case "computer": return { name: "computer", title: "Computer action" };
    case "subagent": return { name: "subagent", title: "Subagent run" };
    default: return { name: "tool", title: "Tool operation" };
  }
}

function hashedCallId(value: unknown): string | null {
  const opaque = optionalId(value);
  return opaque
    ? `sha256:${createHash("sha256").update(opaque).digest("hex").slice(0, 32)}`
    : null;
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function assistantProjection(
  sequence: bigint,
  event: Record<string, unknown>,
  redact: RuntimeVisibleTextRedactor,
): Extract<RuntimePiProjection, { type: "assistant" }> | null {
  if (event.type !== "message_end") return null;
  if (!event.message || typeof event.message !== "object" || Array.isArray(event.message)) return null;
  const message = event.message as Record<string, unknown>;
  if (message.role !== "assistant") return null;
  const blocks = contentBlocks(message);
  const text = (typeof message.content === "string" ? message.content : blocks
    .filter((block) => block.type === "text")
    .map((block) => typeof block.text === "string" ? block.text : "")
    .join(""))
    .trim();
  const reasoning = blocks
    .filter((block) => block.type === "thinking"
      || block.type === "reasoning"
      || block.type === "redacted_thinking")
    .map((block) => typeof block.thinking === "string"
      ? block.thinking
      : typeof block.text === "string" ? block.text : "")
    .join("")
    .trim();
  const content = redact(text || reasoning);
  if (!content) return null;
  const redactedReasoning = reasoning ? redact(reasoning) : "";
  return {
    sequence,
    type: "assistant",
    entry_key: `assistant:${sequence}`,
    content: bounded(content, MAX_ASSISTANT),
    ...(text && redactedReasoning ? { reasoning: boundedReasoning(redactedReasoning) } : {}),
  };
}

/** The argument object of a tool call, under whichever of Pi's names carries it. */
function toolArguments(event: Record<string, unknown>): Record<string, unknown> | null {
  for (const candidate of [event.args, event.arguments, event.input, event.toolInput]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

function firstText(
  source: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * The text of a tool payload, whether Pi sent a string or its content-block shape.
 *
 * `tool_execution_update` carries `partialResult: { content: [{ type: "text", text }] }` — see the
 * captured event contract in `packages/box-sim/fixtures/pi/official-events.jsonl`. Reading only the
 * flat string spellings is how a progress line silently becomes no progress at all, so the block
 * shape is what this reads first.
 */
function payloadText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const blocks = (value as Record<string, unknown>).content;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .map((block) =>
      block && typeof block === "object" && !Array.isArray(block)
        && (block as Record<string, unknown>).type === "text"
        && typeof (block as Record<string, unknown>).text === "string"
        ? (block as Record<string, unknown>).text as string
        : "")
    .join("")
    .trim();
  return text || null;
}

/** The newest thing a running tool has said about itself, under any shape Pi reports it in. */
function progressText(event: Record<string, unknown>): string | null {
  for (const candidate of [
    event.partialResult,
    event.partial_result,
    event.partialOutput,
    event.partial_output,
    event.output,
    event.content,
    event.message,
  ]) {
    const text = payloadText(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * What a delegated run is, in one line: which agent, and the first line of what it was asked to do.
 *
 * Everything here is provider text, so it is redacted before it is bounded and bounded before it is
 * persisted. A run whose arguments say neither is still shown — as a subagent run that started,
 * which is more than a reader learns from a spinner with no card at all.
 */
function subagentStart(
  event: Record<string, unknown>,
  fallbackTitle: string,
  redact: RuntimeVisibleTextRedactor,
): { title: string; detail: string | null } {
  const args = toolArguments(event);
  const rawAgent = firstText(args, ["agent", "agent_name", "agentName", "name"]);
  const rawTask = firstText(args, ["task", "prompt", "description", "instructions"]);
  // Redact before cutting, never after. The turn dictionary removes exact values by whole-string
  // match, so a credential that straddles a cut no longer matches the value it came from and its
  // surviving half is what gets persisted. `decisionRequestKey` refuses provider input for the same
  // reason; here there is a safe answer, which is to scrub first and bound the scrubbed text.
  const agent = rawAgent
    ? withoutOrphanSurrogate(firstLine(redact(rawAgent)).slice(0, MAX_SUBAGENT_AGENT), "end")
    : null;
  const task = rawTask ? redact(rawTask) : null;
  const headline = [agent, task ? firstLine(task) : null].filter(Boolean).join(": ");
  return {
    title: headline ? bounded(headline, MAX_TITLE) : fallbackTitle,
    detail: task ? bounded(task, MAX_SUBAGENT_DETAIL) : null,
  };
}

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim())?.trim() ?? "";
}

/**
 * One tool run, as the transcript stores it.
 *
 * Arguments are never persisted for a tool the catalog only knows generically: a shell command or a
 * file path is the payload most likely to carry a credential, and the card says enough without it.
 * A delegated agent is the exception, because "a tool ran for six minutes" tells a reader nothing
 * about what their Companion is doing while it runs. So a subagent run carries its task and its
 * progress, redacted and bounded, and settles in place through the shared `call_id`.
 *
 * Empty title, empty content, and null detail are inherit sentinels the projection reads as "keep
 * what the row already holds". Classification stays stateless per event: nothing here remembers a
 * previous event, so replaying a page produces byte-identical projections.
 */
function toolProjection(
  sequence: bigint,
  event: Record<string, unknown>,
  redact: RuntimeVisibleTextRedactor,
): Extract<RuntimePiProjection, { type: "tool" }> | null {
  if (
    event.type !== "tool_execution_start"
    && event.type !== "tool_execution_update"
    && event.type !== "tool_execution_end"
  ) return null;
  const callId = hashedCallId(event.toolCallId ?? event.tool_call_id ?? event.callId);
  const rawName = optionalId(event.toolName ?? event.tool_name ?? event.name, 120) ?? "tool";
  // Transcript entry keys have a strict DB-safe grammar. Provider-controlled
  // call ids remain structured metadata, never part of the idempotency key.
  const entryKey = `tool:${sequence}`;
  const kind = toolKind(rawName);
  const { name, title } = safeToolMetadata(kind);
  // Only a delegated run reports progress. Every other kind's update stays what it has always been:
  // activity, which keeps the turn alive without touching the card.
  if (event.type === "tool_execution_update") {
    // Without a call id there is no card to merge into, and one row per progress line would bury
    // the thread. Progress is only ever an update to a run that already named itself.
    if (kind !== "subagent" || !callId) return null;
    const progress = progressText(event);
    // Emptiness is judged after redaction, not before. A line that was entirely a credential leaves
    // nothing to show, and an empty detail is not the inherit sentinel — it would overwrite the task
    // the card is holding with nothing, and take the disclosure with it.
    const scrubbed = progress ? redact(progress).trim() : "";
    if (!scrubbed) return null;
    return {
      sequence,
      type: "tool",
      entry_key: entryKey,
      content: "",
      tool: {
        call_id: callId,
        kind,
        name,
        title: "",
        status: "running",
        detail: boundedTail(scrubbed, MAX_SUBAGENT_DETAIL),
        screenshot: null,
      },
    };
  }
  if (event.type === "tool_execution_start") {
    const started = kind === "subagent"
      ? subagentStart(event, title, redact)
      : { title, detail: null };
    return {
      sequence,
      type: "tool",
      entry_key: entryKey,
      content: started.title,
      tool: {
        call_id: callId,
        kind,
        name,
        title: started.title,
        status: "running",
        detail: started.detail,
        screenshot: null,
      },
    };
  }
  const failed = event.isError === true || event.is_error === true || event.success === false;
  // A settled subagent keeps the headline and the last progress it was already showing.
  const settledTitle = kind === "subagent" ? "" : title;
  return {
    sequence,
    type: "tool",
    entry_key: entryKey,
    content: settledTitle,
    tool: {
      call_id: callId,
      kind,
      name,
      title: settledTitle,
      status: failed ? "error" : "ok",
      detail: null,
      screenshot: null,
    },
  };
}

function parseRoutineProposalMessage(
  message: unknown,
  redact: RuntimeVisibleTextRedactor,
): { summary: string; proposal: CompanionRoutineProposal } | null {
  if (typeof message !== "string") return null;
  const raw = message.trim();
  if (!raw || redact(raw) !== raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const envelope = companionRoutineProposalMessageSchema.safeParse(parsed);
  if (!envelope.success) return null;
  const serialized = JSON.stringify(envelope.data);
  if (redact(serialized) !== serialized) return null;
  return envelope.data;
}

function parseConfigProposalMessage(
  message: unknown,
  redact: RuntimeVisibleTextRedactor,
): { summary: string; proposal: CompanionConfigProposal } | null {
  if (typeof message !== "string") return null;
  const raw = message.trim();
  if (!raw || redact(raw) !== raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const envelope = companionConfigProposalMessageSchema.safeParse(parsed);
  if (!envelope.success) return null;
  const serialized = JSON.stringify(envelope.data);
  if (redact(serialized) !== serialized) return null;
  return envelope.data;
}

function decisionProjection(
  sequence: bigint,
  event: Record<string, unknown>,
  now: Date,
  redact: RuntimeVisibleTextRedactor,
): Extract<RuntimePiProjection, { type: "decision" }> | null {
  if (event.type !== "extension_ui_request") return null;
  const requestKey = decisionRequestKey(event.id ?? event.requestId, redact);
  const method = typeof event.method === "string" ? event.method : "";
  const title = typeof event.title === "string" ? event.title.trim() : "";
  const parsed = DECISION_TITLE.exec(title);
  if (!requestKey || !parsed) return null;
  const decisionKind = parsed[1] as "shell" | "file" | "question" | "config" | "routine";
  const requestKind = decisionKind === "question"
    ? "question"
    : decisionKind === "config"
      ? "config_proposal"
      : decisionKind === "routine"
        ? "routine_proposal"
        : "confirmation";
  if (
    (requestKind === "question" && method !== "input" && method !== "editor")
    || (requestKind === "confirmation" && method !== "confirm" && method !== "select")
    || (requestKind === "config_proposal" && method !== "confirm")
    || (requestKind === "routine_proposal" && method !== "confirm")
  ) return null;
  const configMessage = requestKind === "config_proposal"
    ? parseConfigProposalMessage(event.message, redact)
    : null;
  const routineMessage = requestKind === "routine_proposal"
    ? parseRoutineProposalMessage(event.message, redact)
    : null;
  if (requestKind === "config_proposal" && !configMessage) return null;
  if (requestKind === "routine_proposal" && !routineMessage) return null;
  const proposalMessage = configMessage ?? routineMessage;
  const detailSource = requestKind === "question"
    ? event.placeholder
    : proposalMessage
      ? proposalMessage.summary
      : event.message;
  const detail = typeof detailSource === "string" && detailSource.trim()
    ? bounded(redact(detailSource.trim()), MAX_DECISION_DETAIL)
    : undefined;
  const titleText = bounded(
    redact(detail?.split("\n").find((line) => line.trim())?.trim() || parsed[2]!),
    MAX_TITLE,
  );
  const requestedTimeout = typeof event.timeout === "number" && Number.isFinite(event.timeout)
    ? event.timeout
    : DEFAULT_DECISION_TIMEOUT_MS;
  const timeout = Math.max(1, Math.min(DEFAULT_DECISION_TIMEOUT_MS, requestedTimeout));
  const expiresAt = new Date(now.getTime() + timeout).toISOString();
  return {
    sequence,
    type: "decision",
    // The request id is opaque provider input and may not satisfy the DB key
    // grammar. Broker sequence is already monotone and attempt-scoped.
    entry_key: `decision:${sequence}`,
    request_key: requestKey,
    request_kind: requestKind,
    content: titleText,
    ...(proposalMessage ? { proposal: proposalMessage.proposal } : {}),
    decision: {
      request_id: requestKey,
      kind: decisionKind,
      name: decisionKind,
      title: titleText,
      detail: detail ?? null,
      status: "pending",
      answer: null,
      decided_by_id: null,
      decided_by_name: null,
      decided_at: null,
      expires_at: expiresAt,
      proposal: proposalMessage?.proposal ?? null,
    },
    expires_at: expiresAt,
  };
}

export function classifyPiJournalPage(
  page: ValidatedPiJournalRead,
  now = new Date(),
  redact: RuntimeVisibleTextRedactor = genericRuntimeVisibleTextRedactor,
): ClassifiedPiJournalPage {
  const projections: RuntimePiProjection[] = [];
  let unknownEvents = 0;
  let activity = false;
  let needsInput = false;
  let settled = false;
  let processExit: ClassifiedPiJournalPage["processExit"] = null;

  for (const record of page.events) {
    if (record.kind === "pi_process_exit") {
      projections.push({ sequence: record.sequence, type: "process_exit", ...record.exit });
      processExit = record.exit;
      continue;
    }
    const eventType = typeof record.event.type === "string" ? record.event.type : null;
    if (!eventType || !SUPPORTED_EVENT_TYPES.has(eventType)) {
      unknownEvents += 1;
      continue;
    }
    if (eventType === "agent_settled") {
      if (Object.keys(record.event).length !== 1) {
        unknownEvents += 1;
        continue;
      }
      projections.push({ sequence: record.sequence, type: "settled" });
      settled = true;
      continue;
    }
    if (eventType === "extension_ui_request") {
      const decision = decisionProjection(record.sequence, record.event, now, redact);
      if (!decision) {
        unknownEvents += 1;
        continue;
      }
      projections.push(decision);
      activity = true;
      needsInput = true;
      continue;
    }
    const assistant = assistantProjection(record.sequence, record.event, redact);
    if (assistant) projections.push(assistant);
    const tool = toolProjection(record.sequence, record.event, redact);
    if (tool) projections.push(tool);
    if (ACTIVITY_EVENT_TYPES.has(eventType)) {
      activity = true;
      if (!assistant && !tool) {
        projections.push({ sequence: record.sequence, type: "activity", event_type: eventType });
      }
    }
  }

  return {
    projections,
    throughCursor: page.nextCursor,
    unknownEvents,
    activity,
    needsInput,
    settled,
    processExit,
  };
}

export function validateBrokerCounters(value: unknown): PiBrokerCounters {
  const row = object(value);
  const keys = [
    "malformedLines",
    "oversizedLines",
    "unterminatedLines",
    "unknownEvents",
    "unboundEvents",
    "orphanResponses",
  ] as const;
  const result = {} as PiBrokerCounters;
  for (const key of keys) {
    const count = row[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw new PiJournalValidationError();
    result[key] = count as number;
  }
  return result;
}
