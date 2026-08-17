import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANION_RUNTIME_ERROR_MAX_LENGTH } from "@companion/core";

import {
  AsciiBoxCompanionRuntime,
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
  composeDaemonFailureDetail,
  mintBoxDesktopUrl,
} from "./boxCompanionRuntime";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Box desktop mint", () => {
  it("mints a fresh VNC URL for every join", async () => {
    let sequence = 0;
    const vnc = vi.fn(async () => ({ desktopUrl: `https://desktop.test/vnc/${++sequence}` }));
    const input = {
      vnc,
      webrtc: vi.fn(async () => ({ desktopUrl: "https://desktop.test/webrtc" })),
      budgetMs: 100,
      pause: vi.fn(async () => undefined),
      now: () => 0,
    };

    await expect(mintBoxDesktopUrl(input)).resolves.toEqual({
      url: "https://desktop.test/vnc/1",
      provisioning: false,
      transport: "vnc",
    });
    await expect(mintBoxDesktopUrl(input)).resolves.toEqual({
      url: "https://desktop.test/vnc/2",
      provisioning: false,
      transport: "vnc",
    });
    expect(input.webrtc).not.toHaveBeenCalled();
  });

  it("waits for VNC until its budget is spent, then falls back to WebRTC", async () => {
    let now = 0;
    const pause = vi.fn(async () => { now += 10; });
    const vnc = vi.fn(async () => ({ provisioning: true }));
    const webrtc = vi.fn(async () => ({ url: "https://desktop.test/webrtc" }));

    await expect(mintBoxDesktopUrl({
      vnc,
      webrtc,
      budgetMs: 20,
      pause,
      now: () => now,
    })).resolves.toEqual({
      url: "https://desktop.test/webrtc",
      provisioning: false,
      transport: "webrtc",
    });
    expect(vnc).toHaveBeenCalledTimes(2);
    expect(webrtc).toHaveBeenCalledOnce();
  });

  it("falls back immediately when the provider build refuses VNC", async () => {
    await expect(mintBoxDesktopUrl({
      vnc: async () => {
        throw new BoxRuntimeProviderError("VNC unsupported", 400);
      },
      webrtc: async () => ({ desktopUrl: "https://desktop.test/webrtc" }),
      budgetMs: 100,
      pause: async () => undefined,
    })).resolves.toEqual({
      url: "https://desktop.test/webrtc",
      provisioning: false,
      transport: "webrtc",
    });
  });
});

describe("narrow AsciiBoxCompanionRuntime", () => {
  it("fails closed when the Box service key is absent", () => {
    expect(() => new AsciiBoxCompanionRuntime({})).toThrow(BoxRuntimeConfigurationError);
  });

  it("observes, resumes, archives, updates TTL, and mints desktop without implicit creation", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let state: "archived" | "ready" | "archiving" = "archived";
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      requests.push({ method, url, body });
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box(state) });
      }
      if (url.endsWith("/boxes/bx_23456789/resume") && method === "POST") {
        state = "ready";
        return response({ box: box(state) });
      }
      if (url.endsWith("/boxes/bx_23456789/commands") && method === "POST") {
        return response(commandResult("inactive\ncompanion-pi-broker-unready\n"));
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") return response({ box: box(state) });
      if (url.endsWith("/boxes/bx_23456789/stop") && method === "POST") {
        state = "archiving";
        return response({ box: box(state) });
      }
      if (url.endsWith("/boxes/bx_23456789/desktop?vnc=1") && method === "POST") {
        return response({ desktopUrl: "https://desktop.test/vnc" });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));
    const runtime = runtimeClient();

    await expect(runtime.existingBoxStatus({ boxId: "bx_23456789" })).resolves.toEqual({
      boxId: "bx_23456789",
      state: "archived",
    });
    await expect(runtime.resumeExistingBox({ boxId: "bx_23456789" })).resolves.toMatchObject({
      boxId: "bx_23456789",
      runtimeState: "stopped",
      daemonState: "stopped",
    });
    await runtime.refreshTtl({ boxId: "bx_23456789", ttlSeconds: 21_600 });
    await expect(runtime.desktop({ boxId: "bx_23456789" })).resolves.toEqual({
      url: "https://desktop.test/vnc",
      provisioning: false,
      transport: "vnc",
    });
    await expect(runtime.archiveExistingBox({ boxId: "bx_23456789" })).resolves.toEqual({
      boxId: "bx_23456789",
      state: "archiving",
    });

    expect(requests.some((request) => request.url.endsWith("/boxes") && request.method === "POST"))
      .toBe(false);
    expect(requests.find((request) => request.method === "PATCH")?.body)
      .toEqual({ ttlSeconds: 21_600 });
  });

  it("dispatches only correlated layout-14 commands and validates monotonic journal pages", async () => {
    const commandTypes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_rawUrl: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { command: string };
      const command = decodeBrokerCommand(body.command);
      commandTypes.push(String(command.type));
      const id = String(command.id);
      if (command.type === "prompt") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "prompt",
          success: true,
          data: {
            attemptId: command.attemptId,
            invocationId: "invocation-1",
            piAcknowledged: true,
          },
        }) + "\n"));
      }
      if (command.type === "runtime_state") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "runtime_state",
          success: true,
          data: {
            invocationId: "invocation-1",
            activeAttemptId: "attempt-1",
            tailCursor: 1,
            acknowledgedCursor: 0,
            modelInput: ["text", "image"],
            counters: zeroCounters(),
          },
        }) + "\n"));
      }
      if (command.type === "read_events") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "read_events",
          success: true,
          data: {
            events: [{
              sequence: 1,
              invocationId: "invocation-1",
              attemptId: "attempt-1",
              kind: "pi_event",
              event: { type: "agent_start" },
            }],
            nextCursor: 1,
            acknowledgedCursor: 0,
            hasMore: false,
          },
        }) + "\n"));
      }
      if (command.type === "ack_events") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "ack_events",
          success: true,
          data: { acknowledgedCursor: 1 },
        }) + "\n"));
      }
      throw new Error(`unexpected broker command ${String(command.type)}`);
    }));
    const runtime = runtimeClient();

    await expect(runtime.dispatchPrompt({
      boxId: "bx_23456789",
      attemptId: "attempt-1",
      requestId: "prompt-1",
      message: "do work",
    })).resolves.toEqual({
      outcome: "accepted",
      attemptId: "attempt-1",
      invocationId: "invocation-1",
    });
    await expect(runtime.brokerState({ boxId: "bx_23456789" })).resolves.toMatchObject({
      invocationId: "invocation-1",
      modelInput: ["text", "image"],
    });
    await expect(runtime.readEvents({ boxId: "bx_23456789", after: 0 })).resolves.toMatchObject({
      nextCursor: 1,
      acknowledgedCursor: 0,
      events: [expect.objectContaining({ sequence: 1, attemptId: "attempt-1" })],
    });
    await expect(runtime.ackEvents({ boxId: "bx_23456789", through: 1 })).resolves.toEqual({
      acknowledgedCursor: 1,
    });
    expect(commandTypes).toEqual(["prompt", "runtime_state", "read_events", "ack_events"]);
  });

  it("keeps a lost prompt acknowledgement ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("synthetic transport loss");
    }));
    await expect(runtimeClient().dispatchPrompt({
      boxId: "bx_23456789",
      attemptId: "attempt-ambiguous",
      message: "possibly written",
    })).resolves.toEqual({
      outcome: "ambiguous",
      code: "pi_ack_ambiguous",
      message: "Pi prompt acknowledgement is unavailable",
    });
  });

  it("propagates abort while probing the daemon during Box resume", async () => {
    const controller = new AbortController();
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/boxes/bx_23456789") && (!init?.method || init.method === "GET")) {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/commands") && init?.method === "POST") {
        commandStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const observation = runtime.resumeExistingBox({ boxId: "bx_23456789", signal: controller.signal });
    await started;
    const stopped = new Error("runtime handoff");
    controller.abort(stopped);

    await expect(observation).rejects.toBe(stopped);
  });

  it("propagates abort while reading broker state for Pi status", async () => {
    const controller = new AbortController();
    let brokerStarted!: () => void;
    const started = new Promise<void>((resolve) => { brokerStarted = resolve; });
    let commandCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/commands") && init?.method === "POST") {
        commandCount += 1;
        if (commandCount === 1) {
          return response({
            success: true,
            exitCode: 0,
            stdout: "active\ncompanion-pi-broker-ready\n",
            stderr: "",
          });
        }
        brokerStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const status = runtime.piDaemonStatus({ boxId: "bx_23456789", signal: controller.signal });
    await started;
    const stopped = new Error("runtime handoff");
    controller.abort(stopped);

    await expect(status).rejects.toBe(stopped);
  });
});

describe("bounded daemon diagnostics", () => {
  it("keeps a stable, one-line failure inside the persistence limit", () => {
    const detail = composeDaemonFailureDetail([
      "companion-pi-state failed",
      "companion-pi-status Active: failed (Result: exit-code)",
      "companion-pi-restarts 123456",
      `companion-pi-stderr ${"x".repeat(500)}`,
    ].join("\n"));
    expect(detail).not.toContain("\n");
    expect(`Pi daemon is not running after start${detail}`.length)
      .toBeLessThanOrEqual(COMPANION_RUNTIME_ERROR_MAX_LENGTH);
  });
});

function runtimeClient(): AsciiBoxCompanionRuntime {
  return new AsciiBoxCompanionRuntime({
    COMPANION_BOX_API_KEY: "box_test",
    COMPANION_BOX_POLL_INTERVAL_MS: "1",
    COMPANION_BOX_READY_TIMEOUT_MS: "100",
    COMPANION_BOX_DESKTOP_MINT_BUDGET_MS: "10",
  });
}

function box(state: "archived" | "ready" | "archiving") {
  return {
    id: "bx_23456789",
    name: "Companion 11111111-1111-4111-8111-111111111111 g1",
    state,
    desktopAvailable: state === "ready",
    setupStatus: "done",
  };
}

function commandResult(stdout = "") {
  return { success: true, exitCode: 0, stdout, stderr: "" };
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function decodeBrokerCommand(command: string): Record<string, unknown> {
  const encoded = /COMPANION_PI_BROKER_COMMAND='([A-Za-z0-9+/=]+)'/.exec(command)?.[1];
  if (!encoded) throw new Error("adapter did not send a layout-14 broker command");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
}

function zeroCounters() {
  return {
    malformedLines: 0,
    oversizedLines: 0,
    unterminatedLines: 0,
    unknownEvents: 0,
    unboundEvents: 0,
    orphanResponses: 0,
  };
}
