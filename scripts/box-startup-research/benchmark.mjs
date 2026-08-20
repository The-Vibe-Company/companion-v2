#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { summarizeBoxRuntimeBenchmark } from "../summarize-box-runtime-benchmark.mjs";
import {
  BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
  deterministicCompanionId,
  leaseTokenHash,
  resourcePrefix,
  RESULT_SENTINEL,
  validateBenchmarkLease,
} from "./contracts.mjs";
import { evaluatorChecksum } from "./evaluator-integrity.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name) {
  const value = option(name)?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function safeEnvironment() {
  const boxKey = process.env.BOX_API_KEY?.trim() || process.env.COMPANION_BOX_API_KEY?.trim();
  const zaiKey = process.env.ZAI_API_KEY?.trim()
    || process.env.COMPANION_BOX_E2E_ZAI_API_KEY?.trim();
  if (!boxKey || !zaiKey) throw new Error("research credentials are not configured");
  return {
    ...process.env,
    COMPANION_BOX_API_KEY: boxKey,
    COMPANION_BOX_E2E_ZAI_API_KEY: zaiKey,
  };
}

async function run(command, args, options = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.forward) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      rejectRun(new Error(`${options.label ?? command} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

function jsonEvents(contents) {
  return contents.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

async function currentTreeSha() {
  return (await run("git", ["rev-parse", "HEAD^{tree}"], { label: "git tree lookup" })).stdout.trim();
}

export function validateLeaseGrant(raw, verification) {
  const lease = validateBenchmarkLease({
    schemaVersion: BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
    ...raw,
    tokenHash: verification.tokenHash,
  });
  if (leaseTokenHash(verification.token) !== lease.tokenHash) {
    throw new Error("benchmark lease token is invalid");
  }
  if (lease.resourcePrefix !== resourcePrefix(lease.runId, lease.candidateId)) {
    throw new Error("benchmark resource prefix is outside the lease");
  }
  const now = verification.now ?? Date.now();
  const expiresAt = Date.parse(lease.expiresAt);
  if (expiresAt <= now || expiresAt - now > 60 * 60_000) {
    throw new Error("benchmark lease is expired");
  }
  if (verification.actualTreeSha !== lease.treeSha) {
    throw new Error("workspace tree does not match the lease");
  }
  return lease;
}

async function cleanup(input) {
  const args = [
    "--filter", "@companion/runtime", "exec", "tsx",
    resolve("scripts/box-startup-research/cleanup.ts"),
  ];
  for (const companionId of input.companionIds) args.push("--companion-id", companionId);
  if (input.snapshot) args.push("--snapshot", input.snapshot);
  if (input.treeSha) args.push("--tree-sha", input.treeSha);
  try {
    const cleaned = await run("pnpm", args, { env: input.env, label: "research cleanup" });
    const event = jsonEvents(cleaned.stdout).find((candidate) =>
      candidate.phase === "research_cleanup");
    if (!event || event.status !== "succeeded" || event.complete !== true) {
      throw new Error("research cleanup was not proven");
    }
    return {
      schemaVersion: BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
      boxes: event.boxes ?? [],
      snapshots: event.snapshots ?? [],
      complete: true,
    };
  } catch {
    return {
      schemaVersion: BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
      boxes: [],
      snapshots: input.snapshot ? [{ name: input.snapshot, deleted: false }] : [],
      complete: false,
    };
  }
}

export async function runLeasedBenchmark(raw = {}) {
  const expectedEvaluatorChecksum = process.env.BOX_STARTUP_RESEARCH_EVALUATOR_CHECKSUM?.trim();
  if (!/^[a-f0-9]{64}$/.test(expectedEvaluatorChecksum ?? "")
    || await evaluatorChecksum() !== expectedEvaluatorChecksum) {
    throw new Error("research evaluator checksum does not match the grant");
  }
  const token = raw.token ?? requiredOption("--lease-token");
  const lease = validateLeaseGrant({
    runId: raw.runId ?? requiredOption("--run-id"),
    candidateId: raw.candidateId ?? requiredOption("--candidate-id"),
    phase: raw.phase ?? requiredOption("--phase"),
    resourcePrefix: raw.resourcePrefix ?? requiredOption("--resource-prefix"),
    expiresAt: raw.expiresAt ?? requiredOption("--expires-at"),
    cycles: Number(raw.cycles ?? requiredOption("--cycles")),
    treeSha: raw.treeSha ?? requiredOption("--tree-sha"),
  }, {
    token,
    tokenHash: process.env.BOX_STARTUP_RESEARCH_LEASE_TOKEN_HASH,
    actualTreeSha: await currentTreeSha(),
  });
  const expiresAt = Date.parse(lease.expiresAt);

  const env = safeEnvironment();
  const runDirectory = resolve(".context/autoresearch/box-startup", lease.runId, lease.candidateId);
  await mkdir(runDirectory, { recursive: true });
  const logPath = resolve(runDirectory, `${lease.phase}.jsonl`);
  const companionIds = Array.from({ length: lease.cycles }, (_, index) =>
    deterministicCompanionId(lease.runId, lease.candidateId, lease.phase, index + 1));
  const bakerCompanionId = deterministicCompanionId(
    lease.runId,
    lease.candidateId,
    `${lease.phase}-bake`,
    0,
  );
  let snapshot = null;
  let bakeDurationMs = 0;
  let snapshotSizeBytes;
  let benchmark = null;
  let cycleContents = "";
  let primaryError = null;
  try {
    const baked = await run("pnpm", [
      "--filter", "@companion/runtime", "exec", "tsx",
      resolve("scripts/box-startup-research/bake-image.ts"),
    ], {
      env: {
        ...env,
        BOX_STARTUP_RESEARCH_TREE_SHA: lease.treeSha,
        BOX_STARTUP_RESEARCH_BAKER_COMPANION_ID: bakerCompanionId,
      },
      label: "research image bake",
    });
    const imageEvent = jsonEvents(baked.stdout).find((event) =>
      event.phase === "research_image" && event.status === "succeeded");
    if (!imageEvent || typeof imageEvent.image !== "string") {
      throw new Error("research image bake did not return an image");
    }
    snapshot = imageEvent.image;
    bakeDurationMs = Number(imageEvent.duration_ms) || 0;
    if (Number.isSafeInteger(imageEvent.snapshot_size_bytes)
      && imageEvent.snapshot_size_bytes >= 0) {
      snapshotSizeBytes = imageEvent.snapshot_size_bytes;
    }
    await appendFile(logPath, `${baked.stdout.trim()}\n`, { encoding: "utf8" });

    for (let index = 0; index < lease.cycles; index += 1) {
      if (Date.now() >= expiresAt) throw new Error("benchmark lease expired during execution");
      const cycle = await run("pnpm", ["e2e:box-runtime-change"], {
        env: {
          ...env,
          COMPANION_BOX_E2E_IMAGE: snapshot,
          COMPANION_BOX_E2E_GENERATION: "1",
          COMPANION_BOX_E2E_COMPANION_ID: companionIds[index],
          COMPANION_BOX_E2E_RESEARCH_TAG: lease.resourcePrefix,
        },
        forward: true,
        label: `benchmark cycle ${index + 1}`,
      });
      cycleContents += cycle.stdout;
      await appendFile(logPath, cycle.stdout, { encoding: "utf8" });
    }
    benchmark = summarizeBoxRuntimeBenchmark(cycleContents, lease.cycles);
  } catch (error) {
    primaryError = error;
  }

  const cleanupLedger = await cleanup({
    env,
    companionIds: [bakerCompanionId, ...companionIds],
    snapshot,
    treeSha: lease.treeSha,
  });
  if (primaryError || !benchmark || !cleanupLedger.complete) {
    throw new Error(primaryError ? "leased benchmark failed" : "leased benchmark cleanup failed");
  }
  const result = {
    schemaVersion: BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
    runId: lease.runId,
    candidateId: lease.candidateId,
    phase: lease.phase,
    treeSha: lease.treeSha,
    resourcePrefix: lease.resourcePrefix,
    benchmark,
    cleanup: cleanupLedger,
    bakeDurationMs,
    ...(snapshotSizeBytes === undefined ? {} : { snapshotSizeBytes }),
  };
  process.stdout.write(`${RESULT_SENTINEL}${JSON.stringify(result)}\n`);
  return result;
}

async function main() {
  await runLeasedBenchmark();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stdout.write(`${JSON.stringify({
      phase: "box_startup_research",
      status: "failed",
      code: "box_startup_research_failed",
    })}\n`);
    process.exitCode = 1;
  });
}
