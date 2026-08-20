import { afterEach, describe, expect, it } from "vitest";

import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  type CompanionPiBrokerEventPage,
} from "@companion/box-runtime";
import { createBoxSimServer, type BoxSimServerHandle } from "../src/server";

const openServers: BoxSimServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("production Box runtime v2 against the simulator", () => {
  it("creates, stages, dispatches, and archives only through explicit narrow checkpoints", async () => {
    const harness = await provision({
      apiKey: "box_adapter_contract",
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
    });
    const { boxId, runtime, server } = harness;

    expect("start" in runtime).toBe(false);
    expect("healPiDaemon" in runtime).toBe(false);
    expect("captureDesktopFrame" in runtime).toBe(false);
    await expect(runtime.existingBoxStatus({ boxId })).resolves.toEqual({
      boxId,
      state: "ready",
    });
    await expect(runtime.piDaemonStatus({ boxId })).resolves.toMatchObject({
      state: "idle",
      invocationId: "00000000000000000000000000000001",
    });
    await expect(runtime.dispatchPrompt({
      boxId,
      attemptId: "attempt-contract-1",
      requestId: "dispatch-contract-1",
      message: "Hello from the adapter contract.",
    })).resolves.toEqual({
      outcome: "accepted",
      attemptId: "attempt-contract-1",
      invocationId: "00000000000000000000000000000001",
      initialCursor: 0,
    });

    const settled = await waitForBrokerEvent(runtime, boxId, 0, "agent_settled");
    expect(settled.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ type: "response" }) }),
    ]));
    await expect(runtime.ackEvents({ boxId, through: settled.nextCursor })).resolves.toEqual({
      acknowledgedCursor: settled.nextCursor,
    });
    await expect(runtime.readEvents({ boxId, after: 0 })).resolves.toEqual({
      events: [],
      nextCursor: settled.nextCursor,
      acknowledgedCursor: settled.nextCursor,
      hasMore: false,
    });
    await runtime.refreshTtl({ boxId, ttlSeconds: 21_600 });
    await runtime.stopPiDaemon({ boxId });
    await expect(runtime.archiveExistingBox({ boxId })).resolves.toMatchObject({
      boxId,
      state: "archiving",
    });

    const [snapshot] = server.simulator.snapshot().boxes;
    expect(snapshot?.daemon.status).toBe("inactive");
    expect(snapshot?.name).toBe("Companion 11111111-1111-4111-8111-111111111111 g1");
    expect(snapshot?.daemon.unknownCommandDigests).toEqual([]);
  });

  it("serves monotonic journal cursors and resumes one correlated ask_user decision", async () => {
    const harness = await provision({
      apiKey: "box_adapter_broker_contract",
      companionId: "33333333-3333-4333-8333-333333333333",
      generation: 7,
      piScenario: "ask_user",
    });
    const { boxId, runtime } = harness;

    await expect(runtime.brokerState({ boxId })).resolves.toMatchObject({
      invocationId: "00000000000000000000000000000001",
      layoutMarker: expect.any(String),
      activeAttemptId: null,
      tailCursor: 0,
      acknowledgedCursor: 0,
      modelInput: ["text", "image"],
      counters: {
        malformedLines: 0,
        oversizedLines: 0,
        unterminatedLines: 0,
        unknownEvents: 0,
        unboundEvents: 0,
        orphanResponses: 0,
      },
    });
    await expect(runtime.dispatchPrompt({
      boxId,
      attemptId: "attempt-journal-1",
      requestId: "dispatch-journal-1",
      message: "Ask before continuing.",
    })).resolves.toEqual({
      outcome: "accepted",
      attemptId: "attempt-journal-1",
      invocationId: "00000000000000000000000000000001",
      initialCursor: 0,
    });

    const waiting = await waitForBrokerEvent(runtime, boxId, 0, "extension_ui_request");
    expect(waiting.events.map((event) => event.sequence)).toEqual(
      waiting.events.map((_, index) => index + 1),
    );
    expect(waiting.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        invocationId: "00000000000000000000000000000001",
        attemptId: "attempt-journal-1",
        kind: "pi_event",
      }),
    ]));
    await expect(runtime.brokerState({ boxId })).resolves.toMatchObject({
      activeAttemptId: "attempt-journal-1",
      tailCursor: waiting.nextCursor,
      acknowledgedCursor: 0,
    });

    const acknowledgedThrough = waiting.events[1]?.sequence ?? waiting.nextCursor;
    await expect(runtime.ackEvents({ boxId, through: acknowledgedThrough })).resolves.toEqual({
      acknowledgedCursor: acknowledgedThrough,
    });
    const afterAck = await runtime.readEvents({ boxId, after: 0 });
    expect(afterAck.events.every((event) => event.sequence > acknowledgedThrough)).toBe(true);

    const request = waiting.events.find((record) => (
      record.kind === "pi_event" && record.event.type === "extension_ui_request"
    ));
    const requestId = request?.kind === "pi_event" && typeof request.event.id === "string"
      ? request.event.id
      : null;
    if (!requestId) throw new Error("Pi simulator did not emit a correlated UI request");
    await expect(runtime.dispatchExtensionUi({
      boxId,
      attemptId: "attempt-journal-1",
      requestId: "decision-journal-1",
      response: { type: "extension_ui_response", id: requestId, value: "Continue" },
    })).resolves.toEqual({
      outcome: "accepted",
      attemptId: "attempt-journal-1",
      invocationId: "00000000000000000000000000000001",
    });

    const settled = await waitForBrokerEvent(runtime, boxId, waiting.nextCursor, "agent_settled");
    await expect(runtime.brokerState({ boxId })).resolves.toMatchObject({
      activeAttemptId: null,
      tailCursor: settled.nextCursor,
      acknowledgedCursor: acknowledgedThrough,
    });
  });
});

async function provision(input: {
  apiKey: string;
  companionId: string;
  generation: number;
  piScenario?: string;
}): Promise<{
  server: BoxSimServerHandle;
  runtime: AsciiBoxCompanionRuntime;
  boxId: string;
}> {
  const server = createBoxSimServer({
    apiKey: input.apiKey,
    ...(input.piScenario ? { defaults: { piScenario: input.piScenario } } : {}),
  });
  await server.listen();
  openServers.push(server);
  const env = {
    COMPANION_BOX_API_KEY: input.apiKey,
    COMPANION_BOX_API_BASE: server.baseUrl,
    COMPANION_BOX_POLL_INTERVAL_MS: "1",
    COMPANION_BOX_READY_TIMEOUT_MS: "5000",
    COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "5000",
  };
  const lifecycle = new AsciiBoxMaintenanceClient(env);
  const runtime = new AsciiBoxCompanionRuntime(env);
  const deadlineAt = Date.now() + 10_000;
  const created = await lifecycle.createOrRecoverGenerationBox({
    companionId: input.companionId,
    generation: input.generation,
    ttlSeconds: 21_600,
    deadlineAt,
  });
  const boxId = created.boxId;
  await lifecycle.applyGenerationBoxSettings({
    boxId,
    companionId: input.companionId,
    generation: input.generation,
    ttlSeconds: 21_600,
    deadlineAt,
  });
  for (;;) {
    const status = await fetch(`${server.baseUrl}/boxes/${boxId}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    });
    const body = await status.json() as { box?: { state?: string } };
    if (["ready", "running", "idle"].includes(body.box?.state ?? "")) break;
    if (Date.now() >= deadlineAt) throw new Error("simulated Box did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await runtime.stageExistingBox({
    companionId: input.companionId,
    runtimeGeneration: input.generation,
    orgId: "22222222-2222-4222-8222-222222222222",
    boxId,
    clientSurface: "web",
    providerAuth: { anthropic: { type: "api_key", key: "simulator-only" } },
    replaceProviderAuth: true,
    modelId: "simulated-model",
    mcpCredentials: [],
    mcpAccounts: [],
    skills: [],
  });
  await runtime.startPiDaemon({ boxId });
  return { server, runtime, boxId };
}

async function waitForBrokerEvent(
  runtime: AsciiBoxCompanionRuntime,
  boxId: string,
  after: number,
  eventType: string,
): Promise<CompanionPiBrokerEventPage> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = await runtime.readEvents({ boxId, after });
    if (page.events.some((record) => (
      record.kind === "pi_event" && record.event.type === eventType
    ))) return page;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Pi simulator did not emit ${eventType} within the adapter contract deadline`);
}
