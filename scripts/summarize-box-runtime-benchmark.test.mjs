import assert from "node:assert/strict";
import test from "node:test";

import { summarizeBoxRuntimeBenchmark } from "./summarize-box-runtime-benchmark.mjs";

test("reports nearest-rank P50/P95 for create and resume cycles", () => {
  const lines = [];
  for (let cycle = 1; cycle <= 10; cycle += 1) {
    for (const phase of [
      "provider_start",
      "send_to_prompt_ack",
      "ready_to_prompt_ack",
      "resume_provider_start",
      "resume_send_to_prompt_ack",
      "resume_ready_to_prompt_ack",
      "stage_runtime",
      "start_pi",
      "broker_preflight",
      "stop_archive",
      "resume",
      "resume_start_pi",
      "resume_broker_preflight",
    ]) lines.push(JSON.stringify({ phase, status: "succeeded", duration_ms: cycle * 100 }));
    lines.push(JSON.stringify({
      phase: "provider_call_stats",
      status: "succeeded",
      provider_call_count: cycle,
    }));
    lines.push(JSON.stringify({
      phase: "staging_stats",
      status: "succeeded",
      staging_mode: "skills",
      skill_bytes_transferred: cycle * 1_000,
    }));
    lines.push(JSON.stringify({
      phase: "resume_staging_stats",
      status: "succeeded",
      staging_mode: "refresh",
      skill_bytes_transferred: 0,
    }));
    lines.push(JSON.stringify({ phase: "runtime_change_e2e", status: "succeeded" }));
  }
  const summary = summarizeBoxRuntimeBenchmark(lines.join("\n"), 10);
  assert.equal(summary.cycles, 10);
  assert.deepEqual(summary.metrics.ready_to_prompt_ack, {
    samples: 10,
    p50_ms: 500,
    p95_ms: 1_000,
  });
  assert.deepEqual(summary.diagnostics.provider_calls, { samples: 10, p50: 5, p95: 10 });
  assert.deepEqual(summary.diagnostics.create_staging_modes, { skills: 10 });
});

test("fails closed when a cycle is missing", () => {
  assert.throws(
    () => summarizeBoxRuntimeBenchmark(
      JSON.stringify({ phase: "runtime_change_e2e", status: "succeeded" }),
      2,
    ),
    /expected 2 successful cycles/,
  );
});

test("fails closed when a metric sample is missing from otherwise complete cycles", () => {
  const events = [];
  for (let cycle = 0; cycle < 2; cycle += 1) {
    events.push({ phase: "runtime_change_e2e", status: "succeeded" });
    for (const phase of [
      "ready_to_prompt_ack",
      "send_to_prompt_ack",
      "resume_provider_start",
      "resume_send_to_prompt_ack",
      "resume_ready_to_prompt_ack",
      "stage_runtime",
      "start_pi",
      "broker_preflight",
      "stop_archive",
      "resume",
      "resume_start_pi",
      "resume_broker_preflight",
    ]) events.push({ phase, status: "succeeded", duration_ms: 100 });
    events.push({
      phase: "provider_call_stats",
      status: "succeeded",
      provider_call_count: 10,
    });
    events.push({
      phase: "staging_stats",
      status: "succeeded",
      staging_mode: "skills",
      skill_bytes_transferred: 100,
    });
    events.push({
      phase: "resume_staging_stats",
      status: "succeeded",
      staging_mode: "refresh",
      skill_bytes_transferred: 0,
    });
  }
  events.push({ phase: "provider_start", status: "succeeded", duration_ms: 100 });

  assert.throws(
    () => summarizeBoxRuntimeBenchmark(events.map((event) => JSON.stringify(event)).join("\n"), 2),
    /metric provider_start has 1 samples, expected 2/,
  );
});
