import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLeaseAvailable,
  recoverCandidateResources,
  validatePersistedState,
  waitForSentinel,
} from "./controller.mjs";
import { resourcePrefix } from "./contracts.mjs";

const RUN_ID = "bsr-20260820-aaaaaa";
const SHA = "a".repeat(40);

test("serializes provider leases across candidates", () => {
  assert.doesNotThrow(() => assertLeaseAvailable(null, "w1-c1", "quick"));
  assert.throws(() => assertLeaseAvailable({ candidateId: "w1-c1", phase: "quick" }, "w1-c2", "quick"), /already held/);
});

test("validates resume state before reusing external identities", () => {
  const state = {
    schemaVersion: 1,
    runId: RUN_ID,
    baseSha: SHA,
    incumbentSha: SHA,
    evaluatorChecksum: "b".repeat(64),
    leaseSeed: "c".repeat(64),
    config: {
      schemaVersion: 1,
      runId: RUN_ID,
      baseSha: SHA,
      waves: 4,
      candidatesPerWave: 3,
      quickCycles: 3,
      baselineCycles: 3,
      confirmationCycles: 10,
      finalCycles: 10,
      candidateTimeoutMs: 45 * 60_000,
      leaseDurationMs: 45 * 60_000,
      readyToAckSloMs: 5_000,
    },
    candidates: [{
      id: "w1-c1",
      branch: `autoresearch/${RUN_ID}/w1-c1`,
      resourcePrefix: resourcePrefix(RUN_ID, "w1-c1"),
      baseSha: SHA,
      workspaceId: "11111111-1111-4111-a111-111111111111",
      sessionId: "22222222-2222-4222-a222-222222222222",
    }],
    integration: null,
  };
  assert.equal(validatePersistedState(structuredClone(state), RUN_ID).runId, RUN_ID);
  state.candidates[0].branch = "autoresearch/another-run/w1-c1";
  assert.throws(() => validatePersistedState(state, RUN_ID), /candidate state/);
});

test("ignores malformed duplicate messages and resumes from a valid sentinel", async () => {
  let reads = 0;
  const result = await waitForSentinel({
    client: {
      sessionMessages: async () => {
        reads += 1;
        return reads === 1
          ? { messages: [{ text: "RESULT {broken" }] }
          : { messages: [{ text: 'RESULT {"id":"accepted"}' }] };
      },
      sessionStatus: async () => "running",
      cancelSession: async () => undefined,
    },
    sessionId: "session",
    sentinel: "RESULT ",
    validate: (value) => value,
    matches: (value) => value.id === "accepted",
    timeoutMs: 5_000,
    pollMs: 0,
  });
  assert.equal(result.id, "accepted");
});

test("cancels a session that never returns a valid sentinel", async () => {
  let cancelled = 0;
  await assert.rejects(waitForSentinel({
    client: {
      sessionMessages: async () => ({ messages: [{ text: "RESULT {invalid" }] }),
      sessionStatus: async () => "running",
      cancelSession: async () => { cancelled += 1; },
    },
    sessionId: "session",
    sentinel: "RESULT ",
    validate: (value) => value,
    matches: () => true,
    timeoutMs: 5,
    pollMs: 0,
  }), /timed out/);
  assert.equal(cancelled, 1);
});

test("fails promptly when an idle session omitted its structured result", async () => {
  await assert.rejects(waitForSentinel({
    client: {
      sessionMessages: async () => ({ messages: [] }),
      sessionStatus: async () => "idle",
      cancelSession: async () => undefined,
    },
    sessionId: "session",
    sentinel: "RESULT ",
    validate: (value) => value,
    matches: () => true,
    timeoutMs: 5_000,
    pollMs: 0,
  }), /completed without a valid result/);
});

test("uses a separate session to cleanup deterministic timeout resources", async () => {
  const created = [];
  await recoverCandidateResources({
    runId: "bsr-run",
  }, {
    cancelSession: async () => undefined,
    createSession: async (input) => {
      created.push(input);
      return { sessionId: "cleanup-session" };
    },
    sessionMessages: async () => ({
      messages: [{
        text: '{"phase":"research_cleanup","status":"succeeded","schemaVersion":1,"boxes":[],"snapshots":[],"complete":true}',
      }],
    }),
    sessionStatus: async () => "idle",
  }, {
    id: "w1-c1",
    workspaceId: "workspace",
    treeSha: "a".repeat(40),
  }, "quick", 3);

  assert.equal(created.length, 1);
  assert.match(created[0].message, /--tree-sha a{40}/);
  assert.equal((created[0].message.match(/--companion-id/g) ?? []).length, 4);
});
