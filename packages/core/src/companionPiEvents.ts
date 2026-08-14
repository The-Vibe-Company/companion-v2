import type { CompanionToolRun, CompanionToolRunKind, CompanionTranscriptRole } from "@companion/contracts";

/** One control-plane transcript entry projected from the Pi RPC log; ordinals are assigned later. */
export interface CompanionPiEntry {
  eventId: string;
  role: CompanionTranscriptRole;
  content: string;
  createdAt: Date;
  /** Set on exactly the `tool` entries, as the run looked when Pi started it. */
  tool?: CompanionToolRun;
}

/** The result Pi reported for a tool run, matched back to the chip that is still spinning for it. */
export interface CompanionPiToolCompletion {
  /** Pi's call id when it reported one; a result without one closes the oldest running run. */
  callId: string | null;
  status: "ok" | "error";
  /** What the tool returned, already truncated, appended to the run's disclosed detail. */
  result: string | null;
  completedAt: Date;
}

export interface CompanionPiProjection {
  entries: CompanionPiEntry[];
  /** Results for runs whose chip may already be stored from an earlier chunk. */
  toolCompletions: CompanionPiToolCompletion[];
  /** Bytes of the chunk that formed complete records; a trailing partial line stays unconsumed. */
  consumedBytes: number;
  /** True when Pi reported that the run fully settled inside this chunk. */
  settled: boolean;
}

const MAX_CONTENT_CHARACTERS = 100_000;
const TRUNCATION_SUFFIX = "\n[truncated]";
/** Contract caps the whole detail; arguments and result each get half of it, minus the separator. */
const MAX_TOOL_ARGUMENT_CHARACTERS = 4_000;
const MAX_TOOL_RESULT_CHARACTERS = 8_000;
const MAX_TOOL_TITLE_CHARACTERS = 300;

interface PiContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
}

interface PiMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  timestamp?: unknown;
}

interface PiEvent {
  type?: unknown;
  command?: unknown;
  success?: unknown;
  error?: unknown;
  message?: unknown;
}

const THINKING_BLOCK_TYPES = new Set(["thinking", "reasoning", "redacted_thinking"]);
const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "tool_call", "toolUse", "tool_use"]);
const TOOL_RESULT_BLOCK_TYPES = new Set([
  "toolResult",
  "tool_result",
  "toolOutput",
  "tool_output",
]);
const TOOL_RESULT_MESSAGE_ROLES = new Set(["toolResult", "tool_result", "tool"]);
/** Stop reasons that end a turn. A tool step is mid-turn, so its empty message stays invisible. */
const TURN_END_STOP_REASONS = new Set([
  "stop",
  "endTurn",
  "end_turn",
  "stopSequence",
  "stop_sequence",
  "maxTokens",
  "max_tokens",
]);

function blocksOf(message: PiMessage): PiContentBlock[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((block): block is PiContentBlock =>
    typeof block === "object" && block !== null);
}

function blockType(block: PiContentBlock): string {
  return typeof block.type === "string" ? block.type : "";
}

/**
 * Assistant text only. Thinking blocks are deliberately dropped, and so is the body of a tool call:
 * the call becomes its own chip entry instead of being rendered into the reply. A turn with no text
 * at all falls back to its thinking rather than showing nothing.
 */
function assistantText(message: PiMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  return blocksOf(message)
    .filter((block) => blockType(block) === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

/**
 * The reasoning a turn produced, read only when it produced no text at all. Some models answer a
 * short question inside the thinking block and end the turn with no text part; showing that reasoning
 * is the difference between an answer and a thread that looks stuck. A turn that did produce text
 * keeps its thinking hidden.
 */
function assistantThinking(message: PiMessage): string {
  return blocksOf(message)
    .filter((block) => THINKING_BLOCK_TYPES.has(blockType(block)))
    .map((block) => {
      if (typeof block.thinking === "string") return block.thinking;
      return typeof block.text === "string" ? block.text : "";
    })
    .join("")
    .trim();
}

function hasToolCall(message: PiMessage): boolean {
  return blocksOf(message).some((block) => TOOL_CALL_BLOCK_TYPES.has(blockType(block)));
}

function truncate(content: string, limit = MAX_CONTENT_CHARACTERS): string {
  return content.length <= limit ? content : content.slice(0, limit) + TRUNCATION_SUFFIX;
}

/**
 * Tool names Pi and its harnesses use, grouped by what a run of them touches. Names are matched
 * whole first and then as a word inside a longer name, so `bash` and `run_bash_command` both read as
 * shell while an unfamiliar tool falls through to `tool` rather than being filed under a guess.
 */
const TOOL_KIND_NAMES: ReadonlyArray<readonly [CompanionToolRunKind, ReadonlySet<string>]> = [
  ["computer", new Set([
    "computer", "computeruse", "desktop", "lux", "screenshot", "screencapture", "screen",
    "click", "doubleclick", "rightclick", "type", "key", "press", "scroll", "drag", "mouse",
    "cursor", "hover", "wait",
  ])],
  ["browse", new Set([
    "browse", "browser", "web", "websearch", "webfetch", "fetch", "search", "navigate", "goto",
    "openurl", "url", "http", "https", "request", "curl", "crawl", "page",
  ])],
  ["shell", new Set([
    "bash", "sh", "zsh", "shell", "terminal", "exec", "execute", "run", "command", "cmd",
    "process", "script", "python", "node", "npm", "pnpm", "git",
  ])],
  ["file", new Set([
    "file", "files", "read", "write", "edit", "editor", "patch", "apply", "applypatch", "create",
    "delete", "remove", "move", "copy", "ls", "list", "dir", "glob", "grep", "find", "rg", "view",
    "notebook", "strreplace", "replace", "insert", "open",
  ])],
];

/** Split a tool name into comparable words: `str_replace-editor` and `strReplaceEditor` agree. */
function toolNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function companionToolRunKind(name: string): CompanionToolRunKind {
  const collapsed = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [kind, names] of TOOL_KIND_NAMES) {
    if (names.has(collapsed)) return kind;
  }
  const words = toolNameWords(name);
  for (const [kind, names] of TOOL_KIND_NAMES) {
    if (words.some((word) => names.has(word))) return kind;
  }
  return "tool";
}

/** Runs whose effect is something a reader can see, and therefore worth one frame of the desktop. */
export function companionToolRunIsVisual(kind: CompanionToolRunKind): boolean {
  return kind === "computer" || kind === "browse";
}

function stringField(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return null;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * The one line a chip shows: the command, the path, the address, the gesture. It is read out of the
 * arguments the tool was called with, and a tool whose arguments say nothing recognizable is named
 * by the tool itself rather than by a rendering of its whole payload.
 */
function toolRunTitle(
  kind: CompanionToolRunKind,
  name: string,
  args: Record<string, unknown>,
): string {
  const chosen = (() => {
    switch (kind) {
      case "shell":
        return stringField(args, ["command", "cmd", "script", "input", "code"]);
      case "file":
        return stringField(args, [
          "path", "file_path", "filePath", "file", "filename", "target_file", "pattern", "glob",
        ]);
      case "browse":
        return stringField(args, ["url", "href", "query", "q", "search", "search_query", "prompt"]);
      case "computer": {
        const action = stringField(args, ["action", "command", "gesture"]);
        const target = stringField(args, ["text", "coordinate", "selector", "key", "target"]);
        if (action && target) return `${action} ${target}`;
        return action ?? target;
      }
      default:
        return null;
    }
  })();
  const line = (chosen ?? name).split("\n").map((part) => part.trim()).find(Boolean) ?? name;
  return line.length <= MAX_TOOL_TITLE_CHARACTERS
    ? line
    : `${line.slice(0, MAX_TOOL_TITLE_CHARACTERS - 1)}…`;
}

function toolRunArgumentDetail(args: Record<string, unknown>): string | null {
  if (Object.keys(args).length === 0) return null;
  try {
    return truncate(JSON.stringify(args, null, 2), MAX_TOOL_ARGUMENT_CHARACTERS);
  } catch {
    return null;
  }
}

const TOOL_CALL_ID_KEYS = [
  "id", "callId", "call_id", "toolCallId", "tool_call_id", "toolUseId", "tool_use_id",
] as const;

/** One tool run as Pi announced it: still running, with only what the call itself said about it. */
function toolRunFrom(block: PiContentBlock): CompanionToolRun | null {
  const record = block as unknown as Record<string, unknown>;
  const name = stringField(record, ["name", "toolName", "tool_name", "tool"]);
  if (!name) return null;
  const args = objectOf(record.arguments ?? record.input ?? record.args ?? record.parameters);
  const kind = companionToolRunKind(name);
  return {
    call_id: stringField(record, TOOL_CALL_ID_KEYS),
    kind,
    name: name.slice(0, 120),
    title: toolRunTitle(kind, name, args),
    status: "running",
    detail: toolRunArgumentDetail(args),
    screenshot: null,
  };
}

/** The text a tool returned, however the harness wrapped it. */
function toolResultText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === "string") return block;
        const record = objectOf(block);
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function toolResultFailed(source: Record<string, unknown>): boolean {
  if (source.isError === true || source.is_error === true) return true;
  if (source.success === false) return true;
  return typeof source.error === "string" && source.error.trim().length > 0;
}

function completionFrom(
  source: Record<string, unknown>,
  fallbackText: string,
  at: Date,
): CompanionPiToolCompletion {
  const text = toolResultText(source.content ?? source.result ?? source.output ?? source.text)
    || (typeof source.error === "string" ? source.error.trim() : "")
    || fallbackText;
  return {
    callId: stringField(source, TOOL_CALL_ID_KEYS),
    status: toolResultFailed(source) ? "error" : "ok",
    result: text ? truncate(text, MAX_TOOL_RESULT_CHARACTERS) : null,
    completedAt: at,
  };
}

/**
 * Results carried by one record. Pi reports a tool result either as a message of its own or as
 * result blocks inside one, so both are read; a record that carries neither closes nothing.
 */
function completionsFrom(event: PiEvent, now: Date): CompanionPiToolCompletion[] {
  if (event.type !== "message_end") return [];
  const message = objectOf(event.message) as PiMessage;
  const blocks = blocksOf(message).filter((block) => TOOL_RESULT_BLOCK_TYPES.has(blockType(block)));
  const at = messageTimestamp(message, now);
  if (blocks.length) {
    return blocks.map((block) => completionFrom(block as unknown as Record<string, unknown>, "", at));
  }
  if (typeof message.role !== "string" || !TOOL_RESULT_MESSAGE_ROLES.has(message.role)) return [];
  return [completionFrom(message as unknown as Record<string, unknown>, "", at)];
}

function messageTimestamp(message: PiMessage, fallback: Date): Date {
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return fallback;
  const parsed = new Date(message.timestamp);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function entryFrom(event: PiEvent, now: Date): Omit<CompanionPiEntry, "eventId"> | null {
  if (event.type === "message_end") {
    const message = (typeof event.message === "object" && event.message !== null
      ? event.message
      : {}) as PiMessage;
    if (message.role !== "assistant") return null;
    const content = assistantText(message) || assistantThinking(message);
    if (content) {
      return { role: "assistant", content: truncate(content), createdAt: messageTimestamp(message, now) };
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return {
        role: "system",
        content: `Pi ended the turn without a reply (${message.stopReason}).`,
        createdAt: messageTimestamp(message, now),
      };
    }
    // A turn that ended with nothing to show must still close the conversation, or the thread looks
    // like Pi is still thinking. Mid-turn tool steps carry no visible content either and stay silent.
    if (typeof message.stopReason === "string"
      && TURN_END_STOP_REASONS.has(message.stopReason)
      && !hasToolCall(message)) {
      return {
        role: "system",
        content: "Pi ended the turn without a visible reply.",
        createdAt: messageTimestamp(message, now),
      };
    }
    return null;
  }
  if (
    event.type === "response"
    && event.command === "prompt"
    && event.success === false
  ) {
    const reason = typeof event.error === "string" && event.error.trim()
      ? event.error.trim()
      : "the harness rejected it";
    return { role: "system", content: truncate(`Pi did not accept the message: ${reason}`), createdAt: now };
  }
  return null;
}

/**
 * The runs one record announced, as their own transcript entries. A run is not folded into the
 * assistant turn that called it: it keeps an ordinal of its own, so the chip sits between the turns
 * it happened between and stays there once the turn around it has been written.
 */
function toolEntriesFrom(event: PiEvent, recordOffset: number, now: Date): CompanionPiEntry[] {
  if (event.type !== "message_end") return [];
  const message = objectOf(event.message) as PiMessage;
  if (message.role !== "assistant") return [];
  const createdAt = messageTimestamp(message, now);
  return blocksOf(message)
    .filter((block) => TOOL_CALL_BLOCK_TYPES.has(blockType(block)))
    .flatMap((block, index) => {
      const tool = toolRunFrom(block);
      if (!tool) return [];
      return [{
        eventId: `pi:${recordOffset}:tool:${index}`,
        role: "tool" as const,
        // The row's own text stays readable on its own, so a reader that never learned about chips
        // still sees which run happened where.
        content: tool.title,
        createdAt,
        tool,
      }];
    });
}

/**
 * Project a byte range of the Box `pi.rpc.ndjson` log into transcript entries. Event ids are derived
 * from the record's byte offset, so re-reading the same range yields the same ids and the transcript
 * insert stays idempotent. Pi writes strict LF-delimited JSON, so a chunk that ends mid-record leaves
 * those bytes unconsumed for the next read instead of guessing.
 *
 * Tool runs are projected twice over: the call that starts one becomes a running entry, and the
 * result that ends it comes back as a completion the caller applies to whichever entry is still
 * running for it — the two halves routinely arrive in different chunks, seconds apart.
 */
export function projectCompanionPiEvents(input: {
  chunk: string;
  offset: number;
  now?: Date;
}): CompanionPiProjection {
  const now = input.now ?? new Date();
  const records = input.chunk.split("\n");
  const complete = records.slice(0, -1);
  const entries: CompanionPiEntry[] = [];
  const toolCompletions: CompanionPiToolCompletion[] = [];
  let consumedBytes = 0;
  let settled = false;

  for (const record of complete) {
    const recordOffset = input.offset + consumedBytes;
    consumedBytes += Buffer.byteLength(record, "utf8") + 1;
    const line = record.trim();
    if (!line) continue;
    let event: PiEvent;
    try {
      event = JSON.parse(line) as PiEvent;
    } catch {
      continue;
    }
    if (event.type === "agent_settled") settled = true;
    const projected = entryFrom(event, now);
    if (projected) entries.push({ eventId: `pi:${recordOffset}`, ...projected });
    entries.push(...toolEntriesFrom(event, recordOffset, now));
    toolCompletions.push(...completionsFrom(event, now));
  }

  return { entries, toolCompletions, consumedBytes, settled };
}
