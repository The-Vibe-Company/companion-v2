/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- The agent sits on a JSON wire boundary: broker socket responses and HTTP bodies arrive untyped and are narrowed here before use. */
import { execFile } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  COMPANION_PI_BROKER_READ_LIMIT,
  sendCompanionPiBrokerCommand,
  type PiJsonObject,
} from "./companionPiBrokerCore";
import {
  COMPANION_ATTACHMENT_FILENAME_PATTERN,
  COMPANION_ATTACHMENT_MAX_BYTES,
  COMPANION_ATTACHMENT_MIME_TYPES,
  COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT,
} from "@companion/contracts";

/**
 * The Companion Box agent is a second on-box daemon: a network front-end that speaks the existing
 * one-LF-command-per-connection Unix socket protocol to the Pi broker. It owns no lifecycle and
 * cannot execute shell commands, read provider credentials, or control systemd. Its narrow file
 * surface is limited to the already-contracted attachment and outbox directories. Its only inbound
 * channel is the ascii.dev `host <port>` HTTPS proxy, whose `_token` gate sits in front of the
 * per-box bearer enforced here as defense in depth.
 */
export const COMPANION_BOX_AGENT_VERSION = 2;
export const COMPANION_BOX_AGENT_DEFAULT_PORT = 8790;
export const COMPANION_BOX_AGENT_MAX_BODY_BYTES = COMPANION_ATTACHMENT_MAX_BYTES;
const COMPANION_BOX_AGENT_JSON_BODY_BYTES = 64 * 1024;
/** The ascii.dev proxy tolerates ~25 s responses; long-poll never exceeds it. */
export const COMPANION_BOX_AGENT_LONG_POLL_CAP_MS = 25_000;
export const COMPANION_BOX_AGENT_LONG_POLL_INTERVAL_MS = 200;
export const COMPANION_BOX_AGENT_AUTH_FAILURE_LIMIT = 10;
export const COMPANION_BOX_AGENT_AUTH_FAILURE_WINDOW_MS = 60_000;
export const COMPANION_BOX_AGENT_AUTH_BAN_MS = 60_000;
export const COMPANION_BOX_AGENT_BROKER_RPC_TIMEOUT_MS = 8_000;

/** Paths relative to the Box user's home, mirrored by the staging control bundle. */
export const COMPANION_BOX_AGENT_AUTH_PATH = ".companion/runtime/state/agent-auth.json";
export const COMPANION_BOX_AGENT_SCRIPT_PATH = ".companion/bin/companion-box-agent.mjs";
export const COMPANION_BOX_AGENT_UNIT_NAME = "companion-box-agent.service";
export const COMPANION_BOX_AGENT_HOST_TITLE = "companion-agent";

const AUTH_TOKEN_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PI_UNIT_STATE_PATTERN = /^[a-z-]{1,32}$/;
const MAX_TRACKED_CLIENTS = 4_096;
const MAX_LAYOUT_MARKER_LENGTH = 1_024;
const MAX_BEARER_LENGTH = 512;
const MAX_ERROR_MESSAGE_LENGTH = 500;

export interface CompanionBoxAgentHealth extends PiJsonObject {
  agentVersion: number;
  piUnit: string;
  brokerSocketReady: boolean;
  layoutMarker: string | null;
}

export interface CompanionBoxAgentRequest {
  method: string;
  /** Path plus query string, exactly as received. */
  url: string;
  authorization: string | null;
  remoteAddress: string;
  body: Uint8Array | null;
}

export interface CompanionBoxAgentResult {
  status: number;
  body: PiJsonObject;
  rawBody?: Uint8Array;
  contentType?: string;
}

export interface CompanionBoxAgentAttachmentDescriptor extends PiJsonObject {
  position: number;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
}

export interface CompanionBoxAgentOutboxEntry extends PiJsonObject {
  name: string;
  encodedName: string;
  byteSize: number;
  sha256: string;
}

/**
 * Everything the agent touches outside its own process, injectable so the core is testable without
 * a broker socket, systemd, or a clock.
 */
export interface CompanionBoxAgentSeams {
  brokerCommand(command: PiJsonObject & { id: string }): Promise<PiJsonObject>;
  /** `systemctl --user is-active` verdict for the Pi unit, already sanitized by the seam. */
  piUnitState(): Promise<string>;
  /** The raw content of the agent auth file, or null when it is unreadable. */
  readAuthFile(): string | null;
  /** True when the broker socket exists, is a socket, and is owner-only (mode 600). */
  brokerSocketReady(): boolean;
  readLayoutMarker(): string | null;
  uploadAttachment(input: {
    messageId: string;
    position: number;
    sha256: string;
    bytes: Uint8Array;
  }): void;
  commitAttachments(input: {
    messageId: string;
    files: CompanionBoxAgentAttachmentDescriptor[];
  }): CompanionBoxAgentAttachmentDescriptor[];
  clearOutbox(): void;
  listOutbox(): CompanionBoxAgentOutboxEntry[];
  readOutbox(encodedName: string): { entry: CompanionBoxAgentOutboxEntry; bytes: Uint8Array };
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CompanionBoxAgentSeamPaths {
  brokerSocketPath: string;
  authFilePath: string;
  layoutMarkerPath: string;
  attachmentsPath: string;
  attachmentUploadsPath: string;
  outboxPath: string;
  piUnitName?: string;
}

/** Production seams: real filesystem, real broker socket, real systemd user manager. */
export function companionBoxAgentSeams(paths: CompanionBoxAgentSeamPaths): CompanionBoxAgentSeams {
  const piUnitName = paths.piUnitName ?? "companion-pi-daemon.service";
  return {
    brokerCommand: (command) =>
      sendCompanionPiBrokerCommand({
        socketPath: paths.brokerSocketPath,
        command,
        timeoutMs: COMPANION_BOX_AGENT_BROKER_RPC_TIMEOUT_MS,
      }),
    piUnitState: () =>
      new Promise((resolvePiState) => {
        execFile(
          "systemctl",
          ["--user", "is-active", piUnitName],
          { timeout: 5_000 },
          (_error, stdout) => {
            // `is-active` exits non-zero for every state but active; the stdout verdict is the answer
            // either way, and anything unparseable is reported as unknown rather than echoed.
            resolvePiState(sanitizePiUnitState(typeof stdout === "string" ? stdout : ""));
          },
        );
      }),
    readAuthFile() {
      try {
        return readFileSync(paths.authFilePath, "utf8");
      } catch {
        return null;
      }
    },
    brokerSocketReady() {
      try {
        const stat = lstatSync(paths.brokerSocketPath);
        return stat.isSocket() && (stat.mode & 0o777) === 0o600;
      } catch {
        return false;
      }
    },
    readLayoutMarker() {
      try {
        const value = readFileSync(paths.layoutMarkerPath, "utf8").trim();
        return value ? value.slice(0, MAX_LAYOUT_MARKER_LENGTH) : null;
      } catch {
        return null;
      }
    },
    uploadAttachment(input) {
      const directory = join(paths.attachmentUploadsPath, input.messageId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, `${input.position}-${input.sha256}`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, input.bytes, { mode: 0o600, flag: "wx" });
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    commitAttachments(input) {
      const parent = dirname(paths.attachmentsPath);
      const nextRoot = join(parent, `.attachments-${randomUUID()}.next`);
      const messageDirectory = join(nextRoot, input.messageId);
      mkdirSync(messageDirectory, { recursive: true, mode: 0o700 });
      try {
        for (const file of input.files) {
          const uploaded = join(paths.attachmentUploadsPath, input.messageId, `${file.position}-${file.sha256}`);
          const stat = statSync(uploaded);
          if (!stat.isFile() || stat.size !== file.byteSize) throw new Error("attachment upload is unavailable");
          const target = join(messageDirectory, `${file.position}-${file.filename}`);
          copyFileSync(uploaded, target);
          chmodSync(target, 0o444);
        }
        rmSync(paths.attachmentsPath, { recursive: true, force: true });
        renameSync(nextRoot, paths.attachmentsPath);
        rmSync(join(paths.attachmentUploadsPath, input.messageId), { recursive: true, force: true });
      } finally {
        rmSync(nextRoot, { recursive: true, force: true });
      }
      return input.files.map((file) => ({ ...file }));
    },
    clearOutbox() {
      mkdirSync(paths.outboxPath, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(paths.outboxPath)) {
        rmSync(join(paths.outboxPath, name), { recursive: true, force: true });
      }
    },
    listOutbox() {
      try {
        return readdirSync(paths.outboxPath).sort().flatMap((name) => {
          if (!validOutboxName(name)) return [];
          const path = join(paths.outboxPath, name);
          const stat = lstatSync(path);
          if (!stat.isFile()) return [];
          const bytes = readFileSync(path);
          return [{
            name,
            encodedName: Buffer.from(name, "utf8").toString("base64"),
            byteSize: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }];
        });
      } catch {
        return [];
      }
    },
    readOutbox(encodedName) {
      const name = decodeOutboxName(encodedName);
      const path = join(paths.outboxPath, name);
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new Error("outbox entry is unavailable");
      const bytes = readFileSync(path);
      return {
        entry: {
          name,
          encodedName,
          byteSize: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        bytes,
      };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  };
}

export function sanitizePiUnitState(stdout: string): string {
  const verdict = stdout.trim().split(/\s+/)[0] ?? "";
  return PI_UNIT_STATE_PATTERN.test(verdict) ? verdict : "unknown";
}

/**
 * Compare a presented bearer against the stored `{ tokenSha256 }` digest without ever holding the
 * expected plaintext. The file is re-read per request so a staging-time rotation applies without an
 * agent restart. A missing or malformed file fails closed.
 */
export function bearerMatchesAuthFile(authorization: string | null, authFileContent: string | null): boolean {
  if (!authorization) return false;
  const match = /^Bearer\s+(\S+)$/.exec(authorization.trim());
  if (!match) return false;
  const token = match[1]!;
  if (token.length > MAX_BEARER_LENGTH) return false;
  if (!authFileContent) return false;
  let storedSha256: unknown;
  try {
    // SAFETY: JSON.parse returns any; widening to unknown forces the narrowing below.
    const parsed = JSON.parse(authFileContent) as unknown;
    storedSha256 = isJsonObject(parsed) ? parsed.tokenSha256 : undefined;
  } catch {
    return false;
  }
  if (typeof storedSha256 !== "string" || !AUTH_TOKEN_SHA256_PATTERN.test(storedSha256)) return false;
  const presented = createHash("sha256").update(token, "utf8").digest();
  const expected = Buffer.from(storedSha256, "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * HTTP front-end for the broker socket and bounded chat-file directories. Deliberately absent:
 * arbitrary exec, arbitrary filesystem paths, credentials, and systemd control. Prompt dispatch
 * is idempotent through the broker's durable ledger; abort and decision delivery preserve their
 * explicit ambiguous-outcome contract when the one-way Pi acknowledgement is lost.
 */
export class CompanionBoxAgentCore {
  readonly #seams: CompanionBoxAgentSeams;
  readonly #failures = new Map<string, number[]>();
  readonly #bans = new Map<string, number>();
  #commandSequence = 0;

  constructor(seams: CompanionBoxAgentSeams) {
    this.#seams = seams;
  }

  async handle(request: CompanionBoxAgentRequest): Promise<CompanionBoxAgentResult> {
    const client = request.remoteAddress || "unknown";
    if (this.#banned(client)) {
      return errorResult(429, "rate_limited", "too many failed authentication attempts");
    }
    if (!bearerMatchesAuthFile(request.authorization, this.#seams.readAuthFile())) {
      this.#recordAuthFailure(client);
      return errorResult(401, "unauthorized", "a valid agent bearer token is required");
    }
    if (request.body && request.body.byteLength > COMPANION_BOX_AGENT_MAX_BODY_BYTES) {
      return errorResult(413, "payload_too_large", "request body exceeds the agent limit");
    }

    const parsed = parseUrl(request.url);
    if (!parsed) return errorResult(400, "invalid_request", "request path is invalid");
    const { path, query } = parsed;
    if (path !== "/v1/files" && request.body
      && request.body.byteLength > COMPANION_BOX_AGENT_JSON_BODY_BYTES) {
      return errorResult(413, "payload_too_large", "request body exceeds the JSON limit");
    }

    if (path === "/v1/files") {
      if (request.method !== "PUT") return methodNotAllowed();
      return this.#uploadAttachment(query, request.body);
    }
    const attachmentCommit = /^\/v1\/attachments\/([0-9a-f-]{36})$/.exec(path);
    if (attachmentCommit) {
      if (request.method !== "POST") return methodNotAllowed();
      return this.#commitAttachments(attachmentCommit[1]!, request.body);
    }

    switch (path) {
      case "/v1/health":
        if (request.method !== "GET") return methodNotAllowed();
        return { status: 200, body: await this.#health() };
      case "/v1/broker/state":
        if (request.method !== "GET") return methodNotAllowed();
        return await this.#broker("runtime_state", {});
      case "/v1/events":
        if (request.method !== "GET") return methodNotAllowed();
        return await this.#events(query);
      case "/v1/ack":
        if (request.method !== "POST") return methodNotAllowed();
        return await this.#ack(request.body);
      case "/v1/prompt":
        if (request.method !== "POST") return methodNotAllowed();
        return await this.#prompt(request.body);
      case "/v1/dispatch/status":
        if (request.method !== "GET") return methodNotAllowed();
        return await this.#dispatchStatus(query);
      case "/v1/abort":
        if (request.method !== "POST") return methodNotAllowed();
        return await this.#abort(request.body);
      case "/v1/decision":
        if (request.method !== "POST") return methodNotAllowed();
        return await this.#decision(request.body);
      case "/v1/outbox":
        if (request.method !== "GET") return methodNotAllowed();
        return { status: 200, body: { entries: this.#seams.listOutbox() } };
      case "/v1/outbox/file":
        if (request.method !== "GET") return methodNotAllowed();
        return this.#readOutbox(query);
      case "/v1/outbox/clear":
        if (request.method !== "POST") return methodNotAllowed();
        this.#seams.clearOutbox();
        return { status: 200, body: { cleared: true } };
      default:
        return errorResult(404, "not_found", "unknown agent route");
    }
  }

  /** Local observations only; the broker socket is never touched for a health read. */
  async #health(): Promise<CompanionBoxAgentHealth> {
    return {
      agentVersion: COMPANION_BOX_AGENT_VERSION,
      piUnit: sanitizePiUnitState(await this.#seams.piUnitState()),
      brokerSocketReady: this.#seams.brokerSocketReady(),
      layoutMarker: this.#seams.readLayoutMarker(),
    };
  }

  async #events(query: URLSearchParams): Promise<CompanionBoxAgentResult> {
    const after = nonNegativeQueryInteger(query, "after", 0);
    if (after === null) return errorResult(400, "invalid_request", "after must be a non-negative integer");
    const limit = positiveQueryInteger(query, "limit", COMPANION_PI_BROKER_READ_LIMIT);
    if (limit === null || limit > COMPANION_PI_BROKER_READ_LIMIT) {
      return errorResult(
        400,
        "invalid_request",
        `limit must be a positive integer of at most ${COMPANION_PI_BROKER_READ_LIMIT}`,
      );
    }
    const requestedWait = nonNegativeQueryInteger(query, "wait_ms", 0);
    if (requestedWait === null) {
      return errorResult(400, "invalid_request", "wait_ms must be a non-negative integer");
    }
    const waitMs = Math.min(requestedWait, COMPANION_BOX_AGENT_LONG_POLL_CAP_MS);
    const deadline = this.#seams.now() + waitMs;
    // Long-poll, not SSE: one bounded HTTP response. An empty page re-polls the local socket until
    // something arrives or the deadline passes, then returns whatever the last read said.
    for (;;) {
      const result = await this.#broker("read_events", { after, limit });
      if (result.status !== 200) return result;
      const events = result.body.events;
      if (Array.isArray(events) && events.length > 0) return result;
      const remaining = deadline - this.#seams.now();
      if (remaining <= 0) return result;
      await this.#seams.sleep(Math.min(COMPANION_BOX_AGENT_LONG_POLL_INTERVAL_MS, remaining));
    }
  }

  async #ack(body: Uint8Array | null): Promise<CompanionBoxAgentResult> {
    const parsed = parseJsonBody(body);
    if (!parsed) return errorResult(400, "invalid_request", "a JSON body is required");
    const through = parsed.through;
    if (!Number.isSafeInteger(through) || Number(through) < 0) {
      return errorResult(400, "invalid_request", "through must be a non-negative integer");
    }
    return await this.#broker("ack_events", { through: Number(through) });
  }

  async #prompt(body: Uint8Array | null): Promise<CompanionBoxAgentResult> {
    const parsed = parseJsonBody(body);
    if (!parsed) return errorResult(400, "invalid_request", "a JSON body is required");
    const commandId = opaqueId(parsed.commandId);
    const attemptId = opaqueId(parsed.attemptId);
    const expectedInvocationId = opaqueId(parsed.expectedInvocationId);
    const message = typeof parsed.message === "string" ? parsed.message : "";
    if (!commandId || !attemptId || !expectedInvocationId || !message) {
      return errorResult(400, "invalid_request", "prompt identity, invocation, and message are required");
    }
    return await this.#broker("prompt", {
      id: commandId,
      attemptId,
      expectedInvocationId,
      message,
      requiredInput: ["text"],
      clearOutbox: true,
    }, false);
  }

  async #dispatchStatus(query: URLSearchParams): Promise<CompanionBoxAgentResult> {
    const attemptId = opaqueId(query.get("attempt_id"));
    const commandId = opaqueId(query.get("command_id"));
    if (!attemptId || !commandId) {
      return errorResult(400, "invalid_request", "dispatch identity is required");
    }
    return await this.#broker("dispatch_status", { attemptId, commandId });
  }

  async #abort(body: Uint8Array | null): Promise<CompanionBoxAgentResult> {
    const parsed = parseJsonBody(body);
    if (!parsed) return errorResult(400, "invalid_request", "a JSON body is required");
    const commandId = opaqueId(parsed.commandId);
    const attemptId = opaqueId(parsed.attemptId);
    if (!commandId || !attemptId) {
      return errorResult(400, "invalid_request", "abort identity is required");
    }
    return await this.#broker("abort", { id: commandId, attemptId }, false);
  }

  async #decision(body: Uint8Array | null): Promise<CompanionBoxAgentResult> {
    const parsed = parseJsonBody(body);
    if (!parsed) return errorResult(400, "invalid_request", "a JSON body is required");
    const commandId = opaqueId(parsed.commandId);
    const attemptId = opaqueId(parsed.attemptId);
    const response = parsed.response;
    if (!commandId || !attemptId || !isJsonObject(response)) {
      return errorResult(400, "invalid_request", "decision identity and response are required");
    }
    return await this.#broker("extension_ui_response", {
      id: commandId,
      attemptId,
      response,
    }, false);
  }

  #uploadAttachment(
    query: URLSearchParams,
    body: Uint8Array | null,
  ): CompanionBoxAgentResult {
    const messageId = attachmentMessageId(query.get("message_id"));
    const position = boundedPosition(query.get("position"));
    const sha256 = query.get("sha256") ?? "";
    if (!messageId || position === null || !/^[a-f0-9]{64}$/.test(sha256) || !body) {
      return errorResult(400, "invalid_request", "attachment upload metadata is invalid");
    }
    if (createHash("sha256").update(body).digest("hex") !== sha256) {
      return errorResult(409, "digest_mismatch", "attachment bytes do not match their digest");
    }
    this.#seams.uploadAttachment({ messageId, position, sha256, bytes: body });
    return { status: 200, body: { uploaded: true, position, byteSize: body.byteLength, sha256 } };
  }

  #commitAttachments(messageIdValue: string, body: Uint8Array | null): CompanionBoxAgentResult {
    const messageId = attachmentMessageId(messageIdValue);
    const parsed = parseJsonBody(body);
    if (!messageId || !parsed || !Array.isArray(parsed.files)
      || parsed.files.length > COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT) {
      return errorResult(400, "invalid_request", "attachment manifest is invalid");
    }
    const files: CompanionBoxAgentAttachmentDescriptor[] = [];
    for (const value of parsed.files) {
      if (!isJsonObject(value)) return errorResult(400, "invalid_request", "attachment entry is invalid");
      const position = Number(value.position);
      const filename = value.filename;
      const contentType = value.contentType;
      const byteSize = Number(value.byteSize);
      const sha256 = value.sha256;
      if (
        !Number.isSafeInteger(position) || position < 0 || position > 9
        || typeof filename !== "string" || !COMPANION_ATTACHMENT_FILENAME_PATTERN.test(filename)
        || typeof contentType !== "string" || !COMPANION_ATTACHMENT_MIME_TYPES.includes(contentType as never)
        || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > COMPANION_ATTACHMENT_MAX_BYTES
        || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
      ) return errorResult(400, "invalid_request", "attachment entry is invalid");
      files.push({ position, filename, contentType, byteSize, sha256 });
    }
    try {
      const committed = this.#seams.commitAttachments({ messageId, files });
      return {
        status: 200,
        body: {
          files: committed.map((file) => ({
            ...file,
            path: `~/attachments/${messageId}/${file.position}-${file.filename}`,
          })),
        },
      };
    } catch {
      return errorResult(409, "attachment_unavailable", "one or more uploaded files are unavailable");
    }
  }

  #readOutbox(query: URLSearchParams): CompanionBoxAgentResult {
    const encodedName = query.get("name") ?? "";
    try {
      const file = this.#seams.readOutbox(encodedName);
      return {
        status: 200,
        body: { entry: file.entry },
        rawBody: file.bytes,
        contentType: "application/octet-stream",
      };
    } catch {
      return errorResult(404, "not_found", "outbox entry is unavailable");
    }
  }

  async #broker(
    type: string,
    fields: PiJsonObject,
    assignAgentId = true,
  ): Promise<CompanionBoxAgentResult> {
    this.#commandSequence += 1;
    const id = assignAgentId
      ? `agent:${this.#commandSequence.toString(10)}`
      : opaqueId(fields.id);
    if (!id) return errorResult(400, "invalid_request", "command id is required");
    let response: PiJsonObject;
    try {
      response = await this.#seams.brokerCommand({ id, type, ...fields });
    } catch {
      // The broker is down during staging and Pi restarts; that is an expected, retryable state.
      return errorResult(503, "broker_unavailable", "Pi broker is unreachable");
    }
    if (response.success === true && isJsonObject(response.data)) {
      return { status: 200, body: response.data };
    }
    const error = isJsonObject(response.error) ? response.error : null;
    return errorResult(
      502,
      typeof error?.code === "string" && error.code ? error.code.slice(0, 64) : "broker_failed",
      typeof error?.message === "string" ? error.message : "Pi broker command failed",
      error?.ambiguous === true,
    );
  }

  #banned(client: string): boolean {
    const until = this.#bans.get(client);
    if (until === undefined) return false;
    if (until <= this.#seams.now()) {
      this.#bans.delete(client);
      return false;
    }
    return true;
  }

  #recordAuthFailure(client: string): void {
    const now = this.#seams.now();
    const recent = (this.#failures.get(client) ?? [])
      .filter((at) => now - at < COMPANION_BOX_AGENT_AUTH_FAILURE_WINDOW_MS);
    recent.push(now);
    if (recent.length >= COMPANION_BOX_AGENT_AUTH_FAILURE_LIMIT) {
      this.#bans.set(client, now + COMPANION_BOX_AGENT_AUTH_BAN_MS);
      this.#failures.delete(client);
    } else {
      this.#failures.set(client, recent);
    }
    this.#pruneTracking(now);
  }

  /** The proxy funnels every caller through few addresses; bound the maps regardless. */
  #pruneTracking(now: number): void {
    if (this.#failures.size > MAX_TRACKED_CLIENTS) {
      for (const [client, attempts] of this.#failures) {
        const last = attempts.at(-1) ?? 0;
        if (now - last >= COMPANION_BOX_AGENT_AUTH_FAILURE_WINDOW_MS) this.#failures.delete(client);
      }
      while (this.#failures.size > MAX_TRACKED_CLIENTS) {
        const oldest = this.#failures.keys().next().value;
        if (oldest === undefined) break;
        this.#failures.delete(oldest);
      }
    }
    if (this.#bans.size > MAX_TRACKED_CLIENTS) {
      for (const [client, until] of this.#bans) {
        if (until <= now) this.#bans.delete(client);
      }
    }
  }
}

function opaqueId(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9._:-]+$/.test(value)
    ? value
    : null;
}

function attachmentMessageId(value: unknown): string | null {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value
    : null;
}

function boundedPosition(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d$/.test(value)) return null;
  const position = Number(value);
  return position >= 0 && position <= 9 ? position : null;
}

function validOutboxName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.includes("/") && name !== "." && name !== "..";
}

function decodeOutboxName(encodedName: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedName) || encodedName.length > 344) {
    throw new Error("outbox name is invalid");
  }
  const name = Buffer.from(encodedName, "base64").toString("utf8");
  if (!validOutboxName(name) || Buffer.from(name, "utf8").toString("base64") !== encodedName) {
    throw new Error("outbox name is invalid");
  }
  return name;
}

export interface StartCompanionBoxAgentServerOptions {
  core: CompanionBoxAgentCore;
  port: number;
  /** The hosted proxy reaches the box only on 0.0.0.0. */
  host?: string;
  maxBodyBytes?: number;
}

/** Bind the HTTP front-end. Request bodies and bearers are never logged. */
export async function startCompanionBoxAgentServer(
  options: StartCompanionBoxAgentServerOptions,
): Promise<Server> {
  const maxBodyBytes = options.maxBodyBytes ?? COMPANION_BOX_AGENT_MAX_BODY_BYTES;
  const server = createHttpServer((request, response) => {
    void receiveBody(request, maxBodyBytes)
      .then(async (body) => {
        if (body === "oversized") {
          respondJson(response, 413, {
            error: { code: "payload_too_large", message: "request body exceeds the agent limit", ambiguous: false },
          });
          return;
        }
        const result = await options.core.handle({
          method: request.method ?? "GET",
          url: request.url ?? "/",
          authorization: firstHeader(request.headers.authorization),
          remoteAddress: request.socket.remoteAddress ?? "unknown",
          body,
        });
        if (result.rawBody) {
          respondBytes(response, result.status, result.rawBody, result.contentType ?? "application/octet-stream");
        } else {
          respondJson(response, result.status, result.body);
        }
      })
      .catch(() => {
        respondJson(response, 500, {
          error: { code: "agent_internal", message: "the box agent failed to answer", ambiguous: false },
        });
      });
  });
  server.requestTimeout = COMPANION_BOX_AGENT_LONG_POLL_CAP_MS + 10_000;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host ?? "0.0.0.0");
  });
  return server;
}

function receiveBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Uint8Array | null | "oversized"> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    request.on("data", (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.byteLength;
      if (bytes > maxBodyBytes) {
        done = true;
        chunks.length = 0;
        resolveBody("oversized");
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (done) return;
      done = true;
      resolveBody(bytes === 0 ? null : Buffer.concat(chunks, bytes));
    });
    request.on("error", () => {
      if (done) return;
      done = true;
      resolveBody(null);
    });
  });
}

function respondJson(response: ServerResponse, status: number, body: PiJsonObject): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function respondBytes(
  response: ServerResponse,
  status: number,
  body: Uint8Array,
  contentType: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": body.byteLength,
  });
  response.end(body);
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function parseUrl(url: string): { path: string; query: URLSearchParams } | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://companion-box-agent.invalid");
  } catch {
    return null;
  }
  return { path: parsed.pathname.replace(/\/+$/, "") || "/", query: parsed.searchParams };
}

function parseJsonBody(body: Uint8Array | null): PiJsonObject | null {
  if (!body || body.byteLength === 0) return null;
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse returns any; widening to unknown forces the narrowing below.
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    return null;
  }
  return isJsonObject(parsed) ? parsed : null;
}

function nonNegativeQueryInteger(query: URLSearchParams, name: string, fallback: number): number | null {
  const raw = query.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d{1,15}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveQueryInteger(query: URLSearchParams, name: string, fallback: number): number | null {
  const value = nonNegativeQueryInteger(query, name, fallback);
  return value === null || value <= 0 ? (value === null ? null : null) : value;
}

function methodNotAllowed(): CompanionBoxAgentResult {
  return errorResult(405, "method_not_allowed", "the agent route does not support this method");
}

function errorResult(
  status: number,
  code: string,
  message: string,
  ambiguous = false,
): CompanionBoxAgentResult {
  return {
    status,
    body: { error: { code, message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH), ambiguous } },
  };
}

function isJsonObject(value: unknown): value is PiJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
