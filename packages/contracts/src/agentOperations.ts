/**
 * Capabilities that may authorize a tenant-scoped Companion REST operation.
 * `public-skills:install` is deliberately absent: it can only be executed as a
 * capability to mint an exact public-package transfer ticket.
 */
export type CompanionAgentTenantCapability =
  | "skills:read"
  | "skills:write"
  | "secrets:read"
  | "secrets:write";

export type CompanionAgentHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CompanionAgentOperationTransport =
  | "rest"
  | "transfer-ticket-upload"
  | "transfer-ticket-download";

export interface CompanionAgentOperationDefinition {
  readonly method: CompanionAgentHttpMethod;
  /** API-base-relative path template. Dynamic values always occupy exactly one segment. */
  readonly path: `/${string}`;
  readonly capability: CompanionAgentTenantCapability;
  readonly transport: CompanionAgentOperationTransport;
  readonly sensitive?: true;
}

/**
 * The single closed registry shared by Agent Auth verification and the bundled
 * Companion client. Binary package/file routes are present here so callers can select
 * their ticket exchange, but the server bearer-JWT matcher only accepts
 * `transport: "rest"` entries.
 */
export const COMPANION_AGENT_OPERATION_REGISTRY = [
  { method: "GET", path: "/orgs/current/skill-naming-policy", capability: "skills:read", transport: "rest" },
  { method: "GET", path: "/skills", capability: "skills:read", transport: "rest" },
  { method: "POST", path: "/skills", capability: "skills:write", transport: "transfer-ticket-upload" },
  { method: "POST", path: "/skills/create", capability: "skills:write", transport: "rest" },
  { method: "GET", path: "/skills/:slug", capability: "skills:read", transport: "rest" },
  { method: "GET", path: "/skills/:slug/download", capability: "skills:read", transport: "rest" },
  { method: "GET", path: "/skills/:slug/share-plan", capability: "skills:read", transport: "rest" },
  { method: "POST", path: "/skills/:slug/share", capability: "skills:write", transport: "rest" },
  { method: "POST", path: "/skills/:slug/rename", capability: "skills:write", transport: "rest" },
  // Install state is caller-owned personal state. It intentionally needs read, not catalog-write.
  { method: "POST", path: "/skills/:slug/install", capability: "skills:read", transport: "rest" },
  { method: "DELETE", path: "/skills/:slug/install", capability: "skills:read", transport: "rest" },
  { method: "POST", path: "/skills/:slug/labels", capability: "skills:write", transport: "rest" },
  { method: "DELETE", path: "/skills/:slug/labels", capability: "skills:write", transport: "rest" },
  { method: "POST", path: "/skills/:slug/personal-labels", capability: "skills:write", transport: "rest" },
  { method: "DELETE", path: "/skills/:slug/personal-labels", capability: "skills:write", transport: "rest" },
  { method: "GET", path: "/skills/:slug/dependencies", capability: "skills:read", transport: "rest" },
  { method: "POST", path: "/skills/:slug/archive", capability: "skills:write", transport: "rest" },
  { method: "POST", path: "/skills/:slug/restore", capability: "skills:write", transport: "rest" },
  { method: "PUT", path: "/skills/:slug/public-version", capability: "skills:write", transport: "rest" },
  { method: "DELETE", path: "/skills/:slug/public-version", capability: "skills:write", transport: "rest" },
  {
    method: "GET",
    path: "/skills/:slug/versions/:version/package",
    capability: "skills:read",
    transport: "transfer-ticket-download",
  },
  { method: "GET", path: "/skills/:slug/versions/:version/files", capability: "skills:read", transport: "rest" },
  {
    method: "GET",
    path: "/skills/:slug/versions/:version/files/content",
    capability: "skills:read",
    transport: "transfer-ticket-download",
  },
  { method: "GET", path: "/labels", capability: "skills:read", transport: "rest" },
  { method: "POST", path: "/labels", capability: "skills:write", transport: "rest" },
  { method: "PUT", path: "/labels/rename", capability: "skills:write", transport: "rest" },
  { method: "PUT", path: "/labels/color", capability: "skills:write", transport: "rest" },
  { method: "PUT", path: "/labels/icon", capability: "skills:write", transport: "rest" },
  { method: "DELETE", path: "/labels", capability: "skills:write", transport: "rest" },
  { method: "GET", path: "/personal-labels", capability: "skills:read", transport: "rest" },
  { method: "POST", path: "/personal-labels", capability: "skills:write", transport: "rest" },
  { method: "PUT", path: "/personal-labels/rename", capability: "skills:write", transport: "rest" },
  { method: "PUT", path: "/personal-labels/color", capability: "skills:write", transport: "rest" },
  { method: "PUT", path: "/personal-labels/icon", capability: "skills:write", transport: "rest" },
  { method: "DELETE", path: "/personal-labels", capability: "skills:write", transport: "rest" },
  { method: "GET", path: "/local-skills", capability: "skills:read", transport: "rest" },
  { method: "GET", path: "/local-skills/:key", capability: "skills:read", transport: "rest" },
  {
    method: "GET",
    path: "/local-skills/:key/package",
    capability: "skills:read",
    transport: "transfer-ticket-download",
  },
  { method: "POST", path: "/local-skills/:key/installed", capability: "skills:write", transport: "rest" },
  { method: "GET", path: "/secrets", capability: "secrets:read", transport: "rest", sensitive: true },
  { method: "POST", path: "/secrets", capability: "secrets:write", transport: "rest", sensitive: true },
  { method: "GET", path: "/secrets/:id", capability: "secrets:read", transport: "rest", sensitive: true },
  { method: "PATCH", path: "/secrets/:id", capability: "secrets:write", transport: "rest", sensitive: true },
  { method: "DELETE", path: "/secrets/:id", capability: "secrets:write", transport: "rest", sensitive: true },
  { method: "POST", path: "/secrets/:id/rotate", capability: "secrets:write", transport: "rest", sensitive: true },
  {
    method: "GET",
    path: "/skills/:slug/secret-configuration",
    capability: "secrets:read",
    transport: "rest",
    sensitive: true,
  },
  {
    method: "PUT",
    path: "/skills/:slug/secret-bindings/:slotId",
    capability: "secrets:write",
    transport: "rest",
    sensitive: true,
  },
  {
    method: "DELETE",
    path: "/skills/:slug/secret-bindings/:slotId",
    capability: "secrets:write",
    transport: "rest",
    sensitive: true,
  },
  {
    method: "PUT",
    path: "/skills/:slug/secret-suggestions/:slotId",
    capability: "secrets:write",
    transport: "rest",
    sensitive: true,
  },
  {
    method: "DELETE",
    path: "/skills/:slug/secret-suggestions/:slotId",
    capability: "secrets:write",
    transport: "rest",
    sensitive: true,
  },
  {
    method: "POST",
    path: "/skills/:slug/secret-suggestions/:slotId/accept",
    capability: "secrets:write",
    transport: "rest",
    sensitive: true,
  },
  {
    method: "POST",
    path: "/secret-retrievals/preflight",
    capability: "secrets:read",
    transport: "rest",
    sensitive: true,
  },
  {
    method: "POST",
    path: "/secret-retrievals/:planId/grant",
    capability: "secrets:read",
    transport: "rest",
    sensitive: true,
  },
  {
    method: "POST",
    path: "/secret-grants/redeem",
    capability: "secrets:read",
    transport: "rest",
    sensitive: true,
  },
] as const satisfies readonly CompanionAgentOperationDefinition[];

export type CompanionAgentOperation = (typeof COMPANION_AGENT_OPERATION_REGISTRY)[number];

function pathMatches(pattern: string, pathname: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  return (
    patternParts.length === pathParts.length &&
    patternParts.every((part, index) =>
      part.startsWith(":") ? Boolean(pathParts[index]) : part === pathParts[index],
    )
  );
}

/** Match one already-normalized API-base-relative pathname against the closed registry. */
export function matchCompanionAgentOperation(
  method: string,
  pathname: string,
): CompanionAgentOperation | null {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("?") || pathname.includes("#")) {
    return null;
  }
  const normalizedMethod = method.toUpperCase();
  return COMPANION_AGENT_OPERATION_REGISTRY.find(
    (operation) => operation.method === normalizedMethod && pathMatches(operation.path, pathname),
  ) ?? null;
}
