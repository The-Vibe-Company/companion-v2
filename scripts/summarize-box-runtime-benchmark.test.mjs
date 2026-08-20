import assert from "node:assert/strict";
import test from "node:test";

import { summarizeBoxRuntimeBenchmark } from "./summarize-box-runtime-benchmark.mjs";

test("reports nearest-rank P50/P95 for create and resume cycles", () => {
  const lines = [];
  for (let cycle = 1; cycle <= 10; cycle += 1) {
    for (const phase of [
      "provider_start",
      "ready_to_prompt_ack",
      "resume_provider_start",
      "resume_ready_to_prompt_ack",
    ]) lines.push(JSON.stringify({ phase, status: "succeeded", duration_ms: cycle * 100 }));
    lines.push(JSON.stringify({ phase: "runtime_change_e2e", status: "succeeded" }));
  }
  const summary = summarizeBoxRuntimeBenchmark(lines.join("\n"), 10);
  assert.equal(summary.cycles, 10);
  assert.deepEqual(summary.metrics.ready_to_prompt_ack, {
    samples: 10,
    p50_ms: 500,
    p95_ms: 1_000,
  });
});

test("fails closed when a cycle or metric sample is missing", () => {
  assert.throws(
    () => summarizeBoxRuntimeBenchmark(
      JSON.stringify({ phase: "runtime_change_e2e", status: "succeeded" }),
      2,
    ),
    /expected 2 successful cycles/,
  );
});
