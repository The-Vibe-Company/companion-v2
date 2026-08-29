import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

import type { BoxLabConfig } from "./config";
import { BoxLabError, BoxLabService } from "./lab";

const requestBodySchema = z.object({}).passthrough();
const createBoxRequestSchema = z.object({
  ttlSeconds: z.number().optional(),
  setupScript: z.string().optional(),
  from: z.string().optional(),
});
const saveSnapshotRequestSchema = z.object({
  boxId: z.string(),
  name: z.string(),
});
const patchBoxRequestSchema = z.object({
  name: z.string().optional(),
  ttlSeconds: z.number().optional(),
});
const resumeBoxRequestSchema = z.object({
  ttlSeconds: z.number().optional(),
});
const commandRequestSchema = z.object({
  command: z.string(),
  timeoutSeconds: z.number().optional(),
});
const writeFileRequestSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

type RequestBody = z.infer<typeof requestBodySchema>;

export interface BoxLabServerOptions {
  config: BoxLabConfig;
  service: BoxLabService;
  /** Test-only ephemeral port override. Production configuration rejects port zero. */
  port?: number;
}

export interface BoxLabServerHandle {
  readonly server: Server;
  readonly service: BoxLabService;
  readonly baseUrl: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

function sendJson<Body>(response: ServerResponse, status: number, body: Body): void {
  if (response.destroyed || response.headersSent) return;
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.byteLength,
  });
  response.end(payload);
}

function errorEnvelope(error: BoxLabError, requestId: string) {
  return {
    ok: false,
    type: "box.error",
    status: error.status,
    code: error.code,
    message: error.message,
    error: {
      code: error.code,
      message: error.message,
      status: error.status,
      details: { error: error.message },
    },
    requestId,
  };
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<RequestBody> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) throw new BoxLabError(413, "request_too_large", "Box request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: ReturnType<typeof requestBodySchema.safeParse>;
  try {
    parsed = requestBodySchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new BoxLabError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (!parsed.success) {
    throw new BoxLabError(400, "invalid_json_body", "JSON body must be an object");
  }
  return parsed.data;
}

function parseRequest<Output>(schema: z.ZodType<Output>, body: RequestBody): Output {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BoxLabError(
      400,
      "invalid_request",
      parsed.error.issues[0]?.message ?? "Request body is invalid",
    );
  }
  return parsed.data;
}

function authenticated(header: string | undefined, apiKey: string): boolean {
  if (header === undefined) return false;
  const expected = Buffer.from(`Bearer ${apiKey}`, "utf8");
  const actual = Buffer.from(header, "utf8");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BoxLabError(400, "invalid_path", "Path contains invalid percent encoding");
  }
}

function listLimit(value: string | null): number {
  if (value === null) return 100;
  if (!/^\d+$/.test(value)) throw new BoxLabError(400, "invalid_request", "limit must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new BoxLabError(400, "invalid_request", "limit must be between 1 and 200");
  }
  return parsed;
}

export function createBoxLabServer(options: BoxLabServerOptions): BoxLabServerHandle {
  const { config, service } = options;
  const requestedPort = options.port ?? config.port;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("Box Lab server port is invalid");
  }
  let requestSequence = 0;
  let server!: Server;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "box-lab.invalid"}`);
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        type: "box-lab.health",
        driver: service.driverKind,
        workspaceId: config.workspaceId,
      });
      return;
    }
    if (!authenticated(request.headers.authorization, config.apiKey)) {
      throw new BoxLabError(401, "unauthorized", "A valid Box API bearer token is required");
    }
    const body = method === "GET" || method === "HEAD"
      ? {}
      : await readJsonBody(request, config.bodyLimitBytes);

    if (method === "GET" && url.pathname === "/boxes") {
      const result = await service.listBoxes({
        cursor: url.searchParams.get("cursor"),
        limit: listLimit(url.searchParams.get("limit")),
        sort: url.searchParams.get("sort") === "desc" ? "desc" : "asc",
      });
      sendJson(response, 200, { ok: true, type: "box.list", ...result });
      return;
    }
    if (method === "POST" && url.pathname === "/boxes") {
      const box = await service.createBox(parseRequest(createBoxRequestSchema, body));
      sendJson(response, 202, {
        ok: true,
        type: "box.created",
        status: box.state,
        ttlSeconds: box.ttlSeconds,
        box,
      });
      return;
    }
    if (method === "GET" && url.pathname === "/named-snapshots") {
      sendJson(response, 200, {
        ok: true,
        type: "snapshot.named.list",
        snapshots: await service.listSnapshots(),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/named-snapshots") {
      const input = parseRequest(saveSnapshotRequestSchema, body);
      const snapshot = await service.saveSnapshot(input.boxId, input.name);
      sendJson(response, 202, {
        ok: true,
        type: "snapshot.named.saving",
        snapshot,
        status: snapshot.status,
      });
      return;
    }
    const snapshotMatch = /^\/named-snapshots\/([^/]+)$/.exec(url.pathname);
    if (snapshotMatch) {
      const name = decodeSegment(snapshotMatch[1]!);
      if (method === "GET") {
        const snapshot = await service.getSnapshot(name);
        sendJson(response, 200, { ok: true, type: "snapshot.named.info", snapshot, status: snapshot.status });
        return;
      }
      if (method === "DELETE") {
        await service.deleteSnapshot(name);
        sendJson(response, 200, { ok: true, type: "snapshot.named.deleted", name });
        return;
      }
    }
    const boxMatch = /^\/boxes\/([^/]+)$/.exec(url.pathname);
    if (boxMatch) {
      const boxId = decodeSegment(boxMatch[1]!);
      if (method === "GET") {
        sendJson(response, 200, { ok: true, type: "box.info", box: await service.getBox(boxId) });
        return;
      }
      if (method === "PATCH") {
        const box = await service.patchBox(boxId, parseRequest(patchBoxRequestSchema, body));
        sendJson(response, 200, { ok: true, type: "box.updated", box });
        return;
      }
      if (method === "DELETE") {
        if (request.headers["x-ascii-confirm-delete"] !== boxId) {
          throw new BoxLabError(409, "delete_confirmation_required", `Confirm deletion with X-Ascii-Confirm-Delete: ${boxId}`);
        }
        const operation = await service.requestDeletion(boxId);
        sendJson(response, 202, { ok: true, type: "box.deleting", operation });
        return;
      }
    }
    const stopMatch = /^\/boxes\/([^/]+)\/stop$/.exec(url.pathname);
    if (method === "POST" && stopMatch) {
      const box = await service.stopBox(decodeSegment(stopMatch[1]!));
      sendJson(response, 202, { ok: true, type: "box.stopping", box });
      return;
    }
    const resumeMatch = /^\/boxes\/([^/]+)\/resume$/.exec(url.pathname);
    if (method === "POST" && resumeMatch) {
      const box = await service.resumeBox(
        decodeSegment(resumeMatch[1]!),
        parseRequest(resumeBoxRequestSchema, body),
      );
      sendJson(response, 202, { ok: true, type: "box.resuming", box });
      return;
    }
    const commandMatch = /^\/boxes\/([^/]+)\/commands$/.exec(url.pathname);
    if (method === "POST" && commandMatch) {
      const startedAt = Date.now();
      const input = parseRequest(commandRequestSchema, body);
      const result = await service.executeCommand({
        boxId: decodeSegment(commandMatch[1]!),
        command: input.command,
        timeoutSeconds: input.timeoutSeconds,
      });
      sendJson(response, 200, {
        ok: true,
        type: "command.completed",
        success: result.success,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    const fileMatch = /^\/boxes\/([^/]+)\/files$/.exec(url.pathname);
    if (method === "PUT" && fileMatch) {
      const input = parseRequest(writeFileRequestSchema, body);
      const file = await service.writeBoxFile({
        boxId: decodeSegment(fileMatch[1]!),
        path: input.path,
        content: input.content,
        encoding: input.encoding,
      });
      sendJson(response, 200, { ok: true, type: "file.written", success: true, ...file });
      return;
    }
    if (/^\/boxes\/[^/]+\/(?:desktop|host)$/.test(url.pathname)) {
      throw new BoxLabError(501, "unsupported_surface", "Desktop and direct transport are not available in Box Lab v1");
    }
    const deletionMatch = /^\/deletion-operations\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && deletionMatch) {
      const operation = await service.getDeletion(decodeSegment(deletionMatch[1]!));
      sendJson(response, 200, { ok: true, type: "deletion.operation", operation });
      return;
    }
    throw new BoxLabError(404, "route_not_found", `No Box Lab route for ${method} ${url.pathname}`);
  }

  server = createServer((request, response) => {
    requestSequence += 1;
    const requestId = `req_box_lab_${requestSequence.toString(10).padStart(8, "0")}`;
    void route(request, response).catch((error) => {
      const safe = error instanceof BoxLabError
        ? error
        : new BoxLabError(500, "internal_error", "Box Lab request failed");
      sendJson(response, safe.status, errorEnvelope(safe, requestId));
    });
  });

  return {
    server,
    service,
    get baseUrl() {
      // SAFETY: this server is opened as a TCP listener, so Node returns AddressInfo while listening.
      const address = server.address() as AddressInfo | null;
      const port = address?.port ?? requestedPort;
      const host = config.host === "::1" ? "[::1]" : config.host;
      return `http://${host}:${port}`;
    },
    async listen() {
      await service.initialize();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const onError = (error: Error): void => rejectPromise(error);
        server.once("error", onError);
        server.listen(requestedPort, config.host, () => {
          server.off("error", onError);
          resolvePromise();
        });
      });
    },
    async close() {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        if (!server.listening) {
          resolvePromise();
          return;
        }
        server.close((error) => error ? rejectPromise(error) : resolvePromise());
      });
      await service.close();
    },
  };
}
