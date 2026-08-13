import type { CompanionTranscriptRole } from "@companion/contracts";

/** One control-plane transcript entry projected from the Pi RPC log; ordinals are assigned later. */
export interface CompanionPiEntry {
  eventId: string;
  role: CompanionTranscriptRole;
  content: string;
  createdAt: Date;
}

export interface CompanionPiProjection {
  entries: CompanionPiEntry[];
  /** Bytes of the chunk that formed complete records; a trailing partial line stays unconsumed. */
  consumedBytes: number;
  /** True when Pi reported that the run fully settled inside this chunk. */
  settled: boolean;
}

const MAX_CONTENT_CHARACTERS = 100_000;
const TRUNCATION_SUFFIX = "\n[truncated]";

interface PiTextBlock {
  type?: unknown;
  text?: unknown;
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

/**
 * Assistant text only. Thinking blocks, tool calls, and tool results are deliberately dropped: the
 * chat thread is a conversation surface, never a Pi tool console.
 */
function assistantText(message: PiMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is PiTextBlock =>
      typeof block === "object" && block !== null && (block as PiTextBlock).type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

function truncate(content: string): string {
  return content.length <= MAX_CONTENT_CHARACTERS
    ? content
    : content.slice(0, MAX_CONTENT_CHARACTERS) + TRUNCATION_SUFFIX;
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
    const content = assistantText(message);
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
 * Project a byte range of the Box `pi.rpc.ndjson` log into transcript entries. Event ids are derived
 * from the record's byte offset, so re-reading the same range yields the same ids and the transcript
 * insert stays idempotent. Pi writes strict LF-delimited JSON, so a chunk that ends mid-record leaves
 * those bytes unconsumed for the next read instead of guessing.
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
  }

  return { entries, consumedBytes, settled };
}
