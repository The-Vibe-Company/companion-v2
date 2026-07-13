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
