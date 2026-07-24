import {
  PROJECT_TRANSCRIPT_MAX_BYTES,
  RUN_CHAT_DELTA_MAX,
  RUN_CHAT_ID_MAX,
  RUN_CHAT_MESSAGE_MAX,
  RUN_CHAT_NAME_MAX,
  RUN_CHAT_TITLE_MAX,
  RUN_CHAT_TOOL_INPUT_MAX,
  RUN_CHAT_TOOL_OUTPUT_MAX,
  RUN_CHAT_TRANSCRIPT_TEXT_MAX,
  runChatEventSchema,
  runChatHistoryItemSchema,
  type RunChatEvent,
  type RunChatHistoryItem,
} from "@companion/contracts";

/** Stable marker used everywhere a literal injected into a run is removed. */
export const RUN_REDACTION_PLACEHOLDER = "[REDACTED]";

/** Every non-empty injected credential is sensitive, even when its value is unusually short. */
export const RUN_REDACTION_MIN_LITERAL_LENGTH = 1;

export type RunRedactionLiteral = string | null | undefined;

function normalizeLiterals(values: Iterable<RunRedactionLiteral>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length < RUN_REDACTION_MIN_LITERAL_LENGTH) continue;
    unique.add(value);
  }
  return [...unique].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function literalAt(input: string, offset: number, literals: readonly string[]): string | null {
  for (const literal of literals) {
    if (input.startsWith(literal, offset)) return literal;
  }
  return null;
}

/** Redact complete literals in a string without interpreting them as regular expressions. */
function redactTextWith(input: string, literals: readonly string[]): string {
  if (input.length === 0 || literals.length === 0) return input;

  let output = "";
  let emittedThrough = 0;
  let cursor = 0;
  let changed = false;

  while (cursor < input.length) {
    const literal = literalAt(input, cursor, literals);
    if (!literal) {
      cursor += 1;
      continue;
    }
    output += input.slice(emittedThrough, cursor) + RUN_REDACTION_PLACEHOLDER;
    cursor += literal.length;
    emittedThrough = cursor;
    changed = true;
  }

  return changed ? output + input.slice(emittedThrough) : input;
}

function isRedactableObject(value: object): boolean {
  if (value instanceof Error) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const ERROR_VALUE_KEYS = new Set<PropertyKey>(["name", "message", "stack", "cause"]);

function redactNested(value: unknown, literals: readonly string[], seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactTextWith(value, literals);
  if (value === null || typeof value !== "object") return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const clone: unknown[] = new Array(value.length);
    seen.set(value, clone);
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if ("value" in descriptor) descriptor.value = redactNested(descriptor.value, literals, seen);
      Object.defineProperty(clone, key, descriptor);
    }
    return clone;
  }

  // Run events are JSON-like objects; Error is included explicitly so message, stack, cause, and
  // structured custom fields are all copied and redacted. Opaque platform objects are left alone.
  if (!isRedactableObject(value)) return value;

  const clone = Object.create(Object.getPrototypeOf(value)) as object;
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    // V8 may expose Error.stack through a lazy accessor tied to the original Error's internal
    // slots. Standard Error fields are materialized as redacted data properties below instead.
    if (value instanceof Error && ERROR_VALUE_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ("value" in descriptor) descriptor.value = redactNested(descriptor.value, literals, seen);
    Object.defineProperty(clone, key, descriptor);
  }
  if (value instanceof Error) {
    const error = value as Error & { cause?: unknown };
    const fields: Array<[PropertyKey, unknown]> = [
      ["name", error.name],
      ["message", error.message],
      ["stack", error.stack],
      ["cause", error.cause],
    ];
    for (const [key, fieldValue] of fields) {
      const original = Object.getOwnPropertyDescriptor(value, key);
      if (fieldValue === undefined && original === undefined) continue;
      Object.defineProperty(clone, key, {
        configurable: original?.configurable ?? true,
        enumerable: original?.enumerable ?? false,
        writable: "writable" in (original ?? {}) ? original?.writable : true,
        value: redactNested(fieldValue, literals, seen),
      });
    }
  }
  return clone;
}

/** Exact-value redactor for complete run events, tool payloads, transcripts, and errors. */
export class RunRedactor {
  private literals: string[];

  constructor(values: Iterable<RunRedactionLiteral>) {
    this.literals = normalizeLiterals(values);
  }

  redactText(input: string): string {
    return redactTextWith(input, this.literals);
  }

  /** Redact exact UTF-8 literal bytes without decoding or otherwise corrupting binary files. */
  redactBytes(input: Uint8Array): Buffer {
    let output = Buffer.from(input);
    const replacement = Buffer.from(RUN_REDACTION_PLACEHOLDER, "utf8");
    for (const literal of this.literals) {
      const needle = Buffer.from(literal, "utf8");
      if (needle.length === 0 || output.indexOf(needle) < 0) continue;
      const chunks: Buffer[] = [];
      let cursor = 0;
      let match = output.indexOf(needle, cursor);
      while (match >= 0) {
        chunks.push(output.subarray(cursor, match), replacement);
        cursor = match + needle.length;
        match = output.indexOf(needle, cursor);
      }
      chunks.push(output.subarray(cursor));
      output = Buffer.concat(chunks);
    }
    return output;
  }

  /** Return a recursively redacted copy. The supplied payload is never mutated. */
  redactPayload<T>(input: T): T {
    return redactNested(input, this.literals, new WeakMap()) as T;
  }

  /** Create an independent stream redactor with the same current literals. */
  createStream(): RunStreamingRedactor {
    return new RunStreamingRedactor(this.literals);
  }

  /** Drop all retained literal references. Subsequent calls become pass-through operations. */
  clear(): void {
    this.literals = [];
  }
}

/**
 * Stateful redactor for streamed text deltas. It retains at most `longest literal - 1` raw code
 * units, so a literal divided between adjacent chunks cannot leak before the next chunk arrives.
 */
export class RunStreamingRedactor {
  private literals: string[];
  private maxLiteralLength: number;
  private tail = "";

  constructor(values: Iterable<RunRedactionLiteral>) {
    this.literals = normalizeLiterals(values);
    this.maxLiteralLength = this.literals[0]?.length ?? 0;
  }

  push(chunk: string): string {
    if (chunk.length === 0) return "";
    if (this.literals.length === 0) return chunk;

    const input = this.tail + chunk;
    const safeEnd = Math.max(0, input.length - this.maxLiteralLength + 1);
    if (safeEnd === 0) {
      this.tail = input;
      return "";
    }

    let output = "";
    let emittedThrough = 0;
    let cursor = 0;
    while (cursor < safeEnd) {
      const literal = literalAt(input, cursor, this.literals);
      if (!literal) {
        cursor += 1;
        continue;
      }
      output += input.slice(emittedThrough, cursor) + RUN_REDACTION_PLACEHOLDER;
      cursor += literal.length;
      emittedThrough = cursor;
    }
    output += input.slice(emittedThrough, cursor);
    this.tail = input.slice(cursor);
    return output;
  }

  /** Redact and emit the bounded tail, resetting the stream boundary. */
  flush(): string {
    const output = redactTextWith(this.tail, this.literals);
    this.tail = "";
    return output;
  }

  /** Drop retained literals and any pending raw tail without emitting it. */
  clear(): void {
    this.literals = [];
    this.maxLiteralLength = 0;
    this.tail = "";
  }
}

export function createRunRedactor(values: Iterable<RunRedactionLiteral>): RunRedactor {
  return new RunRedactor(values);
}

export function createRunStreamingRedactor(values: Iterable<RunRedactionLiteral>): RunStreamingRedactor {
  return new RunStreamingRedactor(values);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= budget) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${marker}`;
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return [value];
  const chunks: string[] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (current.length > 0 && bytes + width > maxBytes) {
      chunks.push(current.join(""));
      current = [];
      bytes = 0;
    }
    current.push(character);
    bytes += width;
  }
  if (current.length > 0) chunks.push(current.join(""));
  return chunks;
}

/**
 * Redact first, then bound every untrusted SDK field before contract parsing or persistence.
 * Text/reasoning deltas are split rather than truncated so the live transcript remains lossless.
 */
export function redactAndBoundRunEvents(
  events: RunChatEvent[],
  redactor?: RunRedactor,
): RunChatEvent[] {
  return events.flatMap((source): RunChatEvent[] => {
    const event = redactor ? redactor.redactPayload(source) : source;
    switch (event.type) {
      case "ready":
        return [{ ...event, session_id: truncateUtf8(event.session_id, RUN_CHAT_ID_MAX) }];
      case "tool.start":
        return [{
          ...event,
          call_id: truncateUtf8(event.call_id, RUN_CHAT_ID_MAX),
          skill: event.skill === null ? null : truncateUtf8(event.skill, RUN_CHAT_NAME_MAX),
          tool: truncateUtf8(event.tool, RUN_CHAT_NAME_MAX),
          title: event.title === null ? null : truncateUtf8(event.title, RUN_CHAT_TITLE_MAX),
          input: truncateUtf8(event.input, RUN_CHAT_TOOL_INPUT_MAX),
        }];
      case "tool.done":
        return [{
          ...event,
          call_id: truncateUtf8(event.call_id, RUN_CHAT_ID_MAX),
          title: event.title === null ? null : truncateUtf8(event.title, RUN_CHAT_TITLE_MAX),
          output: truncateUtf8(event.output, RUN_CHAT_TOOL_OUTPUT_MAX),
        }];
      case "text.delta":
        return splitUtf8(event.delta, RUN_CHAT_DELTA_MAX).map((delta) => ({
          ...event,
          message_id: truncateUtf8(event.message_id, RUN_CHAT_ID_MAX),
          delta,
        }));
      case "reasoning.delta":
        return splitUtf8(event.delta, RUN_CHAT_DELTA_MAX).map((delta) => ({
          ...event,
          part_id: truncateUtf8(event.part_id, RUN_CHAT_ID_MAX),
          delta,
        }));
      case "text.done":
        return [{ ...event, message_id: truncateUtf8(event.message_id, RUN_CHAT_ID_MAX) }];
      case "reasoning.done":
        return [{ ...event, part_id: truncateUtf8(event.part_id, RUN_CHAT_ID_MAX) }];
      case "status":
        return [{
          ...event,
          message: event.message === null ? null : truncateUtf8(event.message, RUN_CHAT_MESSAGE_MAX),
        }];
      case "session.idle":
        return [{ ...event, session_id: truncateUtf8(event.session_id, RUN_CHAT_ID_MAX) }];
      case "artifacts.collecting":
      case "artifacts.updated":
      case "prompt.status":
        return [event];
      case "run.warning":
      case "run.error":
      case "error":
        return [{ ...event, message: truncateUtf8(event.message, RUN_CHAT_MESSAGE_MAX) }];
    }
  });
}

/**
 * Project persistence boundary for complete events.
 *
 * Streamed text/reasoning must first pass through the caller's stateful `RunStreamingRedactor` so a
 * credential split across SDK chunks is removed as a whole. This helper then applies the shared
 * Run field bounds and parses away any payload outside the canonical event vocabulary.
 */
export function redactAndBoundProjectEvents(
  events: RunChatEvent[],
  redactor?: RunRedactor,
): RunChatEvent[] {
  return redactAndBoundRunEvents(events, redactor).map((event) => runChatEventSchema.parse(event));
}

function boundProjectTranscriptItem(item: RunChatHistoryItem): RunChatHistoryItem {
  if (item.kind === "user" || item.kind === "assistant") {
    return runChatHistoryItemSchema.parse({
      ...item,
      text: truncateUtf8(item.text, RUN_CHAT_TRANSCRIPT_TEXT_MAX),
      ...(item.message_id === undefined
        ? {}
        : { message_id: truncateUtf8(item.message_id, RUN_CHAT_ID_MAX) }),
    });
  }
  return runChatHistoryItemSchema.parse({
    ...item,
    call_id: truncateUtf8(item.call_id, RUN_CHAT_ID_MAX),
    tool: truncateUtf8(item.tool, RUN_CHAT_NAME_MAX),
    skill: item.skill === null ? null : truncateUtf8(item.skill, RUN_CHAT_NAME_MAX),
    title: item.title === null ? null : truncateUtf8(item.title, RUN_CHAT_TITLE_MAX),
    input: truncateUtf8(item.input, RUN_CHAT_TOOL_INPUT_MAX),
    output: truncateUtf8(item.output, RUN_CHAT_TOOL_OUTPUT_MAX),
  });
}

/**
 * Redact and cap the cumulative Project recovery transcript while retaining the newest complete
 * items. Each item is parsed through the shared Run history contract before aggregate measurement.
 */
export function redactAndBoundProjectTranscript(
  items: RunChatHistoryItem[],
  redactor?: RunRedactor,
  maxBytes = PROJECT_TRANSCRIPT_MAX_BYTES,
): RunChatHistoryItem[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
    throw new RangeError("Project transcript byte limit must be an integer of at least 2");
  }
  const redacted = redactor ? redactor.redactPayload(items) : items;
  const bounded = redacted.map(boundProjectTranscriptItem);
  const serialized = bounded.map((item) => JSON.stringify(item));
  let totalBytes = 2;
  let start = bounded.length;
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const item = serialized[index];
    if (item === undefined) continue;
    const nextBytes = Buffer.byteLength(item, "utf8") + (start < bounded.length ? 1 : 0);
    if (totalBytes + nextBytes > maxBytes) break;
    totalBytes += nextBytes;
    start = index;
  }
  return bounded.slice(start);
}
