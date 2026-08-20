import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireCampaignLock,
  assertLeaseAvailable,
  assertProviderBenchmarkEvidence,
  candidateWorkspaceEnvironment,
  evaluatorSnapshotName,
  grantBenchmark,
  recoverCandidateResources,
  validateControllerBenchmarkResult,
  validatePersistedState,
  waitForSentinel,
} from "./controller.mjs";
import { resourcePrefix } from "./contracts.mjs";

const RUN_ID = "bsr-20260820-aaaaaa";
const SHA = "a".repeat(40);

function benchmarkResult(cycles = 3) {
  const metric = (value) => ({ samples: cycles, p50_ms: value, p95_ms: value + 1 });
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    candidateId: "w1-c1",
    phase: "quick",
    treeSha: SHA,
    resourcePrefix: resourcePrefix(RUN_ID, "w1-c1"),
    benchmark: {
      cycles,
      metrics: {
        provider_start: metric(100),
        ready_to_prompt_ack: metric(200),
        resume_provider_start: metric(100),
        resume_ready_to_prompt_ack: metric(200),
      },
    },
    cleanup: {
      schemaVersion: 1,
      boxes: [],
      snapshots: [{
        name: evaluatorSnapshotName(RUN_ID, "w1-c1", "quick", SHA),
        deleted: true,
      }],
      complete: true,
    },
    bakeDurationMs: 100,
  };
}

function benchmarkState() {
  return {
    runId: RUN_ID,
    controllerWorkspaceId: "11111111-1111-4111-a111-111111111111",
    evaluatorChecksum: "b".repeat(64),
    leaseSeed: "c".repeat(64),
    config: { leaseDurationMs: 45 * 60_000 },
    activeLease: null,
    cleanupLedger: [],
    leaseJournal: [],
    save: async () => undefined,
  };
}

function candidate() {
  return {
    id: "w1-c1",
    sessionId: "22222222-2222-4222-a222-222222222222",
    treeSha: SHA,
    resourcePrefix: resourcePrefix(RUN_ID, "w1-c1"),
  };
}

test("serializes provider leases across candidates", () => {
  assert.doesNotThrow(() => assertLeaseAvailable(null, "w1-c1", "quick"));
  assert.throws(() => assertLeaseAvailable({ candidateId: "w1-c1", phase: "quick" }, "w1-c2", "quick"), /already held/);
});

test("rejects candidate timings that are faster than controller-observed provider evidence", () => {
  const result = benchmarkResult(3);
  const evidence = {
    cleanupProven: true,
    metrics: Object.fromEntries([
      "provider_start",
      "ready_to_prompt_ack",
      "resume_provider_start",
      "resume_ready_to_prompt_ack",
    ].map((name) => [name, { samples: 3, p50_ms: 250, p95_ms: 300 }])),
  };
  assert.doesNotThrow(() => assertProviderBenchmarkEvidence(result, evidence));
  evidence.metrics.ready_to_prompt_ack.p95_ms = 500;
  assert.throws(
    () => assertProviderBenchmarkEvidence(result, evidence),
    /contradicts controller provider evidence/,
  );
});

test("serializes controller processes for one campaign directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "box-startup-controller-lock-"));
  try {
    const first = await acquireCampaignLock(directory, { heartbeatMs: 60_000 });
    await assert.rejects(
      acquireCampaignLock(directory, { heartbeatMs: 60_000 }),
      /active controller/,
    );
    await first.release();
    const second = await acquireCampaignLock(directory, { heartbeatMs: 60_000 });
    await second.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("releases the kernel campaign lock when its controller crashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "box-startup-controller-crash-lock-"));
  const moduleUrl = new URL("./controller.mjs", import.meta.url).href;
  try {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { acquireCampaignLock } from ${JSON.stringify(moduleUrl)};
await acquireCampaignLock(${JSON.stringify(directory)});
process.stdout.write("locked\\n");
process.exit(17);`,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const exitCode = await new Promise((resolveExit) => child.once("close", resolveExit));
    assert.equal(exitCode, 17);
    assert.match(stdout, /locked/);

    let recovered;
    for (let attempt = 0; attempt < 20 && !recovered; attempt += 1) {
      recovered = await acquireCampaignLock(directory).catch(() => null);
      if (!recovered) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.ok(recovered, "the orphaned lock must release when the controller pipe closes");
    await recovered.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("uses controller-owned cleanup instead of a candidate session", async () => {
  const cleaned = [];
  await recoverCandidateResources({
    runId: "bsr-run",
  }, {
    cancelSession: async () => undefined,
    createSession: async () => { throw new Error("candidate cleanup must not create a session"); },
  }, {
    id: "w1-c1",
    treeSha: "a".repeat(40),
    resourcePrefix: resourcePrefix("bsr-run", "w1-c1"),
  }, "quick", 3, {
    cleanup: async (lease) => {
      cleaned.push(lease);
      return { complete: true };
    },
  });

  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].candidateId, "w1-c1");
  assert.equal(cleaned[0].cycles, 3);
});

test("candidate workspaces explicitly shadow provider credentials", () => {
  const env = candidateWorkspaceEnvironment({
    runId: RUN_ID,
    candidateId: "w1-c1",
    resourcePrefix: resourcePrefix(RUN_ID, "w1-c1"),
  });
  for (const name of [
    "BOX_API_KEY",
    "COMPANION_BOX_API_KEY",
    "ZAI_API_KEY",
    "COMPANION_BOX_E2E_ZAI_API_KEY",
  ]) assert.equal(env[name], "");
});

test("controller binds benchmark evidence and ignores empty or fabricated candidate chat", async () => {
  const state = benchmarkState();
  const submitted = candidate();
  let sessionMessageReads = 0;
  let executed = null;
  const result = await grantBenchmark(state, {
    sessionMessages: async () => {
      sessionMessageReads += 1;
      return { messages: [{ text: "BOX_STARTUP_RESEARCH_RESULT {\"fabricated\":true}" }] };
    },
    sendMessage: async () => { throw new Error("benchmark grants are controller-owned"); },
    cancelSession: async () => undefined,
  }, submitted, "quick", 3, {
    assertEvaluatorChecksum: async () => undefined,
    execute: async (...input) => {
      executed = input;
      return benchmarkResult();
    },
    recordResult: async () => undefined,
  });

  assert.equal(sessionMessageReads, 0);
  assert.equal(executed[1], submitted);
  assert.equal(result.benchmark.cycles, 3);
  assert.equal(state.activeLease, null);
  assert.throws(() => validateControllerBenchmarkResult(benchmarkResult(2), {
    runId: RUN_ID,
    candidateId: "w1-c1",
    phase: "quick",
    treeSha: SHA,
    resourcePrefix: resourcePrefix(RUN_ID, "w1-c1"),
    cycles: 3,
    snapshotName: evaluatorSnapshotName(RUN_ID, "w1-c1", "quick", SHA),
  }), /does not match/);
});

test("failed controller cleanup leaves the provider lease durably blocked", async () => {
  const state = benchmarkState();
  await assert.rejects(grantBenchmark(state, {
    cancelSession: async () => undefined,
  }, candidate(), "quick", 3, {
    assertEvaluatorChecksum: async () => undefined,
    execute: async () => { throw new Error("benchmark failed"); },
    recover: async () => { throw new Error("cleanup failed"); },
  }), /cleanup proof is incomplete/);

  assert.equal(state.status, "blocked-cleanup");
  assert.equal(state.activeLease?.cleanupStatus, "blocked");
  assert.equal(state.leaseJournal.at(-1)?.event, "blocked_cleanup");
});
