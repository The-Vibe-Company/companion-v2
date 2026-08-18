import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  CompanionCanaryError,
  loadCompanionCanaryConfig,
  runCompanionRuntimeCanary,
} from "./companion-runtime-canary.mjs";

const COMPANION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_IDS = [
  "22222222-2222-4222-8222-222222222221",
  "22222222-2222-4222-8222-222222222222",
  "22222222-2222-4222-8222-222222222223",
];
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";

function environment(overrides = {}) {
  return {
    COMPANION_CANARY_API_URL: "https://companion.example.test",
    COMPANION_CANARY_EMAIL: "canary@example.test",
    COMPANION_CANARY_PASSWORD: "super-secret-password",
    COMPANION_CANARY_ORG_ID: "44444444-4444-4444-8444-444444444444",
    COMPANION_CANARY_PROVIDER_ID: "anthropic",
    COMPANION_CANARY_MODEL_ID: "claude-opus-4-8",
    COMPANION_CANARY_IMAGE_URL: "https://companion.example.test/canary/vision-fixture.png",
    COMPANION_CANARY_IMAGE_EXPECTED_TEXT: "PIXEL_PROOF_7K4M",
    COMPANION_CANARY_RELEASE_ID: "production-2026-08-17.3",
    GITHUB_RUN_ID: "98765",
    GITHUB_RUN_ATTEMPT: "2",
    ...overrides,
  };
}

function fastConfig(overrides = {}) {
  return {
    ...loadCompanionCanaryConfig(environment()),
    pollIntervalMs: 1,
    requestTimeoutMs: 1_000,
    coldReplyTimeoutMs: 100,
    hotReplyTimeoutMs: 100,
    lifecycleTimeoutMs: 100,
    ...overrides,
  };
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (milliseconds) => { value += milliseconds; },
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockCanaryApi(config, options = {}) {
  const calls = [];
  const messages = [];
  let deleted = false;
  let stopped = false;
  let threadFailures = options.threadFailures ?? 0;

  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, headers, body });

    if (url.toString() === config.imageUrl) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (url.pathname === "/health") {
      assert.equal(headers.get("x-companion-org"), null);
      return jsonResponse({ ok: true, release_id: options.releaseId ?? config.releaseId });
    }
    if (url.pathname === "/v1/auth/login") {
      assert.equal(headers.get("x-companion-org"), null);
      return jsonResponse(
        { user: { id: "canary" } },
        200,
        { "set-cookie": "better-auth.session_token=in-memory-only; Path=/; HttpOnly" },
      );
    }

    assert.equal(headers.get("x-companion-org"), config.orgId);
    assert.match(headers.get("cookie") ?? "", /better-auth\.session_token=in-memory-only/);

    if (url.pathname === "/v1/companions" && method === "POST") {
      if (options.invalidCreateResponse) return jsonResponse({}, 201);
      return jsonResponse({
        companion: {
          id: COMPANION_ID,
          name: body.name,
          runtime: {
            state: "not_created",
            ...(options.missingGeneration ? {} : { generation: options.generation ?? 1 }),
          },
        },
      }, 201);
    }
    if (url.pathname === "/v1/companions" && method === "GET") {
      return jsonResponse({
        companions: deleted ? [] : [{ id: COMPANION_ID, name: `Runtime canary ${config.runLabel}` }],
      });
    }
    if (url.pathname.endsWith("/messages") && method === "POST") {
      messages.push(body);
      return jsonResponse({ turn: { id: TURN_IDS[messages.length - 1] }, thread: {} }, 202);
    }
    if (url.pathname.endsWith("/thread") && method === "GET") {
      if (threadFailures > 0) {
        threadFailures -= 1;
        return jsonResponse({ error: "temporary_failure" }, 500);
      }
      const entries = messages.flatMap((message, index) => {
        const correlation = /CANARY_[A-Z]+_[A-F0-9]+/.exec(message.content)?.[0] ?? "missing";
        const user = {
          event_id: `msg:${message.client_message_id}`,
          ordinal: index * 2 + 1,
          role: "user",
          content: message.content,
        };
        return options.neverReply
          ? [user]
          : [user, {
            event_id: `reply:${index}`,
            ordinal: index * 2 + 2,
            role: "assistant",
            content: `${correlation} ${index === 1 && !options.omitVisionExpected
              ? `${config.imageExpectedText} `
              : ""}verified`,
          }];
      });
      return jsonResponse({
        thread: {
          entries,
          active_turn: options.neverReply ? { id: TURN_IDS[messages.length - 1] } : null,
          interrupted_turn: null,
          queued_count: 0,
        },
      });
    }
    if (url.pathname.endsWith("/runtime/stop") && method === "POST") {
      assert.match(headers.get("idempotency-key") ?? "", /^[0-9a-f-]{36}$/i);
      stopped = true;
      return jsonResponse({ operation: { id: OPERATION_ID, kind: "stop" } }, 202);
    }
    if (url.pathname.endsWith("/runtime") && method === "GET") {
      return jsonResponse({
        companion: { id: COMPANION_ID, runtime: { state: stopped ? "stopped" : "running" } },
      });
    }
    if (url.pathname === `/v1/companions/${COMPANION_ID}` && method === "DELETE") {
      assert.match(headers.get("idempotency-key") ?? "", /^[0-9a-f-]{36}$/i);
      deleted = true;
      if (options.deleteAlreadyAbsent) return jsonResponse({ error: "not_found" }, 404);
      return jsonResponse({ operation: { id: OPERATION_ID, kind: "delete" } }, 202);
    }
    if (url.pathname === `/v1/companions/${COMPANION_ID}` && method === "GET") {
      return deleted
        ? jsonResponse({ error: "not_found" }, 404)
        : jsonResponse({ companion: { id: COMPANION_ID, runtime: { state: "running" } } });
    }
    throw new Error(`unexpected mocked request: ${method} ${url.pathname}`);
  };

  return { fetch, calls, messages, wasDeleted: () => deleted };
}

test("missing production configuration is explicitly not configured", () => {
  assert.throws(
    () => loadCompanionCanaryConfig({}),
    (error) => error instanceof CompanionCanaryError && error.code === "missing_configuration",
  );
});

test("configuration resolves the public image fixture without exposing credentials", () => {
  const config = loadCompanionCanaryConfig(environment());
  assert.equal(config.imageUrl, "https://companion.example.test/canary/vision-fixture.png");
  assert.equal(config.imageExpectedText, "PIXEL_PROOF_7K4M");
  assert.equal(config.runLabel, "98765-2");
  assert.equal(config.releaseId, "production-2026-08-17.3");
  assert.throws(
    () => loadCompanionCanaryConfig(environment({ COMPANION_CANARY_IMAGE_URL: "" })),
    (error) => error instanceof CompanionCanaryError && error.code === "missing_configuration",
  );
  for (const imageUrl of [
    "https://cdn.example.test/PIXEL_PROOF_7K4M.png",
    "https://cdn.example.test/%50%49%58%45%4c_%50%52%4f%4f%46_%37%4b%34%4d.png",
    `https://cdn.example.test/${encodeURIComponent(encodeURIComponent(encodeURIComponent(
      "%50%49%58%45%4c_%50%52%4f%4f%46_%37%4b%34%4d",
    )))}.png`,
    "https://cdn.example.test/%not-an-escape.png",
  ]) {
    assert.throws(
      () => loadCompanionCanaryConfig(environment({ COMPANION_CANARY_IMAGE_URL: imageUrl })),
      (error) => error instanceof CompanionCanaryError && error.code === "invalid_configuration",
    );
  }
  const manualEnvironment = environment({
    GITHUB_RUN_ID: undefined,
    GITHUB_RUN_ATTEMPT: undefined,
  });
  const labels = [
    loadCompanionCanaryConfig(manualEnvironment, { randomUUID: () => "manual-a" }).runLabel,
    loadCompanionCanaryConfig(manualEnvironment, { randomUUID: () => "manual-b" }).runLabel,
  ];
  assert.deepEqual(labels, ["manual-manual-a-1", "manual-manual-b-1"]);
  assert.notEqual(labels[0], labels[1]);
  assert.throws(
    () => loadCompanionCanaryConfig(environment({
      COMPANION_CANARY_IMAGE_URL: "https://cdn.example.test/image.png?token=must-not-persist",
    })),
    (error) => error instanceof CompanionCanaryError && error.code === "invalid_configuration",
  );
  for (const sentinel of ["unknown", "local-development"]) {
    assert.throws(
      () => loadCompanionCanaryConfig(environment({ COMPANION_CANARY_RELEASE_ID: sentinel })),
      (error) => error instanceof CompanionCanaryError && error.code === "invalid_configuration",
    );
  }
});

test("runs cold reply, vision, stop, wake-on-send, and permanent cleanup over the API", async () => {
  const config = fastConfig();
  const api = mockCanaryApi(config);
  const events = [];
  let clock = 0;
  const report = await runCompanionRuntimeCanary(config, {
    fetch: api.fetch,
    randomUUID,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    logger: (event) => events.push(event),
  });

  assert.equal(report.status, "succeeded");
  assert.equal(report.cleanup, "not_needed");
  assert.equal(report.generation, 1);
  assert.equal(api.wasDeleted(), true);
  assert.equal(api.messages.length, 3);
  assert.match(api.messages[1].content, /use the read tool/i);
  assert.match(api.messages[1].content, /canary\/vision-fixture\.png/);
  assert.doesNotMatch(api.messages[1].content, new RegExp(config.imageExpectedText));
  assert.deepEqual(
    events
      .filter((event) => event.status === "succeeded" && event.phase !== "canary")
      .map((event) => event.phase),
    ["release", "login", "create", "cold_send", "image_fixture", "vision", "stop", "wake_send", "delete"],
  );

  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(config.email), false);
  assert.equal(serialized.includes(config.password), false);
  assert.equal(serialized.includes(config.apiUrl), false);
  assert.equal(serialized.includes(config.imageUrl), false);
  assert.equal(serialized.includes(config.imageExpectedText), false);
});

test("vision cannot pass by echoing only the correlation marker", async () => {
  const config = fastConfig();
  const api = mockCanaryApi(config, { omitVisionExpected: true });
  const clock = fakeClock();
  const report = await runCompanionRuntimeCanary(config, {
    fetch: api.fetch,
    randomUUID,
    ...clock,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.code, "uncorrelated_or_failed_reply");
  assert.equal(report.cleanup, "succeeded");
  assert.equal(api.wasDeleted(), true);
});

test("a canary checkout cannot be attributed to a different deployed release", async () => {
  const config = fastConfig();
  const api = mockCanaryApi(config, { releaseId: "previous-production-release" });
  const clock = fakeClock();
  const report = await runCompanionRuntimeCanary(config, {
    fetch: api.fetch,
    randomUUID,
    ...clock,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.code, "release_mismatch");
  assert.equal(report.release_id, config.releaseId);
});

test("a failed phase still permanently deletes the disposable Companion in finally", async () => {
  const config = fastConfig();
  const api = mockCanaryApi(config, { threadFailures: 1 });
  const events = [];
  const clock = fakeClock();
  const report = await runCompanionRuntimeCanary(config, {
    fetch: api.fetch,
    randomUUID,
    ...clock,
    logger: (event) => events.push(event),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.code, "http_500");
  assert.equal(report.cleanup, "succeeded");
  assert.equal(api.wasDeleted(), true);
  assert.ok(events.some((event) => event.phase === "cleanup" && event.status === "succeeded"));
});

test("cleanup recovers the exact run-named Companion when create acknowledgement is malformed", async () => {
  const config = fastConfig();
  const api = mockCanaryApi(config, { invalidCreateResponse: true });
  const clock = fakeClock();
  const report = await runCompanionRuntimeCanary(config, {
    fetch: api.fetch,
    randomUUID,
    ...clock,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.code, "create_failed");
  assert.equal(report.cleanup, "succeeded");
  assert.equal(api.wasDeleted(), true);
});

test("a green canary requires a positive runtime generation and still cleans up", async () => {
  const config = fastConfig();
  const api = mockCanaryApi(config, { missingGeneration: true });
  const clock = fakeClock();
  const report = await runCompanionRuntimeCanary(config, {
    fetch: api.fetch,
    randomUUID,
    ...clock,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.code, "invalid_runtime_generation");
  assert.equal(report.generation, null);
  assert.equal(report.cleanup, "succeeded");
  assert.equal(api.wasDeleted(), true);
});

test("cleanup treats an already absent Companion as successfully deleted", async () => {
  const config = fastConfig();
  const api = mockCanaryApi(config, { invalidCreateResponse: true, deleteAlreadyAbsent: true });
  const clock = fakeClock();
  const report = await runCompanionRuntimeCanary(config, {
    fetch: api.fetch,
    randomUUID,
    ...clock,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.code, "create_failed");
  assert.equal(report.cleanup, "succeeded");
  assert.equal(api.wasDeleted(), true);
});

test("a silent active turn reaches the reply deadline with the advancing fake clock", async () => {
  const config = fastConfig({ coldReplyTimeoutMs: 3 });
  const api = mockCanaryApi(config, { neverReply: true });
  const clock = fakeClock();
  const report = await runCompanionRuntimeCanary(config, {
    fetch: api.fetch,
    randomUUID,
    ...clock,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.code, "reply_timeout");
  assert.equal(report.cleanup, "succeeded");
  assert.equal(api.wasDeleted(), true);
});
