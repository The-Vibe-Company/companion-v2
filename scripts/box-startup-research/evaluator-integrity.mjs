import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const EVALUATOR_FILES = [
  "scripts/box-runtime-change-e2e.ts",
  "scripts/summarize-box-runtime-benchmark.mjs",
  "scripts/box-startup-research/benchmark.mjs",
  "scripts/box-startup-research/bake-image.ts",
  "scripts/box-startup-research/cleanup.ts",
  "scripts/box-startup-research/contracts.mjs",
  "scripts/box-startup-research/controller.mjs",
  "scripts/box-startup-research/evaluator-integrity.mjs",
  "scripts/box-startup-research/policy.mjs",
  "scripts/box-startup-research/program.md",
];

export async function evaluatorChecksum(cwd = process.cwd()) {
  const digest = createHash("sha256");
  for (const path of EVALUATOR_FILES) {
    digest.update(`${path}\0`);
    digest.update(await readFile(resolve(cwd, path)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function evaluatorFiles() {
  return [...EVALUATOR_FILES];
}
