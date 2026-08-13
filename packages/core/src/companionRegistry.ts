import { z } from "zod";
import type {
  CompanionRegistryConnect,
  CompanionRegistryCredential,
  CompanionRegistryDetailResponse,
  CompanionRegistryListResponse,
  CompanionRegistryServer,
} from "@companion/contracts";

/**
 * Server-side proxy and cache for the official MCP registry (THE-327).
 *
 * The registry (`https://registry.modelcontextprotocol.io`) is a zero-SLA preview, so the browser
 * never calls it. This module fetches, normalizes, filters (dropping `deleted`/`deprecated`), and
 * caches results with a ~1h TTL plus a last-good fallback, and applies the curated pin overrides so
 * the Plugins surface always has something to show even when the registry is down.
 */

const DEFAULT_REGISTRY_BASE = "https://registry.modelcontextprotocol.io";
const REGISTRY_CACHE_TTL_MS = 60 * 60 * 1000;
const REGISTRY_REQUEST_TIMEOUT_MS = 8_000;
const REGISTRY_PAGE_LIMIT = 30;
const REGISTRY_PAGE_LIMIT_MAX = 50;

/** Reads the registry base URL, allowing an operator override while keeping a safe default. */
export function companionRegistryBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.COMPANION_MCP_REGISTRY_BASE?.trim() || DEFAULT_REGISTRY_BASE).replace(/\/+$/, "");
}

/**
 * Curated, verified overrides pinned to the top of the browse surface (verified 2026-08-13). GitHub
 * is pinned to the hosted Copilot remote because its registry entry is stdio/OCI only; Linear and
 * Notion pin their official `streamable-http` remotes. Auth V1 is a token/header the user pastes;
 * OAuth is THE-328. Pins never require the registry to be reachable.
 */
export const COMPANION_MCP_REGISTRY_PINS: readonly CompanionRegistryServer[] = [
  {
    name: "app.linear/linear",
    provider: "linear",
    title: "Linear",
    description: "Linear project management and issue tracking.",
    version: "latest",
    website_url: "https://linear.app",
    repository_url: null,
    pinned: true,
    connect: {
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      credential: {
        name: "Authorization",
        description: "Optional bearer token. Leave blank until OAuth ships (THE-328).",
        is_secret: true,
        required: false,
      },
    },
  },
  {
    name: "io.github.github/github-mcp-server",
    provider: "github",
    title: "GitHub",
    description: "GitHub repositories, issues, pull requests, and workflows.",
    version: "latest",
    website_url: "https://github.com/github/github-mcp-server",
    repository_url: "https://github.com/github/github-mcp-server",
    pinned: true,
    connect: {
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      credential: {
        name: "Authorization",
        description: "Authorization header, e.g. a GitHub token as `Bearer <token>`.",
        is_secret: true,
        required: false,
      },
    },
  },
  {
    name: "com.notion/mcp",
    provider: "notion",
    title: "Notion",
    description: "Notion pages, databases, and search.",
    version: "latest",
    website_url: "https://www.notion.so",
    repository_url: null,
    pinned: true,
    connect: {
      transport: "http",
      url: "https://mcp.notion.com/mcp",
      credential: {
        name: "Authorization",
        description: "Optional bearer token. Leave blank until OAuth ships (THE-328).",
        is_secret: true,
        required: false,
      },
    },
  },
];

const PINNED_NAMES = new Set(COMPANION_MCP_REGISTRY_PINS.map((pin) => pin.name));

export class CompanionRegistryUnavailableError extends Error {
  constructor() {
    super("The MCP registry is unavailable and no cached copy exists yet.");
    this.name = "CompanionRegistryUnavailableError";
  }
}

/**
 * Provider slug derived from a registry reverse-DNS name. The last label of the namespace is the
 * brand: `app.linear/linear` and `io.github.github/github-mcp-server` and `com.notion/mcp` become
 * `linear`, `github`, and `notion`. Sanitized to the `saveCompanionPlugin` provider grammar.
 */
export function deriveCompanionProviderSlug(name: string): string {
  const namespace = name.split("/")[0] ?? name;
  const label = namespace.split(".").filter(Boolean).pop() ?? namespace;
  let slug = label
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  if (!slug) slug = "mcp";
  if (!/^[a-z]/.test(slug)) slug = `mcp-${slug}`.slice(0, 63).replace(/-+$/g, "");
  return slug;
}

const registryKeyValueSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullish(),
  isSecret: z.boolean().nullish(),
  isRequired: z.boolean().nullish(),
  value: z.string().nullish(),
});

const registryArgumentSchema = z.object({
  type: z.string().optional(),
  name: z.string().nullish(),
  value: z.string().nullish(),
  valueHint: z.string().nullish(),
  isRequired: z.boolean().nullish(),
  isSecret: z.boolean().nullish(),
});

const registryTransportSchema = z.object({
  type: z.string().optional(),
  url: z.string().nullish(),
  headers: z.array(registryKeyValueSchema).nullish(),
});

const registryPackageSchema = z.object({
  registryType: z.string().optional(),
  identifier: z.string().optional(),
  version: z.string().nullish(),
  runtimeHint: z.string().nullish(),
  transport: registryTransportSchema.nullish(),
  runtimeArguments: z.array(registryArgumentSchema).nullish(),
  packageArguments: z.array(registryArgumentSchema).nullish(),
  environmentVariables: z.array(registryKeyValueSchema).nullish(),
});

const registryServerJsonSchema = z.object({
  name: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  version: z.string().nullish(),
  websiteUrl: z.string().nullish(),
  repository: z.object({ url: z.string().nullish() }).nullish(),
  remotes: z.array(registryTransportSchema).nullish(),
  packages: z.array(registryPackageSchema).nullish(),
});

const registryOfficialMetaSchema = z.object({
  status: z.string().nullish(),
  isLatest: z.boolean().nullish(),
});

const registryServerResponseSchema = z.object({
  server: registryServerJsonSchema,
  _meta: z
    .object({ "io.modelcontextprotocol.registry/official": registryOfficialMetaSchema.nullish() })
    .nullish(),
});

const registryListResponseSchema = z.object({
  servers: z.array(registryServerResponseSchema).nullish(),
  metadata: z.object({ nextCursor: z.string().nullish(), count: z.number().nullish() }).nullish(),
});

type RegistryServerResponse = z.infer<typeof registryServerResponseSchema>;
type RegistryTransport = z.infer<typeof registryTransportSchema>;
type RegistryPackage = z.infer<typeof registryPackageSchema>;

function lastNameSegment(name: string): string {
  const afterSlash = name.split("/")[1] ?? name;
  return afterSlash || name;
}

function headerCredential(
  headers: z.infer<typeof registryKeyValueSchema>[] | null | undefined,
): CompanionRegistryCredential | null {
  const named = (headers ?? []).filter((header) => header.name?.trim());
  if (named.length === 0) return null;
  const chosen = named.find((header) => header.isSecret) ?? named[0]!;
  return {
    name: chosen.name!.trim(),
    description: chosen.description?.trim() || null,
    is_secret: Boolean(chosen.isSecret),
    required: Boolean(chosen.isRequired),
  };
}

function envCredential(
  variables: z.infer<typeof registryKeyValueSchema>[] | null | undefined,
): CompanionRegistryCredential | null {
  const named = (variables ?? []).filter(
    (variable) => variable.name && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(variable.name),
  );
  if (named.length === 0) return null;
  const chosen = named.find((variable) => variable.isSecret) ?? named[0]!;
  return {
    name: chosen.name!,
    description: chosen.description?.trim() || null,
    is_secret: Boolean(chosen.isSecret),
    required: Boolean(chosen.isRequired),
  };
}

/** Literal argument values only; templated (`{token}`) or secret args are left for the user. */
function literalArgs(args: z.infer<typeof registryArgumentSchema>[] | null | undefined): string[] {
  const out: string[] = [];
  for (const arg of args ?? []) {
    if (arg.isSecret) continue;
    const value = arg.value?.trim();
    const hasTemplate = value ? /\{[^}]+\}/.test(value) : false;
    if (arg.type === "named" && arg.name) {
      out.push(arg.name);
      if (value && !hasTemplate) out.push(value);
    } else if (value && !hasTemplate) {
      out.push(value);
    }
  }
  return out;
}

/** Builds a stdio command for the `npx`/`uvx`/`oci` package shapes the issue calls out. */
function stdioConnect(pkg: RegistryPackage): CompanionRegistryConnect | null {
  const identifier = pkg.identifier?.trim();
  if (!identifier) return null;
  const registryType = pkg.registryType?.toLocaleLowerCase("en-US");
  const packageArgs = literalArgs(pkg.packageArguments);
  const credential = envCredential(pkg.environmentVariables);
  let command: string;
  let args: string[];
  switch (registryType) {
    case "npm":
      command = "npx";
      args = ["-y", identifier, ...packageArgs];
      break;
    case "pypi":
      command = "uvx";
      args = [identifier, ...packageArgs];
      break;
    case "oci":
      command = "docker";
      args = ["run", "-i", "--rm", identifier, ...packageArgs];
      break;
    default:
      return null;
  }
  return { transport: "stdio", command, args, credential };
}

function resolveConnect(server: z.infer<typeof registryServerJsonSchema>): CompanionRegistryConnect | null {
  const httpRemote = (server.remotes ?? []).find(
    (remote: RegistryTransport) => remote.type === "streamable-http" && remote.url?.trim(),
  );
  if (httpRemote?.url) {
    return {
      transport: "http",
      url: httpRemote.url.trim(),
      credential: headerCredential(httpRemote.headers),
    };
  }
  const stdioPackage = (server.packages ?? []).find(
    (pkg: RegistryPackage) => pkg.transport?.type === "stdio",
  );
  return stdioPackage ? stdioConnect(stdioPackage) : null;
}

/**
 * Normalize a raw registry entry. Returns null for `deleted`/`deprecated` entries unless
 * `includeInactive` is set (detail reads keep an explicitly-requested server visible). Pinned names
 * are returned as their curated override so the metadata never drifts from the verified pin.
 */
export function mapRegistryServer(
  response: RegistryServerResponse,
  options: { includeInactive?: boolean } = {},
): CompanionRegistryServer | null {
  const pin = COMPANION_MCP_REGISTRY_PINS.find((entry) => entry.name === response.server.name);
  if (pin) return pin;
  const status = response._meta?.["io.modelcontextprotocol.registry/official"]?.status;
  if (!options.includeInactive && (status === "deleted" || status === "deprecated")) return null;
  const server = response.server;
  return {
    name: server.name,
    provider: deriveCompanionProviderSlug(server.name),
    title: server.title?.trim() || lastNameSegment(server.name),
    description: server.description?.trim() || "",
    version: server.version?.trim() || "latest",
    website_url: server.websiteUrl?.trim() || null,
    repository_url: server.repository?.url?.trim() || null,
    pinned: false,
    connect: resolveConnect(server),
  };
}

interface RegistryListPage {
  servers: CompanionRegistryServer[];
  nextCursor: string | null;
}

interface CacheEntry {
  value: unknown;
  storedAt: number;
}

/** In-memory TTL cache that also keeps the last-good value for fallback when the registry is down. */
export class CompanionRegistryCache {
  private readonly store = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.store.get(key);
  }

  set(key: string, value: unknown, storedAt: number): void {
    this.store.set(key, { value, storedAt });
  }

  clear(): void {
    this.store.clear();
  }
}

const defaultCache = new CompanionRegistryCache();

interface RegistryClientOptions {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  cache?: CompanionRegistryCache;
  now?: () => number;
}

function resolveOptions(options: RegistryClientOptions) {
  return {
    baseUrl: options.baseUrl ?? companionRegistryBaseUrl(options.env),
    fetchImpl: options.fetchImpl ?? fetch,
    cache: options.cache ?? defaultCache,
    now: options.now ?? Date.now,
  };
}

async function fetchRegistryJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry responded ${response.status}`);
  return response.json();
}

async function fetchRegistryPage(
  fetchImpl: typeof fetch,
  baseUrl: string,
  params: { search?: string; cursor?: string; limit: number },
): Promise<RegistryListPage> {
  const query = new URLSearchParams({ version: "latest", limit: String(params.limit) });
  if (params.search) query.set("search", params.search);
  if (params.cursor) query.set("cursor", params.cursor);
  const raw = await fetchRegistryJson(fetchImpl, `${baseUrl}/v0.1/servers?${query.toString()}`);
  const parsed = registryListResponseSchema.parse(raw);
  const servers: CompanionRegistryServer[] = [];
  for (const entry of parsed.servers ?? []) {
    if (PINNED_NAMES.has(entry.server.name)) continue;
    const mapped = mapRegistryServer(entry);
    if (mapped) servers.push(mapped);
  }
  return { servers, nextCursor: parsed.metadata?.nextCursor?.trim() || null };
}

/**
 * List/search the registry through the cache. Pins are attached on the default view (no search, no
 * cursor). A fresh fetch is `live`; a TTL hit or a fallback to the last-good page is `cache`; a cold
 * failure returns `unavailable` with only pins so the surface is never blank.
 */
export async function listCompanionRegistry(
  input: { search?: string; cursor?: string; limit?: number } & RegistryClientOptions = {},
): Promise<CompanionRegistryListResponse> {
  const { baseUrl, fetchImpl, cache, now } = resolveOptions(input);
  const search = input.search?.trim() || undefined;
  const cursor = input.cursor?.trim() || undefined;
  const limit = Math.min(Math.max(input.limit ?? REGISTRY_PAGE_LIMIT, 1), REGISTRY_PAGE_LIMIT_MAX);
  const pins = !search && !cursor ? [...COMPANION_MCP_REGISTRY_PINS] : [];
  const key = `servers:${baseUrl}:${limit}:${search ?? ""}:${cursor ?? ""}`;

  const entry = cache.get(key);
  if (entry && now() - entry.storedAt < REGISTRY_CACHE_TTL_MS) {
    const page = entry.value as RegistryListPage;
    return { pins, servers: page.servers, next_cursor: page.nextCursor, source: "cache" };
  }
  try {
    const page = await fetchRegistryPage(fetchImpl, baseUrl, { search, cursor, limit });
    cache.set(key, page, now());
    return { pins, servers: page.servers, next_cursor: page.nextCursor, source: "live" };
  } catch {
    if (entry) {
      const page = entry.value as RegistryListPage;
      return { pins, servers: page.servers, next_cursor: page.nextCursor, source: "cache" };
    }
    return { pins, servers: [], next_cursor: null, source: "unavailable" };
  }
}

/**
 * Fetch one server's latest version through the cache. Pinned names resolve to their curated
 * override without touching the registry. A cold failure with no cached copy throws
 * `CompanionRegistryUnavailableError`.
 */
export async function getCompanionRegistryServer(
  input: { name: string } & RegistryClientOptions,
): Promise<CompanionRegistryDetailResponse> {
  const pin = COMPANION_MCP_REGISTRY_PINS.find((entry) => entry.name === input.name);
  if (pin) return { server: pin, source: "live" };

  const { baseUrl, fetchImpl, cache, now } = resolveOptions(input);
  const key = `server:${baseUrl}:${input.name}`;
  const entry = cache.get(key);
  if (entry && now() - entry.storedAt < REGISTRY_CACHE_TTL_MS) {
    return { server: entry.value as CompanionRegistryServer, source: "cache" };
  }
  try {
    const raw = await fetchRegistryJson(
      fetchImpl,
      `${baseUrl}/v0.1/servers/${encodeURIComponent(input.name)}/versions/latest`,
    );
    const parsed = registryServerResponseSchema.parse(raw);
    const server = mapRegistryServer(parsed, { includeInactive: true });
    if (!server) throw new Error("registry entry could not be normalized");
    cache.set(key, server, now());
    return { server, source: "live" };
  } catch (error) {
    if (entry) return { server: entry.value as CompanionRegistryServer, source: "cache" };
    if (error instanceof CompanionRegistryUnavailableError) throw error;
    throw new CompanionRegistryUnavailableError();
  }
}
