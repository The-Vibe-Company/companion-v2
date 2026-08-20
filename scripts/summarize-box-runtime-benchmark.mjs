#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const METRICS = [
  "provider_start",
  "ready_to_prompt_ack",
  "resume_provider_start",
  "resume_ready_to_prompt_ack",
];

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

export function summarizeBoxRuntimeBenchmark(contents, expectedCycles = 10) {
  const events = String(contents).split(/\r?\n/).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event && typeof event === "object" && !Array.isArray(event) ? [event] : [];
    } catch {
      return [];
    }
  });
  const completedCycles = events.filter((event) =>
    event.phase === "runtime_change_e2e" && event.status === "succeeded").length;
  if (completedCycles !== expectedCycles) {
    throw new Error(`expected ${expectedCycles} successful cycles, received ${completedCycles}`);
  }
  const metrics = Object.fromEntries(METRICS.map((phase) => {
    const values = events.filter((event) =>
      event.phase === phase
      && event.status === "succeeded"
      && Number.isSafeInteger(event.duration_ms)
      && event.duration_ms >= 0)
      .map((event) => event.duration_ms);
    if (values.length !== expectedCycles) {
      throw new Error(`metric ${phase} has ${values.length} samples, expected ${expectedCycles}`);
    }
    return [phase, {
      samples: values.length,
      p50_ms: percentile(values, 0.5),
      p95_ms: percentile(values, 0.95),
    }];
  }));
  return { cycles: completedCycles, metrics };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("benchmark log path is required");
  const expectedCycles = Number(process.env.COMPANION_BOX_BENCHMARK_CYCLES || "10");
  const sloMs = Number(process.env.COMPANION_BOX_READY_TO_ACK_SLO_MS || "5000");
  if (!Number.isSafeInteger(expectedCycles) || expectedCycles < 1 || expectedCycles > 100) {
    throw new Error("benchmark cycle count is invalid");
  }
  if (!Number.isSafeInteger(sloMs) || sloMs < 1) throw new Error("benchmark SLO is invalid");
  const summary = summarizeBoxRuntimeBenchmark(await readFile(path, "utf8"), expectedCycles);
  process.stdout.write(`${JSON.stringify({ phase: "box_runtime_benchmark", ...summary })}\n`);
  for (const phase of ["ready_to_prompt_ack", "resume_ready_to_prompt_ack"]) {
    if (summary.metrics[phase].p95_ms > sloMs) {
      throw new Error(`${phase} P95 exceeds ${sloMs}ms`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "benchmark failed"}\n`);
    process.exitCode = 1;
  });
}
