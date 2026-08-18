import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

import { createBoxSimPiController } from "./piController";
import {
  BOX_SIM_CONTROL_PREFIX,
  BoxSimHttpError,
  type BoxSimCommandResult,
  type BoxSimDefaults,
  type BoxSimFaultAction,
  type BoxSimFaultRuleInput,
  type BoxSimPiControllerFactory,
} from "./protocol";
import { BoxSimulator, type BoxSimulatorOptions } from "./simulator";

const CONTROL_PREFIX_ALIASES = [BOX_SIM_CONTROL_PREFIX, "/__box-sim", "/_sim"] as const;

export interface BoxSimServerOptions extends BoxSimulatorOptions {
  host?: string;
  port?: number;
  apiKey?: string;
  controlToken?: string;
  bodyLimitBytes?: number;
  simulator?: BoxSimulator;
  piControllerFactory?: BoxSimPiControllerFactory;
}

export interface BoxSimServerHandle {
  readonly server: Server;
  readonly simulator: BoxSimulator;
  readonly baseUrl: string;
  readonly controlUrl: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface JsonObject {
  [key: string]: unknown;
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxSimHttpError(400, "invalid_json_body", "JSON body must be an object");
  }
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject {
  return value === undefined ? {} : asObject(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.headersSent) return;
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": payload.byteLength,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: BoxSimHttpError, requestId: string): void {
  sendJson(response, error.status, {
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
  });
}

function parseBoxListLimit(value: string | null): number {
  if (value === null) return 100;
  if (!/^\d+$/.test(value)) {
    throw new BoxSimHttpError(400, "invalid_request", "limit must be a positive integer");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new BoxSimHttpError(400, "invalid_request", "limit must be between 1 and 200");
  }
  return limit;
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) {
    throw new BoxSimHttpError(413, "request_too_large", `JSON body exceeds ${limit} bytes`);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BoxSimHttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BoxSimHttpError(400, "invalid_path", "Path contains invalid percent encoding");
  }
}

function commandFromFault(action: Extract<BoxSimFaultAction, { kind: "command" }>): BoxSimCommandResult {
  const success = action.success ?? false;
  return {
    success,
    exitCode: action.exitCode === undefined ? (success ? 0 : 1) : action.exitCode,
    stdout: action.stdout ?? "",
    stderr: action.stderr ?? (success ? "" : "simulated command fault"),
  };
}

function controlPath(pathname: string): string | null {
  for (const prefix of CONTROL_PREFIX_ALIASES) {
    if (pathname === prefix) return "/";
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  }
  return null;
}

function headerEquals(request: IncomingMessage, name: string, expected: string): boolean {
  const value = request.headers[name];
  return typeof value === "string" && value === expected;
}

function confirmedDelete(request: IncomingMessage, boxId: string): boolean {
  return request.headers["x-ascii-confirm-delete"] === boxId;
}

export function createBoxSimServer(options: BoxSimServerOptions = {}): BoxSimServerHandle {
  const host = options.host?.trim() || "127.0.0.1";
  const port = options.port ?? 0;
  const apiKey = options.apiKey ?? "box-sim-api-key";
  const controlToken = options.controlToken ?? "box-sim-control-token";
  const bodyLimitBytes = options.bodyLimitBytes ?? 12 * 1024 * 1024;
  if (!apiKey) throw new Error("Box simulator apiKey must not be empty");
  if (!controlToken) throw new Error("Box simulator controlToken must not be empty");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Box simulator port must be between 0 and 65535");
  }
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes < 1) {
    throw new Error("Box simulator bodyLimitBytes must be a positive integer");
  }

  const simulator = options.simulator ?? new BoxSimulator({
    defaults: options.defaults,
    piControllerFactory: options.piControllerFactory === undefined
      ? createBoxSimPiController
      : options.piControllerFactory,
  });
  const sockets = new Set<Socket>();
  const requestIds = new WeakMap<IncomingMessage, string>();
  let requestSequence = 0;

  const requestIdFor = (request: IncomingMessage): string => {
    const existing = requestIds.get(request);
    if (existing) return existing;
    requestSequence += 1;
    const requestId = `req_box_sim_${requestSequence.toString(10).padStart(8, "0")}`;
    requestIds.set(request, requestId);
    return requestId;
  };

  let server!: Server;

  async function applyFault(
    request: IncomingMessage,
    response: ServerResponse,
    point: string,
    commandEndpoint = false,
  ): Promise<boolean> {
    const action = simulator.consumeFault(point);
    if (!action) return false;
    switch (action.kind) {
      case "http":
        sendError(
          response,
          new BoxSimHttpError(
            action.status,
            action.code ?? "simulated_fault",
            action.message ?? `Simulated fault at ${point}`,
          ),
          requestIdFor(request),
        );
        return true;
      case "disconnect":
        request.socket.destroy();
        return true;
      case "stall":
        await new Promise<void>((resolve) => response.once("close", resolve));
        return true;
      case "command":
        if (!commandEndpoint) {
          sendError(
            response,
            new BoxSimHttpError(
              500,
              "invalid_fault_action",
              `Command fault cannot run at ${point}`,
            ),
            requestIdFor(request),
          );
        } else {
          sendJson(response, 200, {
            ok: true,
            type: "command.completed",
            ...commandFromFault(action),
            durationMs: 0,
          });
        }
        return true;
    }
  }

  async function withFault<T>(input: {
    request: IncomingMessage;
    response: ServerResponse;
    point: string;
    commandEndpoint?: boolean;
    operation: () => T | Promise<T>;
    respond: (value: T) => void;
  }): Promise<void> {
    if (await applyFault(
      input.request,
      input.response,
      `${input.point}.before`,
      input.commandEndpoint,
    )) return;
    const value = await input.operation();
    if (await applyFault(
      input.request,
      input.response,
      `${input.point}.after`,
      input.commandEndpoint,
    )) return;
    input.respond(value);
  }

  async function handleControl(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    pathname: string,
  ): Promise<void> {
    if (!headerEquals(request, "x-box-sim-token", controlToken)) {
      throw new BoxSimHttpError(401, "invalid_control_token", "A valid Box simulator control token is required");
    }
    const bodyValue = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await readJsonBody(request, bodyLimitBytes);
    const body = optionalObject(bodyValue);
    simulator.recordRequest({ surface: "control", method: request.method ?? "GET", path: url.pathname, body });

    if (request.method === "POST" && pathname === "/reset") {
      await simulator.reset();
      sendJson(response, 200, { ok: true, type: "box-sim.reset", state: simulator.snapshot() });
      return;
    }
    if (request.method === "PUT" && pathname === "/defaults") {
      const patch = (body.defaults === undefined ? body : asObject(body.defaults)) as Partial<BoxSimDefaults>;
      const defaults = simulator.configureDefaults(patch);
      sendJson(response, 200, { ok: true, type: "box-sim.defaults", defaults });
      return;
    }
    if (request.method === "GET" && pathname === "/state") {
      sendJson(response, 200, { ok: true, type: "box-sim.state", state: simulator.snapshot() });
      return;
    }
    if (request.method === "POST" && pathname === "/faults") {
      const fault = simulator.addFault(body as unknown as BoxSimFaultRuleInput);
      sendJson(response, 201, { ok: true, type: "box-sim.fault", fault });
      return;
    }
    const faultMatch = /^\/faults\/([^/]+)$/.exec(pathname);
    if (request.method === "DELETE" && faultMatch) {
      const id = decodePathSegment(faultMatch[1]!);
      if (!simulator.removeFault(id)) {
        throw new BoxSimHttpError(404, "fault_not_found", `Fault ${id} was not found`);
      }
      sendJson(response, 200, { ok: true, type: "box-sim.fault.deleted", id });
      return;
    }
    const tickMatch = /^\/boxes\/([^/]+)\/tick$/.exec(pathname);
    if (request.method === "POST" && tickMatch) {
      const box = simulator.tickBox(
        decodePathSegment(tickMatch[1]!),
        typeof body.count === "number" ? body.count : 1,
      );
      sendJson(response, 200, { ok: true, type: "box-sim.box.tick", box });
      return;
    }
    const crashMatch = /^\/boxes\/([^/]+)\/pi\/crash$/.exec(pathname);
    if (request.method === "POST" && crashMatch) {
      const boxId = decodePathSegment(crashMatch[1]!);
      await simulator.crashPi(boxId);
      sendJson(response, 200, { ok: true, type: "box-sim.pi.crashed", boxId });
      return;
    }
    const scenarioMatch = /^\/boxes\/([^/]+)\/scenario$/.exec(pathname);
    if (request.method === "PUT" && scenarioMatch) {
      const scenario = typeof body.scenario === "string"
        ? body.scenario
        : typeof body.name === "string" ? body.name : "";
      const boxId = decodePathSegment(scenarioMatch[1]!);
      await simulator.setScenario(boxId, scenario);
      sendJson(response, 200, { ok: true, type: "box-sim.scenario", boxId, scenario });
      return;
    }
    const deletionMatch = /^\/deletion-operations\/([^/]+)$/.exec(pathname);
    if (request.method === "PUT" && deletionMatch) {
      const allowed = new Set(["pending", "processing", "blocked", "completed"]);
      if (typeof body.status !== "string" || !allowed.has(body.status)) {
        throw new BoxSimHttpError(400, "invalid_deletion_status", "invalid deletion operation status");
      }
      const operation = simulator.setDeletionOperationStatus(
        decodePathSegment(deletionMatch[1]!),
        body.status as "pending" | "processing" | "blocked" | "completed",
      );
      sendJson(response, 200, { ok: true, type: "box-sim.deletion", operation });
      return;
    }
    throw new BoxSimHttpError(404, "route_not_found", `No simulator control route for ${request.method} ${pathname}`);
  }

  async function handleProvider(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      throw new BoxSimHttpError(401, "unauthorized", "A valid Box API bearer token is required");
    }
    const method = request.method ?? "GET";
    const bodyValue = method === "GET" || method === "HEAD"
      ? undefined
      : await readJsonBody(request, bodyLimitBytes);
    const body = optionalObject(bodyValue);
    simulator.recordRequest({ surface: "box", method, path: url.pathname, body });

    if (method === "GET" && url.pathname === "/boxes") {
      await withFault({
        request,
        response,
        point: "box.list",
        operation: () => simulator.listBoxes({
          cursor: url.searchParams.get("cursor"),
          limit: parseBoxListLimit(url.searchParams.get("limit")),
          sort: url.searchParams.get("sort") === "desc" ? "desc" : "asc",
        }),
        respond: (result) => sendJson(response, 200, {
          ok: true,
          type: "box.list",
          boxes: result.boxes,
          pageInfo: result.pageInfo,
        }),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/boxes") {
      await withFault({
        request,
        response,
        point: "box.create",
        operation: () => simulator.createBox({
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.ttlSeconds === "number" ? { ttlSeconds: body.ttlSeconds } : {}),
          ...(typeof body.desktopAvailable === "boolean"
            ? { desktopAvailable: body.desktopAvailable }
            : {}),
          ...(typeof body.setupScript === "string" ? { setupScript: body.setupScript } : {}),
          ...(body.env && typeof body.env === "object" && !Array.isArray(body.env)
            ? { env: body.env as Record<string, unknown> }
            : {}),
          ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
          ...(typeof body.noEnv === "boolean" ? { noEnv: body.noEnv } : {}),
        }),
        respond: (box) => sendJson(response, 201, {
          ok: true,
          type: "box.created",
          status: box.state,
          ttlSeconds: box.ttlSeconds,
          box,
        }),
      });
      return;
    }

    const boxMatch = /^\/boxes\/([^/]+)$/.exec(url.pathname);
    if (boxMatch) {
      const boxId = decodePathSegment(boxMatch[1]!);
      if (method === "GET") {
        await withFault({
          request,
          response,
          point: "box.get",
          operation: () => simulator.getBox(boxId),
          respond: (box) => sendJson(response, 200, { ok: true, type: "box.info", box }),
        });
        return;
      }
      if (method === "PATCH") {
        await withFault({
          request,
          response,
          point: "box.patch",
          operation: () => simulator.patchBox(boxId, {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.ttlSeconds === "number" ? { ttlSeconds: body.ttlSeconds } : {}),
          }),
          respond: (box) => sendJson(response, 200, { ok: true, type: "box.info", box }),
        });
        return;
      }
      if (method === "DELETE") {
        if (!confirmedDelete(request, boxId)) {
          throw new BoxSimHttpError(
            409,
            "delete_confirmation_required",
            `Confirm deletion with X-Ascii-Confirm-Delete: ${boxId}`,
          );
        }
        await withFault({
          request,
          response,
          point: "box.delete",
          operation: () => simulator.deleteBox(boxId),
          respond: (operation) => sendJson(response, 202, {
            ok: true,
            type: "box.deleting",
            operation,
          }),
        });
        return;
      }
    }

    const stopMatch = /^\/boxes\/([^/]+)\/stop$/.exec(url.pathname);
    if (method === "POST" && stopMatch) {
      const boxId = decodePathSegment(stopMatch[1]!);
      await withFault({
        request,
        response,
        point: "box.stop",
        operation: () => simulator.stopBox(boxId),
        respond: (box) => sendJson(response, 202, { ok: true, type: "box.stopping", box }),
      });
      return;
    }
    const resumeMatch = /^\/boxes\/([^/]+)\/resume$/.exec(url.pathname);
    if (method === "POST" && resumeMatch) {
      const boxId = decodePathSegment(resumeMatch[1]!);
      await withFault({
        request,
        response,
        point: "box.resume",
        operation: () => simulator.resumeBox(boxId, {
          ...(typeof body.ttlSeconds === "number" ? { ttlSeconds: body.ttlSeconds } : {}),
        }),
        respond: (box) => sendJson(response, 202, { ok: true, type: "box.resuming", box }),
      });
      return;
    }
    const commandMatch = /^\/boxes\/([^/]+)\/commands$/.exec(url.pathname);
    if (method === "POST" && commandMatch) {
      const boxId = decodePathSegment(commandMatch[1]!);
      await withFault({
        request,
        response,
        point: "box.command",
        commandEndpoint: true,
        operation: () => simulator.executeCommand({
          boxId,
          command: typeof body.command === "string" ? body.command : "",
          ...(typeof body.timeoutSeconds === "number" ? { timeoutSeconds: body.timeoutSeconds } : {}),
        }),
        respond: (result) => sendJson(response, 200, {
          ok: true,
          type: "command.completed",
          ...result,
          durationMs: 0,
        }),
      });
      return;
    }
    const filesMatch = /^\/boxes\/([^/]+)\/files$/.exec(url.pathname);
    if (method === "PUT" && filesMatch) {
      const boxId = decodePathSegment(filesMatch[1]!);
      if (body.encoding !== undefined && body.encoding !== "utf8" && body.encoding !== "base64") {
        throw new BoxSimHttpError(400, "invalid_request", "encoding must be utf8 or base64");
      }
      await withFault({
        request,
        response,
        point: "box.file",
        operation: () => simulator.writeFile({
          boxId,
          path: typeof body.path === "string" ? body.path : "",
          content: typeof body.content === "string" ? body.content : "",
          ...(body.encoding === "base64" ? { encoding: "base64" as const } : {}),
        }),
        respond: (file) => sendJson(response, 200, {
          ok: true,
          type: "file.written",
          success: true,
          ...file,
        }),
      });
      return;
    }
    const desktopMatch = /^\/boxes\/([^/]+)\/desktop$/.exec(url.pathname);
    if (method === "POST" && desktopMatch) {
      const boxId = decodePathSegment(desktopMatch[1]!);
      const transport = url.searchParams.get("vnc") === "1" ? "vnc" : "webrtc";
      await withFault({
        request,
        response,
        point: "box.desktop",
        operation: () => simulator.mintDesktop(boxId, transport),
        respond: (desktop) => sendJson(response, 200, {
          ok: true,
          type: "desktop.url",
          success: true,
          transport,
          ...desktop,
        }),
      });
      return;
    }
    const operationMatch = /^\/deletion-operations\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && operationMatch) {
      const operationId = decodePathSegment(operationMatch[1]!);
      await withFault({
        request,
        response,
        point: "deletion.get",
        operation: () => simulator.getDeletionOperation(operationId),
        respond: (operation) => sendJson(response, 200, {
          ok: true,
          type: "deletion.operation",
          operation,
        }),
      });
      return;
    }
    throw new BoxSimHttpError(404, "route_not_found", `No Box route for ${method} ${url.pathname}`);
  }

  server = createServer((request, response) => {
    const requestId = requestIdFor(request);
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "box-sim.invalid"}`);
      const control = controlPath(url.pathname);
      if (
        request.method === "GET"
        && (url.pathname === "/health" || control === "/health")
      ) {
        sendJson(response, 200, { ok: true, type: "box-sim.health", tick: simulator.currentTick });
        return;
      }
      if (control !== null) await handleControl(request, response, url, control);
      else await handleProvider(request, response, url);
    })().catch((error: unknown) => {
      if (response.destroyed) return;
      if (error instanceof BoxSimHttpError) sendError(response, error, requestId);
      else sendError(
        response,
        new BoxSimHttpError(500, "internal_error", "Box simulator request failed"),
        requestId,
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  function resolvedBaseUrl(): string {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Box simulator is not listening");
    }
    const connectHost = address.address === "0.0.0.0" || address.address === "::"
      ? "127.0.0.1"
      : address.family === "IPv6" ? `[${address.address}]` : address.address;
    return `http://${connectHost}:${address.port}`;
  }

  return {
    server,
    simulator,
    get baseUrl() {
      return resolvedBaseUrl();
    },
    get controlUrl() {
      return `${resolvedBaseUrl()}${BOX_SIM_CONTROL_PREFIX}`;
    },
    async listen() {
      if (server.listening) return;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      void (server.address() as AddressInfo | null);
    },
    async close() {
      await simulator.dispose();
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
