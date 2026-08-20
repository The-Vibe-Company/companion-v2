#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { ConductorCloudClient } from "./conductor-client.mjs";
import {
  assertSafeEvaluatorOutput,
  cleanupEnvironment,
  evaluatorRuntimeEnvironment,
  safeEnvironment,
} from "./benchmark.mjs";
import { evaluatorChecksum } from "./evaluator-integrity.mjs";
import {
  benchmarkScore,
  BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
  candidateBeatsIncumbent,
  deterministicCompanionId,
  isFinalSloSatisfied,
  leaseTokenHash,
  parseSentinel,
  providerDriftDetected,
  providerGuardrailsSatisfied,
  resourcePrefix,
  RESULT_SENTINEL,
  REVIEW_SENTINEL,
  SUBMISSION_SENTINEL,
  validateCandidateResult,
  validateCandidateSubmission,
  validateCampaignConfig,
  validateCleanupLedger,
} from "./contracts.mjs";
import { assertNoCredentialMaterial, validateCandidateDiff } from "./policy.mjs";

const execFile = promisify(execFileCallback);
const POLL_MS = 2_000;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HYPOTHESES = [
  "Move immutable Skill preparation or digest work from resume to the pre-archive Stop path.",
  "Replace restored Skill-tree traversal with a revision-bound constant-time proof.",
  "Remove metadata writes and redundant chmod/stat work that faults snapshot pages during restore.",
  "Collapse Box identity, layout and runnable probes without weakening exact-id validation.",
  "Reduce control-bundle construction, transfer and atomic apply work on unchanged configuration.",
  "Make Pi activation consume the warm playbook/cache without a competing provider command.",
  "Challenge whether broker preflight and prompt ACK can share one safe serialized command.",
  "Move regenerable cache warming to bake or Stop while keeping cold creation correct.",
  "Reduce provider round trips on known-id resume and unchanged layout without temporal caching.",
  "Preserve more immutable prepared state across archive while expunging every credential.",
  "Challenge staging order so independent safe work overlaps but restore paging remains unopposed.",
  "Profile and remove the single largest remaining synchronous disk or provider bottleneck.",
];

function nowRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14).toLowerCase();
  return `bsr-${stamp}-${createHash("sha256").update(String(now.getTime())).digest("hex").slice(0, 6)}`;
}

async function command(name, args, options = {}) {
  const { stdout } = await execFile(name, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

async function atomicJson(path, value) {
  const temporary = `${path}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function leaseJournalEvent(state, event, lease, cleanupProven = null) {
  state.leaseJournal ??= [];
  state.leaseJournal.push({
    event,
    at: new Date().toISOString(),
    candidateId: lease.candidateId,
    phase: lease.phase,
    resourcePrefix: lease.resourcePrefix,
    tokenHash: lease.tokenHash,
    ...(cleanupProven === null ? {} : { cleanupProven }),
  });
}

async function settleLease(state, cleanupProven) {
  const lease = state.activeLease;
  if (!lease) return;
  if (cleanupProven) {
    leaseJournalEvent(state, "released", lease, true);
    state.activeLease = null;
  } else {
    lease.cleanupStatus = "blocked";
    state.status = "blocked-cleanup";
    leaseJournalEvent(state, "blocked_cleanup", lease, false);
  }
  await state.save();
}

async function recordResult(state, result) {
  assertNoCredentialMaterial(result, process.env);
  const key = `${result.candidateId}:${result.phase}:${result.treeSha}`;
  state.cleanupLedger ??= [];
  if (!state.cleanupLedger.some((entry) => entry.key === key)) {
    state.cleanupLedger.push({ key, ...result.cleanup });
  }
  const metricsPath = resolve(
    ".context/autoresearch/box-startup",
    state.runId,
    "metrics.jsonl",
  );
  let existing = "";
  try {
    existing = await readFile(metricsPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const alreadyRecorded = existing.split(/\r?\n/).some((line) => {
    try {
      const value = JSON.parse(line);
      return `${value.candidateId}:${value.phase}:${value.treeSha}` === key;
    } catch {
      return false;
    }
  });
  if (!alreadyRecorded) await appendFile(metricsPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
}

function candidateId(wave, index) {
  return `w${wave}-c${index}`;
}

function branchName(runId, id) {
  return `autoresearch/${runId}/${id}`;
}

async function ensureRemoteBranch(baseSha, branch) {
  const reference = `refs/heads/${branch}`;
  const existing = await command("git", ["ls-remote", "--heads", "origin", reference]);
  if (!existing) {
    await command("git", ["push", "origin", `${baseSha}:${reference}`]);
    return;
  }
  await command("git", ["fetch", "origin", branch]);
  const remoteSha = await command("git", ["rev-parse", `origin/${branch}`]);
  const valid = await command("git", [
    "merge-base", "--is-ancestor", baseSha, remoteSha,
  ]).then(() => true, () => false);
  if (!valid) throw new Error(`existing research branch is not based on ${baseSha}`);
}

function tokenFor(state, id) {
  if (!/^[a-f0-9]{64}$/.test(state.leaseSeed ?? "")) {
    throw new Error("campaign lease seed is missing or invalid");
  }
  return createHmac("sha256", state.leaseSeed)
    .update(`${state.controllerWorkspaceId}:${state.runId}:${id}:${state.baseSha}`)
    .digest("base64url");
}

async function gitTreeSha(commit) {
  return await command("git", ["rev-parse", `${commit}^{tree}`]);
}

async function assertEvaluatorChecksum(state) {
  if (await evaluatorChecksum() !== state.evaluatorChecksum) {
    throw new Error("research evaluator changed during the campaign");
  }
}

function messageId(runId, candidate, purpose) {
  const digest = createHash("sha256").update(`${runId}:${candidate}:${purpose}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function waitForSentinel(input) {
  const deadline = Date.now() + input.timeoutMs;
  let idlePolls = 0;
  while (Date.now() < deadline) {
    const messages = await input.client.sessionMessages(input.sessionId);
    const values = parseSentinel(messages, input.sentinel, input.validate);
    const match = [...values].reverse().find(input.matches);
    if (match) return match;
    const status = await input.client.sessionStatus(input.sessionId);
    if (["failed", "cancelled", "archived"].includes(status)) {
      throw new Error(`Conductor session ended as ${status}`);
    }
    if (["idle", "completed"].includes(status)) {
      idlePolls += 1;
      if (idlePolls >= 3) throw new Error("Conductor session completed without a valid result");
    } else {
      idlePolls = 0;
    }
    await new Promise((resolvePause) => setTimeout(resolvePause, input.pollMs ?? POLL_MS));
  }
  await input.client.cancelSession(input.sessionId).catch(() => undefined);
  throw new Error("Conductor session timed out");
}

async function runProcess(name, args, options = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(name, args, {
      cwd: options.cwd ?? process.cwd(),
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
      label: options.label ?? name,
    }));
  });
}

function benchmarkArgs(state, candidate, phase, cycles, expiresAt) {
  return [
    "--lease-token", tokenFor(state, candidate.id),
    "--run-id", state.runId,
    "--candidate-id", candidate.id,
    "--phase", phase,
    "--resource-prefix", candidate.resourcePrefix,
    "--expires-at", expiresAt,
    "--cycles", String(cycles),
    "--tree-sha", candidate.treeSha,
  ];
}

function evaluatorLogDirectory(state) {
  return resolve(".context/autoresearch/box-startup", state.runId, "evaluator-events");
}

function jsonLines(contents) {
  return contents.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

export function validateControllerBenchmarkResult(value, expected) {
  const result = validateCandidateResult(value);
  if (result.runId !== expected.runId
    || result.candidateId !== expected.candidateId
    || result.phase !== expected.phase
    || result.treeSha !== expected.treeSha
    || result.resourcePrefix !== expected.resourcePrefix
    || result.benchmark.cycles !== expected.cycles
    || !result.cleanup.complete
    || result.cleanup.snapshots.length < 1) {
    throw new Error("controller benchmark result does not match its lease");
  }
  return result;
}

function parseControllerBenchmarkOutput(output, expected, env) {
  assertSafeEvaluatorOutput(output.stdout, env);
  assertSafeEvaluatorOutput(output.stderr, env);
  if (output.code !== 0) throw new Error("controller benchmark failed");
  const values = parseSentinel(output.stdout, RESULT_SENTINEL, validateCandidateResult);
  if (values.length !== 1) throw new Error("controller benchmark did not return one result");
  return validateControllerBenchmarkResult(values[0], expected);
}

function cleanupArgs(lease) {
  const args = [
    "--filter", "@companion/runtime", "exec", "tsx",
    resolve("scripts/box-startup-research/cleanup.ts"),
  ];
  for (let cycle = 1; cycle <= lease.cycles; cycle += 1) {
    args.push("--companion-id", deterministicCompanionId(
      lease.runId ?? lease.resourcePrefix,
      lease.candidateId,
      lease.phase,
      cycle,
    ));
  }
  args.push("--companion-id", deterministicCompanionId(
    lease.runId ?? lease.resourcePrefix,
    lease.candidateId,
    `${lease.phase}-bake`,
    0,
  ));
  args.push("--tree-sha", lease.treeSha);
  return args;
}

async function runControllerCleanup(lease) {
  const env = cleanupEnvironment(process.env);
  const output = await runProcess("pnpm", cleanupArgs(lease), {
    env,
    label: "controller cleanup",
  });
  assertSafeEvaluatorOutput(output.stdout, env);
  assertSafeEvaluatorOutput(output.stderr, env);
  if (output.code !== 0) throw new Error("controller cleanup failed");
  const matches = jsonLines(output.stdout).filter((event) => event.phase === "research_cleanup");
  if (matches.length !== 1 || matches[0].status !== "succeeded") {
    throw new Error("controller cleanup did not return one proof");
  }
  const ledger = validateCleanupLedger(matches[0]);
  if (!ledger.complete) throw new Error("controller cleanup proof is incomplete");
  return ledger;
}

async function removeEvaluatorCheckout(checkout) {
  await command("git", ["worktree", "remove", "--force", checkout]).catch(() => undefined);
  await rm(checkout, { recursive: true, force: true });
}

async function createEvaluatorCheckout(state, candidate, phase) {
  await assertEvaluatorChecksum(state);
  const root = resolve(".context/autoresearch/box-startup", state.runId, "evaluator-checkouts");
  const checkout = resolve(root, `${candidate.id}-${phase}-${candidate.treeSha.slice(0, 12)}`);
  if (dirname(checkout) !== root) throw new Error("evaluator checkout path is invalid");
  await mkdir(root, { recursive: true });
  await removeEvaluatorCheckout(checkout);
  await command("git", ["fetch", "origin", candidate.branch]);
  const fetchedCommit = await command("git", ["rev-parse", `origin/${candidate.branch}`]);
  if (fetchedCommit !== candidate.commitSha || await gitTreeSha(fetchedCommit) !== candidate.treeSha) {
    throw new Error("candidate commit changed after validation");
  }
  await command("git", ["worktree", "add", "--detach", checkout, fetchedCommit]);
  try {
    if (await command("git", ["rev-parse", "HEAD^{tree}"], { cwd: checkout }) !== candidate.treeSha) {
      throw new Error("evaluator checkout tree does not match the candidate");
    }
    if (await evaluatorChecksum(checkout) !== state.evaluatorChecksum) {
      throw new Error("evaluator checksum does not match the candidate checkout");
    }
    const [controllerLockfile, checkoutLockfile] = await Promise.all([
      readFile(resolve("pnpm-lock.yaml")),
      readFile(resolve(checkout, "pnpm-lock.yaml")),
    ]);
    if (!controllerLockfile.equals(checkoutLockfile)) {
      throw new Error("candidate checkout lockfile changed");
    }
    const installed = await runProcess("pnpm", ["install", "--frozen-lockfile", "--offline"], {
      cwd: checkout,
      env: evaluatorRuntimeEnvironment(process.env),
      label: "evaluator dependency install",
    });
    assertSafeEvaluatorOutput(installed.stdout, process.env);
    assertSafeEvaluatorOutput(installed.stderr, process.env);
    if (installed.code !== 0) throw new Error("evaluator dependency install failed");
    if (await command("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: checkout })) {
      throw new Error("evaluator dependency install modified the candidate checkout");
    }
    if (await evaluatorChecksum(checkout) !== state.evaluatorChecksum) {
      throw new Error("evaluator changed during dependency installation");
    }
    return checkout;
  } catch (error) {
    await removeEvaluatorCheckout(checkout);
    throw error;
  }
}

export async function executeControllerBenchmark(state, candidate, phase, cycles) {
  const checkout = await createEvaluatorCheckout(state, candidate, phase);
  const expiresAt = state.activeLease?.candidateId === candidate.id
    && state.activeLease.phase === phase
    ? state.activeLease.expiresAt
    : new Date(Date.now() + state.config.leaseDurationMs).toISOString();
  const expected = {
    runId: state.runId,
    candidateId: candidate.id,
    phase,
    treeSha: candidate.treeSha,
    resourcePrefix: candidate.resourcePrefix,
    cycles,
  };
  const env = safeEnvironment(process.env, {
    leaseTokenHash: leaseTokenHash(tokenFor(state, candidate.id)),
    evaluatorChecksum: state.evaluatorChecksum,
    logDirectory: evaluatorLogDirectory(state),
  });
  try {
    const output = await runProcess("node", [
      resolve(checkout, "scripts/box-startup-research/benchmark.mjs"),
      ...benchmarkArgs(state, candidate, phase, cycles, expiresAt),
    ], {
      cwd: checkout,
      env,
      label: "controller benchmark",
    });
    return parseControllerBenchmarkOutput(output, expected, env);
  } finally {
    await removeEvaluatorCheckout(checkout);
  }
}

async function executeLocalBenchmark(state, candidate, phase, cycles, expiresAt) {
  const env = safeEnvironment(process.env, {
    leaseTokenHash: leaseTokenHash(tokenFor(state, candidate.id)),
    evaluatorChecksum: state.evaluatorChecksum,
    logDirectory: evaluatorLogDirectory(state),
  });
  const expected = {
    runId: state.runId,
    candidateId: candidate.id,
    phase,
    treeSha: candidate.treeSha,
    resourcePrefix: candidate.resourcePrefix,
    cycles,
  };
  const output = await runProcess("node", [
    resolve("scripts/box-startup-research/benchmark.mjs"),
    ...benchmarkArgs(state, candidate, phase, cycles, expiresAt),
  ], {
    env,
    label: "controller baseline benchmark",
  });
  return parseControllerBenchmarkOutput(output, expected, env);
}

async function localBenchmark(state, phase, cycles) {
  await assertEvaluatorChecksum(state);
  const id = phase;
  const treeSha = await gitTreeSha(state.baseSha);
  const candidate = { id, treeSha, resourcePrefix: resourcePrefix(state.runId, id) };
  const token = tokenFor(state, id);
  const expiresAt = new Date(Date.now() + state.config.leaseDurationMs).toISOString();
  assertLeaseAvailable(state.activeLease, id, phase);
  state.activeLease = {
    runId: state.runId,
    candidateId: id,
    phase,
    cycles,
    treeSha,
    local: true,
    expiresAt,
    resourcePrefix: candidate.resourcePrefix,
    tokenHash: leaseTokenHash(token),
  };
  leaseJournalEvent(state, "granted", state.activeLease);
  await state.save();
  let cleanupProven = false;
  try {
    const result = await executeLocalBenchmark(state, candidate, phase, cycles, expiresAt);
    cleanupProven = true;
    await recordResult(state, result);
    return result;
  } catch (error) {
    try {
      await runControllerCleanup(state.activeLease);
      cleanupProven = true;
    } catch {
      throw new Error("controller cleanup proof is incomplete");
    }
    throw error;
  } finally {
    await settleLease(state, cleanupProven);
  }
}

function explorationPrompt(program, state, candidate, hypothesis, previous) {
  const prompt = `${program}\n\n## This experiment\n\n`
    + `runId: ${state.runId}\n`
    + `candidateId: ${candidate.id}\n`
    + `baseSha: ${candidate.baseSha}\n`
    + `hypothesis: ${hypothesis}\n\n`
    + `Previous measured results (no credentials):\n${JSON.stringify(previous, null, 2)}\n\n`
    + "Do not call Conductor or launch sub-workspaces. Work only on this hypothesis.";
  assertNoCredentialMaterial(prompt, process.env);
  return prompt;
}

export function candidateWorkspaceEnvironment(input) {
  return {
    BOX_API_KEY: "",
    COMPANION_BOX_API_KEY: "",
    ZAI_API_KEY: "",
    COMPANION_BOX_E2E_ZAI_API_KEY: "",
    BOX_STARTUP_RESEARCH_RUN_ID: input.runId,
    BOX_STARTUP_RESEARCH_CANDIDATE_ID: input.candidateId,
    BOX_STARTUP_RESEARCH_RESOURCE_PREFIX: input.resourcePrefix,
  };
}

async function createCandidate(input) {
  await ensureRemoteBranch(input.baseSha, input.branch);
  const created = await input.client.createWorkspace({
    projectId: input.state.projectId,
    branch: input.branch,
    name: `${input.state.runId} ${input.id}`,
    sessionName: `Explore ${input.id}`,
    model: "gpt-5.6-luna",
    effort: "high",
    messageId: messageId(input.state.runId, input.id, "explore"),
    message: explorationPrompt(input.program, input.state, input, input.hypothesis, input.previous),
    environment: candidateWorkspaceEnvironment({
      runId: input.state.runId,
      candidateId: input.id,
      resourcePrefix: input.resourcePrefix,
    }),
  });
  return {
    id: input.id,
    wave: input.wave,
    branch: input.branch,
    baseSha: input.baseSha,
    hypothesis: input.hypothesis,
    resourcePrefix: input.resourcePrefix,
    ...created,
    status: "exploring",
    results: [],
  };
}

async function collectSubmission(state, client, candidate, integration = false) {
  const submission = await waitForSentinel({
    client,
    sessionId: candidate.sessionId,
    sentinel: SUBMISSION_SENTINEL,
    validate: validateCandidateSubmission,
    matches: (value) => value.runId === state.runId && value.candidateId === candidate.id,
    timeoutMs: state.config.candidateTimeoutMs,
  });
  assertNoCredentialMaterial(submission, process.env);
  await command("git", ["fetch", "origin", candidate.branch]);
  const remoteSha = await command("git", ["rev-parse", `origin/${candidate.branch}`]);
  if (remoteSha !== submission.commitSha || submission.baseSha !== candidate.baseSha) {
    throw new Error("candidate submission does not match its remote branch");
  }
  await validateCandidateDiff({
    cwd: process.cwd(),
    baseSha: candidate.baseSha,
    commitSha: submission.commitSha,
    env: process.env,
    integration,
  });
  return { ...candidate, submission, commitSha: remoteSha, treeSha: await gitTreeSha(remoteSha), status: "ready" };
}

export async function recoverCandidateResources(state, client, candidate, phase, cycles, options = {}) {
  await client.cancelSession(candidate.sessionId).catch(() => undefined);
  return await (options.cleanup ?? runControllerCleanup)({
    runId: state.runId,
    candidateId: candidate.id,
    phase,
    cycles,
    treeSha: candidate.treeSha,
    resourcePrefix: candidate.resourcePrefix,
  });
}

export function assertLeaseAvailable(activeLease, candidateId, phase) {
  if (activeLease !== null && activeLease !== undefined) {
    throw new Error(`provider lease is already held by ${activeLease.candidateId}:${activeLease.phase}`);
  }
  if (!candidateId || !phase) throw new Error("provider lease identity is invalid");
}

export async function grantBenchmark(state, client, candidate, phase, cycles, options = {}) {
  await (options.assertEvaluatorChecksum ?? assertEvaluatorChecksum)(state);
  assertLeaseAvailable(state.activeLease, candidate.id, phase);
  const expiresAt = new Date(Date.now() + state.config.leaseDurationMs).toISOString();
  state.activeLease = {
    runId: state.runId,
    candidateId: candidate.id,
    phase,
    cycles,
    treeSha: candidate.treeSha,
    expiresAt,
    resourcePrefix: candidate.resourcePrefix,
    tokenHash: leaseTokenHash(tokenFor(state, candidate.id)),
  };
  leaseJournalEvent(state, "granted", state.activeLease);
  await state.save();
  let cleanupProven = false;
  try {
    const result = await (options.execute ?? executeControllerBenchmark)(state, candidate, phase, cycles);
    validateControllerBenchmarkResult(result, {
      runId: state.runId,
      candidateId: candidate.id,
      phase,
      treeSha: candidate.treeSha,
      resourcePrefix: candidate.resourcePrefix,
      cycles,
    });
    cleanupProven = true;
    await (options.recordResult ?? recordResult)(state, result);
    return result;
  } catch (error) {
    if (!cleanupProven) {
      try {
        await (options.recover ?? recoverCandidateResources)(state, client, candidate, phase, cycles);
        cleanupProven = true;
      } catch {
        throw new Error("controller cleanup proof is incomplete");
      }
    }
    throw error;
  } finally {
    await settleLease(state, cleanupProven);
  }
}

async function repairIntegration(state, client, integration, attempt, evidence) {
  await client.sendMessage({
    sessionId: integration.sessionId,
    messageId: messageId(state.runId, integration.id, `repair-${attempt}`),
    message: "The final integration did not yet pass its performance/correctness gate. Inspect the "
      + "safe metrics below, make one bounded corrective pass, run affected tests and pnpm verify:change, "
      + "commit and push. Do not benchmark until the next grant. Return a new submission sentinel.\n\n"
      + `${JSON.stringify(evidence ?? { outcome: "integration_gate_failed" }, null, 2)}`,
  });
  return await collectSubmission({ ...state, baseSha: integration.baseSha }, client, integration, true);
}

async function mergeLatestMain(state, client, integration) {
  await command("git", ["fetch", "origin", "main"]);
  const latestMain = await command("git", ["rev-parse", "origin/main"]);
  const alreadyBased = await command("git", [
    "merge-base", "--is-ancestor", latestMain, integration.commitSha,
  ]).then(() => true, () => false);
  if (alreadyBased) return integration;
  await client.sendMessage({
    sessionId: integration.sessionId,
    messageId: messageId(state.runId, integration.id, `merge-main-${latestMain.slice(0, 12)}`),
    message: `Fetch origin and merge origin/main (${latestMain}) into this integration branch. `
      + "Resolve conflicts without weakening features or tests, run affected tests and pnpm verify:change, "
      + `commit/push if needed, then return a submission sentinel with baseSha ${latestMain}. `
      + "Do not run the provider benchmark.",
  });
  return await collectSubmission(
    { ...state, baseSha: latestMain },
    client,
    { ...integration, baseSha: latestMain },
    true,
  );
}

function paretoFinalists(candidates) {
  const eligible = candidates.filter((candidate) => candidate.quick?.cleanup.complete);
  const frontier = eligible.filter((candidate) => !eligible.some((other) => {
    if (other === candidate) return false;
    const left = other.quick.benchmark.metrics;
    const right = candidate.quick.benchmark.metrics;
    return left.ready_to_prompt_ack.p50_ms <= right.ready_to_prompt_ack.p50_ms
      && left.resume_ready_to_prompt_ack.p50_ms <= right.resume_ready_to_prompt_ack.p50_ms
      && (left.ready_to_prompt_ack.p50_ms < right.ready_to_prompt_ack.p50_ms
        || left.resume_ready_to_prompt_ack.p50_ms < right.resume_ready_to_prompt_ack.p50_ms);
  }));
  return [...frontier, ...eligible]
    .filter((candidate, index, all) => all.findIndex((item) => item.id === candidate.id) === index)
    .sort((left, right) => benchmarkScore(left.quick.benchmark) - benchmarkScore(right.quick.benchmark))
    .slice(0, 2);
}

function integrationPrompt(program, state, finalists) {
  const prompt = `${program}\n\n## Sol integration override\n\n`
    + "You are the final arbiter and integrator. You may add or update tests under the three runtime "
    + "source roots and may update docs/design.md, docs/companions-runtime.md, and docs/testing.md. "
    + "The evaluator and public/API/DB/auth surfaces remain protected. Start from this clean branch, "
    + "inspect the finalist branches, combine only compatible measured gains, clean experimental code, "
    + "run affected tests and pnpm verify:change, commit and push. Do not benchmark before a grant.\n\n"
    + `runId: ${state.runId}\ncandidateId: sol-integration\nbaseSha: ${state.baseSha}\n`
    + `Finalists:\n${JSON.stringify(finalists.map((item) => ({
      id: item.id,
      branch: item.branch,
      commitSha: item.commitSha,
      hypothesis: item.submission.hypothesis,
      quick: item.quick.benchmark,
      confirm: item.confirm?.benchmark,
    })), null, 2)}\n\n`
    + "End with the normal BOX_STARTUP_RESEARCH_SUBMISSION line using candidateId sol-integration.";
  assertNoCredentialMaterial(prompt, process.env);
  return prompt;
}

async function createIntegration(state, client, program, finalists) {
  const id = "sol-integration";
  const branch = branchName(state.runId, id);
  await command("git", ["fetch", "origin", "main"]);
  const baseSha = await command("git", ["rev-parse", "origin/main"]);
  await ensureRemoteBranch(baseSha, branch);
  const created = await client.createWorkspace({
    projectId: state.projectId,
    branch,
    name: `${state.runId} Sol integration`,
    sessionName: "Arbitrate and integrate finalists",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    messageId: messageId(state.runId, id, "integrate"),
    message: integrationPrompt(program, { ...state, baseSha }, finalists),
    environment: candidateWorkspaceEnvironment({
      runId: state.runId,
      candidateId: id,
      resourcePrefix: resourcePrefix(state.runId, id),
    }),
  });
  const candidate = {
    id,
    branch,
    baseSha,
    hypothesis: "Sol consolidation of measured finalists",
    resourcePrefix: resourcePrefix(state.runId, id),
    ...created,
    results: [],
  };
  const submitted = await collectSubmission({ ...state, baseSha }, client, candidate, true);
  return submitted;
}

async function reviewIntegration(state, client, integration, attempt = 0) {
  const review = await client.createSession({
    workspaceId: integration.workspaceId,
    model: "gpt-5.6-sol",
    effort: "xhigh",
    name: "Final invariant review",
    messageId: messageId(state.runId, integration.id, `review-${attempt}`),
    message: "Review the integration read-only against program.md and the runtime invariants. "
      + "Return exactly one line: BOX_STARTUP_RESEARCH_REVIEW {\"blocking\":false,\"summary\":\"...\"}. "
      + "Set blocking true for any P0-P2 correctness, security, cleanup, evaluator, or feature regression.",
  });
  const validateReview = (value) => {
    if (!value || typeof value !== "object" || typeof value.blocking !== "boolean"
      || typeof value.summary !== "string") throw new Error("invalid review");
    const validated = { blocking: value.blocking, summary: value.summary.slice(0, 2_000) };
    assertNoCredentialMaterial(validated, process.env);
    return validated;
  };
  return await waitForSentinel({
    client,
    sessionId: review.sessionId,
    sentinel: REVIEW_SENTINEL,
    validate: validateReview,
    matches: () => true,
    timeoutMs: state.config.candidateTimeoutMs,
  });
}

async function openReadyPullRequest(state, integration, finalResult) {
  const title = "perf(runtime): accelerate Box startup through autoresearch";
  const body = [
    "## Summary",
    "",
    "Automated Box startup research integration selected from measured Luna candidates and audited by Sol.",
    "",
    "## Final benchmark",
    "",
    `- create ready → ACK P95: ${finalResult.benchmark.metrics.ready_to_prompt_ack.p95_ms} ms`,
    `- resume ready → ACK P95: ${finalResult.benchmark.metrics.resume_ready_to_prompt_ack.p95_ms} ms`,
    `- cycles: ${finalResult.benchmark.cycles}`,
    `- campaign: ${state.runId}`,
    "",
    "All disposable Boxes and research snapshots were cleanup-proven.",
  ].join("\n");
  let pullRequest = await command("gh", [
    "pr", "view", integration.branch, "--json", "number,isDraft,headRefOid",
  ]).then((value) => JSON.parse(value), () => null);
  if (!pullRequest) {
    await command("gh", [
      "pr", "create", "--draft", "--base", "main", "--head", integration.branch,
      "--title", title, "--body", body,
    ]);
    pullRequest = JSON.parse(await command("gh", [
      "pr", "view", integration.branch, "--json", "number,isDraft,headRefOid",
    ]));
  }
  if (pullRequest.headRefOid !== integration.commitSha) {
    throw new Error("pull request head does not match the validated integration commit");
  }
  await command("gh", ["pr", "checks", integration.branch, "--watch", "--fail-fast"]);
  if (pullRequest.isDraft) await command("gh", ["pr", "ready", integration.branch]);
}

async function writeReport(state, runDirectory) {
  const candidates = state.candidates ?? [];
  const lines = [
    `# Box startup research ${state.runId}`,
    "",
    `Status: ${state.status}`,
    `Base: ${state.baseSha}`,
    `Incumbent: ${state.incumbentSha}`,
    "",
    "| Candidate | Hypothesis | Quick score | Confirm score | Workspace |",
    "|---|---|---:|---:|---|",
    ...candidates.map((candidate) => `| ${candidate.id} | ${candidate.hypothesis.replaceAll("|", "\\|")} | ${
      candidate.quick ? benchmarkScore(candidate.quick.benchmark) : "-"
    } | ${candidate.confirm ? benchmarkScore(candidate.confirm.benchmark, "p95_ms") : "-"} | ${
      candidate.deepLink ? `[open](${candidate.deepLink})` : "-"
    } |`),
    "",
  ];
  await writeFile(resolve(runDirectory, "report.md"), `${lines.join("\n")}\n`);
}

async function cleanupWorkspaceAndBranch(state, client, candidate, keepBranch = false) {
  state.orchestrationCleanup ??= [];
  const existing = state.orchestrationCleanup.find((entry) => entry.id === candidate.id);
  const entry = existing ?? { id: candidate.id, workspaceArchived: false, branchDeleted: false };
  if (!existing) state.orchestrationCleanup.push(entry);
  if (candidate.workspaceId && !entry.workspaceArchived) {
    await client.archiveWorkspace(candidate.workspaceId);
    entry.workspaceArchived = true;
  }
  if (keepBranch) {
    entry.branchDeleted = false;
    entry.branchRetainedForPullRequest = true;
  } else if (candidate.branch && !entry.branchDeleted) {
    await command("git", ["push", "origin", "--delete", candidate.branch]).catch(() => undefined);
    const remaining = await command("git", [
      "ls-remote", "--heads", "origin", `refs/heads/${candidate.branch}`,
    ]);
    if (remaining) throw new Error(`temporary branch cleanup was not proven: ${candidate.branch}`);
    entry.branchDeleted = true;
  }
  await state.save();
}

function createState(value, path) {
  const state = value;
  Object.defineProperty(state, "save", {
    enumerable: false,
    value: async () => await atomicJson(path, state),
  });
  return state;
}

function validateActiveLease(value, runId) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.runId !== runId
    || typeof value.candidateId !== "string" || !RUN_ID_PATTERN.test(value.candidateId)
    || !["baseline-start", "baseline-end", "quick", "confirm", "final"].includes(value.phase)
    || !Number.isSafeInteger(value.cycles) || value.cycles < 1 || value.cycles > 20
    || !SHA_PATTERN.test(value.treeSha ?? "")
    || value.resourcePrefix !== resourcePrefix(runId, value.candidateId)
    || !/^[a-f0-9]{64}$/.test(value.tokenHash ?? "")
    || !Number.isFinite(Date.parse(value.expiresAt ?? ""))
    || (value.local !== undefined && typeof value.local !== "boolean")
    || (value.cleanupStatus !== undefined && !["blocked"].includes(value.cleanupStatus))) {
    throw new Error("persisted active lease is invalid");
  }
}

export function validatePersistedState(value, runId) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== BOX_STARTUP_RESEARCH_SCHEMA_VERSION
    || value.runId !== runId) {
    throw new Error("persisted campaign state identity is invalid");
  }
  value.config = validateCampaignConfig(value.config);
  if (value.config.runId !== runId || value.baseSha !== value.config.baseSha
    || !SHA_PATTERN.test(value.incumbentSha ?? "")
    || !/^[a-f0-9]{64}$/.test(value.evaluatorChecksum ?? "")
    || !/^[a-f0-9]{64}$/.test(value.leaseSeed ?? "")
    || !Array.isArray(value.candidates)) {
    throw new Error("persisted campaign state is invalid");
  }
  for (const candidate of value.candidates) {
    if (!candidate || !/^w[1-4]-c[1-3]$/.test(candidate.id ?? "")
      || candidate.branch !== branchName(runId, candidate.id)
      || candidate.resourcePrefix !== resourcePrefix(runId, candidate.id)
      || !SHA_PATTERN.test(candidate.baseSha ?? "")
      || (candidate.workspaceId !== undefined && !UUID_PATTERN.test(candidate.workspaceId))
      || (candidate.sessionId !== undefined && !UUID_PATTERN.test(candidate.sessionId))
      || (candidate.commitSha !== undefined && !SHA_PATTERN.test(candidate.commitSha))
      || (candidate.treeSha !== undefined && !SHA_PATTERN.test(candidate.treeSha))) {
      throw new Error("persisted candidate state is invalid");
    }
  }
  if (value.integration !== null && value.integration !== undefined) {
    const integration = value.integration;
    if (integration.id !== "sol-integration"
      || integration.branch !== branchName(runId, integration.id)
      || integration.resourcePrefix !== resourcePrefix(runId, integration.id)
      || !UUID_PATTERN.test(integration.workspaceId ?? "")
      || !UUID_PATTERN.test(integration.sessionId ?? "")
      || !SHA_PATTERN.test(integration.baseSha ?? "")
      || !SHA_PATTERN.test(integration.commitSha ?? "")
      || !SHA_PATTERN.test(integration.treeSha ?? "")) {
      throw new Error("persisted integration state is invalid");
    }
  }
  if (value.activeLease !== null && value.activeLease !== undefined) {
    validateActiveLease(value.activeLease, runId);
  }
  return value;
}

async function initialize(runId, runDirectory, client) {
  const status = await command("git", ["status", "--porcelain"]);
  if (status) throw new Error("research controller requires a clean worktree");
  await command("git", ["fetch", "origin", "main"]);
  const baseSha = await command("git", ["rev-parse", "origin/main"]);
  const current = await command("git", ["rev-parse", "HEAD"]);
  if (current !== baseSha) throw new Error("research controller must start at origin/main");
  const workspace = await client.currentWorkspace();
  const config = validateCampaignConfig({
    schemaVersion: BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
    runId,
    baseSha,
    waves: 4,
    candidatesPerWave: 3,
    quickCycles: 3,
    baselineCycles: 3,
    confirmationCycles: 10,
    finalCycles: 10,
    candidateTimeoutMs: 45 * 60_000,
    leaseDurationMs: 45 * 60_000,
    readyToAckSloMs: 5_000,
  });
  const state = createState({
    schemaVersion: 1,
    runId,
    status: "initializing",
    baseSha,
    incumbentSha: baseSha,
    controllerWorkspaceId: workspace.id,
    projectId: workspace.projectId,
    config,
    candidates: [],
    activeLease: null,
    baselineStart: null,
    baselineEnd: null,
    integration: null,
    evaluatorChecksum: await evaluatorChecksum(),
    leaseSeed: randomBytes(32).toString("hex"),
    leaseJournal: [],
    cleanupLedger: [],
  }, resolve(runDirectory, "state.json"));
  await state.save();
  return state;
}

async function retryActiveLeaseCleanup(state, client) {
  const lease = state.activeLease;
  if (!lease) return true;
  try {
    if (lease.local === true) {
      await runControllerCleanup(lease);
      await settleLease(state, true);
      state.status = "interrupted-baseline";
      await state.save();
      return false;
    }
    const interrupted = state.candidates.find((item) => item.id === lease.candidateId)
      ?? (state.integration?.id === lease.candidateId ? state.integration : null);
    if (!interrupted) throw new Error("active lease has no owning workspace");
    await recoverCandidateResources(state, client, interrupted, lease.phase, lease.cycles);
    interrupted.failedPhases ??= [];
    if (!interrupted.failedPhases.includes(lease.phase)) {
      interrupted.failedPhases.push(lease.phase);
    }
    interrupted.status = `rejected_interrupted_${lease.phase}`;
    await settleLease(state, true);
    await state.save();
    return true;
  } catch {
    await settleLease(state, false);
    return false;
  }
}

async function runCampaign() {
  if (!process.argv.includes("--overnight")) {
    throw new Error("pass --overnight to acknowledge the 72-cycle provider campaign");
  }
  const resumeIndex = process.argv.indexOf("--resume");
  const runId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : nowRunId();
  if (!runId || !RUN_ID_PATTERN.test(runId)) throw new Error("--resume requires a valid run id");
  const runDirectory = resolve(".context/autoresearch/box-startup", runId);
  await mkdir(runDirectory, { recursive: true });
  const statePath = resolve(runDirectory, "state.json");
  const client = new ConductorCloudClient({ cwd: process.cwd() });
  const state = resumeIndex >= 0
    ? createState(validatePersistedState(JSON.parse(await readFile(statePath, "utf8")), runId), statePath)
    : await initialize(runId, runDirectory, client);
  const program = await readFile(resolve("scripts/box-startup-research/program.md"), "utf8");
  try {
    if (state.activeLease && !await retryActiveLeaseCleanup(state, client)) return;
    if (!state.baselineStart) {
      state.status = "baseline-start";
      await state.save();
      state.baselineStart = await localBenchmark(state, "baseline-start", state.config.baselineCycles);
      await state.save();
    }
    let incumbentBenchmark = state.baselineStart.benchmark;

    for (let wave = 1; wave <= state.config.waves; wave += 1) {
      state.status = `wave-${wave}`;
      await state.save();
      const waveCandidates = [];
      for (let index = 1; index <= state.config.candidatesPerWave; index += 1) {
        const id = candidateId(wave, index);
        let candidate = state.candidates.find((item) => item.id === id);
        if (!candidate) {
          const hypothesis = HYPOTHESES[(wave - 1) * state.config.candidatesPerWave + index - 1];
          candidate = await createCandidate({
            state,
            client,
            program,
            id,
            wave,
            branch: branchName(state.runId, id),
            baseSha: state.incumbentSha,
            hypothesis,
            resourcePrefix: resourcePrefix(state.runId, id),
            previous: state.candidates.map((item) => ({
              id: item.id,
              hypothesis: item.hypothesis,
              quick: item.quick?.benchmark ?? null,
            })),
          });
          state.candidates.push(candidate);
          await state.save();
        }
        waveCandidates.push(candidate);
      }

      const submitted = [];
      await Promise.all(waveCandidates.map(async (candidate) => {
        if (candidate.commitSha) {
          submitted.push(candidate);
          return;
        }
        try {
          const collected = await collectSubmission(state, client, candidate);
          Object.assign(candidate, collected);
          submitted.push(candidate);
        } catch {
          candidate.status = "rejected_submission";
        }
      }));
      await state.save();

      for (const candidate of submitted) {
        if (candidate.failedPhases?.includes("quick")) continue;
        if (!candidate.quick) {
          try {
            candidate.quick = await grantBenchmark(
              state,
              client,
              candidate,
              "quick",
              state.config.quickCycles,
            );
          } catch {
            if (state.activeLease) {
              state.status = "blocked-cleanup";
              await state.save();
              return;
            }
            candidate.status = "rejected_benchmark";
            await state.save();
            continue;
          }
          await state.save();
        }
        if (candidateBeatsIncumbent(candidate.quick.benchmark, incumbentBenchmark)) {
          state.incumbentSha = candidate.commitSha;
          incumbentBenchmark = candidate.quick.benchmark;
          candidate.promoted = true;
          await state.save();
        }
      }
    }

    const finalists = paretoFinalists(state.candidates);
    if (finalists.length === 0) throw new Error("no candidate passed quick evaluation");
    state.finalists = finalists.map((candidate) => candidate.id);
    const confirmedFinalists = [];
    for (const finalist of finalists) {
      if (finalist.failedPhases?.includes("confirm")) continue;
      if (!finalist.confirm) {
        try {
          finalist.confirm = await grantBenchmark(
            state,
            client,
            finalist,
            "confirm",
            state.config.confirmationCycles,
          );
        } catch {
          if (state.activeLease) {
            state.status = "blocked-cleanup";
            await state.save();
            return;
          }
          finalist.status = "rejected_confirmation";
          await state.save();
          continue;
        }
        await state.save();
      }
      confirmedFinalists.push(finalist);
    }
    if (confirmedFinalists.length === 0) throw new Error("no finalist passed confirmation");

    if (!state.baselineEnd) {
      state.baselineEnd = await localBenchmark(state, "baseline-end", state.config.baselineCycles);
      await state.save();
    }
    if (providerDriftDetected(state.baselineStart.benchmark, state.baselineEnd.benchmark)) {
      state.status = "provider-drift";
      await state.save();
      return;
    }

    if (!state.integration) {
      state.status = "sol-integration";
      await state.save();
      state.integration = await createIntegration(state, client, program, confirmedFinalists);
      await state.save();
    }
    let integration = state.integration;
    let review = null;
    for (let reviewAttempt = 0; reviewAttempt <= 2; reviewAttempt += 1) {
      integration = await mergeLatestMain(state, client, integration);
      state.integration = integration;
      await state.save();
      review = await reviewIntegration(state, client, integration, reviewAttempt);
      if (!review.blocking) break;
      if (reviewAttempt === 2) break;
      const repaired = await repairIntegration(state, client, integration, reviewAttempt + 1, review);
      Object.assign(integration, repaired, { final: null });
      state.integration = integration;
      await state.save();
    }
    integration.review = review;
    if (!review || review.blocking) {
      state.status = "blocked-by-review";
      await state.save();
      return;
    }
    if (!integration.final || integration.final.treeSha !== integration.treeSha) {
      if (integration.failedPhases?.includes("final")) {
        state.status = "completed-without-pr";
        await state.save();
        return;
      }
      try {
        integration.final = await grantBenchmark(
          state,
          client,
          integration,
          "final",
          state.config.finalCycles,
        );
      } catch {
        if (state.activeLease) {
          state.status = "blocked-cleanup";
          await state.save();
          return;
        }
        integration.final = null;
      }
      await state.save();
    }
    if (!integration.final) {
      state.status = "completed-without-pr";
      await state.save();
      return;
    }
    if (!isFinalSloSatisfied(integration.final.benchmark, state.config.readyToAckSloMs)
      || !providerGuardrailsSatisfied(integration.final.benchmark, state.baselineEnd.benchmark)) {
      state.status = "completed-without-pr";
      await state.save();
      return;
    }
    state.status = "opening-pr";
    await state.save();
    await openReadyPullRequest(state, integration, integration.final);
    state.status = "pr-ready";
    await state.save();
  } finally {
    for (const candidate of state.candidates ?? []) {
      await cleanupWorkspaceAndBranch(state, client, candidate).catch(() => undefined);
    }
    if (state.integration) {
      await cleanupWorkspaceAndBranch(
        state,
        client,
        state.integration,
        state.status === "pr-ready",
      ).catch(() => undefined);
    }
    await writeReport(state, runDirectory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCampaign().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "research campaign failed"}\n`);
    process.exitCode = 1;
  });
}
