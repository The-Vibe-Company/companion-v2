import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- Test fixtures narrow live HTTP server addresses and JSON bodies the same way the broker source test does. */
import {
  COMPANION_BOX_AGENT_AUTH_BAN_MS,
  COMPANION_BOX_AGENT_AUTH_FAILURE_LIMIT,
  COMPANION_BOX_AGENT_LONG_POLL_CAP_MS,
  COMPANION_BOX_AGENT_MAX_BODY_BYTES,
  COMPANION_BOX_AGENT_VERSION,
  CompanionBoxAgentCore,
  bearerMatchesAuthFile,
  sanitizePiUnitState,
  startCompanionBoxAgentServer,
  type CompanionBoxAgentRequest,
  type CompanionBoxAgentSeams,
} from "./companionBoxAgentCore";
import { COMPANION_BOX_AGENT_SOURCE } from "./companionBoxAgentSource";

const BEARER = "a".repeat(64);
const BEARER_SHA256 = createHash("sha256").update(BEARER, "utf8").digest("hex");
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";

const processes: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(processes.splice(0).map(async (child) => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface FakeAgent {
  core: CompanionBoxAgentCore;
  seams: CompanionBoxAgentSeams & { brokerCommand: Mock };
  now(): number;
  advance(ms: number): void;
}

function fakeAgent(
  overrides: Partial<Omit<CompanionBoxAgentSeams, "brokerCommand">> & { brokerCommand?: Mock } = {},
): FakeAgent {
  let nowMs = 1_000_000;
  const seams: CompanionBoxAgentSeams & { brokerCommand: Mock } = {
    brokerCommand: vi.fn(async (command: { id: string; type: string }) => ({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: { echoed: command.type },
    })),
    piUnitState: async () => "active",
    readAuthFile: () => JSON.stringify({ tokenSha256: BEARER_SHA256 }),
    brokerSocketReady: () => true,
    readLayoutMarker: () => "14:pkgs:overlay=abcdef",
    uploadAttachment: () => undefined,
    commitAttachments: ({ files }) => files,
    clearOutbox: () => undefined,
    listOutbox: () => [],
    readOutbox: () => { throw new Error("missing outbox fixture"); },
    now: () => nowMs,
    // Sleeping advances the fake clock so long-poll deadlines resolve deterministically.
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    ...overrides,
  };
  return {
    core: new CompanionBoxAgentCore(seams),
    seams,
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

function request(overrides: Partial<CompanionBoxAgentRequest> = {}): CompanionBoxAgentRequest {
  return {
    method: "GET",
    url: "/v1/health",
    authorization: `Bearer ${BEARER}`,
    remoteAddress: "10.0.0.1",
    body: null,
    ...overrides,
  };
}

describe("bearerMatchesAuthFile", () => {
  it("accepts only the exact bearer whose sha256 the auth file stores", () => {
    const file = JSON.stringify({ tokenSha256: BEARER_SHA256 });
    expect(bearerMatchesAuthFile(`Bearer ${BEARER}`, file)).toBe(true);
    expect(bearerMatchesAuthFile(`bearer ${BEARER}`, file)).toBe(false);
    expect(bearerMatchesAuthFile(`Bearer ${BEARER.slice(0, 63)}b`, file)).toBe(false);
    expect(bearerMatchesAuthFile(`Bearer ${BEARER} extra`, file)).toBe(false);
    expect(bearerMatchesAuthFile(BEARER, file)).toBe(false);
    expect(bearerMatchesAuthFile(null, file)).toBe(false);
  });

  it("fails closed on a missing, malformed, or non-digest auth file", () => {
    expect(bearerMatchesAuthFile(`Bearer ${BEARER}`, null)).toBe(false);
    expect(bearerMatchesAuthFile(`Bearer ${BEARER}`, "not json")).toBe(false);
    expect(bearerMatchesAuthFile(`Bearer ${BEARER}`, JSON.stringify({}))).toBe(false);
    expect(bearerMatchesAuthFile(`Bearer ${BEARER}`, JSON.stringify({ tokenSha256: "xyz" }))).toBe(false);
    expect(bearerMatchesAuthFile(
      `Bearer ${BEARER}`,
      JSON.stringify({ tokenSha256: BEARER_SHA256.toUpperCase() }),
    )).toBe(false);
  });
});

describe("sanitizePiUnitState", () => {
  it("keeps only a bare systemd verdict", () => {
    expect(sanitizePiUnitState("active\n")).toBe("active");
    expect(sanitizePiUnitState("inactive")).toBe("inactive");
    expect(sanitizePiUnitState("Failed with result 'exit-code'")).toBe("unknown");
    expect(sanitizePiUnitState("")).toBe("unknown");
  });
});

describe("CompanionBoxAgentCore auth and rate limiting", () => {
  it("rejects every route without a valid bearer and never calls the broker", async () => {
    const agent = fakeAgent();
    for (const url of ["/v1/health", "/v1/broker/state", "/v1/events", "/v1/ack"]) {
      const result = await agent.core.handle(request({ url, authorization: null }));
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: { code: "unauthorized" } });
    }
    expect(agent.seams.brokerCommand).not.toHaveBeenCalled();
  });

  it("bans a client after repeated failures and lifts the ban when it expires", async () => {
    const agent = fakeAgent();
    for (let attempt = 0; attempt < COMPANION_BOX_AGENT_AUTH_FAILURE_LIMIT; attempt += 1) {
      const result = await agent.core.handle(request({ authorization: "Bearer wrong-token" }));
      expect(result.status).toBe(401);
    }
    const banned = await agent.core.handle(request());
    expect(banned.status).toBe(429);
    expect(banned.body).toMatchObject({ error: { code: "rate_limited" } });

    agent.advance(COMPANION_BOX_AGENT_AUTH_BAN_MS + 1);
    const recovered = await agent.core.handle(request());
    expect(recovered.status).toBe(200);
  });

  it("does not ban a second client for the first client's failures", async () => {
    const agent = fakeAgent();
    for (let attempt = 0; attempt < COMPANION_BOX_AGENT_AUTH_FAILURE_LIMIT; attempt += 1) {
      await agent.core.handle(request({ authorization: null, remoteAddress: "10.0.0.9" }));
    }
    const other = await agent.core.handle(request({ remoteAddress: "10.0.0.2" }));
    expect(other.status).toBe(200);
  });
});

describe("CompanionBoxAgentCore routes", () => {
  it("answers health from local observations without touching the broker socket", async () => {
    const agent = fakeAgent({ piUnitState: async () => "inactive\n" });
    const result = await agent.core.handle(request());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      agentVersion: COMPANION_BOX_AGENT_VERSION,
      piUnit: "inactive",
      brokerSocketReady: true,
      layoutMarker: "14:pkgs:overlay=abcdef",
    });
    expect(agent.seams.brokerCommand).not.toHaveBeenCalled();
  });

  it("forwards broker state and returns the broker data verbatim", async () => {
    const agent = fakeAgent();
    const result = await agent.core.handle(request({ url: "/v1/broker/state" }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ echoed: "runtime_state" });
    expect(agent.seams.brokerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "runtime_state" }),
    );
  });

  it("maps a broker error response to 502 with its stable code", async () => {
    const agent = fakeAgent({
      brokerCommand: vi.fn(async () => ({
        type: "response",
        success: false,
        error: { code: "pi_not_idle", message: "Pi is not idle with an empty queue", ambiguous: false },
      })),
    });
    const result = await agent.core.handle(request({ url: "/v1/broker/state" }));
    expect(result.status).toBe(502);
    expect(result.body).toEqual({
      error: { code: "pi_not_idle", message: "Pi is not idle with an empty queue", ambiguous: false },
    });
  });

  it("maps a broker transport failure to 503 broker_unavailable", async () => {
    const agent = fakeAgent({
      brokerCommand: vi.fn(async () => {
        throw new Error("connect ENOENT");
      }),
    });
    const result = await agent.core.handle(request({ url: "/v1/broker/state" }));
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { code: "broker_unavailable" } });
  });

  it("rejects invalid event query parameters", async () => {
    const agent = fakeAgent();
    for (const url of [
      "/v1/events?after=-1",
      "/v1/events?after=nope",
      "/v1/events?limit=0",
      "/v1/events?limit=257",
      "/v1/events?wait_ms=abc",
    ]) {
      const result = await agent.core.handle(request({ url }));
      expect(result.status, url).toBe(400);
    }
    expect(agent.seams.brokerCommand).not.toHaveBeenCalled();
  });

  it("long-polls an empty journal and returns as soon as a page is non-empty", async () => {
    let reads = 0;
    const agent = fakeAgent({
      brokerCommand: vi.fn(async (command: { id: string; type: string }) => {
        reads += 1;
        return {
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: reads < 3
            ? { events: [], nextCursor: 0, acknowledgedCursor: 0, hasMore: false }
            : { events: [{ sequence: 1 }], nextCursor: 1, acknowledgedCursor: 0, hasMore: false },
        };
      }),
    });
    const start = agent.now();
    const result = await agent.core.handle(request({ url: "/v1/events?after=0&wait_ms=5000" }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ events: [{ sequence: 1 }], nextCursor: 1 });
    expect(reads).toBe(3);
    // Two empty pages cost exactly two poll intervals, far below the requested wait.
    expect(agent.now() - start).toBe(400);
  });

  it("caps wait_ms at the proxy-safe long-poll ceiling", async () => {
    const agent = fakeAgent({
      brokerCommand: vi.fn(async (command: { id: string; type: string }) => ({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: { events: [], nextCursor: 0, acknowledgedCursor: 0, hasMore: false },
      })),
    });
    const start = agent.now();
    const result = await agent.core.handle(request({ url: "/v1/events?after=0&wait_ms=999999999" }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ events: [] });
    expect(agent.now() - start).toBe(COMPANION_BOX_AGENT_LONG_POLL_CAP_MS);
  });

  it("forwards acknowledgements and validates the cursor body", async () => {
    const agent = fakeAgent();
    const ok = await agent.core.handle(request({
      method: "POST",
      url: "/v1/ack",
      body: Buffer.from(JSON.stringify({ through: 7 })),
    }));
    expect(ok.status).toBe(200);
    expect(agent.seams.brokerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ack_events", through: 7 }),
    );

    for (const body of [null, Buffer.from("nope"), Buffer.from(JSON.stringify({ through: -1 }))]) {
      const bad = await agent.core.handle(request({ method: "POST", url: "/v1/ack", body }));
      expect(bad.status).toBe(400);
    }
  });

  it("preserves durable command identity for prompt resolution and control writes", async () => {
    const agent = fakeAgent();
    const prompt = await agent.core.handle(request({
      method: "POST",
      url: "/v1/prompt",
      body: Buffer.from(JSON.stringify({
        commandId: "command-1",
        attemptId: "attempt-1",
        expectedInvocationId: "inv-1",
        message: "hello",
      })),
    }));
    expect(prompt.status).toBe(200);
    expect(agent.seams.brokerCommand).toHaveBeenLastCalledWith({
      id: "command-1",
      type: "prompt",
      attemptId: "attempt-1",
      expectedInvocationId: "inv-1",
      message: "hello",
      requiredInput: ["text"],
      clearOutbox: true,
    });

    await agent.core.handle(request({
      url: "/v1/dispatch/status?attempt_id=attempt-1&command_id=command-1",
    }));
    expect(agent.seams.brokerCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "dispatch_status",
      attemptId: "attempt-1",
      commandId: "command-1",
    }));

    await agent.core.handle(request({
      method: "POST",
      url: "/v1/abort",
      body: Buffer.from(JSON.stringify({ commandId: "abort-1", attemptId: "attempt-1" })),
    }));
    expect(agent.seams.brokerCommand).toHaveBeenLastCalledWith({
      id: "abort-1",
      type: "abort",
      attemptId: "attempt-1",
    });

    await agent.core.handle(request({
      method: "POST",
      url: "/v1/decision",
      body: Buffer.from(JSON.stringify({
        commandId: "decision-1",
        attemptId: "attempt-1",
        response: { answer: "yes" },
      })),
    }));
    expect(agent.seams.brokerCommand).toHaveBeenLastCalledWith({
      id: "decision-1",
      type: "extension_ui_response",
      attemptId: "attempt-1",
      response: { answer: "yes" },
    });
  });

  it("stages attachment bytes by digest and commits only a validated manifest", async () => {
    const bytes = Buffer.from("direct attachment");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uploadAttachment = vi.fn();
    const commitAttachments = vi.fn(({ files }) => files);
    const agent = fakeAgent({ uploadAttachment, commitAttachments });

    const uploaded = await agent.core.handle(request({
      method: "PUT",
      url: `/v1/files?message_id=${MESSAGE_ID}&position=0&sha256=${sha256}`,
      body: bytes,
    }));
    expect(uploaded.status).toBe(200);
    expect(uploadAttachment).toHaveBeenCalledWith({
      messageId: MESSAGE_ID,
      position: 0,
      sha256,
      bytes,
    });

    const manifest = {
      files: [{
        position: 0,
        filename: "notes.txt",
        contentType: "text/plain",
        byteSize: bytes.byteLength,
        sha256,
      }],
    };
    const committed = await agent.core.handle(request({
      method: "POST",
      url: `/v1/attachments/${MESSAGE_ID}`,
      body: Buffer.from(JSON.stringify(manifest)),
    }));
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({
      files: [{ path: `~/attachments/${MESSAGE_ID}/0-notes.txt`, sha256 }],
    });

    const mismatched = await agent.core.handle(request({
      method: "PUT",
      url: `/v1/files?message_id=${MESSAGE_ID}&position=0&sha256=${"0".repeat(64)}`,
      body: bytes,
    }));
    expect(mismatched.status).toBe(409);
  });

  it("lists, reads, and clears only the bounded outbox surface", async () => {
    const bytes = Buffer.from("image bytes");
    const encodedName = Buffer.from("answer.png").toString("base64");
    const entry = {
      name: "answer.png",
      encodedName,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const clearOutbox = vi.fn();
    const agent = fakeAgent({
      clearOutbox,
      listOutbox: () => [entry],
      readOutbox: () => ({ entry, bytes }),
    });

    const listed = await agent.core.handle(request({ url: "/v1/outbox" }));
    expect(listed.body).toEqual({ entries: [entry] });
    const read = await agent.core.handle(request({
      url: `/v1/outbox/file?name=${encodeURIComponent(encodedName)}`,
    }));
    expect(read.status).toBe(200);
    expect(read.rawBody).toEqual(bytes);
    const cleared = await agent.core.handle(request({ method: "POST", url: "/v1/outbox/clear" }));
    expect(cleared.body).toEqual({ cleared: true });
    expect(clearOutbox).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for unknown routes and 405 for wrong methods", async () => {
    const agent = fakeAgent();
    expect((await agent.core.handle(request({ url: "/v1/exec" }))).status).toBe(404);
    expect((await agent.core.handle(request({ url: "/v1/prompt" }))).status).toBe(405);
    expect((await agent.core.handle(request({ method: "POST" }))).status).toBe(405);
    expect((await agent.core.handle(request({ url: "/v1/ack" }))).status).toBe(405);
  });

  it("rejects a body above the agent limit", async () => {
    const agent = fakeAgent();
    const result = await agent.core.handle(request({
      method: "POST",
      url: "/v1/ack",
      body: Buffer.alloc(COMPANION_BOX_AGENT_MAX_BODY_BYTES + 1),
    }));
    expect(result.status).toBe(413);
    expect(agent.seams.brokerCommand).not.toHaveBeenCalled();
  });
});

describe("startCompanionBoxAgentServer", () => {
  it("serves the core over HTTP with the bearer gate intact", async () => {
    const agent = fakeAgent();
    const server = await startCompanionBoxAgentServer({
      core: agent.core,
      port: 0,
      host: "127.0.0.1",
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a bound port");
      const base = `http://127.0.0.1:${address.port}`;
      const denied = await fetch(`${base}/v1/health`);
      expect(denied.status).toBe(401);
      const health = await fetch(`${base}/v1/health`, {
        headers: { authorization: `Bearer ${BEARER}` },
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ agentVersion: COMPANION_BOX_AGENT_VERSION });
      const oversized = await fetch(`${base}/v1/ack`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}` },
        body: "x".repeat(COMPANION_BOX_AGENT_MAX_BODY_BYTES + 1),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
    }
  });
});

describe("COMPANION_BOX_AGENT_SOURCE", () => {
  it("retains only Node built-in imports", () => {
    const imports = [
      ...[...COMPANION_BOX_AGENT_SOURCE.matchAll(/\bfrom\s*["']([^"']+)["']/g)]
        .flatMap((match) => match[1] ? [match[1]] : []),
      ...[...COMPANION_BOX_AGENT_SOURCE.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)]
        .flatMap((match) => match[1] ? [match[1]] : []),
      ...[...COMPANION_BOX_AGENT_SOURCE.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g)]
        .flatMap((match) => match[1] ? [match[1]] : []),
    ];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith("node:"))).toBe(true);
  });

  it("runs the staged ESM and fails closed without the auth file", async () => {
    const home = mkdtempSync(join(tmpdir(), "box-agent-source-"));
    directories.push(home);
    mkdirSync(join(home, ".companion", "runtime", "state"), { recursive: true });
    writeFileSync(join(home, ".companion", "runtime", "state", "pi-layout.version"), "14:test\n");
    const agentPath = join(home, "companion-box-agent.mjs");
    writeFileSync(agentPath, COMPANION_BOX_AGENT_SOURCE);
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = spawn(process.execPath, [agentPath], {
      env: {
        ...process.env,
        HOME: home,
        COMPANION_AGENT_PORT: port.toString(10),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10_000;
    let denied: Response | null = null;
    for (;;) {
      try {
        denied = await fetch(`${base}/v1/health`);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("agent never started listening");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    // No agent-auth.json staged yet: the daemon is up but every request fails closed.
    expect(denied.status).toBe(401);

    writeFileSync(
      join(home, ".companion", "runtime", "state", "agent-auth.json"),
      JSON.stringify({ tokenSha256: BEARER_SHA256 }),
    );
    const health = await fetch(`${base}/v1/health`, {
      headers: { authorization: `Bearer ${BEARER}` },
    });
    expect(health.status).toBe(200);
    const body = await health.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      agentVersion: COMPANION_BOX_AGENT_VERSION,
      brokerSocketReady: false,
      layoutMarker: "14:test",
    });
  });
});
