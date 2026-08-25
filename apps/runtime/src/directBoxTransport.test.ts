import { describe, expect, it, vi } from "vitest";

import {
  CompanionBoxAgentRequestError,
  type CompanionPiBrokerState,
} from "@companion/box-runtime";
import { encryptOpaqueValue } from "@companion/core";
import type { RuntimeLogRecord, RuntimePiControl } from "@companion/companion-runtime";

import {
  createDirectRuntimePiControl,
  decryptCompanionAgentEndpointTokens,
  DirectBoxEndpointRegistry,
  DIRECT_ENDPOINT_FRESHNESS_MS,
  DIRECT_SHADOW_COMPARE_INTERVAL_MS,
  DIRECT_SUSPECT_REPROBE_COOLDOWN_MS,
  type DirectAgentCalls,
  type DirectAgentEndpoint,
} from "./directBoxTransport";

const BOX_ID = "bx_abcdefgh";
const MARKER = "layout-14/full-marker";

function brokerState(overrides: Partial<CompanionPiBrokerState> = {}): CompanionPiBrokerState {
  return {
    invocationId: "inv-1",
    layoutMarker: MARKER,
    activeAttemptId: null,
    tailCursor: 5,
    acknowledgedCursor: 5,
    counters: {
      malformedLines: 0,
      oversizedLines: 0,
      unterminatedLines: 0,
      unknownEvents: 0,
      unboundEvents: 0,
      orphanResponses: 0,
    },
    modelInput: ["text"],
    ...overrides,
  };
}

function execBrokerState() {
  return {
    invocationId: "inv-exec",
    layoutMarker: MARKER,
    layoutCurrent: true,
    activeAttemptId: null,
    tailCursor: 5n,
    acknowledgedCursor: 5n,
    counters: brokerState().counters,
    modelInput: ["text" as const],
  };
}

function execControl(): RuntimePiControl {
  return {
    stopPiDaemon: vi.fn(async () => undefined),
    startPiDaemon: vi.fn(async () => ({ state: "idle" as const, invocationId: "inv-exec" })),
    restartPiDaemon: vi.fn(async () => ({ state: "idle" as const, invocationId: "inv-exec" })),
    piDaemonStatus: vi.fn(async () => ({ state: "idle" as const, invocationId: "inv-exec" })),
    brokerState: vi.fn(async () => execBrokerState()),
    prompt: vi.fn(async () => ({ outcome: "accepted" as const, invocationId: "inv-exec", initialCursor: 0n })),
    abort: vi.fn(async () => ({ outcome: "accepted" as const, invocationId: "inv-exec" })),
    readBrokerEvents: vi.fn(async () => ({
      events: [],
      nextCursor: 5,
      acknowledgedCursor: 5,
      hasMore: false,
    })),
    ackBrokerEvents: vi.fn(async () => 5n),
    respondExtensionUi: vi.fn(async () => ({ outcome: "accepted" as const, invocationId: "inv-exec" })),
  };
}

function agentCalls(overrides: Partial<DirectAgentCalls> = {}): DirectAgentCalls {
  return {
    health: vi.fn(async () => ({
      agentVersion: 1,
      piUnit: "active",
      brokerSocketReady: true,
      layoutMarker: MARKER,
    })),
    brokerState: vi.fn(async () => brokerState()),
    readEvents: vi.fn(async () => ({
      events: [],
      nextCursor: 5,
      acknowledgedCursor: 5,
      hasMore: false,
    })),
    ackEvents: vi.fn(async () => ({ acknowledgedCursor: 5 })),
    ...overrides,
  };
}

function collectingLog() {
  const records: RuntimeLogRecord[] = [];
  return {
    records,
    log: {
      error: (record: RuntimeLogRecord) => records.push(record),
      warn: (record: RuntimeLogRecord) => records.push(record),
      info: (record: RuntimeLogRecord) => records.push(record),
    },
  };
}

function harness(input: {
  mode?: "on" | "shadow";
  calls?: DirectAgentCalls;
  nowMs?: () => number;
  register?: boolean;
  observedAt?: Date;
}) {
  const nowMs = input.nowMs ?? (() => 1_000_000);
  const registry = new DirectBoxEndpointRegistry({ now: nowMs });
  const endpoint: DirectAgentEndpoint = {
    hostedUrl: "https://abc-8790.on.ascii.dev/boxes/bx_abcdefgh",
    proxyToken: "proxy-token-1234567890",
    bearerToken: "bearer-token",
    observedAt: input.observedAt ?? new Date(nowMs()),
  };
  if (input.register !== false) registry.register(BOX_ID, endpoint);
  const exec = execControl();
  const calls = input.calls ?? agentCalls();
  const { records, log } = collectingLog();
  const facade = createDirectRuntimePiControl({
    mode: input.mode ?? "on",
    exec,
    registry,
    layoutFullMarker: MARKER,
    log,
    now: nowMs,
    clientFactory: () => calls,
  });
  return { facade, exec, calls, records, registry, endpoint };
}

const signal = new AbortController().signal;

describe("createDirectRuntimePiControl (on)", () => {
  it("serves brokerState direct, mapping cursors and layoutCurrent, without touching exec", async () => {
    const { facade, exec } = harness({});
    const state = await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(state.invocationId).toBe("inv-1");
    expect(state.layoutCurrent).toBe(true);
    expect(state.tailCursor).toBe(5n);
    expect(exec.brokerState).not.toHaveBeenCalled();
  });

  it("falls back to exec without an endpoint, silently", async () => {
    const { facade, exec, records } = harness({ register: false });
    const state = await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(state.invocationId).toBe("inv-exec");
    expect(exec.brokerState).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(0);
  });

  it("falls back to exec when the endpoint observation is older than the freshness bound", async () => {
    const { facade, exec, calls } = harness({
      observedAt: new Date(1_000_000 - DIRECT_ENDPOINT_FRESHNESS_MS - 1),
    });
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(exec.brokerState).toHaveBeenCalledTimes(1);
    expect(calls.brokerState).not.toHaveBeenCalled();
  });

  it("falls back per call on a direct failure, logging one expurgated event and marking suspect", async () => {
    const failing = agentCalls({
      readEvents: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_unreachable");
      }),
    });
    const { facade, exec, records, calls } = harness({ calls: failing });
    const page = await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    expect(page).toEqual({ events: [], nextCursor: 5, acknowledgedCursor: 5, hasMore: false });
    expect(exec.readBrokerEvents).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      expect.objectContaining({
        event: "runtime.direct_transport.fallback",
        operation: "read_events",
        stableCode: "agent_unreachable",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("bearer-token");
    expect(JSON.stringify(records)).not.toContain("ascii.dev");

    // Suspect: the next non-probe call skips direct entirely.
    await facade.pi.ackBrokerEvents({ boxId: BOX_ID, through: 5n, signal });
    expect(calls.ackEvents).not.toHaveBeenCalled();
    expect(exec.ackBrokerEvents).toHaveBeenCalledTimes(1);
  });

  it("re-probes a suspect endpoint on brokerState only after the cooldown, then recovers", async () => {
    let nowMs = 1_000_000;
    const failing = vi.fn(async () => {
      throw new CompanionBoxAgentRequestError("agent_timeout");
    });
    const calls = agentCalls();
    calls.brokerState = failing;
    const { facade, exec } = harness({ calls, nowMs: () => nowMs });

    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(exec.brokerState).toHaveBeenCalledTimes(1);

    // Within the cooldown the probe stays on exec.
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(exec.brokerState).toHaveBeenCalledTimes(2);

    // After the cooldown the probe retries direct; success clears suspect for every call.
    nowMs += DIRECT_SUSPECT_REPROBE_COOLDOWN_MS;
    calls.brokerState = vi.fn(async () => brokerState());
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(exec.brokerState).toHaveBeenCalledTimes(2);
    await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    expect(exec.readBrokerEvents).not.toHaveBeenCalled();
  });

  it("does not mark the endpoint suspect on a broker-relayed failure", async () => {
    const brokerDown = agentCalls({
      readEvents: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_broker_unavailable", 503);
      }),
    });
    const { facade, exec, records, calls } = harness({ calls: brokerDown });
    await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    expect(records[0]).toMatchObject({ stableCode: "agent_broker_unavailable" });
    // Next call still tries direct: the broker being down does not indict the endpoint.
    await facade.pi.ackBrokerEvents({ boxId: BOX_ID, through: 5n, signal });
    expect(calls.ackEvents).toHaveBeenCalledTimes(1);
    expect(exec.readBrokerEvents).toHaveBeenCalledTimes(1);
  });

  it("acknowledges events direct and converts the cursor to bigint", async () => {
    const { facade, exec, calls } = harness({});
    const acknowledged = await facade.pi.ackBrokerEvents({ boxId: BOX_ID, through: 5n, signal });
    expect(acknowledged).toBe(5n);
    expect(calls.ackEvents).toHaveBeenCalledWith({ through: 5, signal });
    expect(exec.ackBrokerEvents).not.toHaveBeenCalled();
  });

  it("maps the daemon probe: inactive unit or unready socket is stopped, never inferred further", async () => {
    const stopped = agentCalls({
      health: vi.fn(async () => ({
        agentVersion: 1,
        piUnit: "inactive",
        brokerSocketReady: false,
        layoutMarker: null,
      })),
    });
    const { facade, exec } = harness({ calls: stopped });
    await expect(facade.pi.piDaemonStatus({ boxId: BOX_ID, signal }))
      .resolves.toEqual({ state: "stopped", invocationId: null });
    expect(exec.piDaemonStatus).not.toHaveBeenCalled();
  });

  it("maps the daemon probe through broker state: active attempt means running", async () => {
    const busy = agentCalls({
      brokerState: vi.fn(async () => brokerState({ activeAttemptId: "attempt-9" })),
    });
    const { facade } = harness({ calls: busy });
    await expect(facade.pi.piDaemonStatus({ boxId: BOX_ID, signal }))
      .resolves.toEqual({ state: "running", invocationId: "inv-1" });
  });

  it("falls back to the full exec probe when the direct health read fails", async () => {
    const failing = agentCalls({
      health: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_auth_failed", 401);
      }),
    });
    const { facade, exec, records } = harness({ calls: failing });
    await expect(facade.pi.piDaemonStatus({ boxId: BOX_ID, signal }))
      .resolves.toEqual({ state: "idle", invocationId: "inv-exec" });
    expect(exec.piDaemonStatus).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({
      operation: "pi_daemon_status",
      stableCode: "agent_auth_failed",
    });
  });

  it("propagates a caller abort instead of falling back", async () => {
    const controller = new AbortController();
    const reason = new Error("kill switch");
    const aborting = agentCalls({
      readEvents: vi.fn(async () => {
        controller.abort(reason);
        throw new CompanionBoxAgentRequestError("agent_timeout");
      }),
    });
    const { facade, exec, records } = harness({ calls: aborting });
    await expect(facade.pi.readBrokerEvents({
      boxId: BOX_ID,
      after: 5n,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(exec.readBrokerEvents).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
  });

  it("answers a zero poll interval only while events are served direct", async () => {
    const flaky = agentCalls();
    const { facade } = harness({ calls: flaky });
    expect(facade.eventPollIntervalMs({ boxId: BOX_ID })).toBe(500);
    await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    expect(facade.eventPollIntervalMs({ boxId: BOX_ID })).toBe(0);
    flaky.readEvents = vi.fn(async () => {
      throw new CompanionBoxAgentRequestError("agent_unreachable");
    });
    await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    expect(facade.eventPollIntervalMs({ boxId: BOX_ID })).toBe(500);
  });

  it("never wraps prompt, abort, decision, or lifecycle calls", async () => {
    const { facade, exec, calls } = harness({});
    await facade.pi.prompt({
      boxId: BOX_ID,
      commandId: "c1",
      attemptId: "a1",
      message: "hello",
      signal,
    });
    await facade.pi.abort({ boxId: BOX_ID, commandId: "c2", attemptId: "a1", signal });
    await facade.pi.respondExtensionUi({
      boxId: BOX_ID,
      commandId: "c3",
      attemptId: "a1",
      response: {},
      signal,
    });
    await facade.pi.startPiDaemon({ boxId: BOX_ID, signal });
    expect(exec.prompt).toHaveBeenCalledTimes(1);
    expect(exec.abort).toHaveBeenCalledTimes(1);
    expect(exec.respondExtensionUi).toHaveBeenCalledTimes(1);
    expect(exec.startPiDaemon).toHaveBeenCalledTimes(1);
    expect(calls.brokerState).not.toHaveBeenCalled();
    expect(calls.readEvents).not.toHaveBeenCalled();
  });
});

describe("createDirectRuntimePiControl (shadow)", () => {
  async function flushShadow(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("returns the exec result, logs one throttled comparison, and routes nothing direct", async () => {
    let nowMs = 1_000_000;
    const calls = agentCalls({
      brokerState: vi.fn(async () => brokerState({ invocationId: "inv-exec" })),
    });
    const { facade, exec, records } = harness({ mode: "shadow", calls, nowMs: () => nowMs });
    const state = await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(state.invocationId).toBe("inv-exec");
    await flushShadow();
    expect(records).toEqual([
      expect.objectContaining({
        event: "runtime.direct_transport.shadow",
        match: true,
        latencyDirectMs: expect.any(Number),
        latencyExecMs: expect.any(Number),
      }),
    ]);

    // Throttled: a second probe inside the interval does not shadow again.
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    await flushShadow();
    expect(records).toHaveLength(1);
    expect(calls.brokerState).toHaveBeenCalledTimes(1);

    nowMs += DIRECT_SHADOW_COMPARE_INTERVAL_MS;
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    await flushShadow();
    expect(records).toHaveLength(2);

    // Events and acks stay pure exec in shadow mode.
    await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    await facade.pi.ackBrokerEvents({ boxId: BOX_ID, through: 5n, signal });
    expect(exec.readBrokerEvents).toHaveBeenCalledTimes(1);
    expect(exec.ackBrokerEvents).toHaveBeenCalledTimes(1);
    expect(calls.readEvents).not.toHaveBeenCalled();
    expect(calls.ackEvents).not.toHaveBeenCalled();
  });

  it("logs a mismatching or failing shadow comparison without affecting the caller", async () => {
    const failing = agentCalls({
      health: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_unreachable");
      }),
    });
    const { facade, records } = harness({ mode: "shadow", calls: failing });
    const state = await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(state.invocationId).toBe("inv-exec");
    await flushShadow();
    expect(records).toEqual([
      expect.objectContaining({
        event: "runtime.direct_transport.shadow",
        match: false,
        stableCode: "agent_unreachable",
      }),
    ]);
  });
});

describe("DirectBoxEndpointRegistry", () => {
  it("keeps the newest observation and drops suspect state on re-registration", () => {
    const registry = new DirectBoxEndpointRegistry({ now: () => 1_000_000 });
    const older: DirectAgentEndpoint = {
      hostedUrl: "https://old.invalid",
      proxyToken: "proxy-old-1234567890",
      bearerToken: "bearer-old",
      observedAt: new Date(500_000),
    };
    const newer: DirectAgentEndpoint = { ...older, hostedUrl: "https://new.invalid", observedAt: new Date(900_000) };
    registry.register(BOX_ID, newer);
    registry.markSuspect(BOX_ID);
    registry.register(BOX_ID, older);
    expect(registry.lookup(BOX_ID)?.hostedUrl).toBe("https://new.invalid");
    expect(registry.isSuspect(BOX_ID)).toBe(true);
    registry.register(BOX_ID, { ...newer, observedAt: new Date(950_000) });
    expect(registry.isSuspect(BOX_ID)).toBe(false);
  });
});

describe("decryptCompanionAgentEndpointTokens", () => {
  const masterKey = Buffer.alloc(32, 7);
  const orgId = "11111111-1111-4111-8111-111111111111";
  const companionId = "22222222-2222-4222-8222-222222222222";

  function ciphertext(value: string, subjectId = companionId): string {
    return JSON.stringify(encryptOpaqueValue(
      { orgId, purpose: "companion_box_agent_endpoint", subjectId, value },
      masterKey,
    ));
  }

  it("round-trips the tokens the material pipeline encrypted", () => {
    const tokenCiphertext = ciphertext(JSON.stringify({
      proxyToken: "proxy-token-1234567890",
      bearerToken: "bearer-token",
    }));
    expect(decryptCompanionAgentEndpointTokens({
      orgId,
      companionId,
      tokenCiphertext,
      masterKey,
    })).toEqual({ proxyToken: "proxy-token-1234567890", bearerToken: "bearer-token" });
  });

  it("fails closed on a cross-companion ciphertext", () => {
    const tokenCiphertext = ciphertext(
      JSON.stringify({ proxyToken: "proxy-token-1234567890", bearerToken: "bearer-token" }),
      "33333333-3333-4333-8333-333333333333",
    );
    expect(() => decryptCompanionAgentEndpointTokens({
      orgId,
      companionId,
      tokenCiphertext,
      masterKey,
    })).toThrow();
  });

  it.each([
    ["not-json", "not json"],
    ["missing tokens", "{}"],
  ])("fails closed on %s plaintext", (_label, plaintext) => {
    const tokenCiphertext = ciphertext(plaintext === "not json" ? "###" : plaintext);
    expect(() => decryptCompanionAgentEndpointTokens({
      orgId,
      companionId,
      tokenCiphertext,
      masterKey,
    })).toThrow();
  });

  it("fails closed on a malformed envelope", () => {
    expect(() => decryptCompanionAgentEndpointTokens({
      orgId,
      companionId,
      tokenCiphertext: "{\"ciphertext\":42}",
      masterKey,
    })).toThrow();
  });
});
