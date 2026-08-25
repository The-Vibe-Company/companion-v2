/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- The endpoint-token decryptor sits on a JSON wire boundary: the encrypted envelope and its decrypted plaintext arrive untyped and are narrowed here before use. */
/**
 * Phase 2.1 direct transport: the runtime consumes the hosted Box agent channel for the EVENT
 * path only — broker state, event reads, event acknowledgements, and the daemon/health probe.
 * Prompt, abort, decision, file, and outbox traffic never routes through here.
 *
 * The facade is the single ambiguity-safety point: every direct call is a read the exec transport
 * can idempotently repeat, so any direct failure falls back to the exec implementation per call,
 * with one structured `runtime.direct_transport.fallback` log carrying only the operation and a
 * stable code. The hosted URL and both tokens never appear in any log or error.
 */
import {
  CompanionBoxAgentClient,
  CompanionBoxAgentRequestError,
  type CompanionBoxAgentEndpointCredentials,
  type CompanionPiBrokerEventPage,
  type CompanionPiBrokerState,
} from "@companion/box-runtime";
import { COMPANION_BUDGETS_BASE } from "@companion/contracts";
import { decryptOpaqueValue } from "@companion/core";
import type {
  RuntimeLogRecord,
  RuntimePiControl,
  RuntimeProcessLog,
} from "@companion/companion-runtime";

/** One registered hosted agent endpoint, decrypted, with the freshness proof staging recorded. */
export interface DirectAgentEndpoint extends CompanionBoxAgentEndpointCredentials {
  observedAt: Date;
}

/**
 * Endpoint freshness bound: the Box warm TTL. `host` registration is sticky while a Box runs and
 * every wake re-stages (re-registering the endpoint), so an observation older than the warm window
 * belongs to a Box that has since idled out; the exec transport handles it until the next staging.
 */
export const DIRECT_ENDPOINT_FRESHNESS_MS = COMPANION_BUDGETS_BASE.boxWarmTtlSeconds * 1_000;
/**
 * How long a suspect endpoint rests before the next brokerState call re-probes it. Keeps the
 * re-probe cheap under the exec fallback cadence (~2 state calls/s) without abandoning the
 * endpoint: one bounded direct attempt per cooldown, not one per loop iteration.
 */
export const DIRECT_SUSPECT_REPROBE_COOLDOWN_MS = 10_000;
/** Shadow mode compares at most once per Box per interval — the per-claim budget approximated. */
export const DIRECT_SHADOW_COMPARE_INTERVAL_MS = 60_000;
const DEFAULT_EVENT_POLL_INTERVAL_MS = 500;
const MAX_REGISTRY_ENTRIES = 4_096;

interface RegistryEntry {
  endpoint: DirectAgentEndpoint;
  suspectAtMs: number | null;
}

/**
 * In-memory Box-id-keyed endpoint registry. Fed by staging (plaintext, same process) and by the
 * fenced material read (ciphertext decrypted under the master key); consulted per direct call.
 * Purely process-local: a restart falls back to exec until the next claim re-registers.
 */
export class DirectBoxEndpointRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  register(boxId: string, endpoint: DirectAgentEndpoint): void {
    const existing = this.#entries.get(boxId);
    // Latest observation wins: a stale material row read after a fresh staging must not roll the
    // endpoint (and its rotated bearer) backwards.
    if (existing && existing.endpoint.observedAt.getTime() > endpoint.observedAt.getTime()) return;
    this.#entries.delete(boxId);
    this.#entries.set(boxId, { endpoint, suspectAtMs: null });
    this.#prune();
  }

  /** The endpoint to try for one direct call, or null when none fresh enough is known. */
  lookup(boxId: string): DirectAgentEndpoint | null {
    const entry = this.#entries.get(boxId);
    if (!entry) return null;
    if (this.#now() - entry.endpoint.observedAt.getTime() > DIRECT_ENDPOINT_FRESHNESS_MS) {
      this.#entries.delete(boxId);
      return null;
    }
    return entry.endpoint;
  }

  isSuspect(boxId: string): boolean {
    return this.#entries.get(boxId)?.suspectAtMs !== null
      && this.#entries.get(boxId)?.suspectAtMs !== undefined;
  }

  markSuspect(boxId: string): void {
    const entry = this.#entries.get(boxId);
    if (entry) entry.suspectAtMs = this.#now();
  }

  clearSuspect(boxId: string): void {
    const entry = this.#entries.get(boxId);
    if (entry) entry.suspectAtMs = null;
  }

  /** A suspect endpoint is retried on the next brokerState call once the cooldown has passed. */
  reprobeDue(boxId: string): boolean {
    const suspectAtMs = this.#entries.get(boxId)?.suspectAtMs;
    if (suspectAtMs === null || suspectAtMs === undefined) return false;
    return this.#now() - suspectAtMs >= DIRECT_SUSPECT_REPROBE_COOLDOWN_MS;
  }

  #prune(): void {
    if (this.#entries.size <= MAX_REGISTRY_ENTRIES) return;
    for (const [boxId, entry] of this.#entries) {
      if (this.#entries.size <= MAX_REGISTRY_ENTRIES) break;
      if (this.#now() - entry.endpoint.observedAt.getTime() > DIRECT_ENDPOINT_FRESHNESS_MS) {
        this.#entries.delete(boxId);
      }
    }
    while (this.#entries.size > MAX_REGISTRY_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

/** The two credentials of one registered agent endpoint, recovered from the durable ciphertext. */
export interface CompanionAgentEndpointTokens {
  proxyToken: string;
  bearerToken: string;
}

function parseJsonObjectOrThrow(text: string): Record<string, unknown> {
  // SAFETY: JSON.parse returns any; widening to unknown forces the narrowing below.
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Companion agent endpoint payload is not a JSON object");
  }
  // SAFETY: The guard above excludes null, arrays, and primitives; a plain JSON object remains.
  return parsed as Record<string, unknown>;
}

function requiredStringField(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error("Companion agent endpoint field is invalid");
  }
  return value;
}

/**
 * Decrypt the staged agent endpoint tokens from the durable ciphertext. Mirrors the encryption in
 * the material pipeline (purpose `companion_box_agent_endpoint`, subject = companion). Any
 * malformed envelope or token throws; callers treat that as "no direct endpoint", never a failure.
 */
export function decryptCompanionAgentEndpointTokens(input: {
  orgId: string;
  companionId: string;
  tokenCiphertext: string;
  masterKey: Buffer;
}): CompanionAgentEndpointTokens {
  const envelope = parseJsonObjectOrThrow(input.tokenCiphertext);
  const plaintext = decryptOpaqueValue(
    {
      orgId: input.orgId,
      purpose: "companion_box_agent_endpoint",
      subjectId: input.companionId,
      ciphertext: requiredStringField(envelope, "ciphertext", 8_192),
      iv: requiredStringField(envelope, "iv", 8_192),
      authTag: requiredStringField(envelope, "authTag", 8_192),
      wrappedDek: requiredStringField(envelope, "wrappedDek", 8_192),
      wrapIv: requiredStringField(envelope, "wrapIv", 8_192),
      wrapAuthTag: requiredStringField(envelope, "wrapAuthTag", 8_192),
      keyId: requiredStringField(envelope, "keyId", 8_192),
    },
    input.masterKey,
  );
  const tokens = parseJsonObjectOrThrow(plaintext);
  return {
    proxyToken: requiredStringField(tokens, "proxyToken", 512),
    bearerToken: requiredStringField(tokens, "bearerToken", 512),
  };
}

type DirectOperation = "broker_state" | "read_events" | "ack_events" | "pi_daemon_status";

/** Codes that indict the endpoint itself; broker-relayed failures rest on the broker, not the URL. */
const SUSPECT_CODES = new Set([
  "agent_unreachable",
  "agent_timeout",
  "agent_auth_failed",
  "agent_rate_limited",
  "agent_http_error",
  "agent_protocol",
  "agent_unexpected",
]);

const FALLBACK: unique symbol = Symbol("direct-transport-fallback");

export interface DirectRuntimePiControlOptions {
  mode: "shadow" | "on";
  exec: RuntimePiControl;
  registry: DirectBoxEndpointRegistry;
  /** Complete package+overlay marker of the deployed layout, for `layoutCurrent` parity. */
  layoutFullMarker: string;
  log?: RuntimeProcessLog;
  now?: () => number;
  /** Injectable for tests; production constructs the real HTTPS client per call. */
  clientFactory?: (endpoint: CompanionBoxAgentEndpointCredentials) => DirectAgentCalls;
}

/** The narrow read-only slice of the agent client the facade consumes; injectable for tests. */
export interface DirectAgentCalls {
  health(signal?: AbortSignal): Promise<{
    agentVersion: number;
    piUnit: string;
    brokerSocketReady: boolean;
    layoutMarker: string | null;
  }>;
  brokerState(signal?: AbortSignal): Promise<CompanionPiBrokerState>;
  readEvents(input: {
    after: number;
    limit?: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<CompanionPiBrokerEventPage>;
  ackEvents(input: {
    through: number;
    signal?: AbortSignal;
  }): Promise<{ acknowledgedCursor: number }>;
}

export interface DirectRuntimePiControl {
  pi: RuntimePiControl;
  /**
   * Per-Box event poll interval for the consume loop: 0 after a direct-served read (the 20 s wait
   * already happened server-side), the flat default while a Box is on the exec fallback.
   */
  eventPollIntervalMs: (input: { boxId: string }) => number;
}

export function createDirectRuntimePiControl(
  options: DirectRuntimePiControlOptions,
): DirectRuntimePiControl {
  const now = options.now ?? Date.now;
  const clientFactory = options.clientFactory
    ?? ((endpoint: CompanionBoxAgentEndpointCredentials): DirectAgentCalls =>
      new CompanionBoxAgentClient({ endpoint }));
  const lastEventsServedDirect = new Map<string, boolean>();
  const lastShadowAtMs = new Map<string, number>();

  const logFallback = (operation: DirectOperation, stableCode: string): void => {
    options.log?.warn({
      ts: new Date(now()).toISOString(),
      event: "runtime.direct_transport.fallback",
      operation,
      stableCode,
    });
  };

  /**
   * One direct attempt with the per-call fallback contract. A caller abort propagates untouched —
   * a kill-switch or fence loss must cut a 20 s long-poll, never continue into an exec retry.
   */
  const attemptDirect = async <T>(
    operation: DirectOperation,
    boxId: string,
    signal: AbortSignal,
    run: (calls: DirectAgentCalls) => Promise<T>,
  ): Promise<T | typeof FALLBACK> => {
    const endpoint = options.registry.lookup(boxId);
    if (!endpoint) return FALLBACK;
    if (options.registry.isSuspect(boxId)) {
      // Only the cheap state probe re-tests a suspect endpoint; other calls stay on exec until it
      // recovers, so a dead agent costs one bounded probe per cooldown instead of one per call.
      if (operation !== "broker_state" || !options.registry.reprobeDue(boxId)) return FALLBACK;
    }
    try {
      const value = await run(clientFactory(endpoint));
      options.registry.clearSuspect(boxId);
      return value;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      const stableCode = error instanceof CompanionBoxAgentRequestError
        ? error.stableCode
        : "agent_unexpected";
      if (SUSPECT_CODES.has(stableCode)) options.registry.markSuspect(boxId);
      logFallback(operation, stableCode);
      return FALLBACK;
    }
  };

  const brokerStateView = (
    state: CompanionPiBrokerState,
  ): Awaited<ReturnType<RuntimePiControl["brokerState"]>> => ({
    invocationId: state.invocationId,
    layoutMarker: state.layoutMarker,
    layoutCurrent: state.layoutMarker === options.layoutFullMarker,
    activeAttemptId: state.activeAttemptId,
    tailCursor: BigInt(state.tailCursor),
    acknowledgedCursor: BigInt(state.acknowledgedCursor),
    counters: state.counters,
    modelInput: state.modelInput,
  });

  /**
   * Shadow mode: one direct health + broker-state comparison per Box per interval, logged and
   * never routed — the exec result is what every caller receives.
   */
  const maybeShadowCompare = (
    boxId: string,
    signal: AbortSignal,
    execPromise: Promise<Awaited<ReturnType<RuntimePiControl["brokerState"]>>>,
    execStartedAtMs: number,
  ): void => {
    const endpoint = options.registry.lookup(boxId);
    if (!endpoint) return;
    const last = lastShadowAtMs.get(boxId);
    if (last !== undefined && now() - last < DIRECT_SHADOW_COMPARE_INTERVAL_MS) return;
    lastShadowAtMs.set(boxId, now());
    const directStartedAtMs = now();
    const directPromise = (async () => {
      const calls = clientFactory(endpoint);
      await calls.health(signal);
      return await calls.brokerState(signal);
    })();
    void (async () => {
      let direct: CompanionPiBrokerState | null = null;
      let stableCode: string | null = null;
      try {
        direct = await directPromise;
      } catch (error) {
        if (signal.aborted) return;
        stableCode = error instanceof CompanionBoxAgentRequestError
          ? error.stableCode
          : "agent_unexpected";
      }
      const latencyDirectMs = now() - directStartedAtMs;
      let exec: Awaited<ReturnType<RuntimePiControl["brokerState"]>>;
      let latencyExecMs: number;
      try {
        exec = await execPromise;
        latencyExecMs = now() - execStartedAtMs;
      } catch {
        // The real call failed; there is no baseline to compare against.
        return;
      }
      const match = direct !== null
        && direct.invocationId === exec.invocationId
        && direct.activeAttemptId === exec.activeAttemptId
        && direct.layoutMarker === exec.layoutMarker;
      const record: RuntimeLogRecord = {
        ts: new Date(now()).toISOString(),
        event: "runtime.direct_transport.shadow",
        match,
        latencyDirectMs,
        latencyExecMs,
      };
      if (stableCode !== null) record.stableCode = stableCode;
      options.log?.info(record);
    })();
  };

  if (options.mode === "shadow") {
    return {
      pi: {
        ...options.exec,
        async brokerState(input) {
          const startedAtMs = now();
          const execPromise = options.exec.brokerState(input);
          maybeShadowCompare(input.boxId, input.signal, execPromise, startedAtMs);
          return await execPromise;
        },
      },
      eventPollIntervalMs: () => DEFAULT_EVENT_POLL_INTERVAL_MS,
    };
  }

  const pi: RuntimePiControl = {
    ...options.exec,
    async brokerState(input) {
      const direct = await attemptDirect(
        "broker_state",
        input.boxId,
        input.signal,
        async (calls) => await calls.brokerState(input.signal),
      );
      if (direct !== FALLBACK) return brokerStateView(direct);
      return await options.exec.brokerState(input);
    },
    async readBrokerEvents(input) {
      const after = cursorNumber(input.after);
      const direct = await attemptDirect(
        "read_events",
        input.boxId,
        input.signal,
        async (calls) => await calls.readEvents({ after, signal: input.signal }),
      );
      if (direct !== FALLBACK) {
        lastEventsServedDirect.set(input.boxId, true);
        return direct;
      }
      lastEventsServedDirect.set(input.boxId, false);
      return await options.exec.readBrokerEvents(input);
    },
    async ackBrokerEvents(input) {
      const through = cursorNumber(input.through);
      const direct = await attemptDirect(
        "ack_events",
        input.boxId,
        input.signal,
        async (calls) => await calls.ackEvents({ through, signal: input.signal }),
      );
      if (direct !== FALLBACK) return BigInt(direct.acknowledgedCursor);
      return await options.exec.ackBrokerEvents(input);
    },
    async piDaemonStatus(input) {
      const direct = await attemptDirect(
        "pi_daemon_status",
        input.boxId,
        input.signal,
        async (calls) => {
          const health = await calls.health(input.signal);
          // Mirror the exec probe: the daemon counts as running only with an active unit and an
          // owner-only broker socket; anything else is stopped, never inferred further.
          if (health.piUnit !== "active" || !health.brokerSocketReady) {
            return { state: "stopped" as const, invocationId: null };
          }
          const broker = await calls.brokerState(input.signal);
          return {
            state: broker.activeAttemptId === null ? ("idle" as const) : ("running" as const),
            invocationId: broker.invocationId,
          };
        },
      );
      if (direct !== FALLBACK) return direct;
      return await options.exec.piDaemonStatus(input);
    },
  };

  return {
    pi,
    eventPollIntervalMs: ({ boxId }) =>
      lastEventsServedDirect.get(boxId) === true ? 0 : DEFAULT_EVENT_POLL_INTERVAL_MS,
  };
}

function cursorNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("Pi broker cursor is outside the safe integer range");
  }
  return number;
}
