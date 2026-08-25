/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Mirrors the existing simulator HTTP fixture conventions. */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHostedAgentEndpoint } from "@companion/box-runtime";

import {
  appendPiEvent,
  executeBoxCommand,
  putBoxFile,
  type BoxSimCommandMachine,
} from "../src/commandShims";
import type { BoxSimPiController } from "../src/protocol";
import {
  createBoxSimServer,
  type BoxSimServerHandle,
  type BoxSimServerOptions,
} from "../src/server";

const API_KEY = "agent-listener-test-key";
const BEARER = "agent-listener-bearer-0123456789abcdef";

/** The exec-side registration script emitted by #registerBoxAgent, minus the user-bus preamble. */
const REGISTRATION_SCRIPT = `set -euo pipefail
systemctl --user daemon-reload
systemctl --user reset-failed companion-box-agent.service >/dev/null 2>&1 || true
systemctl --user enable companion-box-agent.service >/dev/null 2>&1 || true
systemctl --user start companion-box-agent.service
companion_agent_state=unknown
for companion_agent_probe in $(seq 1 50); do
  companion_agent_state="$(systemctl --user is-active companion-box-agent.service 2>/dev/null || true)"
  if [ "$companion_agent_state" = active ]; then break; fi
  sleep 0.1
done
if [ "$companion_agent_state" != active ]; then
  echo 'Companion box agent failed to start' >&2
  exit 1
fi
# 'host' is the provider's sticky per-port service registration; its URL and query token are
# minted by the provider.
host 8790 --title companion-agent >/dev/null 2>&1 || true
companion_agent_url="$(host url 8790 2>/dev/null | grep -Eo 'https?://[^[:space:]]+' | tail -n 1)"
if [ -z "$companion_agent_url" ]; then
  echo 'Companion box agent hosted endpoint is unavailable' >&2
  exit 1
fi
printf 'companion-agent-endpoint %s\\n' "$companion_agent_url"`;

const openServers: BoxSimServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((handle) => handle.close()));
});

async function start(options: BoxSimServerOptions = {}): Promise<BoxSimServerHandle> {
  const handle = createBoxSimServer({
    agentPort: 0,
    piControllerFactory: fakePiController,
    ...options,
    apiKey: API_KEY,
    controlToken: "agent-listener-control-token",
  });
  await handle.listen();
  openServers.push(handle);
  return handle;
}

/** Deterministic in-process Pi so parity assertions never race a child process. */
function fakePiController(): BoxSimPiController {
  return {
    start: vi.fn(),
    restart: vi.fn(),
    stop: vi.fn(),
    handleRpc: vi.fn(async (command: Record<string, unknown>) => ({
      type: "response",
      command: command.type,
      id: command.id,
      success: true,
      ...(command.type === "get_state"
        ? { data: { model: { input: ["text", "image"] } } }
        : {}),
    })),
    respondExtensionUi: vi.fn(),
    crash: vi.fn(),
    setScenario: vi.fn(),
    dispose: vi.fn(),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function brokerShell(command: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(command), "utf8").toString("base64");
  return `broker_socket="$HOME/.companion/runtime/state/pi-broker.sock"
test -S "$broker_socket"
COMPANION_PI_BROKER_COMMAND=${shellQuote(encoded)} node <<'COMPANION_PI_BROKER_CLIENT'`;
}

/** Provision one Box with an active daemon, a staged agent bearer digest, and a hosted endpoint. */
async function agentBox(handle: BoxSimServerHandle): Promise<{
  boxId: string;
  machine: BoxSimCommandMachine;
  endpoint: string;
  proxyToken: string;
}> {
  const box = await handle.simulator.createBox();
  const machine = handle.simulator.commandMachine(box.id);
  putBoxFile(machine, ".companion/pi/auth.json", Buffer.from("{}\n"));
  putBoxFile(machine, ".companion/runtime/state/providers.env", Buffer.from("SIM_TOKEN=redacted\n"));
  putBoxFile(machine, ".companion/runtime/state/pi-layout.version", Buffer.from("14:pins:overlay=agent\n"));
  putBoxFile(machine, ".companion/runtime/state/agent-auth.json", Buffer.from(`${JSON.stringify({
    tokenSha256: createHash("sha256").update(BEARER, "utf8").digest("hex"),
  })}\n`));
  await expect(executeBoxCommand(
    machine,
    "staged_credential_file=x; systemctl --user daemon-reload; systemctl --user start companion-pi-daemon.service",
  )).resolves.toMatchObject({ success: true });
  const registered = await executeBoxCommand(machine, REGISTRATION_SCRIPT);
  expect(registered).toMatchObject({ success: true });
  const minted = /companion-agent-endpoint (\S+)/.exec(registered.stdout)?.[1];
  if (!minted) throw new Error("registration shim printed no endpoint marker");
  const url = new URL(minted);
  const proxyToken = url.searchParams.get("_token")!;
  url.search = "";
  return { boxId: box.id, machine, endpoint: url.toString().replace(/\/+$/, ""), proxyToken };
}

function agentGet(path: string, bearer: string | null = BEARER): Promise<Response> {
  return fetch(path, bearer === null ? {} : { headers: { Authorization: `Bearer ${bearer}` } });
}

describe("Companion box agent listener", () => {
  it("mints a sticky hosted endpoint the production URL parser accepts", async () => {
    const handle = await start();
    const { boxId, machine, endpoint, proxyToken } = await agentBox(handle);

    expect(machine.agentUnitEnabled).toBe(true);
    expect(endpoint).toBe(`${handle.agentBaseUrl}/boxes/${boxId}`);
    expect(proxyToken).toMatch(/^[a-f0-9]{64}$/);
    expect(parseHostedAgentEndpoint(`${endpoint}?_token=${proxyToken}`)).toEqual({
      hostedUrl: endpoint,
      proxyToken,
    });

    // The provider keeps one URL and token per port, so a re-registration after stop/resume must
    // hand the adapter the exact endpoint it already stored.
    const again = await executeBoxCommand(machine, REGISTRATION_SCRIPT);
    expect(again.stdout).toBe(`companion-agent-endpoint ${endpoint}?_token=${proxyToken}\n`);
  });

  it("gates the proxy token before the bearer, each failing closed", async () => {
    const handle = await start();
    const { endpoint, proxyToken } = await agentBox(handle);

    const missingToken = await agentGet(`${endpoint}/v1/health`);
    expect(missingToken.status).toBe(403);
    expect(await missingToken.text()).toBe("Access denied");
    expect((await agentGet(`${endpoint}/v1/health?_token=${"0".repeat(64)}`)).status).toBe(403);

    const missingBearer = await agentGet(`${endpoint}/v1/health?_token=${proxyToken}`, null);
    expect(missingBearer.status).toBe(401);
    expect(await missingBearer.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "a valid agent bearer token is required",
        ambiguous: false,
      },
    });
    expect((await agentGet(`${endpoint}/v1/health?_token=${proxyToken}`, "wrong-bearer-0123456789"))
      .status).toBe(401);

    expect((await agentGet(`${endpoint}/v1/health?_token=${proxyToken}`)).status).toBe(200);
    expect((await agentGet(`${endpoint}/v1/unknown?_token=${proxyToken}`)).status).toBe(404);
  });

  it("serves the exact agent health shape from the shared machine", async () => {
    const handle = await start();
    const { machine, endpoint, proxyToken } = await agentBox(handle);

    const active = await agentGet(`${endpoint}/v1/health?_token=${proxyToken}`);
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({
      agentVersion: 1,
      piUnit: "active",
      brokerSocketReady: true,
      layoutMarker: "14:pins:overlay=agent",
    });

    await expect(executeBoxCommand(machine, "Pi daemon is still active after stop"))
      .resolves.toMatchObject({ success: true });
    expect(await (await agentGet(`${endpoint}/v1/health?_token=${proxyToken}`)).json()).toEqual({
      agentVersion: 1,
      piUnit: "inactive",
      brokerSocketReady: false,
      layoutMarker: "14:pins:overlay=agent",
    });
    const state = await agentGet(`${endpoint}/v1/broker/state?_token=${proxyToken}`);
    expect(state.status).toBe(503);
    expect(await state.json()).toMatchObject({ error: { code: "broker_unavailable" } });
  });

  it("answers byte-identically to the exec transport from the same kernel", async () => {
    const handle = await start();
    const { machine, endpoint, proxyToken } = await agentBox(handle);
    machine.daemon.activeAttemptId = "attempt-parity";
    appendPiEvent(machine, { type: "turn_start" });
    appendPiEvent(machine, { type: "message_start" });

    const execState = await executeBoxCommand(machine, brokerShell({
      id: "parity-runtime-state",
      type: "runtime_state",
    }));
    const agentState = await agentGet(`${endpoint}/v1/broker/state?_token=${proxyToken}`);
    expect(agentState.status).toBe(200);
    expect(JSON.stringify(await agentState.json()))
      .toBe(JSON.stringify((JSON.parse(execState.stdout) as { data: unknown }).data));

    const execEvents = await executeBoxCommand(machine, brokerShell({
      id: "parity-read-events",
      type: "read_events",
      after: 0,
    }));
    const agentEvents = await agentGet(`${endpoint}/v1/events?_token=${proxyToken}&after=0`);
    expect(agentEvents.status).toBe(200);
    expect(JSON.stringify(await agentEvents.json()))
      .toBe(JSON.stringify((JSON.parse(execEvents.stdout) as { data: unknown }).data));

    const acked = await fetch(`${endpoint}/v1/ack?_token=${proxyToken}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ through: 2 }),
    });
    expect(acked.status).toBe(200);
    expect(await acked.json()).toEqual({ acknowledgedCursor: 2 });
    const afterAck = await executeBoxCommand(machine, brokerShell({
      id: "parity-broker-state",
      type: "broker_state",
    }));
    expect(JSON.parse(afterAck.stdout)).toMatchObject({
      success: true,
      data: { acknowledgedCursor: 2 },
    });
  });

  it("resolves a long-poll as soon as an event lands, well before the deadline", async () => {
    const handle = await start();
    const { machine, endpoint, proxyToken } = await agentBox(handle);
    machine.daemon.activeAttemptId = "attempt-longpoll";

    const startedAt = Date.now();
    const pending = agentGet(`${endpoint}/v1/events?_token=${proxyToken}&after=0&wait_ms=5000`);
    setTimeout(() => appendPiEvent(machine, { type: "turn_start" }), 100);
    const response = await pending;
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      events: [expect.objectContaining({ attemptId: "attempt-longpoll", kind: "pi_event" })],
      nextCursor: 1,
    });
  });

  it("caps wait_ms at the configured long-poll ceiling", async () => {
    const handle = await start({ agentLongPollCapMs: 300 });
    const { endpoint, proxyToken } = await agentBox(handle);

    const startedAt = Date.now();
    const response = await agentGet(`${endpoint}/v1/events?_token=${proxyToken}&after=0&wait_ms=10000`);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ events: [], nextCursor: 0 });
  });

  it("rejects an oversized ack body before touching the broker", async () => {
    const handle = await start();
    const { endpoint, proxyToken } = await agentBox(handle);

    const oversized = await fetch(`${endpoint}/v1/ack?_token=${proxyToken}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ through: 0, padding: "x".repeat(64 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("honors agent fault points for events and connection loss", async () => {
    const handle = await start();
    const { endpoint, proxyToken } = await agentBox(handle);

    handle.simulator.addFault({
      point: "agent.events.before",
      action: { kind: "http", status: 503, code: "synthetic_agent_outage" },
    });
    const faulted = await agentGet(`${endpoint}/v1/events?_token=${proxyToken}&after=0`);
    expect(faulted.status).toBe(503);
    expect(await faulted.json()).toMatchObject({ code: "synthetic_agent_outage" });

    handle.simulator.addFault({ point: "agent.disconnect", action: { kind: "disconnect" } });
    await expect(agentGet(`${endpoint}/v1/health?_token=${proxyToken}`)).rejects.toThrow();
    // The one-shot fault is consumed; the very next request is served normally again.
    expect((await agentGet(`${endpoint}/v1/health?_token=${proxyToken}`)).status).toBe(200);
  });
});
