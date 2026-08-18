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
    const [ack] = chunk.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(ack).toMatchObject({
      type: "response",
      command: "prompt",
      id: "prompt-1",
      success: true,
    });
    expect(chunk).toContain('{"type":"agent_settled"}');

    const stopped = await runtime.stop({ boxId: boxId! });
    expect(stopped).toMatchObject({ runtimeState: "stopping", daemonState: "stopped" });
    const [snapshot] = server.simulator.snapshot().boxes;
    expect(snapshot?.daemon.status).toBe("inactive");
    expect(snapshot?.daemon.unknownCommandDigests).toEqual([]);
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
