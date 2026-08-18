import assert from "node:assert/strict";
import test from "node:test";

import { waitForHttpReady } from "./wait-http-ready.mjs";

function clock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (milliseconds) => { value += milliseconds; },
  };
}

test("waits through a delayed bind before reporting readiness", async () => {
  const fakeClock = clock();
  let calls = 0;
  await waitForHttpReady({
    url: "http://127.0.0.1:3008/health",
    pid: 123,
    timeoutMs: 1_000,
    processAlive: () => true,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("connection refused");
      return new Response(null, { status: 200 });
    },
    ...fakeClock,
  });
  assert.equal(calls, 3);
});

test("fails immediately when the child exits before binding", async () => {
  let fetchCalls = 0;
  await assert.rejects(waitForHttpReady({
    url: "http://127.0.0.1:3008/health",
    pid: 123,
    timeoutMs: 1_000,
    processAlive: () => false,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    },
  }), /process_exited/);
  assert.equal(fetchCalls, 0);
});
