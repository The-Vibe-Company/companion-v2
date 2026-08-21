#!/usr/bin/env node

import { spawn } from "node:child_process";
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
  validateCleanupLedger,
} from "./contracts.mjs";
import { evaluatorChecksum } from "./evaluator-integrity.mjs";
import { assertNoCredentialMaterial } from "./policy.mjs";

const ESSENTIAL_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PNPM_HOME",
  "COREPACK_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "COMPANION_BOX_API_BASE",
  "COMPANION_BOX_TTL_SECONDS",
  "COMPANION_BOX_POLL_INTERVAL_MS",
  "COMPANION_BOX_READY_TIMEOUT_MS",
  "COMPANION_BOX_DESKTOP_MINT_BUDGET_MS",
  "COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS",
  "COMPANION_PI_INSTALL_COMMAND",
  "COMPANION_PI_MCP_ADAPTER_PACKAGE",
  "COMPANION_BOX_E2E_MODEL_ID",
];
const DURATION_PHASES = new Set([
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
  "prompt_ack",
  "resume_prompt_ack",
  "create_stage_identity_probe",
  "create_stage_layout",
  "create_stage_interaction_extension",
  "create_stage_resource_preflight",
  "create_stage_control_bundle",
  "create_stage_skill_transfer",
  "create_stage_skill_apply",
  "resume_stage_identity_probe",
  "resume_stage_layout",
  "resume_stage_interaction_extension",
  "resume_stage_resource_preflight",
  "resume_stage_control_bundle",
  "resume_stage_skill_transfer",
  "resume_stage_skill_apply",
]);
const PROVIDER_OPERATIONS = new Set([
  "list_boxes",
  "create_box",
  "apply_box_settings",
  "get_box",
  "resume_box",
  "archive_box",
  "write_file",
  "execute_command",
  "broker_state",
  "prompt",
  "desktop",
]);
const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CREDENTIAL_MATERIAL_PATTERN = /(?:authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._-]{16,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*["'][^"']{16,})/i;

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name) {
  const value = option(name)?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function stringValue(value) {
  if (value === null || value === undefined) return null;
  try {
    const candidate = String(value);
    return candidate === value ? candidate : null;
  } catch {
    return null;
  }
}

function recordValue(value) {
  return value !== null && !Array.isArray(value) && Object(value) === value;
}

export function evaluatorRuntimeEnvironment(source = process.env) {
  const env = {};
  for (const name of ESSENTIAL_ENVIRONMENT_NAMES) {
    const value = stringValue(source[name]);
    if (value !== null && value.length > 0) env[name] = value;
  }
  return env;
}

export function cleanupEnvironment(source = process.env) {
  const boxKey = source.BOX_API_KEY?.trim() || source.COMPANION_BOX_API_KEY?.trim();
  if (!boxKey) throw new Error("research Box credential is not configured");
  return {
    ...evaluatorRuntimeEnvironment(source),
    BOX_API_KEY: "",
    COMPANION_BOX_API_KEY: boxKey,
    ZAI_API_KEY: "",
    COMPANION_BOX_E2E_ZAI_API_KEY: "",
  };
}

export function safeEnvironment(source = process.env, options = {}) {
  const boxKey = options.boxApiKey ?? (source.BOX_API_KEY?.trim()
    || source.COMPANION_BOX_API_KEY?.trim());
  const zaiKey = options.zaiApiKey ?? (source.ZAI_API_KEY?.trim()
    || source.COMPANION_BOX_E2E_ZAI_API_KEY?.trim());
  if (!boxKey || !zaiKey) throw new Error("research evaluator credentials are not configured");
  const env = evaluatorRuntimeEnvironment(source);
  const home = stringValue(options.home);
  if (home !== null) {
    env.HOME = home;
    env.XDG_CACHE_HOME = resolve(home, ".cache");
    env.XDG_CONFIG_HOME = resolve(home, ".config");
    env.XDG_DATA_HOME = resolve(home, ".local/share");
  }
  const tempDirectory = stringValue(options.tempDirectory);
  if (tempDirectory !== null) {
    env.TMPDIR = tempDirectory;
    env.TMP = tempDirectory;
    env.TEMP = tempDirectory;
  }
  env.BOX_API_KEY = "";
  env.COMPANION_BOX_API_KEY = boxKey;
  env.ZAI_API_KEY = "";
  env.COMPANION_BOX_E2E_ZAI_API_KEY = zaiKey;
  env.COMPANION_BOX_E2E_PROMPT_ACK_ONLY = "1";
  const boxApiBase = stringValue(options.boxApiBase);
  if (boxApiBase !== null) env.COMPANION_BOX_API_BASE = boxApiBase;
  const leaseTokenHashValue = stringValue(options.leaseTokenHash);
  if (leaseTokenHashValue !== null) {
    env.BOX_STARTUP_RESEARCH_LEASE_TOKEN_HASH = leaseTokenHashValue;
  }
  const evaluatorChecksumValue = stringValue(options.evaluatorChecksum);
  if (evaluatorChecksumValue !== null) {
    env.BOX_STARTUP_RESEARCH_EVALUATOR_CHECKSUM = evaluatorChecksumValue;
  }
  const logDirectory = stringValue(options.logDirectory);
  if (logDirectory !== null) env.BOX_STARTUP_RESEARCH_LOG_DIRECTORY = logDirectory;
  const snapshotName = stringValue(options.snapshotName);
  if (snapshotName !== null) env.BOX_STARTUP_RESEARCH_SNAPSHOT_NAME = snapshotName;
  return env;
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
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({
      stdout,
      stderr,
      code: code ?? 1,
      signal,
      label: options.label ?? command,
    }));
  });
}

export function assertSafeEvaluatorOutput(value, env = process.env) {
  assertNoCredentialMaterial(value, env);
  if (CREDENTIAL_MATERIAL_PATTERN.test(value)) {
    throw new Error("evaluator output contains credential-shaped material");
  }
}

function checkedOutput(processResult, env) {
  assertSafeEvaluatorOutput(processResult.stdout, env);
  assertSafeEvaluatorOutput(processResult.stderr, env);
  if (processResult.code !== 0) throw new Error(`${processResult.label} failed`);
  return jsonEvents(processResult.stdout);
}

function jsonEvents(contents) {
  return contents.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return recordValue(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sanitizeImageEvent(events, treeSha, snapshotName) {
  const matches = events.filter((event) => event.phase === "research_image" && event.status === "succeeded");
  if (matches.length !== 1) throw new Error("research image bake did not return one successful image");
  const event = matches[0];
  if (event.tree_sha !== treeSha || event.image !== snapshotName || !SNAPSHOT_PATTERN.test(event.image)) {
    throw new Error("research image bake returned an invalid image");
  }
  const durationMs = nonNegativeInteger(event.duration_ms);
  const providerCallCount = nonNegativeInteger(event.provider_call_count);
  if (durationMs === null || providerCallCount === null) {
    throw new Error("research image bake returned invalid timing data");
  }
  const safe = {
    phase: "research_image",
    status: "succeeded",
    image: event.image,
    tree_sha: treeSha,
    duration_ms: durationMs,
    provider_call_count: providerCallCount,
  };
  if (event.snapshot_size_bytes !== undefined) {
    const snapshotSizeBytes = nonNegativeInteger(event.snapshot_size_bytes);
    if (snapshotSizeBytes === null) throw new Error("research image bake returned an invalid snapshot size");
    safe.snapshot_size_bytes = snapshotSizeBytes;
  }
  return safe;
}

export function sanitizeCycleEvents(events, resourcePrefixValue) {
  const safe = [];
  let resources = 0;
  let cleanups = 0;
  let terminals = 0;
  for (const event of events) {
    if (DURATION_PHASES.has(event.phase) && event.status === "succeeded") {
      const durationMs = nonNegativeInteger(event.duration_ms);
      if (durationMs === null) throw new Error("evaluator returned an invalid timing event");
      safe.push({ phase: event.phase, status: "succeeded", duration_ms: durationMs });
      continue;
    }
    if ((event.phase === "staging_stats" || event.phase === "resume_staging_stats")
      && event.status === "succeeded") {
      const bytes = nonNegativeInteger(event.skill_bytes_transferred);
      if (bytes === null || !["refresh", "skills"].includes(event.staging_mode)) {
        throw new Error("evaluator returned invalid staging diagnostics");
      }
      safe.push({
        phase: event.phase,
        status: "succeeded",
        staging_mode: event.staging_mode,
        skill_bytes_transferred: bytes,
      });
      continue;
    }
    if (event.phase === "provider_call_stats" && event.status === "succeeded") {
      const calls = nonNegativeInteger(event.provider_call_count);
      if (calls === null) throw new Error("evaluator returned invalid provider diagnostics");
      safe.push({ phase: "provider_call_stats", status: "succeeded", provider_call_count: calls });
      continue;
    }
    if (event.phase === "provider_call" && ["succeeded", "failed"].includes(event.status)) {
      const durationMs = nonNegativeInteger(event.duration_ms);
      if (durationMs === null || !PROVIDER_OPERATIONS.has(event.operation)) {
        throw new Error("evaluator returned invalid provider timing");
      }
      safe.push({
        phase: "provider_call",
        status: event.status,
        operation: event.operation,
        duration_ms: durationMs,
      });
      continue;
    }
    if (event.phase === "resource" && event.status === "created") {
      const resourceId = stringValue(event.resource_id);
      if (event.resource_kind !== "box" || resourceId === null
        || !BOX_ID_PATTERN.test(resourceId) || event.research_tag !== resourcePrefixValue) {
        throw new Error("evaluator created a resource outside the lease");
      }
      resources += 1;
      safe.push({
        phase: "resource",
        status: "created",
        resource_kind: "box",
        resource_id: resourceId,
        research_tag: resourcePrefixValue,
      });
      continue;
    }
    if (event.phase === "cleanup" && event.status === "succeeded") {
      if (event.research_tag !== resourcePrefixValue) {
        throw new Error("evaluator cleanup is outside the lease");
      }
      cleanups += 1;
      safe.push({ phase: "cleanup", status: "succeeded", research_tag: resourcePrefixValue });
      continue;
    }
    if (event.phase === "runtime_change_e2e" && event.status === "succeeded") {
      terminals += 1;
      safe.push({ phase: "runtime_change_e2e", status: "succeeded" });
    }
  }
  if (resources !== 1 || cleanups !== 1 || terminals !== 1) {
    throw new Error("evaluator cycle did not prove one leased resource and cleanup");
  }
  return safe;
}

async function appendStructuredEvents(path, events) {
  if (events.length === 0) return;
  await appendFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    encoding: "utf8",
  });
}

async function currentTreeSha() {
  const lookedUp = await run("git", ["rev-parse", "HEAD^{tree}"], { label: "git tree lookup" });
  if (lookedUp.code !== 0) throw new Error("git tree lookup failed");
  return lookedUp.stdout.trim();
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
    const events = checkedOutput(cleaned, input.env);
    const matches = events.filter((candidate) => candidate.phase === "research_cleanup");
    if (matches.length !== 1) throw new Error("research cleanup did not return one result");
    const event = matches[0];
    if (!event || event.status !== "succeeded" || event.complete !== true) {
      throw new Error("research cleanup was not proven");
    }
    const ledger = validateCleanupLedger(event);
    if (input.snapshot && !ledger.snapshots.some((item) => item.name === input.snapshot && item.deleted)) {
      throw new Error("research cleanup did not prove its image deletion");
    }
    return {
      ...ledger,
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
  const snapshotName = process.env.BOX_STARTUP_RESEARCH_SNAPSHOT_NAME?.trim();
  if (!snapshotName || !SNAPSHOT_PATTERN.test(snapshotName)) {
    throw new Error("research snapshot identity is not configured");
  }
  const expiresAt = Date.parse(lease.expiresAt);

  const env = safeEnvironment(process.env);
  const logRoot = process.env.BOX_STARTUP_RESEARCH_LOG_DIRECTORY?.trim()
    || resolve(".context/autoresearch/box-startup", lease.runId);
  const runDirectory = resolve(logRoot, lease.candidateId);
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
        BOX_STARTUP_RESEARCH_SNAPSHOT_NAME: snapshotName,
      },
      label: "research image bake",
    });
    const imageEvent = sanitizeImageEvent(checkedOutput(baked, env), lease.treeSha, snapshotName);
    snapshot = imageEvent.image;
    bakeDurationMs = imageEvent.duration_ms;
    if (imageEvent.snapshot_size_bytes !== undefined) {
      snapshotSizeBytes = imageEvent.snapshot_size_bytes;
    }
    await appendStructuredEvents(logPath, [imageEvent]);

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
        label: `benchmark cycle ${index + 1}`,
      });
      const events = sanitizeCycleEvents(checkedOutput(cycle, env), lease.resourcePrefix);
      const contents = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      cycleContents += contents;
      await appendStructuredEvents(logPath, events);
    }
    benchmark = summarizeBoxRuntimeBenchmark(cycleContents, lease.cycles);
  } catch (error) {
    primaryError = error;
  }

  const cleanupLedger = await cleanup({
    env,
    companionIds: [bakerCompanionId, ...companionIds],
    snapshot,
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
  };
  if (snapshotSizeBytes !== undefined) result.snapshotSizeBytes = snapshotSizeBytes;
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
