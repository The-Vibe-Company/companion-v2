import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";

import {
  DESKTOP_REQUEST_PATH,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_TIMESTAMP_HEADER,
  signDesktopRequest,
} from "./desktopAuth";
import {
  createRuntimeHttpServer,
  type RuntimeHttpServer,
  type RuntimeSchedulerHealthSnapshot,
} from "./server";

const hmacSecret = Buffer.alloc(32, 23);
const nowMs = 1_800_000_000_000;
const ids = {
  orgId: "11111111-1111-4111-8111-111111111111",
  companionId: "22222222-2222-4222-8222-222222222222",
  actorId: "test-user",
};
const openServers: RuntimeHttpServer[] = [];

function healthySnapshot(): RuntimeSchedulerHealthSnapshot {
  return {
    claimLoopAlive: true,
    fatal: false,
    lastSweepStartedAt: new Date(nowMs - 100),
    lastSweepCompletedAt: new Date(nowMs - 50),
    claimLoopErrorAt: null,
    activeCount: 2,
  };
}

async function start(input: {
  snapshot?: RuntimeSchedulerHealthSnapshot;
  ping?: () => Promise<void>;
  authorizeAndMint?: ReturnType<typeof vi.fn>;
} = {}) {
  let snapshot = input.snapshot ?? healthySnapshot();
  const authorizeAndMint = input.authorizeAndMint ?? vi.fn(async () => ({
    url: "https://desktop.example.test/session?token=never-log-this",
    provisioning: false,
    transport: "vnc" as const,
  }));
  const server = createRuntimeHttpServer({
    host: "127.0.0.1",
    port: 0,
    sweepIntervalMs: 2_000,
    desktopHmacSecret: hmacSecret,
    desktopMaxSkewSeconds: 30,
    health: {
      ping: input.ping ?? (async () => undefined),
      snapshot: () => snapshot,
    },
    desktop: { authorizeAndMint },
    now: () => nowMs,
    healthPingTimeoutMs: 20,
  });
  await server.listen();
  openServers.push(server);
  return {
    server,
    authorizeAndMint,
    setSnapshot(next: RuntimeSchedulerHealthSnapshot) { snapshot = next; },
  };
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

describe("private runtime HTTP server", () => {
  it("reports only stable health fields and fails stale or unavailable dependencies", async () => {
    const handle = await start();
    const healthy = await fetch(`${handle.server.baseUrl}/healthz`);
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({
      status: "ok",
      checks: { database: true, claim_loop: true, sweep_fresh: true },
      last_sweep_started_at: new Date(nowMs - 100).toISOString(),
      last_sweep_completed_at: new Date(nowMs - 50).toISOString(),
      claim_loop_error_at: null,
      active_count: 2,
    });

    handle.setSnapshot({
      ...healthySnapshot(),
      lastSweepCompletedAt: new Date(nowMs - 5_001),
      claimLoopErrorAt: new Date(nowMs - 10),
    });
    const unhealthy = await fetch(`${handle.server.baseUrl}/healthz`);
    expect(unhealthy.status).toBe(503);
    const body = JSON.stringify(await unhealthy.json());
    expect(body).not.toContain("Error");
    expect(body).not.toContain(ids.companionId);
    expect(body).not.toContain("http");

    const databaseDown = await start({ ping: async () => { throw new Error("postgres secret"); } });
    const failedPing = await fetch(`${databaseDown.server.baseUrl}/healthz`);
    expect(failedPing.status).toBe(503);
    expect(await failedPing.json()).toMatchObject({ checks: { database: false } });
  });

  it("binds desktop authorization to timestamp, path, and exact body before SQL reauthorization", async () => {
    const handle = await start();
    const rawBody = Buffer.from(JSON.stringify(ids), "utf8");
    const timestamp = Math.floor(nowMs / 1_000);
    const signature = signDesktopRequest({
      method: "POST",
      pathname: DESKTOP_REQUEST_PATH,
      timestamp,
      rawBody,
    }, hmacSecret);
    const response = await fetch(`${handle.server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DESKTOP_TIMESTAMP_HEADER]: String(timestamp),
        [DESKTOP_SIGNATURE_HEADER]: signature,
      },
      body: rawBody,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      desktop_url: "https://desktop.example.test/session?token=never-log-this",
      provisioning: false,
      automation: "lux",
      transport: "vnc",
    });
    expect(handle.authorizeAndMint).toHaveBeenCalledWith({
      ...ids,
      signal: expect.any(AbortSignal),
    });

    const tampered = await fetch(`${handle.server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DESKTOP_TIMESTAMP_HEADER]: String(timestamp),
        [DESKTOP_SIGNATURE_HEADER]: signature,
      },
      body: JSON.stringify({ ...ids, actorId: "44444444-4444-4444-8444-444444444444" }),
    });
    expect(tampered.status).toBe(401);
    expect(handle.authorizeAndMint).toHaveBeenCalledTimes(1);

    const staleTimestamp = timestamp - 31;
    const stale = await fetch(`${handle.server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DESKTOP_TIMESTAMP_HEADER]: String(staleTimestamp),
        [DESKTOP_SIGNATURE_HEADER]: signDesktopRequest({
          method: "POST",
          pathname: DESKTOP_REQUEST_PATH,
          timestamp: staleTimestamp,
          rawBody,
        }, hmacSecret),
      },
      body: rawBody,
    });
    expect(stale.status).toBe(401);
    expect(handle.authorizeAndMint).toHaveBeenCalledTimes(1);
  });

  it("rejects extra desktop fields and never logs or returns provider failure details", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const providerSecret = "https://desktop.invalid/?token=provider-secret";
    const authorizeAndMint = vi.fn(async () => {
      throw new Error(providerSecret);
    });
    const handle = await start({ authorizeAndMint });
    const extraBody = Buffer.from(JSON.stringify({ ...ids, boxId: "forbidden" }));
    const timestamp = Math.floor(nowMs / 1_000);
    const extraResponse = await signedDesktop(handle.server, extraBody, timestamp);
    expect(extraResponse.status).toBe(400);
    expect(authorizeAndMint).not.toHaveBeenCalled();

    const validBody = Buffer.from(JSON.stringify(ids));
    const unavailable = await signedDesktop(handle.server, validBody, timestamp);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(providerSecret);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(providerSecret);
  });

  it("rejects a chunked body over the limit with 413 before authorization", async () => {
    const handle = await start();
    const response = await postChunked(`${handle.server.baseUrl}${DESKTOP_REQUEST_PATH}`, [
      Buffer.alloc(2_049, 1),
      Buffer.alloc(2_048, 1),
    ], {
        "Content-Type": "application/json",
        [DESKTOP_TIMESTAMP_HEADER]: String(Math.floor(nowMs / 1_000)),
        [DESKTOP_SIGNATURE_HEADER]: `v1=${"0".repeat(64)}`,
    });
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: "request_too_large" });
    expect(handle.authorizeAndMint).not.toHaveBeenCalled();
  });

  it("fails desktop closed when the disabled runtime has no HMAC secret", async () => {
    const authorizeAndMint = vi.fn();
    const server = createRuntimeHttpServer({
      host: "127.0.0.1",
      port: 0,
      sweepIntervalMs: 2_000,
      desktopHmacSecret: null,
      desktopMaxSkewSeconds: 30,
      health: { ping: async () => undefined, snapshot: healthySnapshot },
      desktop: { authorizeAndMint },
      now: () => nowMs,
    });
    await server.listen();
    openServers.push(server);

    const response = await fetch(`${server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "desktop_not_configured" });
    expect(authorizeAndMint).not.toHaveBeenCalled();
  });
});

function signedDesktop(
  server: RuntimeHttpServer,
  rawBody: Buffer,
  timestamp: number,
): Promise<Response> {
  return fetch(`${server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [DESKTOP_TIMESTAMP_HEADER]: String(timestamp),
      [DESKTOP_SIGNATURE_HEADER]: signDesktopRequest({
        method: "POST",
        pathname: DESKTOP_REQUEST_PATH,
        timestamp,
        rawBody,
      }, hmacSecret),
    },
    body: rawBody,
  });
}

async function postChunked(
  url: string,
  chunks: Buffer[],
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers }, (response) => {
      const body: Buffer[] = [];
      response.on("data", (chunk: Buffer) => body.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(body).toString("utf8"),
      }));
    });
    request.once("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}
