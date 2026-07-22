const FALLBACK_AGENT_AUTH_URL = "http://127.0.0.1:3001";
const MAX_AGENT_AUTH_HOST_BODY_BYTES = 64 * 1024;
const MAX_AGENT_AUTH_JWT_PAYLOAD_BYTES = 32 * 1024;

type RemoteKeyGuardResult = "allowed" | "remote-jwks" | "body-too-large";

function configuredAgentAuthUrl(): string {
  return process.env.BETTER_AUTH_URL ?? process.env.COMPANION_API_URL ?? FALLBACK_AGENT_AUTH_URL;
}

function canonicalOrigin(configuredUrl = configuredAgentAuthUrl()): URL {
  const parsed = new URL(configuredUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("BETTER_AUTH_URL must be an HTTP(S) public origin");
  }
  return new URL(parsed.origin);
}

function singleForwardedValue(value: string | null): string | null | undefined {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.includes(",")) return undefined;
  return normalized;
}

function effectivePort(origin: URL): string {
  if (origin.port) return origin.port;
  return origin.protocol === "https:" ? "443" : "80";
}

function isCanonicalHost(value: string, origin: URL): boolean {
  return value.toLowerCase() === origin.host.toLowerCase();
}

/** Agent Auth routes are the only Better Auth surface that accepts host/agent JWT audiences. */
export function isAgentAuthProtocolPath(pathname: string): boolean {
  return pathname === "/auth/agent"
    || pathname.startsWith("/auth/agent/")
    || pathname === "/auth/host"
    || pathname.startsWith("/auth/host/")
    || pathname === "/auth/capability"
    || pathname.startsWith("/auth/capability/");
}

function decodedJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1] || !/^[A-Za-z0-9_-]+$/.test(segments[1])) return null;
  // Base64 expands three input bytes to four characters. Reject oversized unverified claims before
  // allocating or parsing them; the Agent Auth plugin applies the authoritative JWT validation.
  if (segments[1].length > Math.ceil(MAX_AGENT_AUTH_JWT_PAYLOAD_BYTES * 4 / 3) + 4) return null;
  try {
    const decoded = Buffer.from(segments[1], "base64url");
    if (decoded.byteLength > MAX_AGENT_AUTH_JWT_PAYLOAD_BYTES) return null;
    const value = JSON.parse(decoded.toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Agent Auth 0.6.2 can dereference host/agent JWKS URLs before it authenticates a dynamic host.
 * Companion deliberately supports dynamic registration only with inline public JWKs, so unverified
 * JWT claims can be inspected solely to reject the unsafe transport before the plugin sees it.
 */
export function authorizationUsesRemoteAgentJwks(authorization: string | null | undefined): boolean {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1]) return false;
  const payload = decodedJwtPayload(match[1]);
  if (!payload) return false;
  return ["host_jwks_url", "agent_jwks_url"].some(
    (field) => Object.hasOwn(payload, field) && payload[field] !== null && payload[field] !== undefined,
  );
}

async function boundedRequestText(request: Request, maxBytes: number): Promise<string | null> {
  const body = request.clone().body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** Reject every remote-key entrypoint while preserving inline-key host registration. */
export async function guardAgentAuthRemoteKeys(request: Request): Promise<RemoteKeyGuardResult> {
  const url = new URL(request.url);
  if (!isAgentAuthProtocolPath(url.pathname)) return "allowed";
  if (authorizationUsesRemoteAgentJwks(request.headers.get("authorization"))) return "remote-jwks";

  const normalizedPath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

  if (
    request.method.toUpperCase() !== "POST"
    || (normalizedPath !== "/auth/host/create" && normalizedPath !== "/auth/host/update")
  ) {
    return "allowed";
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_AGENT_AUTH_HOST_BODY_BYTES) return "body-too-large";
  const text = await boundedRequestText(request, MAX_AGENT_AUTH_HOST_BODY_BYTES);
  if (text === null) return "body-too-large";
  try {
    const body = JSON.parse(text) as unknown;
    if (
      body !== null
      && typeof body === "object"
      && !Array.isArray(body)
      && Object.hasOwn(body, "jwks_url")
      && (body as Record<string, unknown>).jwks_url !== null
      && (body as Record<string, unknown>).jwks_url !== undefined
    ) {
      return "remote-jwks";
    }
  } catch {
    // Better Auth owns normal request-shape errors. This guard only rejects the remote-key surface.
  }
  return "allowed";
}

/**
 * Validate proxy origin headers against the configured public Agent Auth origin, then replace them
 * with one canonical representation. Agent Auth 0.6.2 otherwise treats the request `Host` as an
 * additional valid JWT audience, which would make a client-controlled Host an authorization input.
 *
 * A reverse proxy may keep an internal `Host` only when it also supplies the exact public
 * `x-forwarded-host`. Multi-hop comma-separated values are deliberately rejected instead of guessing
 * which proxy is trusted.
 */
export function canonicalAgentAuthHeaders(
  input: Headers,
  configuredUrl = configuredAgentAuthUrl(),
): Headers | null {
  const origin = canonicalOrigin(configuredUrl);
  const companionProxyOrigin = singleForwardedValue(input.get("x-companion-agent-auth-origin"));
  if (companionProxyOrigin === undefined) return null;
  const companionProxyMatched = companionProxyOrigin !== null;
  if (companionProxyMatched && companionProxyOrigin !== origin.origin) return null;

  const forwardedHost = singleForwardedValue(input.get("x-forwarded-host"));
  const forwardedProto = singleForwardedValue(input.get("x-forwarded-proto"));
  const forwardedPort = singleForwardedValue(input.get("x-forwarded-port"));
  if (forwardedHost === undefined || forwardedProto === undefined || forwardedPort === undefined) return null;

  if (!companionProxyMatched) {
    if (forwardedHost !== null && !isCanonicalHost(forwardedHost, origin)) return null;
    if (forwardedProto !== null && `${forwardedProto.toLowerCase()}:` !== origin.protocol) return null;
    if (forwardedPort !== null && forwardedPort !== effectivePort(origin)) return null;
  }

  const directHost = singleForwardedValue(input.get("host"));
  if (directHost === undefined) return null;
  if (!companionProxyMatched && forwardedHost === null && directHost !== null && !isCanonicalHost(directHost, origin)) {
    return null;
  }

  const headers = new Headers(input);
  headers.set("host", origin.host);
  // The plugin no longer needs to trust proxy-derived origin fields: all audience checks see the
  // configured public host. Keep x-forwarded-for for Better Auth's rate-limit/IP accounting.
  headers.delete("forwarded");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-port");
  headers.delete("x-companion-agent-auth-origin");
  return headers;
}

export function canonicalizeAgentAuthRequest(
  request: Request,
  configuredUrl = configuredAgentAuthUrl(),
): Request | null {
  if (!isAgentAuthProtocolPath(new URL(request.url).pathname)) return request;
  const headers = canonicalAgentAuthHeaders(request.headers, configuredUrl);
  return headers ? new Request(request, { headers }) : null;
}
