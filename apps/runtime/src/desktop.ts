import type { RuntimeDesktopPort, RuntimeDesktopReplayPort } from "./server";

export interface RuntimeDesktopAuthorization {
  authorized: boolean;
  denialCode: string | null;
  boxId: string | null;
  boxState: "ready" | "idle" | "running" | null;
  runtimeGeneration: bigint | null;
}

export interface RuntimeDesktopAuthorizationPort {
  authorize(input: {
    orgId: string;
    companionId: string;
    actorId: string;
  }): Promise<RuntimeDesktopAuthorization>;
}

export interface RuntimeDesktopSqlClient {
  unsafe(query: string, parameters?: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface ExistingBoxDesktopClient {
  /** This operation observes an already-running Box and must never create or resume one. */
  desktop(input: { boxId: string; signal?: AbortSignal }): Promise<{
    url: string | null;
    provisioning: boolean;
    transport: "vnc" | "webrtc" | null;
  }>;
}

export class RuntimeDesktopContractError extends Error {
  constructor() {
    super("Runtime desktop authorization returned an invalid result");
    this.name = "RuntimeDesktopContractError";
  }
}

/** Uses one PostgreSQL uniqueness decision shared by all private HTTP server replicas. */
export class PostgresRuntimeDesktopReplayGuard implements RuntimeDesktopReplayPort {
  constructor(private readonly sql: RuntimeDesktopSqlClient) {}

  async consume(input: {
    requestId: string;
    timestamp: number;
    maxSkewSeconds: number;
  }): Promise<boolean> {
    const rows = await this.sql.unsafe(`
      SELECT public.companion_runtime_consume_desktop_request(
        $1::text, $2::bigint, $3::integer
      ) AS consumed
    `, [input.requestId, input.timestamp, input.maxSkewSeconds]);
    if (rows.length !== 1 || typeof rows[0]?.consumed !== "boolean") {
      throw new RuntimeDesktopContractError();
    }
    return rows[0].consumed;
  }
}

/** Calls only the narrow SECURITY DEFINER desktop authorization function. */
export class PostgresRuntimeDesktopAuthorizer implements RuntimeDesktopAuthorizationPort {
  constructor(private readonly sql: RuntimeDesktopSqlClient) {}

  async authorize(input: {
    orgId: string;
    companionId: string;
    actorId: string;
  }): Promise<RuntimeDesktopAuthorization> {
    const rows = await this.sql.unsafe(`
      SELECT authorized, denial_code, box_id, box_state,
             runtime_generation::text AS runtime_generation
      FROM public.companion_runtime_authorize_desktop($1::uuid, $2::uuid, $3::text)
    `, [input.orgId, input.companionId, input.actorId]);
    if (rows.length !== 1 || !rows[0]) throw new RuntimeDesktopContractError();
    return decodeAuthorization(rows[0]);
  }
}

/** Reauthorizes in PostgreSQL immediately before minting one ephemeral URL from the exact Box. */
export function createRuntimeDesktopPort(input: {
  authorization: RuntimeDesktopAuthorizationPort;
  box: ExistingBoxDesktopClient;
}): RuntimeDesktopPort {
  return {
    async authorizeAndMint(request) {
      request.signal.throwIfAborted();
      const authorization = await input.authorization.authorize(request);
      request.signal.throwIfAborted();
      if (!authorization.authorized || !authorization.boxId) return null;
      const desktop = await input.box.desktop({
        boxId: authorization.boxId,
        signal: request.signal,
      });
      // A shutdown that raced the provider response must discard the signed URL rather than return
      // or retain it. The caller deliberately has no logging hook.
      request.signal.throwIfAborted();
      return desktop;
    },
  };
}

function decodeAuthorization(row: Record<string, unknown>): RuntimeDesktopAuthorization {
  if (typeof row.authorized !== "boolean") throw new RuntimeDesktopContractError();
  const denialCode = row.denial_code;
  const boxId = row.box_id;
  const boxState = row.box_state;
  const generation = row.runtime_generation;
  if (row.authorized) {
    if (
      denialCode !== null
      || typeof boxId !== "string"
      || boxId.length < 1
      || (boxState !== "ready" && boxState !== "idle" && boxState !== "running")
      || typeof generation !== "string"
      || !/^[1-9][0-9]*$/.test(generation)
    ) throw new RuntimeDesktopContractError();
    return {
      authorized: true,
      denialCode: null,
      boxId,
      boxState,
      runtimeGeneration: BigInt(generation),
    };
  }
  if (
    typeof denialCode !== "string"
    || !/^[a-z][a-z0-9_]{0,99}$/.test(denialCode)
    || boxId !== null
    || boxState !== null
    || generation !== null
  ) throw new RuntimeDesktopContractError();
  return {
    authorized: false,
    denialCode,
    boxId: null,
    boxState: null,
    runtimeGeneration: null,
  };
}
