import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { pipeline, Readable, Transform } from "node:stream";
import { z } from "zod";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const TOKEN_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const gatewayConfigSchema = z.object({
  accounts: z.array(z.object({
    accountId: z.string().regex(UUID),
    credentialGeneration: z.string().regex(UUID),
    upstreamUrl: z.string().url(),
    github: z.boolean(),
  }).strict()).max(50),
}).strict();
const gatewayAddressSchema = z.object({ port: z.number().int().min(1).max(65_535) }).passthrough();
const accessTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_at: z.string().datetime().nullable(),
  credential_version: z.number().int().positive(),
}).strict();
const forwardedHeaderSchema = z.string();

interface GatewayAccount {
  accountId: string;
  credentialGeneration: string;
  upstreamUrl: string;
  github: boolean;
}

interface CachedAccess {
  token: string;
  expiresAt: number | null;
  receivedAt: number;
}

export interface CompanionMcpGateway {
  origin: string;
  close(): Promise<void>;
}

export async function startCompanionMcpGateway(input: {
  configPath: string;
  apiUrl: string;
  brokerToken: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<CompanionMcpGateway | null> {
  const accounts = readGatewayAccounts(input.configPath);
  if (accounts.length === 0) return null;
  if (!/^cmp_mcp_[0-9a-f]{48}$/.test(input.brokerToken)) {
    throw new Error("MCP broker capability is unavailable");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const cache = new Map<string, CachedAccess>();
  const pending = new Map<string, { force: boolean; promise: Promise<CachedAccess> }>();
  let origin = "";

  const accessFor = async (account: GatewayAccount, force: boolean): Promise<CachedAccess> => {
    const cached = cache.get(account.accountId);
    const requestForce = force || Boolean(cached && !cacheUsable(cached, now()));
    const active = pending.get(account.accountId);
    if (active) {
      const value = await active.promise;
      if (!force || active.force) return value;
      return await accessFor(account, true);
    }
    const request = fetchAccessToken({
      account,
      apiUrl: input.apiUrl,
      brokerToken: input.brokerToken,
      forceRefresh: requestForce,
      fetchImpl,
      now,
    }).then((value) => {
      cache.set(account.accountId, value);
      return value;
    }).finally(() => pending.delete(account.accountId));
    pending.set(account.accountId, { force: requestForce, promise: request });
    return await request;
  };

  const server = createServer((request, response) => {
    void handleGatewayRequest({
      request,
      response,
      accounts,
      accessFor,
      fetchImpl,
      gatewayOrigin: () => origin,
    }).catch(() => {
      if (response.headersSent) response.destroy();
      else safeError(response, 502);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = gatewayAddressSchema.safeParse(server.address());
  if (!address.success) {
    server.close();
    throw new Error("MCP gateway did not bind a loopback port");
  }
  origin = `http://127.0.0.1:${address.data.port}`;
  return {
    origin,
    close: async () => await new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

function readGatewayAccounts(path: string): GatewayAccount[] {
  if (!existsSync(path)) return [];
  const parsed = gatewayConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const seen = new Set<string>();
  return parsed.accounts.map((value) => {
    if (seen.has(value.accountId)) throw new Error("invalid MCP gateway account");
    const upstream = new URL(value.upstreamUrl);
    if (upstream.protocol !== "https:" || upstream.username || upstream.password) {
      throw new Error("invalid MCP gateway upstream");
    }
    seen.add(value.accountId);
    return {
      accountId: value.accountId,
      credentialGeneration: value.credentialGeneration,
      upstreamUrl: upstream.toString(),
      github: value.github,
    };
  });
}

function cacheUsable(cached: CachedAccess, now: number): boolean {
  if (cached.expiresAt === null) return true;
  const lifetime = Math.max(0, cached.expiresAt - cached.receivedAt);
  const margin = Math.min(30_000, Math.max(100, Math.floor(lifetime / 10)));
  return cached.expiresAt - now > margin;
}

async function fetchAccessToken(input: {
  account: GatewayAccount;
  apiUrl: string;
  brokerToken: string;
  forceRefresh: boolean;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<CachedAccess> {
  const endpoint = new URL("runtime/mcp-access-token", `${input.apiUrl.replace(/\/+$/, "")}/`);
  const response = await input.fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.brokerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      account_id: input.account.accountId,
      credential_generation: input.account.credentialGeneration,
      force_refresh: input.forceRefresh,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("MCP access token request failed");
  }
  const raw = accessTokenResponseSchema.parse(await response.json());
  const expiresAt = raw.expires_at === null ? null : Date.parse(raw.expires_at);
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= input.now())) {
    throw new Error("MCP access token is already expired");
  }
  return { token: raw.access_token, expiresAt, receivedAt: input.now() };
}

async function handleGatewayRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  accounts: GatewayAccount[];
  accessFor(account: GatewayAccount, force: boolean): Promise<CachedAccess>;
  fetchImpl: typeof fetch;
  gatewayOrigin(): string;
}): Promise<void> {
  const requestUrl = new URL(input.request.url ?? "/", input.gatewayOrigin());
  const route = /^\/(mcp|git)\/([0-9a-f-]{36})(?:\/endpoint\/([A-Za-z0-9_-]+))?$/.exec(requestUrl.pathname);
  if (!route) return safeError(input.response, 404);
  const account = input.accounts.find((candidate) => candidate.accountId === route[2]);
  if (!account) return safeError(input.response, 404);
  if (route[1] === "git") {
    if (!account.github || input.request.method !== "GET") return safeError(input.response, 404);
    const access = await input.accessFor(account, false);
    input.response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      pragma: "no-cache",
    });
    input.response.end(access.token);
    return;
  }
  if (!input.request.method || !["GET", "POST", "DELETE"].includes(input.request.method)) {
    return safeError(input.response, 405);
  }
  const body = input.request.method === "GET" || input.request.method === "DELETE"
    ? undefined
    : await readBoundedBody(input.request);
  const endpointTarget = route[3] ? decodeEndpoint(route[3], account.upstreamUrl) : null;
  const target = endpointTarget ?? new URL(account.upstreamUrl);
  const firstAccess = await input.accessFor(account, false);
  let upstream = await forward({
    target,
    method: input.request.method,
    incomingHeaders: input.request.headers,
    body,
    accessToken: firstAccess.token,
    fetchImpl: input.fetchImpl,
  });
  if (upstream.status === 401) {
    await upstream.body?.cancel().catch(() => undefined);
    const refreshed = await input.accessFor(account, true);
    upstream = await forward({
      target,
      method: input.request.method,
      incomingHeaders: input.request.headers,
      body,
      accessToken: refreshed.token,
      fetchImpl: input.fetchImpl,
    });
  }
  proxyResponse({
    response: input.response,
    upstream,
    account,
    gatewayOrigin: input.gatewayOrigin(),
  });
}

async function forward(input: {
  target: URL;
  method: string;
  incomingHeaders: IncomingHttpHeaders;
  body: Buffer | undefined;
  accessToken: string;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${input.accessToken}` });
  for (const name of ["accept", "content-type", "last-event-id", "mcp-protocol-version", "mcp-session-id"]) {
    const value = forwardedHeaderSchema.safeParse(input.incomingHeaders[name]);
    if (value.success) headers.set(name, value.data);
  }
  return await input.fetchImpl(input.target, {
    method: input.method,
    headers,
    body: input.body,
    redirect: "error",
  });
}

function proxyResponse(input: {
  response: ServerResponse;
  upstream: Response;
  account: GatewayAccount;
  gatewayOrigin: string;
}): void {
  const headers: OutgoingHttpHeaders = { "cache-control": "no-store" };
  for (const name of ["content-type", "mcp-protocol-version", "mcp-session-id", "retry-after"]) {
    const value = input.upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  input.response.writeHead(input.upstream.status, headers);
  if (!input.upstream.body) {
    input.response.end();
    return;
  }
  // SAFETY: Node's fetch body is a Web ReadableStream, while this Node release's overload keeps a
  // narrower generic declaration. The runtime value is exactly the stream accepted by fromWeb.
  const body = Readable.fromWeb(input.upstream.body as never);
  if (input.upstream.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    pipeline(body, endpointRewriteTransform(input.account, input.gatewayOrigin), input.response, (error) => {
      if (error && !input.response.destroyed) input.response.destroy(error);
    });
  } else {
    pipeline(body, input.response, (error) => {
      if (error && !input.response.destroyed) input.response.destroy(error);
    });
  }
}

function endpointRewriteTransform(account: GatewayAccount, gatewayOrigin: string): Transform {
  let pending = "";
  let endpointEvent = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        this.push(lines.map((line) => {
          if (line.trim() === "event: endpoint") endpointEvent = true;
          if (endpointEvent && line.startsWith("data:")) {
            const raw = line.slice(5).trim();
            const target = new URL(raw, account.upstreamUrl);
            if (target.origin !== new URL(account.upstreamUrl).origin || target.username || target.password) {
              throw new Error("invalid MCP SSE endpoint");
            }
            endpointEvent = false;
            const encoded = Buffer.from(target.toString(), "utf8").toString("base64url");
            return `data: ${gatewayOrigin}/mcp/${account.accountId}/endpoint/${encoded}`;
          }
          if (line === "\r" || line === "") endpointEvent = false;
          return line;
        }).join("\n") + "\n");
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error("invalid MCP SSE endpoint"));
      }
    },
    flush(callback) {
      if (pending) this.push(pending);
      callback();
    },
  });
}

function decodeEndpoint(encoded: string, upstreamUrl: string): URL {
  const value = Buffer.from(encoded, "base64url").toString("utf8");
  const endpoint = new URL(value);
  if (endpoint.origin !== new URL(upstreamUrl).origin || endpoint.username || endpoint.password) {
    throw new Error("invalid MCP endpoint origin");
  }
  return endpoint;
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("MCP request body is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function safeError(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
  response.end("MCP gateway unavailable");
}
