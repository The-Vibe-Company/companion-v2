import type {
  AgentCapabilityGrant,
  AgentAuthEvent,
  AgentSession,
  Capability,
  Constraints,
} from "@better-auth/agent-auth";
import {
  COMPANION_AGENT_OPERATION_REGISTRY,
  matchCompanionAgentOperation,
  type CompanionAgentTenantCapability,
} from "@companion/contracts/agent-operations";

export const AGENT_CAPABILITY_NAMES = [
  "skills:read",
  "skills:write",
  "secrets:read",
  "secrets:write",
  "public-skills:install",
] as const;

export type AgentCapabilityName = (typeof AGENT_CAPABILITY_NAMES)[number];
export type AgentTenantCapability = CompanionAgentTenantCapability;

const workspaceInputSchema = {
  type: "object",
  properties: {
    workspaceId: {
      type: "string",
      format: "uuid",
      description: "Companion organization/workspace UUID selected for this operation.",
    },
  },
  required: ["workspaceId"],
  additionalProperties: false,
} as const;

const skillsReadInputSchema = {
  ...workspaceInputSchema,
  properties: {
    ...workspaceInputSchema.properties,
    transfer: {
      type: "object",
      description: "Request a one-use package or exact-file download ticket instead of sending bytes through capability execution.",
      properties: {
        action: { type: "string", enum: ["download", "download-file", "download-local"] },
        slug: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
      },
      required: ["action", "slug", "version"],
      additionalProperties: false,
    },
  },
} as const;

const skillsWriteInputSchema = {
  ...workspaceInputSchema,
  properties: {
    ...workspaceInputSchema.properties,
    transfer: {
      type: "object",
      description: "Request a one-use upload ticket bound to the intended archive digest and size.",
      properties: {
        action: { type: "string", enum: ["upload"] },
        slug: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
        checksum: { type: "string", minLength: 1 },
        sizeBytes: { type: "number", minimum: 0 },
      },
      required: ["action", "slug", "version", "checksum", "sizeBytes"],
      additionalProperties: false,
    },
  },
} as const;

export const AGENT_AUTH_CAPABILITIES = [
  {
    name: "skills:read",
    description: "Read skills, immutable versions, labels, and package metadata in one Companion workspace.",
    input: skillsReadInputSchema,
    requiredConstraints: ["workspaceId"],
  },
  {
    name: "skills:write",
    description: "Create, publish, organize, archive, or otherwise change skills in one Companion workspace.",
    input: skillsWriteInputSchema,
    requiredConstraints: ["workspaceId"],
  },
  {
    name: "secrets:read",
    description: "Read secret metadata and request explicitly approved secret retrieval in one Companion workspace.",
    input: workspaceInputSchema,
    requiredConstraints: ["workspaceId"],
  },
  {
    name: "secrets:write",
    description: "Create, rotate, bind, or remove secret configuration in one Companion workspace.",
    input: workspaceInputSchema,
    requiredConstraints: ["workspaceId"],
  },
  {
    name: "public-skills:install",
    description: "Request a short-lived, one-use ticket for the exact public release behind a known share token.",
    input: {
      type: "object",
      properties: {
        token: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
      },
      required: ["token", "version"],
      additionalProperties: false,
    },
  },
] as const satisfies readonly Capability[];

const CAPABILITY_SET = new Set<string>(AGENT_CAPABILITY_NAMES);

export function isAgentCapabilityName(value: string): value is AgentCapabilityName {
  return CAPABILITY_SET.has(value);
}

/** Derived compatibility export; the contracts package owns the only operation list. */
export const AGENT_OPERATION_REGISTRY = COMPANION_AGENT_OPERATION_REGISTRY;
export type AgentOperation = (typeof AGENT_OPERATION_REGISTRY)[number];

export function capabilityForAgentOperation(method: string, pathname: string): AgentTenantCapability | null {
  const relativePathname = pathname.startsWith("/v1/")
    ? pathname.slice(3)
    : pathname === "/v1"
      ? "/"
      : pathname;
  const operation = matchCompanionAgentOperation(method, relativePathname);
  // Package bytes require the separately executed, single-use transfer-ticket
  // capability. Never accept a bearer JWT directly on those routes.
  return operation?.transport === "rest" ? operation.capability : null;
}

function constraintEqualsWorkspace(constraints: Constraints | null, workspaceId: string): boolean {
  if (!constraints || typeof constraints !== "object") return false;
  const value = constraints.workspaceId;
  if (value === workspaceId) return true;
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "eq" in value &&
    (value as { eq?: unknown }).eq === workspaceId
  );
}

export interface ResolvedAgentAuthorization {
  session: AgentSession;
  capability: AgentTenantCapability;
  workspaceId: string;
}

export function authorizeAgentOperation(input: {
  session: AgentSession;
  method: string;
  pathname: string;
  workspaceId: string | null;
}): ResolvedAgentAuthorization | null {
  const capability = capabilityForAgentOperation(input.method, input.pathname);
  if (
    !capability ||
    !input.workspaceId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.workspaceId)
  ) {
    return null;
  }
  const grant = input.session.agent.capabilityGrants.find(
    (candidate) =>
      candidate.status === "active" &&
      candidate.capability === capability &&
      constraintEqualsWorkspace(candidate.constraints, input.workspaceId!),
  );
  if (!grant) return null;
  return { session: input.session, capability, workspaceId: input.workspaceId };
}

export type AgentCapabilityExecutor = (input: {
  capability: AgentCapabilityName;
  arguments?: Record<string, unknown>;
  session: AgentSession;
  grant: AgentCapabilityGrant;
}) => unknown | Promise<unknown>;

const executors: Partial<Record<AgentCapabilityName, AgentCapabilityExecutor>> = {};

/** Register a service-layer executor during API composition (never a path/method proxy). */
export function registerAgentCapabilityExecutor(
  capability: AgentCapabilityName,
  executor: AgentCapabilityExecutor,
): () => void {
  executors[capability] = executor;
  return () => {
    if (executors[capability] === executor) delete executors[capability];
  };
}

export async function executeAgentCapability(input: {
  capability: string;
  arguments?: Record<string, unknown>;
  session: AgentSession;
  grant: AgentCapabilityGrant;
}): Promise<unknown> {
  if (!isAgentCapabilityName(input.capability)) throw new Error("unsupported Agent Auth capability");
  const executor = executors[input.capability];
  if (executor) return executor({ ...input, capability: input.capability });
  if (input.capability === "public-skills:install") {
    throw new Error("public skill ticket service is not configured");
  }
  if (input.arguments?.transfer) {
    throw new Error("skill transfer ticket service is not configured");
  }
  return {
    ok: true,
    capability: input.capability,
    transport: "companion-rest",
    workspace_id: input.arguments?.workspaceId ?? null,
  };
}

export type AgentAuthEventSink = (event: AgentAuthEvent) => void | Promise<void>;
let eventSink: AgentAuthEventSink | null = null;

export function registerAgentAuthEventSink(sink: AgentAuthEventSink): () => void {
  eventSink = sink;
  return () => {
    if (eventSink === sink) eventSink = null;
  };
}

function safeEventMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const capabilities = Array.isArray(metadata.capabilities)
    ? metadata.capabilities.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    ...(capabilities ? { capabilities } : {}),
    ...(typeof metadata.method === "string" ? { method: metadata.method } : {}),
    ...(typeof metadata.status === "string" ? { status: metadata.status } : {}),
  };
}

/** Explicit allowlist: arguments, output, raw errors, tickets, and secret values never reach sinks. */
export async function emitAgentAuthEvent(event: AgentAuthEvent): Promise<void> {
  if (!eventSink) return;
  const common = {
    type: event.type,
    ...(event.orgId ? { orgId: event.orgId } : {}),
    ...(event.actorId ? { actorId: event.actorId } : {}),
    ...(event.actorType ? { actorType: event.actorType } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.hostId ? { hostId: event.hostId } : {}),
    ...(event.targetId ? { targetId: event.targetId } : {}),
    ...(event.targetType ? { targetType: event.targetType } : {}),
    ...(safeEventMetadata(event.metadata) ? { metadata: safeEventMetadata(event.metadata) } : {}),
  };
  const safeEvent = event.type === "capability.executed"
    ? {
        ...common,
        capability: event.capability,
        ...(event.provider ? { provider: event.provider } : {}),
        ...(event.agentName ? { agentName: event.agentName } : {}),
        ...(event.userId ? { userId: event.userId } : {}),
        status: event.status,
        ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
      }
    : common;
  await eventSink(safeEvent as AgentAuthEvent);
}
