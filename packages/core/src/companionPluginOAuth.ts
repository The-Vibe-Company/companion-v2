import { createHash, randomBytes } from "node:crypto";
import type { CompanionPluginOAuthServerName } from "@companion/contracts";

const OAUTH_TIMEOUT_MS = 10_000;

interface CompanionPluginOAuthServerConfig {
  provider: string;
  remoteUrl: string;
  resourceMetadataUrl: string;
  authorizationServer: string;
  scopes: readonly string[];
  allowedOrigins: readonly string[];
  dynamicRegistration: boolean;
}

export const COMPANION_PLUGIN_OAUTH_SERVERS = {
  "app.linear/linear": {
    provider: "linear",
    remoteUrl: "https://mcp.linear.app/mcp",
    resourceMetadataUrl: "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
    authorizationServer: "https://mcp.linear.app",
    scopes: ["read", "write"],
    allowedOrigins: ["https://mcp.linear.app"],
    dynamicRegistration: true,
  },
  "io.github.github/github-mcp-server": {
    provider: "github",
    remoteUrl: "https://api.githubcopilot.com/mcp/",
    resourceMetadataUrl: "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/",
    authorizationServer: "https://github.com/login/oauth",
    scopes: ["repo", "read:org", "read:user", "user:email"],
    allowedOrigins: ["https://api.githubcopilot.com", "https://github.com"],
    dynamicRegistration: false,
  },
  "com.notion/mcp": {
    provider: "notion",
    remoteUrl: "https://mcp.notion.com/mcp",
    resourceMetadataUrl: "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
    authorizationServer: "https://mcp.notion.com",
    scopes: ["default"],
    allowedOrigins: ["https://mcp.notion.com"],
    dynamicRegistration: true,
  },
} as const satisfies Record<CompanionPluginOAuthServerName, CompanionPluginOAuthServerConfig>;

export interface CompanionPluginOAuthClient {
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
}

export interface CompanionPluginOAuthFlow {
  serverName: CompanionPluginOAuthServerName;
  provider: string;
  remoteUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  scope: string;
  codeVerifier: string;
  client: CompanionPluginOAuthClient;
}

export interface CompanionPluginOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: string | null;
  scope: string | null;
  tokenType: "Bearer";
}

export interface CompanionPluginStoredOAuthCredential extends CompanionPluginOAuthTokens {
  kind: "oauth";
  version: 1;
  serverName: CompanionPluginOAuthServerName;
  tokenEndpoint: string;
  resource: string;
  client: CompanionPluginOAuthClient;
}

export class CompanionPluginOAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "oauth_not_supported"
      | "oauth_not_configured"
      | "oauth_discovery_failed"
      | "oauth_registration_failed"
      | "oauth_exchange_failed"
      | "oauth_refresh_failed",
  ) {
    super(message);
    this.name = "CompanionPluginOAuthError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, error: CompanionPluginOAuthError): string {
  if (typeof value !== "string" || !value.trim()) throw error;
  return value.trim();
}

function allowedUrl(value: unknown, origins: readonly string[], error: CompanionPluginOAuthError): string {
  const raw = requiredString(value, error);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw error;
  }
  if (url.protocol !== "https:" || url.username || url.password || !origins.includes(url.origin)) {
    throw error;
  }
  return url.toString();
}

async function oauthJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  failure: CompanionPluginOAuthError,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(OAUTH_TIMEOUT_MS)])
        : AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw failure;
  }
  if (!response.ok) throw failure;
  const value = await response.json().catch((error: unknown) => {
    if (signal?.aborted) throw signal.reason ?? error;
    return null;
  });
  if (signal?.aborted) throw signal.reason ?? failure;
  if (!isRecord(value)) throw failure;
  return value;
}

function codeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function companionPluginOAuthCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function githubClient(env: NodeJS.ProcessEnv): CompanionPluginOAuthClient {
  const clientId = env.COMPANION_MCP_GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.COMPANION_MCP_GITHUB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new CompanionPluginOAuthError(
      "GitHub MCP OAuth is not configured.",
      "oauth_not_configured",
    );
  }
  return { clientId, clientSecret, tokenEndpointAuthMethod: "client_secret_post" };
}

/**
 * Discover and register an OAuth client for one curated OAuth-first MCP remote. Every URL is
 * constrained to that pin's known origins, so malformed discovery metadata cannot become SSRF.
 */
export async function beginCompanionPluginOAuth(input: {
  serverName: string;
  redirectUri: string;
  state: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<{ authorizationUrl: string; flow: CompanionPluginOAuthFlow }> {
  if (!(input.serverName in COMPANION_PLUGIN_OAUTH_SERVERS)) {
    throw new CompanionPluginOAuthError(
      "This catalog server does not support Companion OAuth.",
      "oauth_not_supported",
    );
  }
  const serverName = input.serverName as CompanionPluginOAuthServerName;
  const server = COMPANION_PLUGIN_OAUTH_SERVERS[serverName];
  const fetchImpl = input.fetchImpl ?? fetch;
  const discoveryFailure = new CompanionPluginOAuthError(
    "The MCP server's OAuth metadata could not be verified.",
    "oauth_discovery_failed",
  );
  const resourceMetadata = await oauthJson(
    server.resourceMetadataUrl,
    { method: "GET" },
    fetchImpl,
    discoveryFailure,
  );
  const resource = allowedUrl(resourceMetadata.resource, server.allowedOrigins, discoveryFailure);
  if (resource !== new URL(server.remoteUrl).toString()) throw discoveryFailure;
  const authorizationServers = resourceMetadata.authorization_servers;
  if (
    !Array.isArray(authorizationServers)
    || !authorizationServers.some((value) => value === server.authorizationServer)
  ) {
    throw discoveryFailure;
  }

  let authorizationEndpoint: string;
  let tokenEndpoint: string;
  let client: CompanionPluginOAuthClient;
  if (serverName === "io.github.github/github-mcp-server") {
    authorizationEndpoint = "https://github.com/login/oauth/authorize";
    tokenEndpoint = "https://github.com/login/oauth/access_token";
    client = githubClient(input.env ?? process.env);
  } else {
    const authorizationMetadata = await oauthJson(
      `${server.authorizationServer}/.well-known/oauth-authorization-server`,
      { method: "GET" },
      fetchImpl,
      discoveryFailure,
    );
    authorizationEndpoint = allowedUrl(
      authorizationMetadata.authorization_endpoint,
      server.allowedOrigins,
      discoveryFailure,
    );
    tokenEndpoint = allowedUrl(
      authorizationMetadata.token_endpoint,
      server.allowedOrigins,
      discoveryFailure,
    );
    const registrationEndpoint = allowedUrl(
      authorizationMetadata.registration_endpoint,
      server.allowedOrigins,
      discoveryFailure,
    );
    const registrationFailure = new CompanionPluginOAuthError(
      "The MCP server could not register this Companion deployment.",
      "oauth_registration_failed",
    );
    const registered = await oauthJson(
      registrationEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Companion",
          redirect_uris: [input.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      },
      fetchImpl,
      registrationFailure,
    );
    const clientId = requiredString(registered.client_id, registrationFailure);
    const clientSecret = typeof registered.client_secret === "string" && registered.client_secret
      ? registered.client_secret
      : null;
    const reportedMethod = registered.token_endpoint_auth_method;
    const tokenEndpointAuthMethod =
      reportedMethod === "client_secret_basic" || reportedMethod === "client_secret_post"
        ? reportedMethod
        : clientSecret ? "client_secret_post" : "none";
    client = { clientId, clientSecret, tokenEndpointAuthMethod };
  }

  const verifier = codeVerifier();
  const scope = server.scopes.join(" ");
  const flow: CompanionPluginOAuthFlow = {
    serverName,
    provider: server.provider,
    remoteUrl: server.remoteUrl,
    authorizationEndpoint,
    tokenEndpoint,
    resource,
    scope,
    codeVerifier: verifier,
    client,
  };
  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", client.clientId);
  authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
  authorizationUrl.searchParams.set("state", input.state);
  authorizationUrl.searchParams.set("code_challenge", companionPluginOAuthCodeChallenge(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("scope", scope);
  if (serverName !== "io.github.github/github-mcp-server") {
    authorizationUrl.searchParams.set("resource", resource);
  }
  return { authorizationUrl: authorizationUrl.toString(), flow };
}

function clientAuthentication(
  client: CompanionPluginOAuthClient,
  body: URLSearchParams,
): Record<string, string> {
  body.set("client_id", client.clientId);
  if (!client.clientSecret || client.tokenEndpointAuthMethod === "none") return {};
  if (client.tokenEndpointAuthMethod === "client_secret_basic") {
    return {
      authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
    };
  }
  body.set("client_secret", client.clientSecret);
  return {};
}

function parseTokens(
  raw: Record<string, unknown>,
  previousRefreshToken: string | null = null,
): CompanionPluginOAuthTokens {
  const failure = new CompanionPluginOAuthError(
    "The MCP server did not return a usable OAuth credential.",
    "oauth_exchange_failed",
  );
  const accessToken = requiredString(raw.access_token, failure);
  if (/[\r\n\0]/.test(accessToken)) throw failure;
  const tokenType = typeof raw.token_type === "string" ? raw.token_type : "Bearer";
  if (tokenType.toLocaleLowerCase("en-US") !== "bearer") throw failure;
  const refreshToken = typeof raw.refresh_token === "string" && raw.refresh_token
    ? raw.refresh_token
    : previousRefreshToken;
  if (refreshToken && /[\r\n\0]/.test(refreshToken)) throw failure;
  const expiresIn = typeof raw.expires_in === "number" && Number.isFinite(raw.expires_in)
    ? Math.max(0, raw.expires_in)
    : null;
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: expiresIn === null
      ? null
      : new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: typeof raw.scope === "string" ? raw.scope : null,
    tokenType: "Bearer",
  };
}

/** Exchange an authorization code without ever returning provider response bodies in errors. */
export async function completeCompanionPluginOAuth(input: {
  flow: CompanionPluginOAuthFlow;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<CompanionPluginStoredOAuthCredential> {
  const failure = new CompanionPluginOAuthError(
    "The MCP authorization code could not be exchanged.",
    "oauth_exchange_failed",
  );
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.flow.codeVerifier,
  });
  if (input.flow.serverName !== "io.github.github/github-mcp-server") {
    body.set("resource", input.flow.resource);
  }
  const authentication = clientAuthentication(input.flow.client, body);
  const raw = await oauthJson(
    input.flow.tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...authentication },
      body,
    },
    input.fetchImpl ?? fetch,
    failure,
  );
  return {
    kind: "oauth",
    version: 1,
    ...parseTokens(raw),
    serverName: input.flow.serverName,
    tokenEndpoint: input.flow.tokenEndpoint,
    resource: input.flow.resource,
    // GitHub's client secret belongs to the deployment, not an account. Keep it in env only.
    client: input.flow.serverName === "io.github.github/github-mcp-server"
      ? { ...input.flow.client, clientSecret: null }
      : input.flow.client,
  };
}

/** Refresh one stored OAuth grant. The old refresh token survives providers that rotate only access. */
export async function refreshCompanionPluginOAuth(input: {
  credential: CompanionPluginStoredOAuthCredential;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CompanionPluginStoredOAuthCredential> {
  if (!input.credential.refreshToken) {
    throw new CompanionPluginOAuthError(
      "The MCP authorization has expired. Reconnect it in Plugins.",
      "oauth_refresh_failed",
    );
  }
  const failure = new CompanionPluginOAuthError(
    "The MCP authorization could not be refreshed. Reconnect it in Plugins.",
    "oauth_refresh_failed",
  );
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.credential.refreshToken,
  });
  const github = input.credential.serverName === "io.github.github/github-mcp-server";
  if (!github) body.set("resource", input.credential.resource);
  const client = github ? githubClient(input.env ?? process.env) : input.credential.client;
  if (client.clientId !== input.credential.client.clientId) throw failure;
  const authentication = clientAuthentication(client, body);
  const raw = await oauthJson(
    input.credential.tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...authentication },
      body,
    },
    input.fetchImpl ?? fetch,
    failure,
    input.signal,
  );
  return {
    ...input.credential,
    ...parseTokens(raw, input.credential.refreshToken),
  };
}
