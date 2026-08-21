import { createHash } from "node:crypto";

export const BOX_STARTUP_RESEARCH_SCHEMA_VERSION = 1;
export const SUBMISSION_SENTINEL = "BOX_STARTUP_RESEARCH_SUBMISSION ";
export const RESULT_SENTINEL = "BOX_STARTUP_RESEARCH_RESULT ";
export const REVIEW_SENTINEL = "BOX_STARTUP_RESEARCH_REVIEW ";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class ResearchContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResearchContractError";
  }
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchContractError(`${label} must be an object`);
  }
  return value;
}

function string(value, label, pattern, maximum = 10_000) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new ResearchContractError(`${label} must be a non-empty bounded string`);
  }
  if (pattern && !pattern.test(value)) throw new ResearchContractError(`${label} is invalid`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ResearchContractError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new ResearchContractError(`${label} must be boolean`);
  return value;
}

function version(value, label) {
  if (value !== BOX_STARTUP_RESEARCH_SCHEMA_VERSION) {
    throw new ResearchContractError(`${label} schema version is unsupported`);
  }
  return value;
}

export function resourcePrefix(runId, candidateId) {
  const digest = createHash("sha256").update(`${runId}:${candidateId}`).digest("hex").slice(0, 16);
  return `box-startup-${digest}`;
}

export function leaseTokenHash(token) {
  return createHash("sha256").update(string(token, "lease token", /^[A-Za-z0-9_-]{32,128}$/)).digest("hex");
}

export function validateCampaignConfig(value) {
  const input = record(value, "campaign config");
  version(input.schemaVersion, "campaign config");
  return {
    schemaVersion: BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
    runId: string(input.runId, "run id", ID_PATTERN),
    baseSha: string(input.baseSha, "base sha", SHA_PATTERN),
    waves: integer(input.waves, "waves", 1, 12),
    candidatesPerWave: integer(input.candidatesPerWave, "candidates per wave", 1, 8),
    quickCycles: integer(input.quickCycles, "quick cycles", 1, 10),
    baselineCycles: integer(input.baselineCycles, "baseline cycles", 1, 10),
    confirmationCycles: integer(input.confirmationCycles, "confirmation cycles", 1, 20),
    finalCycles: integer(input.finalCycles, "final cycles", 1, 20),
    candidateTimeoutMs: integer(input.candidateTimeoutMs, "candidate timeout", 60_000, 7_200_000),
    leaseDurationMs: integer(input.leaseDurationMs, "lease duration", 60_000, 7_200_000),
    readyToAckSloMs: integer(input.readyToAckSloMs, "ready-to-ack SLO", 100, 180_000),
  };
}

export function validateCandidateSubmission(value) {
  const input = record(value, "candidate submission");
  version(input.schemaVersion, "candidate submission");
  return {
    schemaVersion: BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
    runId: string(input.runId, "run id", ID_PATTERN),
    candidateId: string(input.candidateId, "candidate id", ID_PATTERN),
    baseSha: string(input.baseSha, "base sha", SHA_PATTERN),
    commitSha: string(input.commitSha, "commit sha", SHA_PATTERN),
    hypothesis: string(input.hypothesis, "hypothesis", undefined, 2_000),
    summary: string(input.summary, "summary", undefined, 4_000),
    checks: Array.isArray(input.checks)
      ? input.checks.map((check, index) => string(check, `check ${index}`, undefined, 500))
      : (() => { throw new ResearchContractError("checks must be an array"); })(),
  };
}

function metric(value, label) {
  const input = record(value, label);
  return {
    samples: integer(input.samples, `${label} samples`, 1, 100),
    p50_ms: integer(input.p50_ms, `${label} p50`, 0, 3_600_000),
    p95_ms: integer(input.p95_ms, `${label} p95`, 0, 3_600_000),
  };
}

function diagnostic(value, label) {
  const input = record(value, label);
  return {
    samples: integer(input.samples, `${label} samples`, 1, 100),
    p50: integer(input.p50, `${label} p50`, 0, Number.MAX_SAFE_INTEGER),
    p95: integer(input.p95, `${label} p95`, 0, Number.MAX_SAFE_INTEGER),
  };
}

function stagingModes(value, label) {
  const input = record(value, label);
  const result = {};
  for (const mode of ["refresh", "skills"]) {
    if (input[mode] !== undefined) result[mode] = integer(input[mode], `${label} ${mode}`, 0, 100);
  }
  if (Object.keys(result).length === 0) throw new ResearchContractError(`${label} is empty`);
  return result;
}

export function validateBenchmarkSummary(value) {
  const input = record(value, "benchmark summary");
  const metrics = record(input.metrics, "benchmark metrics");
  const validatedMetrics = {
    provider_start: metric(metrics.provider_start, "provider_start"),
    ready_to_prompt_ack: metric(metrics.ready_to_prompt_ack, "ready_to_prompt_ack"),
    resume_provider_start: metric(metrics.resume_provider_start, "resume_provider_start"),
    resume_ready_to_prompt_ack: metric(
      metrics.resume_ready_to_prompt_ack,
      "resume_ready_to_prompt_ack",
    ),
  };
  for (const name of [
    "send_to_prompt_ack",
    "resume_send_to_prompt_ack",
    "stage_runtime",
    "start_pi",
    "broker_preflight",
    "stop_archive",
    "resume",
    "resume_start_pi",
    "resume_broker_preflight",
  ]) {
    if (metrics[name] !== undefined) validatedMetrics[name] = metric(metrics[name], name);
  }
  const result = {
    cycles: integer(input.cycles, "benchmark cycles", 1, 100),
    metrics: validatedMetrics,
  };
  if (input.diagnostics !== undefined) {
    const diagnostics = record(input.diagnostics, "benchmark diagnostics");
    result.diagnostics = {
      provider_calls: diagnostic(diagnostics.provider_calls, "provider calls"),
      create_skill_bytes: diagnostic(diagnostics.create_skill_bytes, "create skill bytes"),
      resume_skill_bytes: diagnostic(diagnostics.resume_skill_bytes, "resume skill bytes"),
      create_staging_modes: stagingModes(
        diagnostics.create_staging_modes,
        "create staging modes",
      ),
      resume_staging_modes: stagingModes(
        diagnostics.resume_staging_modes,
        "resume staging modes",
      ),
    };
  }
  return result;
}

export function validateBenchmarkLease(value) {
  const input = record(value, "benchmark lease");
  version(input.schemaVersion, "benchmark lease");
  const expiresAt = string(input.expiresAt, "lease expiry", undefined, 64);
  if (!Number.isFinite(Date.parse(expiresAt))) throw new ResearchContractError("lease expiry is invalid");
  return {
    schemaVersion: BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
    runId: string(input.runId, "run id", ID_PATTERN),
    candidateId: string(input.candidateId, "candidate id", ID_PATTERN),
    phase: string(input.phase, "lease phase", /^(baseline-start|baseline-end|quick|confirm|final)$/),
    resourcePrefix: string(input.resourcePrefix, "resource prefix", /^box-startup-[a-f0-9]{16}$/),
    tokenHash: string(input.tokenHash, "lease token hash", /^[a-f0-9]{64}$/),
    expiresAt,
    cycles: integer(input.cycles, "lease cycles", 1, 20),
    treeSha: string(input.treeSha, "tree sha", SHA_PATTERN),
  };
}

export function validateCleanupLedger(value) {
  const input = record(value, "cleanup ledger");
  version(input.schemaVersion, "cleanup ledger");
  const boxes = Array.isArray(input.boxes) ? input.boxes.map((entry, index) => {
    const item = record(entry, `cleanup box ${index}`);
    return {
      id: string(item.id, `cleanup box ${index} id`, BOX_ID_PATTERN),
      deleted: boolean(item.deleted, `cleanup box ${index} deleted`),
    };
  }) : (() => { throw new ResearchContractError("cleanup boxes must be an array"); })();
  const snapshots = Array.isArray(input.snapshots) ? input.snapshots.map((entry, index) => {
    const item = record(entry, `cleanup snapshot ${index}`);
    return {
      name: string(item.name, `cleanup snapshot ${index} name`, SNAPSHOT_PATTERN),
      deleted: boolean(item.deleted, `cleanup snapshot ${index} deleted`),
    };
  }) : (() => { throw new ResearchContractError("cleanup snapshots must be an array"); })();
  const complete = boolean(input.complete, "cleanup complete");
  const proven = boxes.every((entry) => entry.deleted)
    && snapshots.every((entry) => entry.deleted);
  if (complete !== proven) {
    throw new ResearchContractError("cleanup completion does not match its resource proofs");
  }
  return {
    schemaVersion: BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
    boxes,
    snapshots,
    complete,
  };
}

export function validateCandidateResult(value) {
  const input = record(value, "candidate result");
  version(input.schemaVersion, "candidate result");
  return {
    schemaVersion: BOX_STARTUP_RESEARCH_SCHEMA_VERSION,
    runId: string(input.runId, "run id", ID_PATTERN),
    candidateId: string(input.candidateId, "candidate id", ID_PATTERN),
    phase: string(input.phase, "result phase", /^(baseline-start|baseline-end|quick|confirm|final)$/),
    treeSha: string(input.treeSha, "tree sha", SHA_PATTERN),
    resourcePrefix: string(input.resourcePrefix, "resource prefix", /^box-startup-[a-f0-9]{16}$/),
    benchmark: validateBenchmarkSummary(input.benchmark),
    cleanup: validateCleanupLedger(input.cleanup),
    bakeDurationMs: integer(input.bakeDurationMs, "bake duration", 0, 3_600_000),
    ...(input.snapshotSizeBytes === undefined ? {} : {
      snapshotSizeBytes: integer(
        input.snapshotSizeBytes,
        "snapshot size bytes",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    }),
  };
}

export function parseSentinel(records, sentinel, validate) {
  const values = [];
  const visit = (value) => {
    if (typeof value === "string") {
      for (const line of value.split(/\r?\n/)) {
        const index = line.indexOf(sentinel);
        if (index < 0) continue;
        try {
          values.push(validate(JSON.parse(line.slice(index + sentinel.length).trim())));
        } catch {
          // Ignore malformed agent prose and keep looking for a valid machine line.
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(records);
  return values;
}

export function benchmarkScore(summary, percentile = "p50_ms") {
  const validated = validateBenchmarkSummary(summary);
  return Math.max(
    validated.metrics.ready_to_prompt_ack[percentile],
    validated.metrics.resume_ready_to_prompt_ack[percentile],
  );
}

export function candidateBeatsIncumbent(candidate, incumbent) {
  const next = validateBenchmarkSummary(candidate);
  const current = validateBenchmarkSummary(incumbent);
  const currentScore = benchmarkScore(current);
  const nextScore = benchmarkScore(next);
  const requiredGain = Math.max(1_000, Math.ceil(currentScore * 0.1));
  const legs = ["ready_to_prompt_ack", "resume_ready_to_prompt_ack"];
  const noLegRegression = legs.every((name) => {
    const currentValue = current.metrics[name].p50_ms;
    const allowed = Math.max(500, Math.ceil(currentValue * 0.1));
    return next.metrics[name].p50_ms <= currentValue + allowed;
  });
  const providers = ["provider_start", "resume_provider_start"];
  const providerGuard = providers.every((name) => {
    const currentValue = current.metrics[name].p50_ms;
    return next.metrics[name].p50_ms <= currentValue + Math.max(2_000, Math.ceil(currentValue * 0.2));
  });
  return noLegRegression && providerGuard && currentScore - nextScore >= requiredGain;
}

export function providerGuardrailsSatisfied(candidate, reference) {
  const next = validateBenchmarkSummary(candidate);
  const current = validateBenchmarkSummary(reference);
  return ["provider_start", "resume_provider_start"].every((name) => {
    const currentValue = current.metrics[name].p50_ms;
    return next.metrics[name].p50_ms
      <= currentValue + Math.max(2_000, Math.ceil(currentValue * 0.2));
  });
}

export function providerDriftDetected(start, end) {
  const first = validateBenchmarkSummary(start);
  const last = validateBenchmarkSummary(end);
  return ["provider_start", "resume_provider_start"].some((name) => {
    const initial = first.metrics[name].p50_ms;
    const final = last.metrics[name].p50_ms;
    return Math.abs(final - initial) > Math.max(2_000, Math.ceil(initial * 0.2));
  });
}

export function isFinalSloSatisfied(summary, sloMs) {
  const validated = validateBenchmarkSummary(summary);
  return validated.metrics.ready_to_prompt_ack.p95_ms <= sloMs
    && validated.metrics.resume_ready_to_prompt_ack.p95_ms <= sloMs;
}

export function deterministicCompanionId(runId, candidateId, phase, cycle) {
  const bytes = Buffer.from(createHash("sha256")
    .update(`${runId}:${candidateId}:${phase}:${cycle}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_PATTERN.test(value)) throw new ResearchContractError("deterministic companion id failed");
  return value;
}
