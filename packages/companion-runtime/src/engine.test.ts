import { describe, expect, it } from "vitest";
import { RuntimeEngine } from "./engine";
import type { RuntimeProcessLog } from "./logging";
import type { RuntimePiControl } from "./ports";
import {
  RuntimeStoreContractError,
  RuntimeStoreIndeterminateError,
} from "./store";
import type { DecisionRuntimeClaim, HealthRuntimeClaim } from "./types";
import {
  ATTEMPT_ID,
  BOX_ID,
  COMMAND_ID,
  COMPANION_ID,
  ORG_ID,
  PI_INVOCATION_ID,
  TURN_ID,
  attemptAuthorization,
  attemptClaim,
  attemptMaterial,
  engineDependencies,
  fakePorts,
  MemoryRuntimeStore,
  TestClock,
} from "./test/fixtures";

function assistantAndSettlementPage(): unknown {
  return {
    events: [
      {
        sequence: 1,
        invocationId: PI_INVOCATION_ID,
        attemptId: ATTEMPT_ID,
        kind: "pi_event",
        event: {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Durable reply" }] },
        },
      },
      {
        sequence: 2,
        invocationId: PI_INVOCATION_ID,
        attemptId: ATTEMPT_ID,
        kind: "pi_event",
        event: { type: "agent_settled" },
      },
    ],
    nextCursor: 2,
    acknowledgedCursor: 0,
    hasMore: false,
  };
}

function settlementOnlyPage(): unknown {
  return {
    events: [{
      sequence: 1,
      invocationId: PI_INVOCATION_ID,
      attemptId: ATTEMPT_ID,
      kind: "pi_event",
      event: { type: "agent_settled" },
    }],
    nextCursor: 1,
    acknowledgedCursor: 0,
    hasMore: false,
  };
}

function assistantOnlyPage(): unknown {
  return {
    events: [{
      sequence: 1,
      invocationId: PI_INVOCATION_ID,
      attemptId: ATTEMPT_ID,
      kind: "pi_event",
      event: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Durable reply" }] },
      },
    }],
    nextCursor: 1,
    acknowledgedCursor: 0,
    hasMore: false,
  };
}

function settlementAfterFirstProjectionPage(): unknown {
  return {
    events: [{
      sequence: 2,
      invocationId: PI_INVOCATION_ID,
      attemptId: ATTEMPT_ID,
      kind: "pi_event",
      event: { type: "agent_settled" },
    }],
    nextCursor: 2,
    acknowledgedCursor: 0,
    hasMore: false,
  };
}

function healthClaim(): HealthRuntimeClaim {
  return {
    ...attemptClaim(),
    workKind: "health",
    workId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    actorId: null,
    clientSurface: null,
    checkpoint: "observing",
    checkpointSequence: 0n,
    turnId: null,
    turnStatus: null,
    attemptStatus: null,
    dispatchState: null,
    eventCursor: null,
    unknownEventCount: null,
    malformedEventCount: null,
    oversizedEventCount: null,
    coldStartDeadlineAt: null,
    inactivityDeadlineAt: null,
    absoluteDeadlineAt: null,
    operationKind: null,
    operationStartedAt: null,
    operationAttemptCount: null,
    providerOperationId: null,
    targetSettingsRevision: null,
    targetSkillsRevision: null,
    decisionStatus: null,
    decisionDeliveryState: null,
  };
}

describe("RuntimeEngine attempts", () => {
  it("runs a cold accepted prompt through projection, ACK, and settlement", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    ports.eventReads.push(assistantAndSettlementPage());
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(ports.promptCalls).toEqual([{ attemptId: ATTEMPT_ID, message: "Hello from a durable turn" }]);
    expect(store.checkpoints.map((checkpoint) => checkpoint.nextCheckpoint)).toEqual([
      "dispatch_write_intent",
      "dispatch_accepted",
    ]);
    expect(ports.log.indexOf("project")).toBeLessThan(ports.log.indexOf("ack"));
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("starts a new attempt from the broker's acknowledged monotone cursor", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    const baseBrokerState = ports.pi.brokerState;
    ports.pi.brokerState = async (input) => ({
      ...await baseBrokerState(input),
      tailCursor: 10n,
      acknowledgedCursor: 10n,
    });
    ports.eventReads.push({
      events: [
        {
          sequence: 11,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "Second reply" }] },
          },
        },
        {
          sequence: 12,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "agent_settled" },
        },
      ],
      nextCursor: 12,
      acknowledgedCursor: 10,
      hasMore: false,
    });

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(store.checkpoints.find((checkpoint) =>
      checkpoint.nextCheckpoint === "dispatch_accepted")?.eventCursor).toBe(10n);
    expect(store.authorization.eventCursor).toBe(12n);
    expect(store.projected[0]?.map((event) => event.sequence)).toEqual([11n, 12n]);
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("keeps consuming an accepted attempt when the warm-TTL refresh exhausts retries", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const clock = new TestClock();
    const ports = fakePorts(store);
    let ttlCalls = 0;
    ports.box.setTtl = async () => {
      ttlCalls += 1;
      throw Object.assign(new Error("provider unavailable"), { status: 503 });
    };
    ports.eventReads.push(assistantAndSettlementPage());
    const engine = new RuntimeEngine(engineDependencies({ store, ports, clock }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(ttlCalls).toBe(6);
    expect(ports.promptCalls).toHaveLength(1);
    expect(store.authorization.dispatchState).toBe("accepted");
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("interrupts instead of releasing the queue when event ACK fails after projection", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    let ackCalls = 0;
    ports.eventReads.push(assistantAndSettlementPage());
    ports.pi.ackBrokerEvents = async () => {
      ackCalls += 1;
      throw Object.assign(new Error("broker unavailable"), { status: 503 });
    };
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("interrupted");
    expect(ackCalls).toBe(6);
    expect(ports.promptCalls).toHaveLength(1);
    expect(store.authorization.eventCursor).toBe(2n);
    expect(store.settlements[0]).toMatchObject({
      terminalStatus: "interrupted",
      error: { code: "pi_event_stream_interrupted", action: "restart_pi" },
    });
  });

  it("interrupts when credential-aware redactor preparation fails after Pi accepted", async () => {
    const claim = attemptClaim({
      checkpoint: "dispatch_accepted",
      checkpointSequence: 2n,
      attemptStatus: "running",
      turnStatus: "running",
      dispatchState: "accepted",
      eventCursor: 0n,
      inactivityDeadlineAt: new Date("2026-08-16T12:10:00.000Z"),
    });
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    const dependencies = engineDependencies({ store, ports });
    dependencies.projectionRedactorFactory = {
      forMaterial: () => { throw new Error("opaque-secret-must-not-persist"); },
    };

    const result = await new RuntimeEngine(dependencies).execute(claim);

    expect(result.outcome).toBe("interrupted");
    expect(ports.promptCalls).toHaveLength(0);
    expect(ports.log).not.toContain("ack");
    expect(store.projected).toHaveLength(0);
    expect(store.settlements[0]).toMatchObject({
      terminalStatus: "interrupted",
      error: { code: "pi_event_stream_interrupted", action: "restart_pi" },
    });
    expect(JSON.stringify(store.settlements)).not.toContain("opaque-secret-must-not-persist");
  });

  it("abandons an indeterminate checkpoint and takeover follows its durable write intent", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    const checkpoint = store.checkpoint.bind(store);
    let loseResponse = true;
    store.checkpoint = async (fence, input) => {
      const result = await checkpoint(fence, input);
      if (loseResponse) {
        loseResponse = false;
        throw new RuntimeStoreIndeterminateError();
      }
      return result;
    };
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const first = await engine.execute(claim);

    expect(first.outcome).toBe("fence_lost");
    expect(store.authorization.workCheckpoint).toBe("dispatch_write_intent");
    expect(ports.promptCalls).toHaveLength(0);
    expect(store.settlements).toHaveLength(0);

    const takeoverClaim = attemptClaim({
      checkpoint: "dispatch_write_intent",
      checkpointSequence: store.authorization.workCheckpointSequence,
      attemptStatus: "dispatching",
      turnStatus: "dispatching",
      dispatchState: "write_intent",
    });
    const takeover = await new RuntimeEngine(engineDependencies({ store, ports }))
      .execute(takeoverClaim);

    expect(takeover.outcome).toBe("interrupted");
    expect(ports.promptCalls).toHaveLength(0);
    expect(store.settlements.at(-1)?.error?.code).toBe("prompt_dispatch_ambiguous");
  });

  it("abandons an indeterminate projection and takeover resumes after its durable cursor", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    ports.eventReads.push(assistantOnlyPage());
    const project = store.projectEventBatch.bind(store);
    let loseResponse = true;
    store.projectEventBatch = async (fence, input) => {
      const result = await project(fence, input);
      if (loseResponse) {
        loseResponse = false;
        throw new RuntimeStoreIndeterminateError();
      }
      return result;
    };
    const firstEngine = new RuntimeEngine(engineDependencies({ store, ports }));

    const first = await firstEngine.execute(claim);

    expect(first.outcome).toBe("fence_lost");
    expect(store.authorization.workCheckpoint).toBe("event_projected");
    expect(store.authorization.eventCursor).toBe(1n);
    expect(store.material.hasVisibleOutput).toBe(true);
    expect(ports.log).not.toContain("ack");
    expect(store.settlements).toHaveLength(0);

    const takeoverClaim = attemptClaim({
      checkpoint: "event_projected",
      checkpointSequence: store.authorization.workCheckpointSequence,
      attemptStatus: "running",
      turnStatus: "running",
      dispatchState: "accepted",
      eventCursor: 1n,
      inactivityDeadlineAt: store.authorization.inactivityDeadlineAt,
    });
    const takeoverPorts = fakePorts(store);
    takeoverPorts.eventReads.push(settlementAfterFirstProjectionPage());
    const baseBrokerState = takeoverPorts.pi.brokerState;
    takeoverPorts.pi.brokerState = async (input) => ({
      ...await baseBrokerState(input),
      tailCursor: 2n,
      acknowledgedCursor: 0n,
    });

    const takeover = await new RuntimeEngine(engineDependencies({
      store,
      ports: takeoverPorts,
    })).execute(takeoverClaim);

    expect(takeover.outcome).toBe("succeeded");
    expect(takeoverPorts.promptCalls).toHaveLength(0);
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("takes over a projected settlement by ACKing its durable terminal cursor", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    ports.eventReads.push(assistantAndSettlementPage());
    const project = store.projectEventBatch.bind(store);
    store.projectEventBatch = async (fence, input) => {
      const result = await project(fence, input);
      throw new RuntimeStoreIndeterminateError();
    };

    const first = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(first.outcome).toBe("fence_lost");
    expect(store.authorization.workCheckpoint).toBe("agent_settled");
    expect(store.authorization.eventCursor).toBe(2n);
    expect(ports.log).not.toContain("ack");
    expect(store.settlements).toHaveLength(0);

    const takeover = await new RuntimeEngine(engineDependencies({
      store,
      ports: fakePorts(store),
    })).execute(attemptClaim({
      checkpoint: "agent_settled",
      checkpointSequence: store.authorization.workCheckpointSequence,
      attemptStatus: "running",
      turnStatus: "running",
      dispatchState: "accepted",
      eventCursor: 2n,
      inactivityDeadlineAt: store.authorization.inactivityDeadlineAt,
    }));

    expect(takeover.outcome).toBe("succeeded");
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("settles and ACKs durable terminal output without reloading rotated credentials", async () => {
    const claim = attemptClaim({
      checkpoint: "agent_settled",
      checkpointSequence: 8n,
      attemptStatus: "running",
      turnStatus: "running",
      dispatchState: "accepted",
      eventCursor: 4n,
      inactivityDeadlineAt: new Date("2026-08-16T12:10:00.000Z"),
    });
    const store = new MemoryRuntimeStore({
      authorization: attemptAuthorization(claim),
      material: attemptMaterial({ hasVisibleOutput: true }),
    });
    let materialReads = 0;
    const materialProvider = {
      getMaterial: async () => {
        materialReads += 1;
        throw new Error("credential snapshot changed");
      },
    };
    const ports = fakePorts(store);

    const result = await new RuntimeEngine(engineDependencies({
      store,
      ports,
      materialProvider,
    })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(materialReads).toBe(0);
    expect(ports.log).toContain("ack");
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("takes over a projected Pi exit by ACKing its durable terminal cursor", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    ports.eventReads.push({
      events: [{
        sequence: 1,
        invocationId: PI_INVOCATION_ID,
        attemptId: ATTEMPT_ID,
        kind: "pi_process_exit",
        exit: { code: 137, signal: "SIGKILL" },
      }],
      nextCursor: 1,
      acknowledgedCursor: 0,
      hasMore: false,
    });
    const project = store.projectEventBatch.bind(store);
    store.projectEventBatch = async (fence, input) => {
      const result = await project(fence, input);
      throw new RuntimeStoreIndeterminateError();
    };

    const first = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(first.outcome).toBe("fence_lost");
    expect(store.authorization.workCheckpoint).toBe("process_exited");
    expect(store.authorization.eventCursor).toBe(1n);
    expect(ports.log).not.toContain("ack");

    const takeover = await new RuntimeEngine(engineDependencies({
      store,
      ports: fakePorts(store),
    })).execute(attemptClaim({
      checkpoint: "process_exited",
      checkpointSequence: store.authorization.workCheckpointSequence,
      attemptStatus: "running",
      turnStatus: "running",
      dispatchState: "accepted",
      eventCursor: 1n,
      inactivityDeadlineAt: store.authorization.inactivityDeadlineAt,
    }));

    expect(takeover.outcome).toBe("failed");
    expect(store.settlements[0]?.error?.code).toBe("pi_process_exited");
  });

  it("does not issue a second settlement after an indeterminate committed settlement", async () => {
    const claim = attemptClaim({
      checkpoint: "agent_settled",
      checkpointSequence: 8n,
      attemptStatus: "running",
      turnStatus: "running",
      dispatchState: "accepted",
      eventCursor: 4n,
      inactivityDeadlineAt: new Date("2026-08-16T12:10:00.000Z"),
    });
    const store = new MemoryRuntimeStore({
      authorization: attemptAuthorization(claim),
      material: attemptMaterial({ hasVisibleOutput: true }),
    });
    store.settle = async (_fence, input) => {
      store.settlements.push(input);
      throw new RuntimeStoreIndeterminateError();
    };
    const engine = new RuntimeEngine(engineDependencies({ store }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("fence_lost");
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("removes a rejected execution from active tracking without an ignored finally rejection", async () => {
    const claim = attemptClaim({
      checkpoint: "agent_settled",
      checkpointSequence: 8n,
      attemptStatus: "running",
      turnStatus: "running",
      dispatchState: "accepted",
      eventCursor: 4n,
      inactivityDeadlineAt: new Date("2026-08-16T12:10:00.000Z"),
    });
    const store = new MemoryRuntimeStore({
      authorization: attemptAuthorization(claim),
      material: attemptMaterial({ hasVisibleOutput: true }),
    });
    store.settle = async () => {
      throw new RuntimeStoreContractError();
    };
    const engine = new RuntimeEngine(engineDependencies({ store }));

    await expect(engine.execute(claim)).rejects.toBeInstanceOf(RuntimeStoreContractError);
    await Promise.resolve();

    expect(engine.activeCount).toBe(0);
  });

  it("marks an ambiguous prompt interrupted and never replays it", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    ports.pi.prompt = async (input) => {
      ports.promptCalls.push({ attemptId: input.attemptId, message: input.message });
      return { outcome: "ambiguous", code: "ack_timeout" };
    };
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("interrupted");
    expect(ports.promptCalls).toHaveLength(1);
    expect(store.settlements[0]).toMatchObject({
      terminalStatus: "interrupted",
      error: { code: "prompt_dispatch_ambiguous", action: "retry" },
    });
  });

  it("abandons an ambiguous prompt when its durable ambiguity checkpoint is unclassified", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    ports.pi.prompt = async (input) => {
      ports.promptCalls.push({ attemptId: input.attemptId, message: input.message });
      return { outcome: "ambiguous", code: "ack_timeout" };
    };
    const checkpoint = store.checkpoint.bind(store);
    store.checkpoint = async (fence, input) => {
      if (input.nextCheckpoint === "dispatch_ambiguous") {
        throw new RuntimeStoreContractError();
      }
      return await checkpoint(fence, input);
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("fence_lost");
    expect(ports.promptCalls).toHaveLength(1);
    expect(store.authorization.workCheckpoint).toBe("dispatch_write_intent");
    expect(store.settlements).toHaveLength(0);
  });

  it("fails explicitly before dispatch when Pi reports no text capability", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    const original = ports.pi.brokerState;
    ports.pi.brokerState = async (input) => ({
      ...await original(input),
      modelInput: ["image"],
    });
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("failed");
    expect(ports.promptCalls).toHaveLength(0);
    expect(store.settlements[0]?.error).toMatchObject({
      code: "model_text_input_unsupported",
      action: "switch_model",
    });
  });

  it("does not replay a takeover at dispatch_write_intent", async () => {
    const claim = attemptClaim({
      checkpoint: "dispatch_write_intent",
      checkpointSequence: 4n,
      attemptStatus: "dispatching",
      turnStatus: "dispatching",
      dispatchState: "write_intent",
    });
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("interrupted");
    expect(ports.promptCalls).toHaveLength(0);
    expect(store.settlements[0]?.error?.code).toBe("prompt_dispatch_ambiguous");
  });

  it("fails explicitly when Pi settles without a visible assistant or decision", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    ports.eventReads.push(settlementOnlyPage());
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("failed");
    expect(store.settlements[0]).toMatchObject({
      terminalStatus: "failed",
      error: { code: "empty_response" },
    });
  });

  it("settles a page whose decision request is followed by agent_settled", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    ports.eventReads.push({
      events: [
        {
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "extension_ui_request",
            id: "request-1",
            method: "input",
            title: "companion:question:ask_user",
            placeholder: "Choose one",
          },
        },
        {
          sequence: 2,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "agent_settled" },
        },
      ],
      nextCursor: 2,
      acknowledgedCursor: 0,
      hasMore: false,
    });

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(store.authorization.workCheckpoint).toBe("agent_settled");
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("persists unknown counters and fails explicitly on a correlated Pi process exit", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    ports.eventReads.push({
      events: [
        {
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "future_event", raw: "ignored" },
        },
        {
          sequence: 2,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_process_exit",
          exit: { code: 1, signal: null },
        },
      ],
      nextCursor: 2,
      acknowledgedCursor: 0,
      hasMore: false,
    });
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("failed");
    expect(store.authorization.unknownEventCount).toBe(1);
    expect(store.authorization.eventCursor).toBe(2n);
    expect(store.settlements[0]?.error?.code).toBe("pi_process_exited");
    expect(ports.log.indexOf("project")).toBeLessThan(ports.log.indexOf("ack"));
  });

  it("uses durable output proof after takeover at agent_settled", async () => {
    const claim = attemptClaim({
      checkpoint: "agent_settled",
      checkpointSequence: 8n,
      attemptStatus: "running",
      turnStatus: "running",
      dispatchState: "accepted",
      eventCursor: 4n,
      inactivityDeadlineAt: new Date("2026-08-16T12:10:00.000Z"),
    });
    const store = new MemoryRuntimeStore({
      authorization: attemptAuthorization(claim),
      material: attemptMaterial({ hasVisibleOutput: true }),
    });
    const ports = fakePorts(store);
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(ports.eventReads).toHaveLength(0);
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("cannot succeed from a terminal-looking checkpoint after authorization is revoked", async () => {
    const claim = attemptClaim({
      checkpoint: "agent_settled",
      checkpointSequence: 8n,
      attemptStatus: "running",
      turnStatus: "running",
      dispatchState: "accepted",
      eventCursor: 4n,
      inactivityDeadlineAt: new Date("2026-08-16T12:10:00.000Z"),
    });
    const authorized = attemptAuthorization(claim);
    const denied = attemptAuthorization(claim, {
      authorized: false,
      denialCode: "actor_access_revoked",
      runtimeGeneration: null,
      boxId: null,
      modelId: null,
    });
    const store = new MemoryRuntimeStore({
      authorization: authorized,
      material: attemptMaterial({ hasVisibleOutput: true }),
    });
    let renewals = 0;
    store.renewAndAuthorize = async () => {
      renewals += 1;
      return renewals === 1 ? authorized : denied;
    };
    const engine = new RuntimeEngine(engineDependencies({ store }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("failed");
    expect(store.settlements[0]?.error?.code).toBe("actor_access_revoked");
  });

  it("does no external work after a stale lease fence", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    store.renewReturnsNull = true;
    const ports = fakePorts(store);
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("fence_lost");
    expect(ports.promptCalls).toHaveLength(0);
    expect(store.settlements).toHaveLength(0);
  });

  it("releases a lower-priority claim without contacting Box", async () => {
    const claim = attemptClaim();
    const denied = attemptAuthorization(claim, {
      authorized: false,
      denialCode: "higher_priority_work_pending",
      runtimeGeneration: null,
      boxId: null,
      modelId: null,
    });
    const store = new MemoryRuntimeStore({ authorization: denied });
    const ports = fakePorts(store);
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("released");
    expect(store.releases).toBe(1);
    expect(ports.promptCalls).toHaveLength(0);
  });

  it("settles a deadline denial as interrupted", async () => {
    const claim = attemptClaim();
    const denied = attemptAuthorization(claim, {
      authorized: false,
      denialCode: "inactivity_deadline_exceeded",
      runtimeGeneration: null,
      boxId: null,
      modelId: null,
    });
    const store = new MemoryRuntimeStore({ authorization: denied });
    const engine = new RuntimeEngine(engineDependencies({ store }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("interrupted");
    expect(store.settlements[0]?.error?.code).toBe("turn_stalled");
  });

  it("hands off an active accepted attempt without settling or releasing its lease", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    ports.pi.readBrokerEvents = async ({ signal }) => {
      markReadStarted();
      if (signal.aborted) throw signal.reason;
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const execution = engine.execute(claim);
    await readStarted;
    engine.handoffActive();
    const result = await execution;

    expect(result.outcome).toBe("handed_off");
    expect(ports.promptCalls).toHaveLength(1);
    expect(store.authorization.workCheckpoint).toBe("dispatch_accepted");
    expect(store.settlements).toHaveLength(0);
    expect(store.releases).toBe(0);
  });

  it("interrupts a newly handed-off claim during shutdown", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const engine = new RuntimeEngine(engineDependencies({ store }));
    engine.requestShutdown();

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("interrupted");
    expect(store.settlements[0]?.error?.code).toBe("runtime_shutting_down");
  });
});

describe("RuntimeEngine decisions", () => {
  function decisionSetup(): {
    claim: DecisionRuntimeClaim;
    store: MemoryRuntimeStore;
    ports: ReturnType<typeof fakePorts>;
  } {
    const base = attemptClaim();
    const claim: DecisionRuntimeClaim = {
      ...base,
      workKind: "decision",
      workId: "88888888-8888-4888-8888-888888888888",
      checkpoint: "pending",
      checkpointSequence: 0n,
      decisionStatus: "answered",
      decisionDeliveryState: "pending",
    };
    const store = new MemoryRuntimeStore({
      authorization: attemptAuthorization(base, {
        workCheckpoint: "pending",
        workCheckpointSequence: 0n,
        decisionStatus: "answered",
        decisionDeliveryState: "pending",
        decisionRequestKey: "request-1",
      }),
      material: attemptMaterial({
        attemptId: ATTEMPT_ID,
        messageEventId: null,
        promptText: null,
        decisionRequestKind: "question",
        decisionResponsePayload: { type: "extension_ui_response", id: "request-1", value: "yes" },
      }),
    });
    store.authorization.dispatchState = "accepted";
    const ports = fakePorts(store);
    return { claim, store, ports };
  }

  it("correlates the response to attempt_id rather than turn_id", async () => {
    const { claim, store, ports } = decisionSetup();
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(ports.decisionCalls).toEqual([{ attemptId: ATTEMPT_ID }]);
    expect(ports.decisionCalls[0]?.attemptId).not.toBe(TURN_ID);
    expect(store.checkpoints[0]).toMatchObject({
      nextCheckpoint: "write_intent",
      commandId: COMMAND_ID,
    });
  });

  it("refuses a decision when Pi is bound to another attempt", async () => {
    const { claim, store, ports } = decisionSetup();
    const original = ports.pi.brokerState;
    ports.pi.brokerState = async (input) => ({
      ...await original(input),
      activeAttemptId: "99999999-9999-4999-8999-999999999999",
    });
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("failed");
    expect(ports.decisionCalls).toHaveLength(0);
    expect(store.settlements[0]?.error?.code).toBe("decision_attempt_mismatch");
  });

  it("revalidates the Box and Pi binding after the decision write-intent checkpoint", async () => {
    const { claim, store, ports } = decisionSetup();
    const checkpoint = store.checkpoint.bind(store);
    store.checkpoint = async (fence, input) => {
      const result = await checkpoint(fence, input);
      if (input.nextCheckpoint === "write_intent") {
        store.authorization.boxId = "bx_2345678b";
      }
      return result;
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("fence_lost");
    expect(ports.decisionCalls).toHaveLength(0);
    expect(store.settlements).toHaveLength(0);
  });

  it("marks an ambiguous decision interrupted and never replays it on takeover", async () => {
    const first = decisionSetup();
    first.ports.pi.respondExtensionUi = async (input) => {
      first.ports.decisionCalls.push({ attemptId: input.attemptId });
      return { outcome: "ambiguous", code: "ack_timeout" };
    };
    const firstEngine = new RuntimeEngine(engineDependencies({
      store: first.store,
      ports: first.ports,
    }));

    const firstResult = await firstEngine.execute(first.claim);

    expect(firstResult.outcome).toBe("interrupted");
    expect(first.ports.decisionCalls).toEqual([{ attemptId: ATTEMPT_ID }]);
    expect(first.store.settlements[0]?.error?.code).toBe("decision_delivery_ambiguous");

    const takeover = decisionSetup();
    takeover.claim.checkpoint = "ambiguous";
    takeover.claim.checkpointSequence = 2n;
    takeover.claim.decisionDeliveryState = "ambiguous";
    takeover.store.authorization.workCheckpoint = "ambiguous";
    takeover.store.authorization.workCheckpointSequence = 2n;
    takeover.store.authorization.decisionDeliveryState = "ambiguous";
    const takeoverEngine = new RuntimeEngine(engineDependencies({
      store: takeover.store,
      ports: takeover.ports,
    }));

    const takeoverResult = await takeoverEngine.execute(takeover.claim);

    expect(takeoverResult.outcome).toBe("interrupted");
    expect(takeover.ports.decisionCalls).toHaveLength(0);
  });

  it("abandons the fence when a decision ambiguity checkpoint cannot be classified", async () => {
    const { claim, store, ports } = decisionSetup();
    const checkpoint = store.checkpoint.bind(store);
    store.checkpoint = async (fence, input) => {
      if (input.nextCheckpoint === "ambiguous") throw new RuntimeStoreContractError();
      return await checkpoint(fence, input);
    };
    ports.pi.respondExtensionUi = async (input) => {
      ports.decisionCalls.push({ attemptId: input.attemptId });
      return { outcome: "ambiguous", code: "ack_timeout" };
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("fence_lost");
    expect(ports.decisionCalls).toEqual([{ attemptId: ATTEMPT_ID }]);
    expect(store.settlements).toHaveLength(0);
  });
});

describe("RuntimeEngine process error logs", () => {
  function capturingLog(): { log: RuntimeProcessLog; records: Record<string, unknown>[] } {
    const records: Record<string, unknown>[] = [];
    return {
      records,
      log: {
        error(record) { records.push({ level: "error", ...record }); },
        warn(record) { records.push({ level: "warn", ...record }); },
      },
    };
  }

  it("logs the original Box failure when the persisted error is the generic fallback", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    ports.pi.brokerState = async () => {
      throw new Error("Pi is not installed; configure COMPANION_PI_INSTALL_COMMAND");
    };
    const captured = capturingLog();
    const engine = new RuntimeEngine(engineDependencies({ store, ports, log: captured.log }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("failed");
    expect(store.settlements[0]?.error?.code).toBe("runtime_execution_failed");
    expect(captured.records).toEqual([expect.objectContaining({
      level: "error",
      event: "runtime.work.failed",
      companionId: COMPANION_ID,
      workKind: "attempt",
      genericFallback: true,
      thrown: expect.objectContaining({
        name: "Error",
        message: "Pi is not installed; configure COMPANION_PI_INSTALL_COMMAND",
      }),
      persisted: expect.objectContaining({
        code: "runtime_execution_failed",
        message: "Runtime execution failed.",
      }),
    })]);
  });

  it("logs an indeterminate store wrap instead of disappearing as a silent fence loss", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const ports = fakePorts(store);
    const checkpoint = store.checkpoint.bind(store);
    store.checkpoint = async (fence, input) => {
      await checkpoint(fence, input);
      throw new RuntimeStoreIndeterminateError(
        new Error("settings claim has an impossible nullable shape"),
      );
    };
    const captured = capturingLog();
    const engine = new RuntimeEngine(engineDependencies({ store, ports, log: captured.log }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("fence_lost");
    expect(captured.records).toEqual([expect.objectContaining({
      level: "error",
      event: "runtime.work.fence_lost",
      reason: "indeterminate_store",
      thrown: expect.objectContaining({
        name: "RuntimeStoreIndeterminateError",
        causes: [expect.objectContaining({
          message: "settings claim has an impossible nullable shape",
        })],
      }),
    })]);
  });
});

describe("RuntimeEngine health observation", () => {
  it.each(["unassigned", "provider_404"] as const)(
    "clears stale Pi state when the Box is %s",
    async (scenario) => {
      const claim = healthClaim();
      const store = new MemoryRuntimeStore({
        authorization: attemptAuthorization(attemptClaim(), {
          authorizationActorId: null,
          clientSurface: null,
          workCheckpoint: "observing",
          workCheckpointSequence: 0n,
          turnId: null,
          turnStatus: null,
          attemptStatus: null,
          dispatchState: null,
          eventCursor: null,
          unknownEventCount: null,
          malformedEventCount: null,
          oversizedEventCount: null,
          coldStartDeadlineAt: null,
          inactivityDeadlineAt: null,
          absoluteDeadlineAt: null,
          operationKind: null,
          ...(scenario === "unassigned" ? { boxId: null } : {}),
          boxState: "ready",
          piState: "running",
        }),
      });
      const ports = fakePorts(store);
      if (scenario === "provider_404") {
        ports.box.getStatus = async () => {
          throw Object.assign(new Error("gone"), { status: 404 });
        };
      }

      const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

      expect(result.outcome).toBe("succeeded");
      expect(store.observations.at(-1)).toMatchObject({
        boxState: "absent",
        piState: "absent",
      });
    },
  );
});
