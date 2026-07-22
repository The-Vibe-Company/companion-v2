import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  approveAgentCapabilities,
  auth,
  denyAgentCapabilities,
  getAgentConfiguration,
  guardAgentAuthRemoteKeys,
  revokeConnectedAgent,
  revokeConnectedHost,
} from "@companion/auth";
import { listOrgs, revokeAgentTransferTickets } from "@companion/core/services";
import { sql } from "@companion/db";
import { actorFromContext, jsonError, type ApiVariables } from "./context";

type ApiApp = Hono<{ Variables: ApiVariables }>;

const DEVICE_APPROVAL_FRESH_SESSION_MS = 5 * 60_000;

export interface ConnectedAgentRow {
  agent_id: string;
  agent_name: string;
  agent_status: string;
  agent_created_at: Date | string;
  agent_last_used_at: Date | string | null;
  host_id: string;
  host_name: string | null;
  host_status: string;
  grant_id: string | null;
  capability: string | null;
  constraints: string | Record<string, unknown> | null;
  grant_status: string | null;
  grant_created_at: Date | string | null;
}

export interface ConnectedAgentGrantResponse {
  id: string;
  capability: string;
  constraints: Record<string, unknown> | null;
  status: string;
  created_at: string;
  /** Agent Auth 0.6.2 does not persist capability-level usage. */
  last_used_at: null;
}

export interface ConnectedAgentResponse {
  id: string;
  name: string;
  status: string;
  host: { id: string; name: string; status: string };
  last_used_at: string | null;
  created_at: string;
  grants: ConnectedAgentGrantResponse[];
}

interface DeviceApprovalRow {
  approval_id: string;
  capabilities: string | null;
  user_code_hash: string | null;
  expires_at: Date | string;
  agent_id: string;
  agent_name: string;
  agent_user_id: string | null;
  host_id: string;
  host_name: string | null;
  host_user_id: string | null;
}

interface PendingGrantRow {
  capability: string;
  constraints: string | Record<string, unknown> | null;
  reason: string | null;
}

interface DeviceApprovalWorkspaceRow {
  id: string;
  name: string;
}

type DeviceApprovalResolution =
  | {
      kind: "resolved";
      approval: DeviceApprovalRow;
      grants: PendingGrantRow[];
      workspace: DeviceApprovalWorkspaceRow | null;
    }
  | { kind: "ambiguous" }
  | { kind: "unsafe"; error: "invalid_workspace_constraint" | "mixed_workspace_approval" }
  | null;

const TENANT_AGENT_CAPABILITIES = new Set([
  "skills:read",
  "skills:write",
  "secrets:read",
  "secrets:write",
]);

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseConstraints(value: string | Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** postgres.js returns plugin-owned timestamptz values as strings in some deployments. */
export function agentAuthTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Agent Auth returned an invalid timestamp");
  return date.toISOString();
}

/**
 * Project plugin-owned Agent Auth rows without inventing per-capability activity. The plugin stores
 * `last_used_at` on the agent and host only; a grant has no canonical last-use field in 0.6.2.
 */
export function projectConnectedAgents(rows: readonly ConnectedAgentRow[]): ConnectedAgentResponse[] {
  const agents = new Map<string, ConnectedAgentResponse>();
  for (const row of rows) {
    let agent = agents.get(row.agent_id);
    if (!agent) {
      agent = {
        id: row.agent_id,
        name: row.agent_name,
        status: row.agent_status,
        host: { id: row.host_id, name: row.host_name ?? "Unknown host", status: row.host_status },
        last_used_at: row.agent_last_used_at ? agentAuthTimestamp(row.agent_last_used_at) : null,
        created_at: agentAuthTimestamp(row.agent_created_at),
        grants: [],
      };
      agents.set(row.agent_id, agent);
    }
    if (row.grant_id && row.capability && row.grant_status && row.grant_created_at) {
      agent.grants.push({
        id: row.grant_id,
        capability: row.capability,
        constraints: parseConstraints(row.constraints),
        status: row.grant_status,
        created_at: agentAuthTimestamp(row.grant_created_at),
        last_used_at: null,
      });
    }
  }
  return [...agents.values()];
}

function workspaceIdFromConstraints(constraints: Record<string, unknown> | null): string | null {
  const value = constraints?.workspaceId;
  if (typeof value === "string") return value;
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && "eq" in value
    && typeof value.eq === "string"
  ) {
    return value.eq;
  }
  return null;
}

/** Every tenant capability in one device prompt must name the same exact workspace UUID. */
export function resolveDeviceApprovalWorkspace(
  grants: ReadonlyArray<Pick<PendingGrantRow, "capability" | "constraints">>,
): { workspaceId: string | null; error: null | "invalid_workspace_constraint" | "mixed_workspace_approval" } {
  const workspaceIds = new Set<string>();
  for (const grant of grants) {
    if (!TENANT_AGENT_CAPABILITIES.has(grant.capability)) continue;
    const workspaceId = workspaceIdFromConstraints(parseConstraints(grant.constraints));
    if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
      return { workspaceId: null, error: "invalid_workspace_constraint" };
    }
    workspaceIds.add(workspaceId);
  }
  if (workspaceIds.size > 1) return { workspaceId: null, error: "mixed_workspace_approval" };
  return { workspaceId: [...workspaceIds][0] ?? null, error: null };
}

/** Resolve a human workspace identity only through the approving user's membership. */
export async function findDeviceApprovalWorkspace(input: {
  actor: Parameters<typeof listOrgs>[0];
  workspaceId: string;
}): Promise<DeviceApprovalWorkspaceRow | null> {
  // `organizations` and `memberships` are NOBYPASSRLS tenant tables. The canonical pre-tenant
  // organization RPC used by listOrgs is the only safe way to discover membership before an org
  // context exists; a direct query here would return no rows for the application role.
  const workspace = (await listOrgs(input.actor)).find((org) => org.org_id === input.workspaceId);
  return workspace ? { id: workspace.org_id, name: workspace.name } : null;
}

function normalizeUserCode(code: string): string {
  const stripped = code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return stripped.length === 8 ? `${stripped.slice(0, 4)}-${stripped.slice(4)}` : code.toUpperCase();
}

function hashUserCode(code: string): string {
  return createHash("sha256").update(normalizeUserCode(code), "utf8").digest("base64url");
}

/**
 * Agent Auth 0.6.2 persists capability names, but not grant ids or constraints,
 * on an approval request. Approval is safe only when names map one-to-one.
 */
export function isUnambiguousDeviceApproval(
  approvalCapabilities: string | null,
  grantCapabilities: readonly string[],
): boolean {
  const requestedCapabilities = (approvalCapabilities ?? "").split(/\s+/).filter(Boolean);
  const uniqueRequestedCapabilities = new Set(requestedCapabilities);
  const uniqueGrantCapabilities = new Set(grantCapabilities);
  return (
    requestedCapabilities.length > 0 &&
    uniqueRequestedCapabilities.size === requestedCapabilities.length &&
    uniqueGrantCapabilities.size === grantCapabilities.length &&
    grantCapabilities.length === requestedCapabilities.length &&
    grantCapabilities.every((capability) => uniqueRequestedCapabilities.has(capability))
  );
}

/** Device approval is a privilege escalation and must never rely on a merely valid old session. */
export function isFreshDeviceApprovalSession(createdAt: Date | string | number | null | undefined, now = Date.now()): boolean {
  if (createdAt == null) return false;
  const createdAtMs = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) return false;
  const age = now - createdAtMs;
  return age >= 0 && age <= DEVICE_APPROVAL_FRESH_SESSION_MS;
}

function requireFreshDeviceApprovalSession(c: Parameters<typeof actorFromContext>[0]): Response | null {
  const session = c.get("session");
  if (isFreshDeviceApprovalSession(session?.createdAt)) return null;
  return c.json(
    {
      ok: false,
      error: "fresh_session_required",
      message: "Sign in again before reviewing or resolving an agent capability request.",
    },
    403,
  );
}

async function resolveDeviceApproval(input: {
  actor: Parameters<typeof listOrgs>[0];
  agentId: string;
  code: string;
}): Promise<DeviceApprovalResolution> {
  const codeHash = hashUserCode(input.code);
  const approvals = await sql<DeviceApprovalRow[]>`
    select
      ar.id as approval_id,
      ar.capabilities,
      ar.user_code_hash,
      ar.expires_at,
      a.id as agent_id,
      a.name as agent_name,
      a.user_id as agent_user_id,
      h.id as host_id,
      h.name as host_name,
      h.user_id as host_user_id
    from approval_request ar
    join agent a on a.id = ar.agent_id
    join agent_host h on h.id = a.host_id
    where ar.agent_id = ${input.agentId}
      and ar.method = 'device_authorization'
      and ar.status = 'pending'
      and ar.expires_at > now()
    order by ar.created_at desc
    limit 2
  `;
  // Agent Auth 0.6.2 resolves grants by capability name and, when called with
  // an agent id, resolves every pending approval for that agent. Never present
  // or resolve a request while more than one device approval is live.
  if (approvals.length > 1) return { kind: "ambiguous" };
  const approval = approvals[0];
  if (!approval || approval.user_code_hash !== codeHash) return null;
  // A not-yet-linked device may be approved by the signed-in user holding its
  // one-time code. Once ownership exists, another account cannot inspect or
  // resolve the request even if it obtains the URL.
  if (
    (approval.agent_user_id && approval.agent_user_id !== input.actor.id) ||
    (approval.host_user_id && approval.host_user_id !== input.actor.id)
  ) {
    return null;
  }
  const grants = await sql<PendingGrantRow[]>`
    select capability, constraints, reason
    from agent_capability_grant
    where agent_id = ${input.agentId}
      and status = 'pending'
    order by created_at asc
  `;
  const grantCapabilities = grants.map((grant) => grant.capability);
  // Approval rows do not carry constraints or grant ids. Exact one-to-one
  // capability matching is therefore required before delegating to the plugin.
  if (!isUnambiguousDeviceApproval(approval.capabilities, grantCapabilities)) {
    return { kind: "ambiguous" };
  }
  const requestedWorkspace = resolveDeviceApprovalWorkspace(grants);
  if (requestedWorkspace.error) return { kind: "unsafe", error: requestedWorkspace.error };
  const workspace = requestedWorkspace.workspaceId
    ? await findDeviceApprovalWorkspace({ actor: input.actor, workspaceId: requestedWorkspace.workspaceId })
    : null;
  // Do not reveal a workspace name or approve its tenant capabilities unless the signed-in user is
  // currently a member. Return the same not-found shape as an unknown or inaccessible request.
  if (requestedWorkspace.workspaceId && !workspace) return null;
  return { kind: "resolved", approval, grants, workspace };
}

function ambiguousDeviceApproval(c: Parameters<typeof actorFromContext>[0]): Response {
  return c.json(
    {
      ok: false,
      error: "ambiguous_pending_approval",
      message: "Resolve or let the other pending request expire, then request this capability again.",
    },
    409,
  );
}

function unsafeDeviceApproval(
  c: Parameters<typeof actorFromContext>[0],
  error: "invalid_workspace_constraint" | "mixed_workspace_approval",
): Response {
  const message = error === "mixed_workspace_approval"
    ? "Request each workspace's capabilities in a separate device approval."
    : "Tenant capabilities require one exact workspaceId UUID constraint.";
  return c.json({ ok: false, error, message }, 422);
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function rejectUnsafeAgentKeyRequest(
  c: Context<{ Variables: ApiVariables }>,
): Promise<Response | null> {
  const guard = await guardAgentAuthRemoteKeys(c.req.raw);
  if (guard === "allowed") return null;
  return c.json(
    guard === "remote-jwks"
      ? {
          error: "remote_agent_jwks_disabled",
          message: "Agent Auth hosts and agents must register with inline public keys.",
        }
      : {
          error: "agent_auth_request_too_large",
          message: "Agent Auth host requests must be 64 KiB or smaller.",
        },
    guard === "remote-jwks" ? 400 : 413,
  );
}

async function forwardHostCreateWithoutDefaults(c: Context<{ Variables: ApiVariables }>): Promise<Response> {
  const rejected = await rejectUnsafeAgentKeyRequest(c);
  if (rejected) return rejected;
  const body = jsonObject(await c.req.json());
  if (!body) return c.json({ error: "invalid_host_request" }, 400);
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  return auth.handler(new Request(c.req.raw, {
    headers,
    body: JSON.stringify({ ...body, default_capabilities: [] }),
  }));
}

async function forwardHostUpdateWithoutDefaults(c: Context<{ Variables: ApiVariables }>): Promise<Response> {
  const rejected = await rejectUnsafeAgentKeyRequest(c);
  if (rejected) return rejected;
  const request = c.req.raw.clone();
  const body = jsonObject(await c.req.json());
  if (!body) return c.json({ error: "invalid_host_request" }, 400);
  if (Object.prototype.hasOwnProperty.call(body, "default_capabilities")) {
    return c.json(
      {
        error: "host_default_capabilities_disabled",
        message: "Companion requires device approval for every capability grant.",
      },
      403,
    );
  }
  return auth.handler(request);
}

interface ExactConnectedGrant {
  id: string;
  agent_id: string;
  agent_user_id: string | null;
  capability: string;
  status: string;
}

/** Revoke one persisted grant id without affecting same-name grants for other workspaces. */
export async function revokeExactConnectedGrant(input: {
  userId: string;
  grantId: string;
}): Promise<ExactConnectedGrant | null> {
  const rows = await sql<ExactConnectedGrant[]>`
    select
      g.id,
      g.agent_id,
      a.user_id as agent_user_id,
      g.capability,
      g.status
    from agent_capability_grant g
    join agent a on a.id = g.agent_id
    join agent_host h on h.id = a.host_id
    where g.id = ${input.grantId}
      and (a.user_id = ${input.userId} or h.user_id = ${input.userId})
    limit 1
  `;
  const grant = rows[0];
  if (!grant) return null;
  if (grant.status !== "revoked") {
    await sql`
      update agent_capability_grant
      set status = 'revoked', updated_at = now()
      where id = ${grant.id} and agent_id = ${grant.agent_id}
    `;
  }
  await revokeAgentTransferTickets({
    userId: grant.agent_user_id ?? input.userId,
    agentId: grant.agent_id,
    agentGrantId: grant.id,
  });
  return { ...grant, status: "revoked" };
}

const deviceQuerySchema = z.object({
  agent_id: z.string().uuid(),
  code: z.string().min(1).max(64),
});

const approveSchema = z.object({
  agent_id: z.string().uuid(),
  code: z.string().min(1).max(64),
  // Always bind the mutation to the exact names the user reviewed. Omitting this would make the
  // upstream plugin approve any different capability that became pending during the review window.
  capabilities: z.array(z.string()).min(1),
});

const denySchema = z.object({
  agent_id: z.string().uuid(),
  code: z.string().min(1).max(64),
  reason: z.string().max(500).optional(),
});

/**
 * Mount the root discovery endpoint and signed-in management wrappers.
 *
 * Better Auth continues to own registration, device polling, JWT validation,
 * grant persistence and fresh-session enforcement below `/auth`. These
 * wrappers only provide stable product-facing response shapes.
 */
export function registerAgentAuthRoutes(app: ApiApp): void {
  // The upstream 0.6.2 approval endpoint cannot distinguish two pending grants
  // with the same capability name but different constraints. Its direct-grant
  // endpoint is even broader: any ordinary session can activate a grant without
  // device approval or our five-minute freshness check. Product approval must
  // always pass through the guarded wrapper below, so neither upstream mutator
  // may fall through to the Better Auth wildcard handler.
  const rejectRawCapabilityApproval = (c: Context<{ Variables: ApiVariables }>) =>
    c.json(
      {
        error: "use_device_approval_route",
        message: "Review this request through /device/capabilities.",
      },
      403,
    );
  const rawCapabilityMutators = new Set([
    "/auth/agent/approve-capability",
    "/auth/agent/grant-capability",
  ]);
  // Better Auth normalizes trailing slashes before matching its endpoints while Hono is strict by
  // default. Intercept the whole protocol prefix and compare a normalized path so `/.../` and
  // `/...//` cannot fall through to the upstream direct-grant mutators.
  app.use("/auth/agent/*", async (c, next) => {
    const normalizedPath = c.req.path.length > 1 ? c.req.path.replace(/\/+$/, "") : c.req.path;
    if (c.req.method === "POST" && rawCapabilityMutators.has(normalizedPath)) {
      return rejectRawCapabilityApproval(c);
    }
    await next();
  });

  // Host enrollment is legitimate, but host defaults would silently bypass Companion's per-request
  // device consent. Better Auth normalizes trailing slashes, so route the complete host prefix through
  // the wrappers before its wildcard handler. Creation always persists an empty list; updates may
  // change identity metadata but can never mutate default capabilities.
  app.use("/auth/host/*", async (c, next) => {
    const normalizedPath = c.req.path.length > 1 ? c.req.path.replace(/\/+$/, "") : c.req.path;
    if (c.req.method === "POST" && normalizedPath === "/auth/host/create") {
      return forwardHostCreateWithoutDefaults(c);
    }
    if (c.req.method === "POST" && normalizedPath === "/auth/host/update") {
      return forwardHostUpdateWithoutDefaults(c);
    }
    await next();
  });

  app.get("/.well-known/agent-configuration", async (c) => {
    try {
      const configuration = await getAgentConfiguration();
      c.header("Cache-Control", "public, max-age=300");
      return c.json(configuration);
    } catch (error) {
      return jsonError(c, error, 503);
    }
  });

  app.get("/v1/agent-auth/device-approval", async (c) => {
    try {
      const actor = actorFromContext(c);
      const staleSession = requireFreshDeviceApprovalSession(c);
      if (staleSession) return staleSession;
      const query = deviceQuerySchema.parse(c.req.query());
      const resolved = await resolveDeviceApproval({
        actor,
        agentId: query.agent_id,
        code: query.code,
      });
      if (!resolved) return c.json({ ok: false, error: "device approval request not found" }, 404);
      if (resolved.kind === "ambiguous") return ambiguousDeviceApproval(c);
      if (resolved.kind === "unsafe") return unsafeDeviceApproval(c, resolved.error);
      const capabilities = resolved.grants.map((grant) => ({
        name: grant.capability,
        constraints: parseConstraints(grant.constraints),
        reason: grant.reason,
      }));
      return c.json({
        request: {
          agent_id: resolved.approval.agent_id,
          agent_name: resolved.approval.agent_name,
          host: {
            id: resolved.approval.host_id,
            name: resolved.approval.host_name ?? "Unknown host",
          },
          capabilities,
          workspace_id: resolved.workspace?.id ?? null,
          workspace_name: resolved.workspace?.name ?? null,
          expires_at: agentAuthTimestamp(resolved.approval.expires_at),
        },
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/v1/agent-auth/device-approval/approve", async (c) => {
    try {
      const actor = actorFromContext(c);
      const staleSession = requireFreshDeviceApprovalSession(c);
      if (staleSession) return staleSession;
      const body = approveSchema.parse(await c.req.json());
      const resolved = await resolveDeviceApproval({ actor, agentId: body.agent_id, code: body.code });
      if (!resolved) return c.json({ ok: false, error: "device approval request not found" }, 404);
      if (resolved.kind === "ambiguous") return ambiguousDeviceApproval(c);
      if (resolved.kind === "unsafe") return unsafeDeviceApproval(c, resolved.error);
      const requestedCapabilities = new Set(resolved.grants.map((grant) => grant.capability));
      if (
        new Set(body.capabilities).size !== body.capabilities.length ||
        body.capabilities.some((capability) => !requestedCapabilities.has(capability))
      ) {
        return c.json({ ok: false, error: "invalid_capability_selection" }, 422);
      }
      await approveAgentCapabilities({
        headers: c.req.raw.headers,
        agentId: body.agent_id,
        approvalId: resolved.approval.approval_id,
        userCode: body.code,
        capabilities: body.capabilities,
      });
      return c.json({ ok: true, status: "approved" as const });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/v1/agent-auth/device-approval/deny", async (c) => {
    try {
      const actor = actorFromContext(c);
      const staleSession = requireFreshDeviceApprovalSession(c);
      if (staleSession) return staleSession;
      const body = denySchema.parse(await c.req.json());
      const resolved = await resolveDeviceApproval({ actor, agentId: body.agent_id, code: body.code });
      if (!resolved) return c.json({ ok: false, error: "device approval request not found" }, 404);
      if (resolved.kind === "ambiguous") return ambiguousDeviceApproval(c);
      if (resolved.kind === "unsafe") return unsafeDeviceApproval(c, resolved.error);
      await denyAgentCapabilities({
        headers: c.req.raw.headers,
        agentId: body.agent_id,
        approvalId: resolved.approval.approval_id,
        reason: body.reason,
      });
      return c.json({ ok: true, status: "denied" as const });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/v1/agent-auth/grants", async (c) => {
    try {
      const actor = actorFromContext(c);
      const rows = await sql<ConnectedAgentRow[]>`
        select
          a.id as agent_id,
          a.name as agent_name,
          a.status as agent_status,
          a.created_at as agent_created_at,
          a.last_used_at as agent_last_used_at,
          h.id as host_id,
          h.name as host_name,
          h.status as host_status,
          g.id as grant_id,
          g.capability,
          g.constraints,
          g.status as grant_status,
          g.created_at as grant_created_at
        from agent a
        join agent_host h on h.id = a.host_id
        left join agent_capability_grant g on g.agent_id = a.id
        where a.user_id = ${actor.id} or h.user_id = ${actor.id}
        order by coalesce(a.last_used_at, a.created_at) desc, g.created_at asc
      `;
      return c.json({ agents: projectConnectedAgents(rows) });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.delete("/v1/agent-auth/grants/:id", async (c) => {
    try {
      const actor = actorFromContext(c);
      const grant = await revokeExactConnectedGrant({ userId: actor.id, grantId: c.req.param("id") });
      if (!grant) return c.json({ ok: false, error: "capability grant not found" }, 404);
      return c.json({ ok: true, status: "revoked" as const });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.delete("/v1/agent-auth/agents/:id", async (c) => {
    try {
      const actor = actorFromContext(c);
      const agentId = c.req.param("id");
      const owned = await sql<{ id: string }[]>`
        select a.id
        from agent a
        join agent_host h on h.id = a.host_id
        where a.id = ${agentId}
          and (a.user_id = ${actor.id} or h.user_id = ${actor.id})
        limit 1
      `;
      if (!owned[0]) return c.json({ ok: false, error: "connected agent not found" }, 404);
      await revokeConnectedAgent(c.req.raw.headers, agentId);
      await revokeAgentTransferTickets({ userId: actor.id, agentId });
      return c.json({ ok: true, status: "revoked" as const });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.delete("/v1/agent-auth/hosts/:id", async (c) => {
    try {
      const actor = actorFromContext(c);
      const hostId = c.req.param("id");
      const owned = await sql<{ id: string; agent_id: string | null }[]>`
        select h.id, a.id as agent_id
        from agent_host h
        left join agent a on a.host_id = h.id
        where h.id = ${hostId} and h.user_id = ${actor.id}
      `;
      if (!owned[0]) return c.json({ ok: false, error: "connected host not found" }, 404);
      await revokeConnectedHost(c.req.raw.headers, hostId);
      await Promise.all(
        owned.flatMap((row) =>
          row.agent_id ? [revokeAgentTransferTickets({ userId: actor.id, agentId: row.agent_id })] : [],
        ),
      );
      return c.json({ ok: true, status: "revoked" as const });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
