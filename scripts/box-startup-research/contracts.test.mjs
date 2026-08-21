import assert from "node:assert/strict";
import test from "node:test";

import {
  benchmarkScore,
  candidateBeatsIncumbent,
  deterministicCompanionId,
  leaseTokenHash,
  parseSentinel,
  providerDriftDetected,
  providerGuardrailsSatisfied,
  resourcePrefix,
  RESULT_SENTINEL,
  validateCandidateResult,
} from "./contracts.mjs";

const SHA = "a".repeat(40);

function summary(create = 4_000, resume = 4_500, provider = 10_000) {
  const metric = (value) => ({ samples: 3, p50_ms: value, p95_ms: value + 500 });
  return {
    cycles: 3,
    metrics: {
      provider_start: metric(provider),
      ready_to_prompt_ack: metric(create),
      resume_provider_start: metric(provider),
      resume_ready_to_prompt_ack: metric(resume),
    },
  };
}

function result() {
  return {
    schemaVersion: 1,
    runId: "bsr-20260820-aaaaaa",
    candidateId: "w1-c1",
    phase: "quick",
    treeSha: SHA,
    resourcePrefix: resourcePrefix("bsr-20260820-aaaaaa", "w1-c1"),
    benchmark: summary(),
    cleanup: {
      schemaVersion: 1,
      boxes: [{ id: "bx_23456789", deleted: true }],
      snapshots: [{ name: "companion-l14-abcdef012345", deleted: true }],
      complete: true,
    },
    bakeDurationMs: 12_000,
  };
}

test("validates result contracts without accepting secret-bearing free-form fields", () => {
  assert.deepEqual(validateCandidateResult(result()), result());
  assert.throws(() => validateCandidateResult({ ...result(), phase: "invented" }), /phase/);
  const inconsistent = result();
  inconsistent.cleanup.boxes[0].deleted = false;
  assert.throws(() => validateCandidateResult(inconsistent), /completion/);
});

test("extracts the last valid sentinel from nested Conductor messages", () => {
  const valid = result();
  const messages = { messages: [{ content: `prose\n${RESULT_SENTINEL}${JSON.stringify(valid)}` }] };
  assert.deepEqual(parseSentinel(messages, RESULT_SENTINEL, validateCandidateResult), [valid]);
});

test("uses balanced create/resume score and noise-aware incumbent promotion", () => {
  assert.equal(benchmarkScore(summary()), 4_500);
  assert.equal(candidateBeatsIncumbent(summary(2_500, 3_000), summary()), true);
  assert.equal(candidateBeatsIncumbent(summary(3_900, 4_100), summary()), false);
  assert.equal(candidateBeatsIncumbent(summary(2_000, 3_000, 14_000), summary()), false);
  assert.equal(providerGuardrailsSatisfied(summary(2_000, 3_000, 11_500), summary()), true);
  assert.equal(providerGuardrailsSatisfied(summary(2_000, 3_000, 13_000), summary()), false);
  assert.equal(providerDriftDetected(summary(), summary(4_000, 4_500, 11_500)), false);
  assert.equal(providerDriftDetected(summary(), summary(4_000, 4_500, 13_000)), true);
});

test("derives safe deterministic resource and identity values", () => {
  assert.match(resourcePrefix("run", "candidate"), /^box-startup-[a-f0-9]{16}$/);
  assert.match(deterministicCompanionId("run", "candidate", "quick", 1), /^[0-9a-f-]{36}$/);
  assert.equal(leaseTokenHash("a".repeat(32)).length, 64);
});
