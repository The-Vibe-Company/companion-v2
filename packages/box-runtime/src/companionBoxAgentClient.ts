/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- The client sits on a JSON wire boundary: agent HTTP bodies and thrown fetch values arrive untyped and are narrowed here before use. */

import {
  COMPANION_BOX_AGENT_LONG_POLL_CAP_MS,
  sanitizePiUnitState,
} from "./companionBoxAgentCore";
import {
  parseCompanionPiAckEventsData,
  parseCompanionPiBrokerEventPageData,
  parseCompanionPiBrokerStateData,
  type CompanionPiBrokerEventPage,
  type CompanionPiBrokerState,
} from "./boxCompanionRuntime";

/**
 * Decrypted credentials of one registered Box agent endpoint. `hostedUrl` is the token-free
 * locator; the proxy token gates the provider's `host <port>` proxy and the bearer authenticates
 * at the agent itself. None of the three may appear in any log, error, or persisted value.
 */
export interface CompanionBoxAgentEndpointCredentials {
  hostedUrl: string;
  proxyToken: string;
  bearerToken: string;
}

/** Stable failure taxonomy for the direct channel; drives the per-call exec fallback decision. */
export type CompanionBoxAgentFailureCode =
  | "agent_unreachable"
  | "agent_timeout"
  | "agent_aborted"
  | "agent_auth_failed"
  | "agent_rate_limited"
  | "agent_http_error"
  | "agent_broker_unavailable"
  | "agent_broker_failed"
  | "agent_protocol";

/**
 * One failed direct agent request. The message is a fixed expurgated string per stable code; the
 * hosted URL, tokens, response bodies, and header values never enter it.
 */
export class CompanionBoxAgentRequestError extends Error {
  readonly stableCode: CompanionBoxAgentFailureCode;
  readonly status: number | null;

  constructor(stableCode: CompanionBoxAgentFailureCode, status: number | null = null) {
    super(`Companion box agent request failed: ${stableCode}`);
    this.name = "CompanionBoxAgentRequestError";
    this.stableCode = stableCode;
    this.status = status;
  }
}

/** Local health view of one agent, mapped from `GET /v1/health`. */
export interface CompanionBoxAgentHealthView {
  agentVersion: number;
  piUnit: string;
  brokerSocketReady: boolean;
  layoutMarker: string | null;
}

/** Bounded direct calls: state reads answer fast or fail fast; long-polls add the server wait. */
export const COMPANION_BOX_AGENT_STATE_TIMEOUT_MS = 5_000;
/** Server-side long-poll wait the runtime requests; below the agent/proxy 25 s response cap. */
export const COMPANION_BOX_AGENT_EVENT_WAIT_MS = 20_000;
const EVENT_TIMEOUT_MARGIN_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 2;

export interface CompanionBoxAgentClientOptions {
  endpoint: CompanionBoxAgentEndpointCredentials;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  stateTimeoutMs?: number;
}

/**
 * HTTPS client for the on-box Companion agent behind the provider's hosted proxy. Read-only by
 * construction: it can observe broker state, long-poll the event journal, acknowledge cursors, and
 * read agent health — never dispatch, abort, decide, stage, or touch files. Every response payload
 * is validated by the same parsers as the exec transport, so a malformed direct answer fails with
 * byte-identical semantics.
 */
export class CompanionBoxAgentClient {
  readonly #endpoint: CompanionBoxAgentEndpointCredentials;
  readonly #fetch: typeof fetch;
  readonly #stateTimeoutMs: number;

  constructor(options: CompanionBoxAgentClientOptions) {
    this.#endpoint = options.endpoint;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#stateTimeoutMs = options.stateTimeoutMs ?? COMPANION_BOX_AGENT_STATE_TIMEOUT_MS;
  }

  async health(signal?: AbortSignal): Promise<CompanionBoxAgentHealthView> {
    const body = await this.#requestJson({
      method: "GET",
      path: "/v1/health",
      timeoutMs: this.#stateTimeoutMs,
      signal,
    });
    const agentVersion = body.agentVersion;
    const piUnit = body.piUnit;
    const brokerSocketReady = body.brokerSocketReady;
    const layoutMarker = body.layoutMarker;
    if (
      typeof agentVersion !== "number"
      || !Number.isSafeInteger(agentVersion)
      || typeof piUnit !== "string"
      || typeof brokerSocketReady !== "boolean"
      || (layoutMarker !== null && typeof layoutMarker !== "string")
    ) {
      throw new CompanionBoxAgentRequestError("agent_protocol");
    }
    return {
      agentVersion,
      piUnit: sanitizePiUnitState(piUnit),
      brokerSocketReady,
      layoutMarker: layoutMarker === null ? null : layoutMarker.slice(0, 1_024),
    };
  }

  async brokerState(signal?: AbortSignal): Promise<CompanionPiBrokerState> {
    const body = await this.#requestJson({
      method: "GET",
      path: "/v1/broker/state",
      timeoutMs: this.#stateTimeoutMs,
      signal,
    });
    return parseBody(() => parseCompanionPiBrokerStateData(body));
  }

  async readEvents(input: {
    after: number;
    limit?: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<CompanionPiBrokerEventPage> {
    const waitMs = Math.min(
      Math.max(input.waitMs ?? COMPANION_BOX_AGENT_EVENT_WAIT_MS, 0),
      COMPANION_BOX_AGENT_LONG_POLL_CAP_MS,
    );
    const query: Array<[string, string]> = [
      ["after", String(input.after)],
      ["wait_ms", String(waitMs)],
    ];
    if (input.limit !== undefined) query.push(["limit", String(input.limit)]);
    const body = await this.#requestJson({
      method: "GET",
      path: "/v1/events",
      query,
      timeoutMs: waitMs + EVENT_TIMEOUT_MARGIN_MS,
      signal: input.signal,
    });
    return parseBody(() => parseCompanionPiBrokerEventPageData(body, input.after));
  }

  async ackEvents(input: {
    through: number;
    signal?: AbortSignal;
  }): Promise<{ acknowledgedCursor: number }> {
    const body = await this.#requestJson({
      method: "POST",
      path: "/v1/ack",
      body: { through: input.through },
      timeoutMs: this.#stateTimeoutMs,
      signal: input.signal,
    });
    return parseBody(() => parseCompanionPiAckEventsData(body));
  }

  async #requestJson(input: {
    method: "GET" | "POST";
    path: string;
    query?: ReadonlyArray<readonly [string, string]>;
    body?: { through: number };
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    input.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(input.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let url = this.#url(input.path, input.query);
    let response: Response | null = null;
    // The provider proxy may answer the first exchange with a redirect before honoring `_token` on
    // the path directly. Follow it manually so the bearer header and the token survive the hop, and
    // never leave the endpoint's origin.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await this.#send({
        method: input.method,
        url,
        body: input.body,
        signal,
        callerSignal: input.signal,
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      // Redirect bodies are irrelevant; cancel so the connection is reusable.
      await response.body?.cancel().catch(() => undefined);
      const next = location === null ? null : this.#sameOriginRedirect(url, location);
      if (next === null || hop === MAX_REDIRECTS) {
        throw new CompanionBoxAgentRequestError("agent_http_error", response.status);
      }
      url = next;
      response = null;
    }
    if (response === null) throw new CompanionBoxAgentRequestError("agent_unreachable");
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (status === 401 || status === 403) {
        throw new CompanionBoxAgentRequestError("agent_auth_failed", status);
      }
      if (status === 429) throw new CompanionBoxAgentRequestError("agent_rate_limited", status);
      if (status === 503) {
        throw new CompanionBoxAgentRequestError("agent_broker_unavailable", status);
      }
      if (status === 502) throw new CompanionBoxAgentRequestError("agent_broker_failed", status);
      throw new CompanionBoxAgentRequestError("agent_http_error", status);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw this.#transportError(error, input.signal);
    }
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new CompanionBoxAgentRequestError("agent_protocol", response.status);
    }
    let parsed: unknown;
    try {
      // SAFETY: JSON.parse returns any; widening to unknown forces the narrowing below.
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new CompanionBoxAgentRequestError("agent_protocol", response.status);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CompanionBoxAgentRequestError("agent_protocol", response.status);
    }
    // SAFETY: The guard above excludes null, arrays, and primitives; a plain JSON object remains.
    return parsed as Record<string, unknown>;
  }

  async #send(input: {
    method: "GET" | "POST";
    url: URL;
    body?: { through: number };
    /** The composed caller+timeout signal handed to fetch. */
    signal: AbortSignal;
    /** The caller's own signal, kept apart so a timeout is never misread as a caller abort. */
    callerSignal?: AbortSignal;
  }): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${this.#endpoint.bearerToken}` });
    const requestInit: RequestInit = {
      method: input.method,
      redirect: "manual",
      signal: input.signal,
      headers,
    };
    if (input.body !== undefined) {
      headers.set("content-type", "application/json");
      requestInit.body = JSON.stringify(input.body);
    }
    try {
      return await this.#fetch(input.url, requestInit);
    } catch (error) {
      throw this.#transportError(error, input.callerSignal);
    }
  }

  #transportError(error: unknown, callerSignal?: AbortSignal): Error {
    // A caller abort (lease loss, kill switch, shutdown) must surface as the caller's abort reason,
    // not be reclassified as an endpoint failure the facade would mark suspect.
    if (callerSignal?.aborted) {
      return callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new CompanionBoxAgentRequestError("agent_aborted");
    }
    // Node surfaces the timeout abort as a `TimeoutError`/`AbortError`-named exception whose
    // concrete class varies across fetch internals; the name is the stable classifier.
    if (
      error instanceof Error
      && (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return new CompanionBoxAgentRequestError("agent_timeout");
    }
    return new CompanionBoxAgentRequestError("agent_unreachable");
  }

  #url(path: string, query?: ReadonlyArray<readonly [string, string]>): URL {
    const url = new URL(`${this.#endpoint.hostedUrl}${path}`);
    url.searchParams.set("_token", this.#endpoint.proxyToken);
    for (const [key, value] of query ?? []) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  #sameOriginRedirect(from: URL, location: string): URL | null {
    let next: URL;
    try {
      next = new URL(location, from);
    } catch {
      return null;
    }
    if (next.origin !== from.origin) return null;
    // Re-carry the proxy token: the gate's redirect target may drop the query string.
    if (!next.searchParams.get("_token")) {
      next.searchParams.set("_token", this.#endpoint.proxyToken);
    }
    return next;
  }
}

function parseBody<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    // The shared parser proves shape; a direct payload it rejects is an agent protocol failure the
    // facade answers with an exec fallback rather than a provider-shaped 502.
    throw new CompanionBoxAgentRequestError("agent_protocol", 200);
  }
}
