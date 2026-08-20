import assert from "node:assert/strict";
import test from "node:test";

import {
  BoxProviderE2EError,
  loadBoxProviderE2EConfig,
  runBoxProviderE2E,
} from "./box-provider-e2e.mjs";

const BOX_ID = "bx_23456789";
const OPERATION_ID = "bdop_0123456789abcdef0123456789abcdef";
const API_KEY = "box-secret-that-must-not-be-logged";

function environment(overrides = {}) {
  return {
    COMPANION_BOX_API_KEY: API_KEY,
    COMPANION_BOX_E2E_API_BASE: "https://ascii.dev/api/box/v1",
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    ...loadBoxProviderE2EConfig(environment()),
    requestTimeoutMs: 1_000,
    readyTimeoutMs: 100,
    archiveTimeoutMs: 100,
    pollIntervalMs: 1,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (milliseconds) => { value += milliseconds; },
  };
}

function mockProvider(options = {}) {
  const calls = [];
  let state = "provisioning";
  let readyPolls = 0;
  let commandCount = 0;
  let deleted = false;

  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, headers, body });
    assert.equal(headers.get("authorization"), `Bearer ${API_KEY}`);

    if (url.pathname === "/api/box/v1/boxes" && method === "POST") {
      return jsonResponse({
        ok: true,
        type: "box.created",
        status: "provisioning",
        ttlSeconds: 300,
        box: { id: BOX_ID, state },
      }, 202);
    }
    if (url.pathname === `/api/box/v1/boxes/${BOX_ID}` && method === "GET") {
      if (deleted) return jsonResponse({ code: "box_not_found" }, 404);
      if (state === "provisioning") {
        readyPolls += 1;
        if (readyPolls >= 2) state = "ready";
      } else if (state === "archiving") {
        state = "archived";
      } else if (state === "cloning") {
        state = "ready";
      }
      return jsonResponse({ ok: true, type: "box.info", box: { id: BOX_ID, state } });
    }
    if (url.pathname.endsWith("/commands") && method === "POST") {
      commandCount += 1;
      if (options.failFirstCommand && commandCount === 1) {
        return jsonResponse({ success: false, exitCode: 1, stdout: "", stderr: API_KEY });
      }
      const marker = commandCount === 1
        ? "box-provider-e2e-prepared"
        : "box-provider-e2e-restored";
      return jsonResponse({ ok: true, type: "command.finished", success: true, exitCode: 0, stdout: `${marker}\n`, stderr: "" });
    }
    if (url.pathname.endsWith("/stop") && method === "POST") {
      state = "archiving";
      return jsonResponse({ ok: true, type: "box.stopping", box: { id: BOX_ID, state } }, 202);
    }
    if (url.pathname.endsWith("/resume") && method === "POST") {
      state = "cloning";
      return jsonResponse({ ok: true, type: "box.resuming", box: { id: BOX_ID, state } }, 202);
    }
    if (url.pathname === `/api/box/v1/boxes/${BOX_ID}` && method === "DELETE") {
      assert.equal(headers.get("x-ascii-confirm-delete"), BOX_ID);
      deleted = true;
      return jsonResponse({
        ok: true,
        type: "box.deleting",
        operation: { id: OPERATION_ID, targetId: BOX_ID, status: "pending" },
      }, 202);
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  };

  return { fetch, calls, wasDeleted: () => deleted };
}

test("requires a dedicated Box credential and validates optional provider configuration", () => {
  assert.throws(
    () => loadBoxProviderE2EConfig({}),
    (error) => error instanceof BoxProviderE2EError && error.code === "missing_configuration",
  );
  assert.throws(
    () => loadBoxProviderE2EConfig(environment({ COMPANION_BOX_E2E_API_BASE: "http://ascii.dev" })),
    (error) => error instanceof BoxProviderE2EError && error.code === "invalid_configuration",
  );
  assert.throws(
    () => loadBoxProviderE2EConfig(environment({ COMPANION_BOX_E2E_API_BASE: "https://evil.example" })),
    (error) => error instanceof BoxProviderE2EError && error.code === "invalid_configuration",
  );
  assert.throws(
    () => loadBoxProviderE2EConfig(environment({ COMPANION_BOX_E2E_IMAGE: "../unsafe" })),
    (error) => error instanceof BoxProviderE2EError && error.code === "invalid_configuration",
  );
  assert.equal(
    loadBoxProviderE2EConfig(environment({ COMPANION_BOX_E2E_IMAGE: "companion-l14-deadbeef" })).image,
    "companion-l14-deadbeef",
  );
});

test("creates, exercises, archives, resumes, verifies, and permanently deletes one Box", async () => {
  const provider = mockProvider();
  const events = [];
  const clock = fakeClock();
  const report = await runBoxProviderE2E(config(), {
    fetch: provider.fetch,
    randomUUID: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    logger: (event) => events.push(event),
    ...clock,
  });

  assert.equal(report.status, "succeeded");
  assert.equal(report.cleanup, "succeeded");
  assert.equal(provider.wasDeleted(), true);
  assert.deepEqual(
    events.filter((event) => event.status === "succeeded").map((event) => event.phase),
    ["create", "first_command", "archive", "resume_and_verify", "cleanup", "box_provider_e2e"],
  );
  const commands = provider.calls.filter((call) => call.url.pathname.endsWith("/commands"));
  assert.equal(commands.length, 2);
  assert.match(commands[0].body.command, /dd if=\/dev\/zero/);
  assert.match(commands[1].body.command, /AAAAAAAA/);
  assert.equal(provider.calls[0].body.from, undefined);
  assert.equal(provider.calls.filter((call) => call.url.pathname.endsWith("/stop")).length, 2);
  assert.equal(JSON.stringify(events).includes(API_KEY), false);
});

test("uses the configured named snapshot without exposing its name in reports", async () => {
  const provider = mockProvider();
  const events = [];
  const image = "companion-l14-deadbeef";
  const report = await runBoxProviderE2E(config({ image }), {
    fetch: provider.fetch,
    logger: (event) => events.push(event),
    randomUUID: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ...fakeClock(),
  });

  assert.equal(report.status, "succeeded");
  assert.equal(report.source, "named_snapshot");
  assert.equal(provider.calls[0].body.from, image);
  assert.equal(JSON.stringify(events).includes(image), false);
});

test("a failed command still permanently deletes the exact disposable Box", async () => {
  const provider = mockProvider({ failFirstCommand: true });
  const events = [];
  const report = await runBoxProviderE2E(config(), {
    fetch: provider.fetch,
    logger: (event) => events.push(event),
    randomUUID: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ...fakeClock(),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.code, "command_failed");
  assert.equal(report.cleanup, "succeeded");
  assert.equal(provider.wasDeleted(), true);
  assert.equal(JSON.stringify(events).includes(API_KEY), false);
});
