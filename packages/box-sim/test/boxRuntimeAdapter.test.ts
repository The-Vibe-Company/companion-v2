import { afterEach, describe, expect, it } from "vitest";

import { AsciiBoxCompanionRuntime } from "@companion/box-runtime";
import { createBoxSimServer, type BoxSimServerHandle } from "../src/server";

const openServers: BoxSimServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("production Box runtime against the simulator", () => {
  it("cold-starts, receives a correlated prompt ACK, settles, and stops without host lifecycle calls", async () => {
    const server = createBoxSimServer({ apiKey: "box_adapter_contract" });
    await server.listen();
    openServers.push(server);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_adapter_contract",
      COMPANION_BOX_API_BASE: server.baseUrl,
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_BOX_READY_TIMEOUT_MS: "5000",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "5000",
    });
    let boxId: string | null = null;

    const started = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: null,
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "simulator-only" } },
      replaceProviderAuth: true,
      modelId: "simulated-model",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async (assigned) => { boxId = assigned; },
    });

    expect(started).toMatchObject({
      boxId: "bx_23456789",
      runtimeState: "running",
      daemonState: "running",
      staged: true,
    });
    expect(boxId).toBe("bx_23456789");
    await runtime.prompt({ boxId: boxId!, message: "Hello from the adapter contract.", requestId: "prompt-1" });

    const chunk = await waitForSettlement(runtime, boxId!);
    // Command ACKs are socket-only in layout 14. The compatibility byte log carries only validated
    // general events until Runtime v2 switches fully to the segmented journal cursor.
    expect(chunk).not.toContain('"type":"response"');
    expect(chunk).toContain('{"type":"agent_settled"}');

    const stopped = await runtime.stop({ boxId: boxId! });
    expect(stopped).toMatchObject({ runtimeState: "stopping", daemonState: "stopped" });
    const [snapshot] = server.simulator.snapshot().boxes;
    expect(snapshot?.daemon.status).toBe("inactive");
    expect(snapshot?.name).toBe("Companion 11111111-1111-4111-8111-111111111111");
    expect(snapshot?.daemon.unknownCommandDigests).toEqual([]);
  });

  it("persists broker state and serves monotonic read/ack cursors through the production adapter", async () => {
    const server = createBoxSimServer({
      apiKey: "box_adapter_broker_contract",
      defaults: { piScenario: "ask_user" },
    });
    await server.listen();
    openServers.push(server);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_adapter_broker_contract",
      COMPANION_BOX_API_BASE: server.baseUrl,
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_BOX_READY_TIMEOUT_MS: "5000",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "5000",
    });
    let boxId: string | null = null;

    await runtime.start({
      companionId: "33333333-3333-4333-8333-333333333333",
      orgId: "44444444-4444-4444-8444-444444444444",
      boxId: null,
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "simulator-only" } },
      replaceProviderAuth: true,
      modelId: "simulated-model",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async (assigned) => { boxId = assigned; },
    });
    if (!boxId) throw new Error("simulator did not assign a Box");

    await expect(runtime.brokerState({ boxId })).resolves.toEqual({
      invocationId: "00000000000000000000000000000001",
      activeAttemptId: null,
      tailCursor: 0,
      acknowledgedCursor: 0,
      modelInput: ["text", "image"],
      counters: {
        malformedLines: 0,
        oversizedLines: 0,
        unterminatedLines: 0,
        unknownEvents: 0,
        // This layer still cold-starts with an explicit systemd restart, so the broker records the
        // pre-invocation process exit as unbound. The dedicated runtime switches cold start to an
        // idempotent start in the next stack layer.
        unboundEvents: 1,
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
    });

    const waitingPage = await waitForBrokerEvent(
      runtime,
      boxId,
      0,
      "extension_ui_request",
    );
    expect(waitingPage.events.map((event) => event.sequence)).toEqual(
      waitingPage.events.map((_, index) => index + 1),
    );
    expect(waitingPage.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        invocationId: "00000000000000000000000000000001",
        attemptId: "attempt-journal-1",
        kind: "pi_event",
      }),
    ]));
    await expect(runtime.brokerState({ boxId })).resolves.toMatchObject({
      invocationId: "00000000000000000000000000000001",
      activeAttemptId: "attempt-journal-1",
      tailCursor: waitingPage.nextCursor,
      acknowledgedCursor: 0,
    });

    const acknowledgedThrough = waitingPage.events[1]?.sequence ?? waitingPage.nextCursor;
    await expect(runtime.ackEvents({ boxId, through: acknowledgedThrough })).resolves.toEqual({
      acknowledgedCursor: acknowledgedThrough,
    });
    const afterAck = await runtime.readEvents({ boxId, after: 0 });
    expect(afterAck.acknowledgedCursor).toBe(acknowledgedThrough);
    expect(afterAck.events.every((event) => event.sequence > acknowledgedThrough)).toBe(true);

    const request = waitingPage.events.find((record) => (
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

    const settledPage = await waitForBrokerEvent(
      runtime,
      boxId,
      waitingPage.nextCursor,
      "agent_settled",
    );
    const finalCursor = settledPage.nextCursor;
    await expect(runtime.brokerState({ boxId })).resolves.toMatchObject({
      activeAttemptId: null,
      tailCursor: finalCursor,
      acknowledgedCursor: acknowledgedThrough,
    });
    await expect(runtime.ackEvents({ boxId, through: finalCursor })).resolves.toEqual({
      acknowledgedCursor: finalCursor,
    });
    await expect(runtime.readEvents({ boxId, after: 0 })).resolves.toEqual({
      events: [],
      nextCursor: finalCursor,
      acknowledgedCursor: finalCursor,
      hasMore: false,
    });

    await runtime.stop({ boxId });
    expect(server.simulator.snapshot().boxes[0]?.daemon).toMatchObject({
      activeAttemptId: null,
      // A process exit after agent_settled has no active attempt and is counted, not projected
      // into the correlated journal.
      tailCursor: finalCursor,
      acknowledgedCursor: finalCursor,
      counters: {
        malformedLines: 0,
        oversizedLines: 0,
        unterminatedLines: 0,
        unknownEvents: 0,
        unboundEvents: 2,
        orphanResponses: 0,
      },
      unknownCommandDigests: [],
    });
  });
});

async function waitForSettlement(
  runtime: AsciiBoxCompanionRuntime,
  boxId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { chunk } = await runtime.readEvents({ boxId, offset: 0 });
    if (chunk.includes('"type":"agent_settled"')) return chunk;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Pi simulator did not settle within the adapter contract deadline");
}

async function waitForBrokerEvent(
  runtime: AsciiBoxCompanionRuntime,
  boxId: string,
  after: number,
  eventType: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = await runtime.readEvents({ boxId, after });
    if (page.events.some((record) => (
      record.kind === "pi_event" && record.event.type === eventType
    ))) return page;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Pi simulator did not emit ${eventType} within the adapter contract deadline`);
}
