import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  RUN_ARTIFACT_MAX_BYTES,
  RUN_ARTIFACT_MAX_FILES,
  RUN_ARTIFACT_MAX_TOTAL_BYTES,
  RUN_ARTIFACT_RETENTION_MS,
  RUN_REACTIVATION_RETENTION_MS,
  type RunChatEvent,
  type RunPhase,
} from "@companion/contracts";
import {
  createRunRedactor,
  getSandboxRuntimeDeadline,
  getSandboxRuntimeBudget,
  loadSecretsMasterKey,
  refreshSandboxUsageReservation,
  recordSandboxRuntimeObservation,
  reserveSandboxUsage,
  RunRuntimeError,
  SANDBOX_RUN_ACTIVATION_RESERVATION_MS,
  SecretConfigurationError,
  settleLatestSandboxUsage,
  settleSandboxUsage,
  startSandboxUsage,
  type RunChatRuntime,
  type RunChatTarget,
  type RunRedactor,
  type RunStreamingRedactor,
  type SandboxRef,
} from "@companion/core";
import {
  appendRunEvents,
  beginRunFreeze,
  cancelOutstandingRunPromptsByWorker,
  cancelRunPromptByWorker,
  claimNextRunPrompt,
  claimRunPromptStopRecovery,
  claimRunJobs,
  cleanupExpiredRunEvents,
  completeRunPrompt,
  failOrRetryRunJob,
  failRunPrompt,
  freezeRunAfterRuntimeLossByWorker,
  getRunWorkerLeaseControl,
  heartbeatRunWorker,
  heartbeatRunJob,
  heartbeatRunPrompt,
  interruptRunByWorker,
  getRunPromptAttachments,
  getRunPromptStopControl,
  materializeRunAttachmentFiles,
  getAdoptedRunPrewarm,
  loadRunExecutionPlan,
  loadRunMaterializationPlan,
  markRunPromptSendAttempted,
  materializeRunDynamicFiles,
  materializeRunSkillBundles,
  persistRunTranscript,
  detectRunArtifactType,
  putRunArtifactMetadata,
  reconcileRunArtifactPaths,
  removeRunWorkerHeartbeat,
  runArtifactId,
  RunBusyError,
  RunValidationError,
  sandboxNameForRun,
  teardownSandbox,
  terminalizeRevokedRunLease,
  updateRunWorkerState,
  type ActorContext,
  type ClaimedRunJob,
  type RunControlContext,
  type RunExecutionPlan,
  type RunPromptRow,
} from "@companion/core/services";
import { db, schema, withTenantContext, type Db } from "@companion/db";
import {
  createModelCatalog,
  createOpencodeRunChatRuntime,
  createVercelRuntime,
  imagePathFromReadInput,
  vercelConfigFromEnv,
} from "@companion/sandbox";
import {
  getSkillArchive,
  headSkillArchive,
  isStoragePreconditionFailure,
  putSkillArchive,
  runArtifactKey,
} from "@companion/storage";
import { boundedInteger, runWorkerConfig, type RunWorkerConfig } from "./config";
import type { Supervisor } from "./billingSupervisor";
import { createRunCleanupScheduler } from "./runCleanup";
import { createRunRuntimeReconciler } from "./runRuntimeReconciler";
import { sweepRunAttachmentOrphans } from "./runAttachmentCleanup";
import { sweepRunArtifacts } from "./runArtifactCleanup";
import { createRunPrewarmScheduler } from "./prewarmSupervisor";

const PROMPT_POLL_MS = 250;
const ACL_RECHECK_MS = 15_000;
const OPENCODE_CALL_TIMEOUT_MS = 30_000;
const SANDBOX_CONTROL_TIMEOUT_MS = 60_000;
const ARTIFACT_STORAGE_TIMEOUT_MS = 30_000;
const ARTIFACT_STORAGE_CAS_ATTEMPTS = 3;

function sandboxLifecycleLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  console[level](JSON.stringify({ subsystem: "sandbox_lifecycle", event, ...fields }));
}

class WorkerShutdown extends Error {}
class LostLease extends Error {}
class CancellationRequested extends Error {}
class PromptCancellationRequested extends Error {}
class RuntimeInterrupted extends Error {
  constructor(
    readonly code: "sandbox_expired_during_turn" | "recorder_unavailable",
    readonly sandboxState: "retained" | "missing" | "unknown",
  ) {
    super(
      code === "sandbox_expired_during_turn"
        ? "The sandbox expired while this turn was running."
        : "The run recorder could not reconnect safely.",
    );
  }
}

export function assertRetainedConversationAvailable(input: {
  activationRevision: number;
  opencodeSessionId: string | null;
  sessionState: "idle" | "busy" | "retry" | "missing";
}): void {
  if (input.activationRevision > 0 && input.opencodeSessionId && input.sessionState === "missing") {
    throw new RunValidationError(
      "the retained conversation context is no longer available",
      "run_context_unavailable",
    );
  }
}

/**
 * A retained sandbox is safe to resume only after OpenCode confirms that its active turn stopped.
 * If aborting fails, callers must destroy the sandbox instead of advertising a resumable context.
 */
export async function abortConversationForRetention(input: {
  chat: Pick<RunChatRuntime, "abortSession">;
  target: RunChatTarget | null;
  sessionId: string | null;
  signal: AbortSignal;
}): Promise<boolean> {
  if (!input.target || !input.sessionId) return true;
  try {
    await input.chat.abortSession(input.target, input.sessionId, input.signal);
    return true;
  } catch {
    return false;
  }
}

export function shouldHeartbeatRunLease(input: {
  signalAborted: boolean;
  finalizingCancellation: boolean;
}): boolean {
  return !input.signalAborted || input.finalizingCancellation;
}

export function cancellationStateAfterStop(stopped: boolean): { retained: boolean; cleaned: boolean } {
  // A missing deterministic name may still be an adopted fork that is not visible yet. Recording
  // cleanup lets the prewarm reconciler destroy it as soon as the warming lease is released.
  return stopped ? { retained: true, cleaned: false } : { retained: false, cleaned: true };
}

function abortFailure(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new WorkerShutdown();
}

/** Crash-safe dispatch seam: mounting must finish before OpenCode is inspected or contacted. */
export async function dispatchPromptAfterAttachmentMount(input: {
  mountAttachments: () => Promise<void>;
  getMessageState: () => Promise<"missing" | "pending" | "completed" | "error">;
  beforeSend?: () => Promise<void>;
  onMessageObserved?: (state: "pending" | "completed" | "error") => Promise<void>;
  sendPrompt: () => Promise<void>;
}): Promise<"missing" | "pending" | "completed"> {
  await input.mountAttachments();
  const messageState = await input.getMessageState();
  if (messageState === "missing") {
    await input.beforeSend?.();
    await input.sendPrompt();
  } else {
    await input.onMessageObserved?.(messageState);
    if (messageState === "error") throw new RunRuntimeError("OpenCode could not complete the prompt");
  }
  return messageState;
}

/**
 * Claiming a prompt is not evidence that OpenCode is busy. Arm the recorder gate only after the
 * exact prompt lease proves that dispatch may proceed, otherwise a pre-dispatch stop would leave an
 * idle session permanently blocked from claiming the next FIFO entry.
 */
export function armRecorderForPromptDispatch(
  state: { busy: boolean },
  control: "continue" | "cancel_requested" | "lost_lease",
): "continue" | "cancel_requested" | "lost_lease" {
  if (control === "continue") state.busy = true;
  return control;
}

/** Undo only the in-memory gate that this lease created before any external send was possible. */
export function releaseSyntheticRecorderBusy(
  state: { busy: boolean },
  dispatchMayHaveReachedRuntime: boolean,
): boolean {
  if (dispatchMayHaveReachedRuntime) return false;
  state.busy = false;
  return true;
}

interface RunControlState {
  status: "queued" | "starting" | "running" | "frozen" | "interrupted" | "error" | "canceled";
  phase: RunPhase;
  cancelRequestedAt: Date | null;
  sandboxName: string | null;
  sandboxId: string | null;
  sandboxDomain: string | null;
  opencodeSessionId: string | null;
  activationRevision: number;
  timeoutMs: number;
}

interface RecorderState {
  busy: boolean;
  idleAt: number | null;
  fatal: { code: string; message: string } | null;
  unavailable: {
    code: "sandbox_expired_during_turn" | "recorder_unavailable";
    sandboxState: "retained" | "missing" | "unknown";
  } | null;
  readImagePaths: Set<string>;
}

interface RecorderHandle {
  state: RecorderState;
  started: Promise<void>;
  idleBarrierRevision(): number;
  waitForIdleBarrierAfter(revision: number, timeoutMs: number, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

/**
 * A snapshot is not a continuation barrier until a new event subscription is connected after it.
 * Keep the persisted and ready revisions separate so an unrelated reconnect cannot satisfy a stop.
 */
export function createRecorderIdleBarrierTracker() {
  let persistedRevision = 0;
  let readyRevision = 0;
  let closedError: Error | null = null;
  const waiters = new Set<{
    after: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();

  const notify = () => {
    for (const waiter of [...waiters]) {
      if (readyRevision > waiter.after) waiter.resolve();
    }
  };

  return {
    revision: () => readyRevision,
    markSnapshotPersisted: () => {
      persistedRevision += 1;
      return persistedRevision;
    },
    markFreshIdleConnection: () => {
      if (persistedRevision > readyRevision) {
        readyRevision = persistedRevision;
        notify();
      }
      return readyRevision;
    },
    waitForAfter(after: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
      if (readyRevision > after) return Promise.resolve();
      if (closedError) return Promise.reject(closedError);
      if (signal.aborted) return Promise.reject(abortFailure(signal));
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          waiters.delete(waiter);
          if (error) reject(error);
          else resolve();
        };
        const waiter = {
          after,
          resolve: () => finish(),
          reject: (error: Error) => finish(error),
        };
        const onAbort = () => finish(abortFailure(signal));
        const timer = setTimeout(
          () => finish(new RunRuntimeError("the run recorder did not establish a durable idle barrier after stop")),
          Math.max(1, timeoutMs),
        );
        waiters.add(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) finish(abortFailure(signal));
        else if (readyRevision > after) finish();
      });
    },
    close(error = new WorkerShutdown()) {
      closedError = error;
      for (const waiter of [...waiters]) waiter.reject(error);
    },
  };
}

const SANDBOX_TIMEOUT_MIN_MS = 10_000;
const SANDBOX_TIMEOUT_MAX_MS = 3_600_000;

export function sandboxTimeoutExtensionSchedule(timeoutMs: number): {
  extensionMs: number;
  intervalMs: number;
} {
  const extensionMs = Math.max(SANDBOX_TIMEOUT_MIN_MS, Math.min(SANDBOX_TIMEOUT_MAX_MS, timeoutMs));
  return {
    extensionMs,
    // Refresh no later than halfway through the provider lease, without hammering its control API.
    intervalMs: Math.max(5_000, Math.min(60_000, Math.floor(extensionMs / 2))),
  };
}

export function createSandboxTimeoutExtender(
  runtime: NonNullable<RunControlContext["runtime"]>,
  readBudgetMs?: () => Promise<number | null>,
  options?: {
    maxSessionMs: number;
    now?: () => number;
    readDeadlineAt?: () => Promise<Date | null>;
    onObservation?: (observation: {
      state: "running" | "stopped" | "missing";
      expiresAt: Date | null;
      deadlineAt: Date;
    }) => Promise<void>;
    onError?: (error: unknown) => void;
  },
): {
  activate(ref: SandboxRef): void;
  stop(): Promise<void>;
} {
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeRef: SandboxRef | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let provisionedMs = 0;
  let activatedAtMs = 0;

  const refresh = () => {
    if (stopped || !activeRef || !runtime.extendTimeout || inFlight) return;
    const extend = async () => {
      const nowMs = options?.now?.() ?? Date.now();
      const maxSessionMs = options?.maxSessionMs;
      if (readBudgetMs) {
        const budgetMs = await readBudgetMs();
        if (!options) {
          if (budgetMs === null || budgetMs <= provisionedMs) return;
          const additionalMs = budgetMs - provisionedMs;
          await runtime.extendTimeout!(activeRef!, additionalMs, AbortSignal.timeout(10_000));
          provisionedMs = budgetMs;
          return;
        }
        if (!maxSessionMs && (budgetMs === null || budgetMs <= provisionedMs)) return;
        const admittedMs = Math.min(budgetMs ?? maxSessionMs!, maxSessionMs ?? budgetMs!);
        const deadlineAt = await options?.readDeadlineAt?.()
          ?? new Date(activatedAtMs + admittedMs);
        const observed = await runtime.observe(activeRef!, AbortSignal.timeout(10_000));
        await options?.onObservation?.({ ...observed, deadlineAt });
        if (observed.state !== "running") return;
        const currentExpiryMs = observed.expiresAt?.getTime() ?? activatedAtMs + provisionedMs;
        const additionalMs = Math.max(0, deadlineAt.getTime() - currentExpiryMs);
        if (additionalMs <= 0 || nowMs >= deadlineAt.getTime()) return;
        const extended = await runtime.extendTimeout!(activeRef!, additionalMs, AbortSignal.timeout(10_000));
        provisionedMs = admittedMs;
        if (extended) await options?.onObservation?.({ ...extended, deadlineAt });
        return;
      }
      const { extensionMs } = sandboxTimeoutExtensionSchedule(activeRef!.timeoutMs);
      await runtime.extendTimeout!(activeRef!, extensionMs, AbortSignal.timeout(10_000));
    };
    inFlight = extend().catch((error) => {
      options?.onError?.(error);
    }).finally(() => {
      inFlight = null;
    });
  };

  return {
    activate(ref) {
      if (stopped || timer || !runtime.extendTimeout) return;
      activeRef = ref;
      provisionedMs = ref.timeoutMs;
      activatedAtMs = options?.now?.() ?? Date.now();
      const intervalMs = options
        ? 15_000
        : readBudgetMs
          ? 5_000
          : sandboxTimeoutExtensionSchedule(ref.timeoutMs).intervalMs;
      // Managed sandboxes extend only by newly admitted minutes; self-hosted sandboxes preserve
      // the existing rolling provider lease behavior.
      refresh();
      timer = setInterval(refresh, intervalMs);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await inFlight?.catch(() => undefined);
      activeRef = null;
    },
  };
}

function actorForJob(job: ClaimedRunJob): ActorContext {
  // Core authorization uses the stable user id. Display fields are intentionally never logged.
  return { id: job.creatorId, email: "", name: "Run owner" };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const abortReason = () => signal ? abortFailure(signal) : new WorkerShutdown();
  if (signal?.aborted) return Promise.reject(abortReason());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (!signal) return;
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function withBoundedSignal<T>(input: {
  parent: AbortSignal;
  timeoutMs: number;
  timeoutMessage: string;
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const abort = new AbortController();
  const onParentAbort = () => abort.abort(
    abortFailure(input.parent),
  );
  if (input.parent.aborted) onParentAbort();
  else input.parent.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(
    () => abort.abort(new RunRuntimeError(input.timeoutMessage)),
    Math.max(1, input.timeoutMs),
  );
  try {
    return await input.operation(abort.signal);
  } finally {
    clearTimeout(timer);
    input.parent.removeEventListener("abort", onParentAbort);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof RunValidationError) return error.code;
  if (error instanceof RunBusyError) return error.code;
  if (error instanceof SecretConfigurationError) return "secrets_unavailable";
  if (error instanceof RunRuntimeError) return "runtime_error";
  return "worker_error";
}

export function isTransientRunFailure(error: unknown): boolean {
  if (error instanceof RunValidationError || error instanceof RunBusyError || error instanceof SecretConfigurationError) {
    return false;
  }
  // Unknown database/network/provider errors receive the bounded three-attempt job policy. Only
  // explicit validation, authorization/configuration, and concurrency conflicts fail immediately.
  return true;
}

/** Fail through the durable job transition when a database claim is malformed, never before it. */
export function claimedRunLeaseDeadline(job: Pick<ClaimedRunJob, "leaseExpiresAt">): number {
  if (!(job.leaseExpiresAt instanceof Date)) {
    throw new RunRuntimeError("the claimed run job has invalid lease metadata");
  }
  const deadline = job.leaseExpiresAt.getTime();
  if (!Number.isFinite(deadline)) throw new RunRuntimeError("the claimed run job has invalid lease metadata");
  return deadline;
}

export function runFailureEvent(
  outcome: "queued" | "failed" | "cancel_requested" | "lost_lease",
  input: { attempt: number; code: string; message: string },
): RunChatEvent | null {
  if (outcome === "queued") {
    return { type: "status", state: "retry", attempt: input.attempt + 1, message: "Retrying the run" };
  }
  // `failed` persists run.error atomically with the terminal transition in core. Cancellation uses
  // its snapshot/teardown path, and a lost lease must not emit anything.
  return null;
}

function userFacingError(error: unknown, redactor: RunRedactor): string {
  if (error instanceof RunValidationError || error instanceof RunBusyError || error instanceof RunRuntimeError) {
    return redactor.redactText(error.message).slice(0, 4_000);
  }
  if (error instanceof SecretConfigurationError) return "RunSkill secrets are unavailable";
  return "The run worker could not complete this run";
}

function sandboxRef(plan: RunExecutionPlan, ctx: RunControlContext): SandboxRef {
  return {
    sandboxName: plan.row.sandboxName!,
    sandboxId: plan.row.sandboxId,
    region: ctx.region,
    timeoutMs: plan.row.timeoutMs,
  };
}

async function tenant<T>(job: ClaimedRunJob, fn: (database: Db) => Promise<T>): Promise<T> {
  return withTenantContext({ orgId: job.orgId, userId: job.creatorId }, fn);
}

async function startRunSandboxUsage(
  job: ClaimedRunJob,
  ref: SandboxRef,
  activationRevision: number,
  lifecycle: { enabled: boolean; maxSessionMs: number },
): Promise<void> {
  await tenant(job, async (database) => {
    if (!lifecycle.enabled) {
      await startSandboxUsage({
        orgId: job.orgId,
        sandboxName: ref.sandboxName,
        activationRevision,
        database,
      });
      return;
    }
    const budget = await getSandboxRuntimeBudget({
      orgId: job.orgId,
      sandboxName: ref.sandboxName,
      activationRevision,
      database,
    });
    const maxSessionMs = lifecycle.maxSessionMs;
    const admittedMs = Math.min(maxSessionMs, budget?.limitMs ?? maxSessionMs);
    const now = new Date();
    const runtimeDeadlineAt = new Date(now.getTime() + admittedMs);
    await startSandboxUsage({
      orgId: job.orgId,
      sandboxName: ref.sandboxName,
      activationRevision,
      runtimePolicy: budget ? "budgeted" : "safety_capped",
      runtimeDeadlineAt,
      database,
      now,
    });
    await database
      .update(schema.skillRuns)
      .set({
        runtimeDeadlineAt: sql`coalesce(${schema.skillRuns.runtimeDeadlineAt}, ${runtimeDeadlineAt})`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.skillRuns.orgId, job.orgId),
        eq(schema.skillRuns.id, job.runId),
        eq(schema.skillRuns.creatorId, job.creatorId),
        eq(schema.skillRuns.activationRevision, activationRevision),
      ));
  });
}

async function settleRunSandboxUsage(job: ClaimedRunJob, ref: SandboxRef, activationRevision: number): Promise<void> {
  await tenant(job, (database) => settleSandboxUsage({
    orgId: job.orgId,
    sandboxName: ref.sandboxName,
    activationRevision,
    database,
  }));
}

async function ensureRunSandboxUsage(
  job: ClaimedRunJob,
  ref: SandboxRef,
  activationRevision: number,
): Promise<{ limitMs: number } | null> {
  return tenant(job, async (database) => {
    await reserveSandboxUsage({
      orgId: job.orgId,
      creatorId: job.creatorId,
      kind: "run",
      sourceId: job.runId,
      sandboxName: ref.sandboxName,
      activationRevision,
      reservationMs: SANDBOX_RUN_ACTIVATION_RESERVATION_MS,
      database,
    });
    return refreshSandboxUsageReservation({
      orgId: job.orgId,
      sandboxName: ref.sandboxName,
      activationRevision,
      database,
    });
  });
}

function applySandboxRuntimeBudget(ref: SandboxRef, budget: { limitMs: number } | null): void {
  if (!budget) return;
  if (budget.limitMs < SANDBOX_TIMEOUT_MIN_MS) {
    throw new RunValidationError("the sandbox runtime budget is exhausted", "sandbox_quota_exhausted");
  }
  ref.timeoutMs = Math.min(ref.timeoutMs, budget.limitMs);
}

async function readRunControl(job: ClaimedRunJob): Promise<RunControlState> {
  return tenant(job, async (database) => {
    const rows = await database
      .select({
        status: schema.skillRuns.status,
        phase: schema.skillRuns.phase,
        cancelRequestedAt: schema.skillRuns.cancelRequestedAt,
        sandboxName: schema.skillRuns.sandboxName,
        sandboxId: schema.skillRuns.sandboxId,
        sandboxDomain: schema.skillRuns.sandboxDomain,
        opencodeSessionId: schema.skillRuns.opencodeSessionId,
        activationRevision: schema.skillRuns.activationRevision,
        timeoutMs: schema.skillRuns.timeoutMs,
      })
      .from(schema.skillRuns)
      .where(
        and(
          eq(schema.skillRuns.orgId, job.orgId),
          eq(schema.skillRuns.id, job.runId),
          eq(schema.skillRuns.creatorId, job.creatorId),
        ),
      );
    if (!rows[0]) throw new RunValidationError("run not found", "run_not_found");
    return rows[0];
  });
}

async function setPhase(
  job: ClaimedRunJob,
  actor: ActorContext,
  workerId: string,
  phase: RunPhase,
  extra: Partial<Parameters<typeof updateRunWorkerState>[0]> = {},
): Promise<void> {
  const owned = await tenant(job, (database) =>
    updateRunWorkerState({
      actor,
      orgId: job.orgId,
      runId: job.runId,
      workerId,
      phase,
      ...extra,
      database,
    }),
  );
  if (!owned) throw new LostLease();
}

async function appendEvents(
  job: ClaimedRunJob,
  actor: ActorContext,
  events: RunChatEvent[],
  redactor: RunRedactor,
  requireLease = true,
): Promise<void> {
  if (events.length === 0) return;
  await tenant(job, (database) =>
    appendRunEvents({
      actor,
      orgId: job.orgId,
      runId: job.runId,
      events,
      redactor,
      workerId: requireLease ? job.leaseOwner ?? undefined : undefined,
      database,
    }),
  );
}

function streamKey(event: RunChatEvent): string | null {
  if (event.type === "text.delta" || event.type === "text.done") return `text:${event.message_id}`;
  if (event.type === "reasoning.delta" || event.type === "reasoning.done") return `reasoning:${event.part_id}`;
  return null;
}

function redactStreamEvent(
  event: RunChatEvent,
  redactor: RunRedactor,
  streams: Map<string, RunStreamingRedactor>,
): RunChatEvent[] {
  const key = streamKey(event);
  if (!key) return [event];
  if (event.type === "text.delta" || event.type === "reasoning.delta") {
    const stream = streams.get(key) ?? redactor.createStream();
    streams.set(key, stream);
    const delta = stream.push(event.delta);
    return delta ? [{ ...event, delta }] : [];
  }
  const stream = streams.get(key);
  streams.delete(key);
  if (!stream) return [event];
  const tail = stream.flush();
  stream.clear();
  if (!tail) return [event];
  if (event.type === "text.done") {
    return [{ type: "text.delta", message_id: event.message_id, delta: tail }, event];
  }
  if (event.type === "reasoning.done") {
    return [{ type: "reasoning.delta", part_id: event.part_id, delta: tail }, event];
  }
  return [event];
}

export function toolMayWriteArtifacts(tool: string, serializedInput: string): boolean {
  const normalizedTool = tool.toLowerCase().replaceAll("-", "_");
  if (!["write", "edit", "apply_patch", "patch", "bash", "shell", "command"].includes(normalizedTool)) {
    return false;
  }
  return /(?:^|[\s"'`:=])(\.\/)?artifacts(?:\/|\\|(?=[\s"'`]))|\/vercel\/sandbox\/artifacts(?:\/|\\|(?=[\s"'`]))/i.test(serializedInput);
}

export function createSingleFlightArtifactCollector(collect: () => Promise<void>): {
  request: () => void;
  collectNow: () => Promise<void>;
  waitForIdle: () => Promise<void>;
} {
  let active: Promise<void> | null = null;
  let rerun = false;
  const kick = (): Promise<void> => {
    if (active) {
      rerun = true;
      return active;
    }
    active = (async () => {
      do {
        rerun = false;
        await collect();
      } while (rerun);
    })().finally(() => {
      active = null;
    });
    return active;
  };
  return {
    request() {
      void kick().catch(() => undefined);
    },
    collectNow() {
      if (active) rerun = true;
      return kick();
    },
    async waitForIdle() {
      await active;
    },
  };
}

function startRecorder(input: {
  job: ClaimedRunJob;
  actor: ActorContext;
  ctx: RunControlContext;
  target: { domain: string; password: string };
  sessionId: string;
  ref: SandboxRef;
  activationRevision: number;
  redactor: RunRedactor;
  config: RunWorkerConfig;
  runtimeDeadlineAt: Date | null;
  shutdownSignal: AbortSignal;
  onArtifactToolDone?: () => void;
}): RecorderHandle {
  const chat = input.ctx.chat!;
  const state: RecorderState = {
    busy: false,
    idleAt: null,
    fatal: null,
    unavailable: null,
    readImagePaths: new Set(),
  };
  const abort = new AbortController();
  const recorderSignal = AbortSignal.any([abort.signal, input.shutdownSignal]);
  const streams = new Map<string, RunStreamingRedactor>();
  const artifactToolCalls = new Set<string>();
  const idleBarriers = createRecorderIdleBarrierTracker();
  let stopped = false;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let startedResolved = false;
  let idleSnapshotFresh = false;
  const persistSnapshot = async (emitIdleBarrier = false) => {
    const items = await withBoundedSignal({
      parent: recorderSignal,
      timeoutMs: OPENCODE_CALL_TIMEOUT_MS,
      timeoutMessage: "the OpenCode transcript read timed out",
      operation: (signal) => chat.loadItems(input.target, input.sessionId, signal),
    });
    const persisted = await tenant(input.job, (database) =>
      persistRunTranscript({
        actor: input.actor,
        orgId: input.job.orgId,
        runId: input.job.runId,
        items,
        redactor: input.redactor,
        barrierEvent: emitIdleBarrier
          ? { type: "session.idle", session_id: input.sessionId }
          : undefined,
        workerId: input.job.leaseOwner ?? undefined,
        database,
      }),
    );
    if (!persisted) throw new LostLease();
    if (emitIdleBarrier) idleBarriers.markSnapshotPersisted();
  };

  const loop = (async () => {
    let reconnectMs = input.config.recorderReconnectMinMs;
    let degradedAtMs: number | null = null;
    let reconnectAttempts = 0;
    let lastProviderObservationAt = 0;
    let longDegradedLogged = false;
    recorderLoop: while (!stopped && !input.shutdownSignal.aborted) {
      let connectionAbort: AbortController | null = null;
      let iterator: AsyncIterator<RunChatEvent> | null = null;
      try {
        let connected = false;
        let resolveConnected!: () => void;
        const connection = new Promise<void>((resolve) => { resolveConnected = resolve; });
        connectionAbort = new AbortController();
        const connectionTimer = setTimeout(
          () => connectionAbort?.abort(new RunRuntimeError("the run recorder could not connect")),
          OPENCODE_CALL_TIMEOUT_MS,
        );
        const streamSignal = AbortSignal.any([recorderSignal, connectionAbort.signal]);
        iterator = chat
          .streamEvents(input.target, input.sessionId, streamSignal, () => {
            connected = true;
            clearTimeout(connectionTimer);
            resolveConnected();
          }, abort.signal)
          [Symbol.asyncIterator]();
        let next = iterator.next();
        try {
          await Promise.race([
            connection,
            next.then(() => {
              if (!connected) throw new RunRuntimeError("the run recorder closed before connecting");
            }),
          ]);
        } finally {
          clearTimeout(connectionTimer);
        }
        const sessionState = await withBoundedSignal({
          parent: recorderSignal,
          timeoutMs: OPENCODE_CALL_TIMEOUT_MS,
          timeoutMessage: "the OpenCode session status read timed out",
          operation: (signal) => chat.getSessionState(input.target, input.sessionId, signal),
        });
        if (sessionState === "missing") throw new RunRuntimeError("the OpenCode session is unavailable");
        if (degradedAtMs !== null) {
          await tenant(input.job, (database) => updateRunWorkerState({
            actor: input.actor,
            orgId: input.job.orgId,
            runId: input.job.runId,
            workerId: input.job.leaseOwner ?? undefined,
            runtimeState: "healthy",
            runtimeDegradedAt: null,
            database,
          }));
          sandboxLifecycleLog("info", "recorder_recovered", {
            runId: input.job.runId,
            attempts: reconnectAttempts,
            degradedMs: Date.now() - degradedAtMs,
          });
          degradedAtMs = null;
          reconnectAttempts = 0;
          longDegradedLogged = false;
        }
        if (sessionState === "idle" && !idleSnapshotFresh) {
          // A history read may already include bytes buffered by this subscription. Discard the
          // subscription first so a persisted snapshot and later event replay can never append the
          // same delta twice, then reconnect before another prompt is allowed to start.
          connectionAbort.abort();
          await iterator.return?.().catch(() => undefined);
          state.busy = true;
          await persistSnapshot(true);
          state.idleAt = Date.now();
          idleSnapshotFresh = true;
          continue;
        }
        state.busy = sessionState !== "idle";
        if (sessionState === "idle" && idleSnapshotFresh) {
          idleBarriers.markFreshIdleConnection();
        }
        if (state.busy) {
          state.idleAt = null;
          idleSnapshotFresh = false;
        }
        if (!startedResolved) {
          startedResolved = true;
          resolveStarted();
        }
        while (!stopped && !input.shutdownSignal.aborted) {
          const result = await next;
          if (result.done) break;
          const event = result.value;
          next = iterator.next();
          if (event.type === "tool.start" && event.tool.toLowerCase() === "read") {
            const imagePath = imagePathFromReadInput(event.input);
            if (imagePath && state.readImagePaths.size < RUN_ARTIFACT_MAX_FILES) {
              state.readImagePaths.add(imagePath);
            }
          }
          if (event.type === "tool.start" && toolMayWriteArtifacts(event.tool, event.input)) {
            artifactToolCalls.add(event.call_id);
          }
          const artifactToolDone = event.type === "tool.done" && artifactToolCalls.delete(event.call_id);
          // Only the atomic transcript + session.idle barrier is allowed to mark the recorder
          // dispatch-ready. A generic status:idle can arrive before that snapshot is durable.
          if (event.type === "status" && event.state !== "idle") state.busy = true;
          if (event.type === "run.error") state.fatal = { code: event.code, message: event.message };
          if (event.type !== "session.idle") idleSnapshotFresh = false;
          const normalized = redactStreamEvent(event, input.redactor, streams);
          if (event.type === "session.idle" || (event.type === "status" && event.state === "idle")) {
            // Stop this subscription before reading history: otherwise an eagerly requested next
            // event could already be represented in the snapshot and later be persisted twice.
            // Stay busy until a fresh subscription is established, so no follow-up can race the
            // snapshot or lose its first response.
            state.busy = true;
            connectionAbort.abort();
            await iterator.return?.().catch(() => undefined);
            await persistSnapshot(true);
            state.idleAt = Date.now();
            idleSnapshotFresh = true;
            continue recorderLoop;
          } else {
            await appendEvents(input.job, input.actor, normalized, input.redactor);
            if (artifactToolDone) input.onArtifactToolDone?.();
          }
          reconnectMs = input.config.recorderReconnectMinMs;
        }
      } catch {
        if (stopped || input.shutdownSignal.aborted) break;
      } finally {
        connectionAbort?.abort();
        if (iterator?.return) await iterator.return().catch(() => undefined);
      }
      if (stopped || input.shutdownSignal.aborted) break;
      state.busy = true;
      reconnectAttempts += 1;
      if (input.config.sandboxLifecycleV2 && degradedAtMs === null) {
        degradedAtMs = Date.now();
        await tenant(input.job, (database) => updateRunWorkerState({
          actor: input.actor,
          orgId: input.job.orgId,
          runId: input.job.runId,
          workerId: input.job.leaseOwner ?? undefined,
          runtimeState: "degraded",
          runtimeDegradedAt: new Date(degradedAtMs!),
          database,
        })).catch(() => undefined);
        await appendEvents(
          input.job,
          input.actor,
          [{ type: "status", state: "retry", attempt: null, message: "Reconnecting to the run recorder" }],
          input.redactor,
        ).catch(() => undefined);
        sandboxLifecycleLog("warn", "recorder_degraded", {
          runId: input.job.runId,
          attempts: reconnectAttempts,
        });
      } else if (!input.config.sandboxLifecycleV2) {
        await appendEvents(
          input.job,
          input.actor,
          [{ type: "status", state: "retry", attempt: null, message: "Reconnecting to the run recorder" }],
          input.redactor,
        ).catch(() => undefined);
      }
      if (
        input.config.sandboxLifecycleV2
        && Date.now() - lastProviderObservationAt >= 15_000
      ) {
        lastProviderObservationAt = Date.now();
        const observation = await input.ctx.runtime!
          .observe(input.ref, AbortSignal.timeout(10_000))
          .catch(() => {
            sandboxLifecycleLog("warn", "provider_observe_failed", {
              runId: input.job.runId,
              activationRevision: input.activationRevision,
              attempts: reconnectAttempts,
            });
            return null;
          });
        if (observation && observation.state !== "running") {
          state.unavailable = {
            code: "sandbox_expired_during_turn",
            sandboxState: observation.state === "stopped" ? "retained" : "missing",
          };
        }
      }
      if (
        input.config.sandboxLifecycleV2
        &&
        !state.unavailable
        && degradedAtMs !== null
        && recorderRetryWindowExpired({
          degradedAtMs,
          nowMs: Date.now(),
          maxUnavailableMs: input.config.recorderUnavailableMs,
          runtimeDeadlineAt: input.runtimeDeadlineAt,
        })
      ) {
        state.unavailable = { code: "recorder_unavailable", sandboxState: "unknown" };
        if (
          input.runtimeDeadlineAt
          && Date.now() >= input.runtimeDeadlineAt.getTime()
        ) {
          sandboxLifecycleLog("warn", "runtime_deadline_exceeded", {
            runId: input.job.runId,
            activationRevision: input.activationRevision,
            deadlineAt: input.runtimeDeadlineAt.toISOString(),
            attempts: reconnectAttempts,
          });
        }
      }
      if (degradedAtMs !== null && !longDegradedLogged && Date.now() - degradedAtMs >= 60_000) {
        longDegradedLogged = true;
        sandboxLifecycleLog("warn", "recorder_degraded_over_60s", {
          runId: input.job.runId,
          attempts: reconnectAttempts,
        });
      }
      if (input.config.sandboxLifecycleV2 && reconnectAttempts === 20) {
        sandboxLifecycleLog("warn", "recorder_retry_storm", {
          runId: input.job.runId,
          attempts: reconnectAttempts,
        });
      }
      if (state.unavailable) {
        if (!startedResolved) {
          startedResolved = true;
          resolveStarted();
        }
        break;
      }
      const retryCutoffAt = degradedAtMs === null
        ? Number.POSITIVE_INFINITY
        : Math.min(
            degradedAtMs + input.config.recorderUnavailableMs,
            input.runtimeDeadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
          );
      await sleep(
        Math.min(reconnectMs, Math.max(1, retryCutoffAt - Date.now())),
        recorderSignal,
      ).catch(() => undefined);
      reconnectMs = Math.min(input.config.recorderReconnectMaxMs, reconnectMs * 2);
    }
  })();

  return {
    state,
    started,
    idleBarrierRevision: idleBarriers.revision,
    waitForIdleBarrierAfter: idleBarriers.waitForAfter,
    async stop() {
      stopped = true;
      idleBarriers.close();
      abort.abort();
      await loop.catch(() => undefined);
      for (const stream of streams.values()) stream.clear();
      streams.clear();
      artifactToolCalls.clear();
    },
  };
}

export function recorderRetryWindowExpired(input: {
  degradedAtMs: number;
  nowMs: number;
  maxUnavailableMs: number;
  runtimeDeadlineAt: Date | null;
}): boolean {
  const retryCutoffAt = Math.min(
    input.degradedAtMs + input.maxUnavailableMs,
    input.runtimeDeadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
  );
  return input.nowMs >= retryCutoffAt;
}

export async function collectAndCacheRunArtifacts(input: {
  job: ClaimedRunJob;
  actor: ActorContext;
  workerId: string;
  ctx: RunControlContext;
  ref: SandboxRef;
  imagePaths: string[];
  redactor: RunRedactor;
  signal: AbortSignal;
  dependencies?: {
    putMetadata?: typeof putRunArtifactMetadata;
    reconcileMetadata?: typeof reconcileRunArtifactPaths;
    headObject?: (input: { key: string; signal: AbortSignal }) => Promise<{ etag: string } | null>;
    putObject?: (input: {
      key: string;
      body: Uint8Array;
      contentType: string;
      ifMatch?: string;
      preventOverwrite?: boolean;
      signal: AbortSignal;
    }) => Promise<unknown>;
    isPreconditionFailure?: (error: unknown) => boolean;
    append?: (events: RunChatEvent[]) => Promise<void>;
    now?: () => number;
  };
}): Promise<number> {
  const putMetadata = input.dependencies?.putMetadata ?? putRunArtifactMetadata;
  const reconcileMetadata = input.dependencies
    ? input.dependencies.reconcileMetadata ?? (async () => true)
    : reconcileRunArtifactPaths;
  const headObject = input.dependencies?.headObject ?? ((object) => headSkillArchive(object));
  const putObject = input.dependencies?.putObject ?? ((object) => putSkillArchive(object));
  const isPreconditionFailure = input.dependencies?.isPreconditionFailure ?? isStoragePreconditionFailure;
  const append = input.dependencies?.append
    ?? ((events: RunChatEvent[]) => appendEvents(input.job, input.actor, events, input.redactor));
  const now = input.dependencies?.now ?? Date.now;
  try {
    const files = await withBoundedSignal({
      parent: input.signal,
      timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
      timeoutMessage: "the sandbox artifact collection timed out",
      operation: (signal) => input.ctx.runtime!.collectOutputFiles({
        ref: input.ref,
        imagePaths: input.imagePaths,
        maxFiles: RUN_ARTIFACT_MAX_FILES,
        maxFileBytes: RUN_ARTIFACT_MAX_BYTES,
        maxTotalBytes: RUN_ARTIFACT_MAX_TOTAL_BYTES,
        signal,
      }),
    });
    const publishable: Array<{ file: (typeof files)[number]; data: Buffer }> = [];
    let publishableBytes = 0;
    let failed = 0;
    for (const file of files) {
      const data = input.redactor.redactBytes(file.data);
      if (
        data.length <= 0
        || data.length > RUN_ARTIFACT_MAX_BYTES
        || publishableBytes + data.length > RUN_ARTIFACT_MAX_TOTAL_BYTES
      ) {
        failed += 1;
        continue;
      }
      publishable.push({ file, data });
      publishableBytes += data.length;
    }
    const reconciled = await reconcileMetadata({
      orgId: input.job.orgId,
      runId: input.job.runId,
      creatorId: input.job.creatorId,
      workerId: input.workerId,
      paths: publishable.map(({ file }) => file.path),
      database: db,
    });
    if (!reconciled) throw new LostLease();
    let ready = 0;
    for (const { file, data } of publishable) {
      const id = runArtifactId(input.job.runId, file.path);
      const storageKey = runArtifactKey({ orgId: input.job.orgId, runId: input.job.runId, artifactId: id });
      const detected = detectRunArtifactType(file.path, data);
      const expiresAt = new Date(now() + RUN_ARTIFACT_RETENTION_MS);
      const metadata = {
        orgId: input.job.orgId,
        runId: input.job.runId,
        creatorId: input.job.creatorId,
        workerId: input.workerId,
        id,
        path: file.path,
        fileName: path.posix.basename(file.path),
        contentType: detected.contentType,
        byteSize: data.length,
        previewable: detected.previewable,
        previewKind: detected.previewKind,
        storageKey,
        expiresAt,
      };
      try {
        const reserved = await putMetadata({ ...metadata, ready: false, database: db });
        if (!reserved) throw new LostLease();
        let uploaded = false;
        for (let attempt = 0; attempt < ARTIFACT_STORAGE_CAS_ATTEMPTS; attempt += 1) {
          const existing = await withBoundedSignal({
            parent: input.signal,
            timeoutMs: ARTIFACT_STORAGE_TIMEOUT_MS,
            timeoutMessage: "the artifact storage lookup timed out",
            operation: (signal) => headObject({ key: storageKey, signal }),
          });
          // Fence immediately before the external write. If an old worker observes an object
          // written by its successor, this check stops it before it can use that fresh ETag.
          const stillLeased = await putMetadata({ ...metadata, ready: false, database: db });
          if (!stillLeased) throw new LostLease();
          try {
            await withBoundedSignal({
              parent: input.signal,
              timeoutMs: ARTIFACT_STORAGE_TIMEOUT_MS,
              timeoutMessage: "the artifact upload timed out",
              operation: (signal) => putObject({
                key: storageKey,
                body: data,
                contentType: detected.contentType,
                ifMatch: existing?.etag,
                preventOverwrite: existing === null,
                signal,
              }),
            });
            uploaded = true;
            break;
          } catch (error) {
            if (!isPreconditionFailure(error)) throw error;
            // A competing lease changed the object after our HEAD. The next iteration re-reads
            // its ETag and revalidates the exact database lease before attempting another PUT.
          }
        }
        if (!uploaded) throw new RunRuntimeError("the artifact changed too many times during upload");
        const finalized = await putMetadata({ ...metadata, ready: true, database: db });
        if (!finalized) throw new LostLease();
        ready += 1;
      } catch {
        failed += 1;
      }
    }
    const events: RunChatEvent[] = [];
    events.push({ type: "artifacts.updated", count: ready });
    if (failed > 0) {
      events.push({
        type: "run.warning",
        code: "artifact_collection_failed",
        message: "Some generated files could not be saved. The run itself completed normally.",
        phase: "record",
      });
    }
    await append(events);
    return ready;
  } catch {
    await append([{
      type: "run.warning",
      code: "artifact_collection_failed",
      message: "Generated files could not be collected. The run itself completed normally.",
      phase: "record",
    }]).catch(() => undefined);
    return 0;
  }
}

async function revalidatePinnedSecrets(
  job: ClaimedRunJob,
  actor: ActorContext,
  masterKey: Buffer,
): Promise<void> {
  const plan = await tenant(job, (database) =>
    loadRunExecutionPlan({ actor, orgId: job.orgId, runId: job.runId, masterKey, database }),
  );
  for (const key of Object.keys(plan.env)) delete plan.env[key];
  plan.injectedLiterals.length = 0;
  plan.serverPassword = "";
}

async function guardedStartServer(input: {
  job: ClaimedRunJob;
  actor: ActorContext;
  ctx: RunControlContext;
  ref: SandboxRef;
  env: Record<string, string>;
  shutdownSignal: AbortSignal;
}): Promise<void> {
  const initialControl = await readRunControl(input.job);
  if (initialControl.cancelRequestedAt || initialControl.status === "canceled") {
    throw new CancellationRequested();
  }
  await revalidatePinnedSecrets(input.job, input.actor, input.ctx.masterKey);
  const operationAbort = new AbortController();
  const monitorAbort = new AbortController();
  let failure: unknown = null;
  let finished = false;
  let nextAclCheck = Date.now() + ACL_RECHECK_MS;
  const fail = (error: unknown) => {
    if (failure) return;
    failure = error;
    operationAbort.abort(error);
    monitorAbort.abort(error);
  };
  const onShutdown = () => fail(new WorkerShutdown());
  input.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  const strictTimeout = setTimeout(
    () => fail(new RunRuntimeError("the OpenCode server did not start before its timeout")),
    30_000,
  );

  const monitor = (async () => {
    while (!finished && !monitorAbort.signal.aborted) {
      try {
        const control = await readRunControl(input.job);
        if (control.cancelRequestedAt || control.status === "canceled") {
          throw new CancellationRequested();
        }
        if (Date.now() >= nextAclCheck) {
          await revalidatePinnedSecrets(input.job, input.actor, input.ctx.masterKey);
          nextAclCheck = Date.now() + ACL_RECHECK_MS;
        }
      } catch (error) {
        fail(error);
        return;
      }
      await sleep(1_000, monitorAbort.signal).catch(() => undefined);
    }
  })();

  try {
    await input.ctx.runtime!.startServer({ ref: input.ref, env: input.env, signal: operationAbort.signal });
    if (failure) throw failure;
  } catch (error) {
    if (failure) throw failure;
    throw error;
  } finally {
    finished = true;
    clearTimeout(strictTimeout);
    monitorAbort.abort();
    input.shutdownSignal.removeEventListener("abort", onShutdown);
    await monitor;
  }
}

async function guardedHealthCheck(input: {
  job: ClaimedRunJob;
  actor: ActorContext;
  ctx: RunControlContext;
  ref: SandboxRef;
  domain: string;
  password: string;
  shutdownSignal: AbortSignal;
}): Promise<{ ok: true; ms: number }> {
  const abort = new AbortController();
  let failure: unknown = null;
  let finished = false;
  let nextAclCheck = Date.now() + ACL_RECHECK_MS;
  const onShutdown = () => {
    failure = new WorkerShutdown();
    abort.abort(failure);
  };
  input.shutdownSignal.addEventListener("abort", onShutdown, { once: true });

  const monitor = (async () => {
    while (!finished && !abort.signal.aborted) {
      try {
        const control = await readRunControl(input.job);
        if (control.cancelRequestedAt || control.status === "canceled") {
          throw new CancellationRequested();
        }
        if (Date.now() >= nextAclCheck) {
          await revalidatePinnedSecrets(input.job, input.actor, input.ctx.masterKey);
          nextAclCheck = Date.now() + ACL_RECHECK_MS;
        }
      } catch (error) {
        failure = error;
        abort.abort(error);
        return;
      }
      await sleep(1_000, abort.signal).catch(() => undefined);
    }
  })();

  try {
    const result = await input.ctx.runtime!.healthCheck({
      ref: input.ref,
      domain: input.domain,
      password: input.password,
      signal: abort.signal,
    });
    if (failure) throw failure;
    return result;
  } catch (error) {
    if (failure) throw failure;
    throw error;
  } finally {
    finished = true;
    abort.abort();
    input.shutdownSignal.removeEventListener("abort", onShutdown);
    await monitor;
  }
}

async function waitForPromptCompletion(input: {
  job: ClaimedRunJob;
  actor: ActorContext;
  recorder: RecorderHandle;
  ctx: RunControlContext;
  target: { domain: string; password: string };
  sessionId: string;
  promptId: string;
  workerId: string;
  messageId: string;
  masterKey: Buffer;
  timeoutMs: number;
  shutdownSignal: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + Math.max(60_000, input.timeoutMs);
  let nextAclCheck = Date.now() + ACL_RECHECK_MS;
  while (true) {
    if (input.shutdownSignal.aborted) throw abortFailure(input.shutdownSignal);
    if (input.recorder.state.fatal) {
      throw new RunRuntimeError(input.recorder.state.fatal.message);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new RunRuntimeError("the prompt did not become idle before its timeout");
    const promptControl = await tenant(input.job, (database) =>
      getRunPromptStopControl({
        actor: input.actor,
        orgId: input.job.orgId,
        runId: input.job.runId,
        promptId: input.promptId,
        workerId: input.workerId,
        database,
      }),
    );
    if (promptControl === "cancel_requested") throw new PromptCancellationRequested();
    if (promptControl === "lost_lease") throw new LostLease();
    const messageState = await withBoundedSignal({
      parent: input.shutdownSignal,
      timeoutMs: Math.min(OPENCODE_CALL_TIMEOUT_MS, remainingMs),
      timeoutMessage: "the OpenCode prompt status read timed out",
      operation: (signal) => input.ctx.chat!.getMessageState(
        input.target,
        input.sessionId,
        input.messageId,
        signal,
      ),
    });
    if (messageState === "completed") {
      return;
    }
    if (messageState === "error") throw new RunRuntimeError("OpenCode could not complete the prompt");
    const control = await readRunControl(input.job);
    if (control.cancelRequestedAt || control.status === "canceled") throw new CancellationRequested();
    if (Date.now() >= nextAclCheck) {
      await revalidatePinnedSecrets(input.job, input.actor, input.masterKey);
      nextAclCheck = Date.now() + ACL_RECHECK_MS;
    }
    if (Date.now() >= deadline) throw new RunRuntimeError("the prompt did not become idle before its timeout");
    await sleep(PROMPT_POLL_MS, input.shutdownSignal);
  }
}

export function promptStopBarrierPlan(input: {
  messageState: "missing" | "pending" | "completed" | "error";
  turnBarrierRevision: number | null;
  currentBarrierRevision: number;
}): { abort: boolean; waitAfterRevision: number | null } {
  if (input.messageState === "pending" || input.messageState === "error") {
    return {
      abort: true,
      waitAfterRevision: input.turnBarrierRevision ?? input.currentBarrierRevision,
    };
  }
  if (input.messageState === "completed") {
    return { abort: false, waitAfterRevision: input.turnBarrierRevision };
  }
  return { abort: false, waitAfterRevision: null };
}

/** Abort one OpenCode turn and prove the shared session is idle before it may accept another. */
export async function abortPromptForContinuation(input: {
  chat: Pick<RunChatRuntime, "abortSession" | "getSessionState">;
  target: RunChatTarget;
  sessionId: string;
  messageExists: boolean;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  if (!input.messageExists) return;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  await withBoundedSignal({
    parent: input.signal,
    timeoutMs,
    timeoutMessage: "the active turn could not be stopped safely",
    operation: (signal) => input.chat.abortSession(input.target, input.sessionId, signal),
  });
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new RunRuntimeError("the active turn did not become idle after stop");
    const state = await withBoundedSignal({
      parent: input.signal,
      timeoutMs: Math.min(OPENCODE_CALL_TIMEOUT_MS, remainingMs),
      timeoutMessage: "the stopped turn status check timed out",
      operation: (signal) => input.chat.getSessionState(input.target, input.sessionId, signal),
    });
    if (state === "idle") return;
    if (state === "missing") throw new RunRuntimeError("the stopped conversation context disappeared");
    await sleep(Math.min(PROMPT_POLL_MS, Math.max(1, remainingMs)), input.signal);
  }
}

/**
 * A timed-out send can be followed by a deterministic-message lookup that returns missing. That
 * resolves the message id, but not the shared session's busy state. Prove idle (or abort a busy
 * session and wait for idle) before releasing the recorder gate for the next FIFO prompt.
 */
export async function proveSessionIdleAfterMissingAttempt(input: {
  chat: Pick<RunChatRuntime, "abortSession" | "getSessionState">;
  target: RunChatTarget;
  sessionId: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<"already_idle" | "aborted"> {
  const state = await withBoundedSignal({
    parent: input.signal,
    timeoutMs: input.timeoutMs ?? OPENCODE_CALL_TIMEOUT_MS,
    timeoutMessage: "the ambiguous prompt session status check timed out",
    operation: (signal) => input.chat.getSessionState(input.target, input.sessionId, signal),
  });
  if (state === "idle") return "already_idle";
  if (state === "missing") {
    throw new RunRuntimeError("the conversation context disappeared during prompt recovery");
  }
  await abortPromptForContinuation({
    chat: input.chat,
    target: input.target,
    sessionId: input.sessionId,
    messageExists: true,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  return "aborted";
}

async function saveFinalTranscript(
  job: ClaimedRunJob,
  actor: ActorContext,
  ctx: RunControlContext,
  target: { domain: string; password: string },
  sessionId: string,
  redactor: RunRedactor,
  signal: AbortSignal,
): Promise<void> {
  const items = await withBoundedSignal({
    parent: signal,
    timeoutMs: OPENCODE_CALL_TIMEOUT_MS,
    timeoutMessage: "the final OpenCode transcript read timed out",
    operation: (operationSignal) => ctx.chat!.loadItems(target, sessionId, operationSignal),
  });
  await tenant(job, (database) =>
    persistRunTranscript({
      actor,
      orgId: job.orgId,
      runId: job.runId,
      items,
      redactor,
      workerId: job.leaseOwner ?? undefined,
      database,
    }),
  );
}

async function markCanceled(input: {
  job: ClaimedRunJob;
  actor: ActorContext;
  workerId: string;
  cleaned: boolean;
  retained: boolean;
}): Promise<void> {
  const now = new Date();
  await tenant(input.job, async (database) => {
    const promptsCanceled = await cancelOutstandingRunPromptsByWorker({
      actor: input.actor,
      orgId: input.job.orgId,
      runId: input.job.runId,
      workerId: input.workerId,
      database,
    });
    if (!promptsCanceled) throw new LostLease();
    const updated = await updateRunWorkerState({
      actor: input.actor,
      orgId: input.job.orgId,
      runId: input.job.runId,
      workerId: input.workerId,
      status: "canceled",
      phase: "complete",
      frozenAt: now,
      reactivatableUntil: input.retained
        ? new Date(now.getTime() + RUN_REACTIVATION_RETENTION_MS)
        : null,
      ...(input.cleaned ? { sandboxCleanedAt: now } : {}),
      database,
    });
    if (!updated) throw new LostLease();
  });
}

function sandboxRefFromPersisted(
  job: ClaimedRunJob,
  ctx: RunControlContext,
  state: Pick<RunControlState, "sandboxName" | "sandboxId" | "timeoutMs">,
): SandboxRef {
  return {
    sandboxName: state.sandboxName ?? sandboxNameForRun(job.orgId, job.runId),
    sandboxId: state.sandboxId,
    region: ctx.region,
    timeoutMs: state.timeoutMs,
  };
}

/**
 * Creator RLS intentionally disappears with membership. The worker's exact lease RPC exposes only
 * the sandbox identity needed to destroy the workload and a fixed terminalization transition.
 */
async function terminalizeRevokedMembership(input: {
  job: ClaimedRunJob;
  workerId: string;
  ctx: RunControlContext;
  control?: Awaited<ReturnType<typeof getRunWorkerLeaseControl>>;
}): Promise<boolean> {
  const control = input.control ?? await getRunWorkerLeaseControl({
    orgId: input.job.orgId,
    runId: input.job.runId,
    creatorId: input.job.creatorId,
    workerId: input.workerId,
    database: db,
  });
  if (!control || control.membershipActive) return false;
  const revokedRef = sandboxRefFromPersisted(input.job, input.ctx, control);
  const cleaned = await teardownSandbox(input.ctx.runtime!, revokedRef);
  if (cleaned) {
    try {
      await withTenantContext(
        { orgId: input.job.orgId, userId: input.job.creatorId },
        (database) => settleLatestSandboxUsage({
          orgId: input.job.orgId,
          sandboxName: revokedRef.sandboxName,
          database,
        }),
      );
    } catch {
      // Keep the durable worker lease non-terminal so accounting can be retried. Provider teardown
      // is idempotent and must not leave a live usage row after the sandbox is gone.
      return false;
    }
  }
  return terminalizeRevokedRunLease({
    orgId: input.job.orgId,
    runId: input.job.runId,
    creatorId: input.job.creatorId,
    workerId: input.workerId,
    cleanupConfirmed: cleaned,
    database: db,
  });
}

async function processClaimedJob(input: {
  job: ClaimedRunJob;
  workerId: string;
  ctx: RunControlContext;
  config: RunWorkerConfig;
  shutdownSignal: AbortSignal;
}): Promise<void> {
  const { job, workerId, ctx, config } = input;
  const actor = actorForJob(job);
  const jobAbort = new AbortController();
  const abortJob = (reason: Error) => {
    if (!jobAbort.signal.aborted) jobAbort.abort(reason);
  };
  const onShutdown = () => abortJob(new WorkerShutdown());
  input.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  let leaseLost = false;
  let finalizingCancellation = false;
  let heartbeatPromise: Promise<boolean> | null = null;
  let activePromptId: string | null = null;
  // Keep all claim-data validation inside the durable error handler below. A malformed decoder must
  // release/retry the lease instead of rejecting before `try` and leaving an eternal reclaim loop.
  let leaseDeadline = Date.now() + config.leaseSeconds * 1_000;
  const refreshLease = (): Promise<boolean> => {
    if (heartbeatPromise) return heartbeatPromise;
    heartbeatPromise = tenant(job, async (database) => {
      const jobOwned = await heartbeatRunJob({
        actor,
        orgId: job.orgId,
        runId: job.runId,
        workerId,
        leaseSeconds: config.leaseSeconds,
        database,
      });
      const promptOwned = !jobOwned
        ? false
        : activePromptId
        ? await heartbeatRunPrompt({
            actor,
            orgId: job.orgId,
            runId: job.runId,
            promptId: activePromptId,
            workerId,
            leaseSeconds: config.leaseSeconds,
            database,
          })
        : true;
      return jobOwned && promptOwned;
    })
      .then((owned) => {
        if (!owned) {
          leaseLost = true;
          abortJob(new LostLease());
        } else {
          leaseDeadline = Date.now() + config.leaseSeconds * 1_000;
        }
        return owned;
      })
      .catch(() => {
        // A transient DB outage is allowed only until the last confirmed lease deadline.
        if (Date.now() >= leaseDeadline) {
          leaseLost = true;
          abortJob(new LostLease());
        }
        return !leaseLost;
      })
      .finally(() => { heartbeatPromise = null; });
    return heartbeatPromise;
  };
  const heartbeat = setInterval(() => {
    if (heartbeatPromise || !shouldHeartbeatRunLease({
      signalAborted: jobAbort.signal.aborted,
      finalizingCancellation,
    })) return;
    void refreshLease();
  }, config.heartbeatMs);
  const leaseWatchdog = setInterval(() => {
    if (Date.now() < leaseDeadline || !shouldHeartbeatRunLease({
      signalAborted: jobAbort.signal.aborted,
      finalizingCancellation,
    })) return;
    leaseLost = true;
    abortJob(new LostLease());
  }, Math.min(config.heartbeatMs, 1_000));
  let controlChecking = false;
  const controlWatcher = setInterval(() => {
    if (controlChecking || jobAbort.signal.aborted) return;
    controlChecking = true;
    void getRunWorkerLeaseControl({
      orgId: job.orgId,
      runId: job.runId,
      creatorId: job.creatorId,
      workerId,
      database: db,
    })
      .then((control) => {
        if (jobAbort.signal.aborted) return;
        if (!control) {
          leaseLost = true;
          abortJob(new LostLease());
        } else if (!control.membershipActive) {
          abortJob(new RunValidationError("the run owner is no longer a member", "membership_revoked"));
        } else if (control.status === "canceled" || control.cancelRequestedAt) {
          abortJob(new CancellationRequested());
        }
      })
      .catch(() => {
        if (Date.now() >= leaseDeadline) {
          leaseLost = true;
          abortJob(new LostLease());
        }
      })
      .finally(() => { controlChecking = false; });
  }, 1_000);

  let recorder: RecorderHandle | null = null;
  let artifactCollector: ReturnType<typeof createSingleFlightArtifactCollector> | null = null;
  let plan: RunExecutionPlan | null = null;
  let ref: SandboxRef | null = null;
  let redactor = createRunRedactor([]);
  let target: { domain: string; password: string } | null = null;
  let sessionId: string | null = null;
  let activationRevision = 0;
  let runtimeDeadlineAt: Date | null = null;
  const timeoutExtender = createSandboxTimeoutExtender(ctx.runtime!, async () => {
    if (!ref) return null;
    const budget = await tenant(job, (database) => getSandboxRuntimeBudget({
      orgId: job.orgId,
      sandboxName: ref!.sandboxName,
      activationRevision,
      database,
    }));
    return budget?.limitMs ?? null;
  }, config.sandboxLifecycleV2 ? {
    maxSessionMs: config.sandboxMaxSessionMs,
    readDeadlineAt: async () => {
      if (!ref) return null;
      return tenant(job, (database) => getSandboxRuntimeDeadline({
        orgId: job.orgId,
        sandboxName: ref!.sandboxName,
        activationRevision,
        database,
      }));
    },
    onObservation: async (observation) => {
      if (!ref) return;
      await tenant(job, (database) => recordSandboxRuntimeObservation({
        orgId: job.orgId,
        sandboxName: ref!.sandboxName,
        activationRevision,
        state: observation.state,
        expiresAt: observation.expiresAt,
        database,
      }));
      sandboxLifecycleLog("info", "provider_observed", {
        runId: job.runId,
        activationRevision,
        state: observation.state,
        expiresAt: observation.expiresAt?.toISOString() ?? null,
        deadlineAt: observation.deadlineAt.toISOString(),
      });
      if (Date.now() > observation.deadlineAt.getTime() + 30_000) {
        sandboxLifecycleLog("error", "runtime_deadline_overrun", {
          runId: job.runId,
          activationRevision,
          overrunMs: Date.now() - observation.deadlineAt.getTime(),
        });
      }
    },
    onError: (error) => sandboxLifecycleLog("warn", "extension_failed", {
      runId: job.runId,
      activationRevision,
      code: errorCode(error),
    }),
  } : undefined);
  try {
    leaseDeadline = claimedRunLeaseDeadline(job);
    const leaseControl = await getRunWorkerLeaseControl({
      orgId: job.orgId,
      runId: job.runId,
      creatorId: job.creatorId,
      workerId,
      database: db,
    });
    if (!leaseControl) throw new LostLease();
    if (!leaseControl.membershipActive) {
      await terminalizeRevokedMembership({ job, workerId, ctx, control: leaseControl });
      return;
    }
    const initialControl = await readRunControl(job);
    activationRevision = initialControl.activationRevision;
    ref = sandboxRefFromPersisted(job, ctx, initialControl);
    if (initialControl.status === "canceled" || initialControl.cancelRequestedAt) {
      // Recover enough persisted state for a best-effort final snapshot, but sandbox teardown never
      // depends on secrets still being accessible: `ref` was loaded before this cancellation check.
      plan = await tenant(job, (database) =>
        loadRunExecutionPlan({ actor, orgId: job.orgId, runId: job.runId, masterKey: ctx.masterKey, database }),
      ).catch(() => null);
      if (plan) {
        redactor = createRunRedactor(plan.injectedLiterals);
        if (plan.row.sandboxDomain && plan.row.opencodeSessionId) {
          target = { domain: plan.row.sandboxDomain, password: plan.serverPassword };
          sessionId = plan.row.opencodeSessionId;
        }
      }
      throw new CancellationRequested();
    }
    applySandboxRuntimeBudget(ref, await ensureRunSandboxUsage(job, ref, activationRevision));
    if (initialControl.phase === "freeze") {
      // The previous replica persisted freeze before suspending the named sandbox. Reconcile the
      // final transcript, then repeat the idempotent stop while retaining OpenCode state.
      plan = await tenant(job, (database) =>
        loadRunExecutionPlan({ actor, orgId: job.orgId, runId: job.runId, masterKey: ctx.masterKey, database }),
      ).catch(() => null);
      if (plan) {
        redactor = createRunRedactor(plan.injectedLiterals);
        timeoutExtender.activate(ref);
        if (plan.row.sandboxDomain && plan.row.opencodeSessionId) {
          target = { domain: plan.row.sandboxDomain, password: plan.serverPassword };
          sessionId = plan.row.opencodeSessionId;
          await saveFinalTranscript(job, actor, ctx, target, sessionId, redactor, jobAbort.signal).catch(() => undefined);
        }
      }
      await collectAndCacheRunArtifacts({
        job,
        actor,
        workerId,
        ctx,
        ref,
        imagePaths: [],
        redactor,
        signal: jobAbort.signal,
      });
      await timeoutExtender.stop();
      await withBoundedSignal({
        parent: jobAbort.signal,
        timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
        timeoutMessage: "the sandbox suspension timed out",
        operation: (signal) => ctx.runtime!.stop(ref!, signal),
      });
      await settleRunSandboxUsage(job, ref, activationRevision);
      const frozenAt = new Date();
      await setPhase(job, actor, workerId, "complete", {
        status: "frozen",
        frozenAt,
        reactivatableUntil: new Date(frozenAt.getTime() + RUN_REACTIVATION_RETENTION_MS),
        sandboxCleanedAt: null,
      });
      return;
    }
    await setPhase(job, actor, workerId, "resolve_inputs", { status: "starting", errorCode: null, userMessage: null });
    const materialPlan = await tenant(job, (database) =>
      loadRunMaterializationPlan({ actor, orgId: job.orgId, runId: job.runId, database }),
    );
    const activeRef: SandboxRef = {
      sandboxName: materialPlan.row.sandboxName!,
      sandboxId: materialPlan.row.sandboxId,
      region: ctx.region,
      timeoutMs: materialPlan.row.timeoutMs,
    };
    activationRevision = materialPlan.row.activationRevision;
    applySandboxRuntimeBudget(activeRef, await ensureRunSandboxUsage(job, activeRef, activationRevision));
    ref = activeRef;
    let sandbox: { sandboxId: string; domain: string } | null = null;
    let skillsAlreadyWarm = false;
    if (materialPlan.row.prewarmId) {
      const waitDeadline = Date.now() + SANDBOX_CONTROL_TIMEOUT_MS;
      while (Date.now() < waitDeadline && !jobAbort.signal.aborted) {
        const warm = await tenant(job, (database) => getAdoptedRunPrewarm({
          database,
          orgId: job.orgId,
          runId: job.runId,
          prewarmId: materialPlan.row.prewarmId!,
        }));
        if (!warm) break;
        if (warm.phase === "ready" && warm.status === "ready" && warm.sandboxId && warm.sandboxDomain) {
          sandbox = { sandboxId: warm.sandboxId, domain: warm.sandboxDomain };
          activeRef.sandboxId = warm.sandboxId;
          skillsAlreadyWarm = true;
          break;
        }
        if (warm.status === "failed" || warm.status === "canceled") break;
        if (!warm.leaseExpiresAt || warm.leaseExpiresAt.getTime() <= Date.now()) break;
        await sleep(PROMPT_POLL_MS, jobAbort.signal);
      }
    }

    if (!skillsAlreadyWarm) {
      const skills = await withBoundedSignal({
        parent: jobAbort.signal,
        timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
        timeoutMessage: "the run skill bundle download timed out",
        operation: (signal) => materializeRunSkillBundles({ plan: materialPlan, fetchArchive: ctx.fetchArchive!, signal }),
      });
      await setPhase(job, actor, workerId, "fork");
      sandbox = await withBoundedSignal({
        parent: jobAbort.signal,
        timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
        timeoutMessage: "the sandbox fork timed out",
        operation: (signal) => ctx.runtime!.forkFromGolden({
          ref: activeRef,
          goldenSnapshotId: materialPlan.row.goldenSnapshotId!,
          signal,
        }),
      });
      activeRef.sandboxId = sandbox.sandboxId;
      await setPhase(job, actor, workerId, "push_workspace", { sandboxId: sandbox.sandboxId, sandboxDomain: sandbox.domain });
      await withBoundedSignal({
        parent: jobAbort.signal,
        timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
        timeoutMessage: "the sandbox skill upload timed out",
        operation: (signal) => ctx.runtime!.pushSkillBundles({ ref: activeRef, skills, signal }),
      });
    } else {
      await setPhase(job, actor, workerId, "push_workspace", { sandboxId: sandbox!.sandboxId, sandboxDomain: sandbox!.domain });
    }
    await startRunSandboxUsage(job, activeRef, activationRevision, {
      enabled: config.sandboxLifecycleV2,
      maxSessionMs: config.sandboxMaxSessionMs,
    });
    runtimeDeadlineAt = config.sandboxLifecycleV2
      ? await tenant(job, (database) => getSandboxRuntimeDeadline({
          orgId: job.orgId,
          sandboxName: activeRef.sandboxName,
          activationRevision,
          database,
        }))
      : null;
    timeoutExtender.activate(activeRef);

    const dynamicFiles = await withBoundedSignal({
      parent: jobAbort.signal,
      timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
      timeoutMessage: "the run attachment download timed out",
      operation: (signal) => materializeRunDynamicFiles({
        plan: materialPlan,
        fetchObject: ctx.fetchObject!,
        signal,
      }),
    });
    await withBoundedSignal({
      parent: jobAbort.signal,
      timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
      timeoutMessage: "the sandbox run-file upload timed out",
      operation: (signal) => ctx.runtime!.pushRunFiles({ ref: activeRef, files: dynamicFiles, signal }),
    });

    await setPhase(job, actor, workerId, "start_server");
    // Access can change while the sandbox boots or archives upload. Revalidate every pinned skill
    // secret and the dedicated provider credential before anything reaches the workload.
    const beforeSecretInjection = await readRunControl(job);
    if (beforeSecretInjection.cancelRequestedAt || beforeSecretInjection.status === "canceled") {
      throw new CancellationRequested();
    }
    const activePlan = await tenant(job, (database) =>
      loadRunExecutionPlan({ actor, orgId: job.orgId, runId: job.runId, masterKey: ctx.masterKey, database }),
    );
    plan = activePlan;
    redactor = createRunRedactor(activePlan.injectedLiterals);
    const beforeServerStart = await readRunControl(job);
    if (beforeServerStart.cancelRequestedAt || beforeServerStart.status === "canceled") {
      throw new CancellationRequested();
    }
    const env = activePlan.env;
    await guardedStartServer({ job, actor, ctx, ref: activeRef, env, shutdownSignal: jobAbort.signal });
    for (const key of Object.keys(env)) delete env[key];
    activePlan.injectedLiterals.length = 0;

    await setPhase(job, actor, workerId, "healthcheck");
    await guardedHealthCheck({
      job,
      actor,
      ctx,
      ref: activeRef,
      domain: sandbox!.domain,
      password: activePlan.serverPassword,
      shutdownSignal: jobAbort.signal,
    });
    const chatTarget = { domain: sandbox!.domain, password: activePlan.serverPassword };
    target = chatTarget;

    await setPhase(job, actor, workerId, "create_session");
    const title = `companion-run:${job.runId}`;
    const persistedSessionState = activePlan.row.opencodeSessionId
      ? await withBoundedSignal({
          parent: jobAbort.signal,
          timeoutMs: OPENCODE_CALL_TIMEOUT_MS,
          timeoutMessage: "the persisted OpenCode session lookup timed out",
          operation: (signal) => ctx.chat!.getSessionState(chatTarget, activePlan.row.opencodeSessionId!, signal),
        })
      : "missing";
    assertRetainedConversationAvailable({
      activationRevision: activePlan.row.activationRevision,
      opencodeSessionId: activePlan.row.opencodeSessionId,
      sessionState: persistedSessionState,
    });
    let activeSessionId: string;
    if (activePlan.row.opencodeSessionId && persistedSessionState !== "missing") {
      activeSessionId = activePlan.row.opencodeSessionId;
    } else {
      const existing = await withBoundedSignal({
        parent: jobAbort.signal,
        timeoutMs: OPENCODE_CALL_TIMEOUT_MS,
        timeoutMessage: "the OpenCode session lookup timed out",
        operation: (signal) => ctx.chat!.findSessionByTitle(chatTarget, title, signal),
      });
      activeSessionId = existing?.id ?? (await withBoundedSignal({
        parent: jobAbort.signal,
        timeoutMs: OPENCODE_CALL_TIMEOUT_MS,
        timeoutMessage: "the OpenCode session creation timed out",
        operation: (signal) => ctx.chat!.createSession(chatTarget, title, signal),
      })).id;
    }
    sessionId = activeSessionId;
    await setPhase(job, actor, workerId, "prompt", {
      status: "running",
      opencodeSessionId: activeSessionId,
      lastActiveAt: new Date(),
    });

    artifactCollector = createSingleFlightArtifactCollector(async () => {
      await appendEvents(job, actor, [{ type: "artifacts.collecting" }], redactor);
      const imagePaths = recorder ? [...recorder.state.readImagePaths] : [];
      recorder?.state.readImagePaths.clear();
      await collectAndCacheRunArtifacts({
        job,
        actor,
        workerId,
        ctx,
        ref: activeRef,
        imagePaths,
        redactor,
        signal: jobAbort.signal,
      });
    });
    recorder = startRecorder({
      job,
      actor,
      ctx,
      target: chatTarget,
      sessionId: activeSessionId,
      ref: activeRef,
      activationRevision,
      redactor,
      config,
      runtimeDeadlineAt,
      shutdownSignal: jobAbort.signal,
      onArtifactToolDone: () => artifactCollector?.request(),
    });
    // The adapter resolves `started` only after OpenCode's event subscription is established.
    // Bound the handshake so a permanently broken SSE route becomes a retryable job failure.
    await Promise.race([
      recorder.started,
      sleep(
        config.sandboxLifecycleV2 ? config.recorderUnavailableMs + 15_000 : 30_000,
        jobAbort.signal,
      ).then(() => {
        throw new RunRuntimeError("the run recorder could not connect");
      }),
    ]);

    const activeRecorder = recorder;
    const finishPromptCancellation = async (
      prompt: RunPromptRow,
      turnBarrierRevision: number | null,
      dispatchMayHaveReachedRuntime = prompt.sendAttemptedAt !== null
        || (prompt.attempt > 0 && prompt.dispatchProtocol < 2),
    ): Promise<void> => {
      try {
        const messageState = await withBoundedSignal({
          parent: jobAbort.signal,
          timeoutMs: OPENCODE_CALL_TIMEOUT_MS,
          timeoutMessage: "the stopped OpenCode prompt lookup timed out",
          operation: (signal) => ctx.chat!.getMessageState(
            chatTarget,
            activeSessionId,
            prompt.messageId,
            signal,
          ),
        });
        if (messageState === "missing" && dispatchMayHaveReachedRuntime) {
          const beforeRecoveryBarrier = activeRecorder.idleBarrierRevision();
          const recovery = await proveSessionIdleAfterMissingAttempt({
            chat: ctx.chat!,
            target: chatTarget,
            sessionId: activeSessionId,
            signal: jobAbort.signal,
          });
          if (recovery === "aborted") {
            await activeRecorder.waitForIdleBarrierAfter(
              beforeRecoveryBarrier,
              OPENCODE_CALL_TIMEOUT_MS,
              jobAbort.signal,
            );
          }
        }
        // For a naturally completed turn, the recorder may already have crossed the exact barrier
        // captured before dispatch. Waiting on that revision is immediate and must not demand a
        // second artificial reconnect. Recovery starts after recorder.started, so completed/missing
        // messages with no captured turn revision already have a safe baseline.
        const stopPlan = promptStopBarrierPlan({
          messageState,
          turnBarrierRevision,
          currentBarrierRevision: activeRecorder.idleBarrierRevision(),
        });
        await abortPromptForContinuation({
          chat: ctx.chat!,
          target: chatTarget,
          sessionId: activeSessionId,
          messageExists: stopPlan.abort,
          signal: jobAbort.signal,
        });
        if (stopPlan.waitAfterRevision !== null) {
          await activeRecorder.waitForIdleBarrierAfter(
            stopPlan.waitAfterRevision,
            OPENCODE_CALL_TIMEOUT_MS,
            jobAbort.signal,
          );
        }
        await saveFinalTranscript(
          job,
          actor,
          ctx,
          chatTarget,
          activeSessionId,
          redactor,
          jobAbort.signal,
        );
        const imagePaths = [...activeRecorder.state.readImagePaths];
        activeRecorder.state.readImagePaths.clear();
        await collectAndCacheRunArtifacts({
          job,
          actor,
          workerId,
          ctx,
          ref: activeRef,
          imagePaths,
          redactor,
          signal: jobAbort.signal,
        });
        const promptCanceled = await tenant(job, (database) =>
          cancelRunPromptByWorker({
            actor,
            orgId: job.orgId,
            runId: job.runId,
            promptId: prompt.id,
            workerId,
            database,
          }),
        );
        if (!promptCanceled) throw new LostLease();
        if (messageState === "missing") {
          // No recorder event can clear a synthetic busy gate for a message that never existed.
          // The ambiguous case reached the session-idle proof above before taking this path.
          activeRecorder.state.busy = false;
        }
        activePromptId = null;
        await setPhase(job, actor, workerId, "record", {
          status: "running",
          lastActiveAt: new Date(),
        });
      } catch (stopError) {
        if (stopError instanceof WorkerShutdown || stopError instanceof LostLease || stopError instanceof CancellationRequested) {
          throw stopError;
        }
        const unsafeStop = new RunValidationError(
          "the active turn could not be stopped safely",
          "prompt_stop_failed",
        );
        const failure = await tenant(job, (database) =>
          failRunPrompt({
            actor,
            orgId: job.orgId,
            runId: job.runId,
            promptId: prompt.id,
            workerId,
            errorCode: unsafeStop.code,
            userMessage: unsafeStop.message,
            retry: false,
            overrideCancellation: true,
            database,
          }),
        );
        if (failure !== "updated") throw new LostLease();
        activePromptId = null;
        throw unsafeStop;
      }
    };

    let nextAclCheck = Date.now() + ACL_RECHECK_MS;
    while (!jobAbort.signal.aborted) {
      const control = await readRunControl(job);
      if (control.cancelRequestedAt || control.status === "canceled") throw new CancellationRequested();
      if (recorder.state.unavailable) {
        throw new RuntimeInterrupted(
          recorder.state.unavailable.code,
          recorder.state.unavailable.sandboxState,
        );
      }
      if (recorder.state.fatal) throw new RunRuntimeError(recorder.state.fatal.message);
      if (Date.now() >= nextAclCheck) {
        await revalidatePinnedSecrets(job, actor, ctx.masterKey);
        nextAclCheck = Date.now() + ACL_RECHECK_MS;
      }

      // Stop recovery must outrank the recorder's busy gate. A previous worker may have persisted
      // cancel_requested and crashed before aborting OpenCode, leaving the session legitimately busy.
      const stopRecovery: RunPromptRow | null = activePromptId
        ? null
        : await tenant(job, (database) =>
            claimRunPromptStopRecovery({
              actor,
              orgId: job.orgId,
              runId: job.runId,
              workerId,
              leaseSeconds: config.leaseSeconds,
              database,
            }),
          );
      if (stopRecovery) {
        activePromptId = stopRecovery.id;
        await finishPromptCancellation(stopRecovery, null);
        continue;
      }

      // A new prompt is safe only after the recorder has committed the previous idle snapshot and
      // re-established its upstream subscription. This also enforces one active OpenCode message
      // even if a follow-up is queued immediately after the prior outbox row completes.
      if (recorder.state.busy) {
        await sleep(PROMPT_POLL_MS, jobAbort.signal);
        continue;
      }

      const prompt = await tenant(job, (database) =>
        claimNextRunPrompt({
          actor,
          orgId: job.orgId,
          runId: job.runId,
          workerId,
          leaseSeconds: config.leaseSeconds,
          database,
        }),
      );
      if (prompt) {
        activePromptId = prompt.id;
        await revalidatePinnedSecrets(job, actor, ctx.masterKey);
        await setPhase(job, actor, workerId, "prompt", { status: "running", lastActiveAt: new Date() });
        let promptTurnBarrierRevision: number | null = null;
        let dispatchMayHaveReachedRuntime = prompt.sendAttemptedAt !== null
          || (prompt.attempt > 0 && prompt.dispatchProtocol < 2);
        try {
          const beforeSend = await readRunControl(job);
          if (beforeSend.cancelRequestedAt || beforeSend.status === "canceled") {
            throw new CancellationRequested();
          }
          const promptControl = await tenant(job, (database) =>
            getRunPromptStopControl({
              actor,
              orgId: job.orgId,
              runId: job.runId,
              promptId: prompt.id,
              workerId,
              database,
            }),
          );
          const dispatchControl = armRecorderForPromptDispatch(activeRecorder.state, promptControl);
          if (dispatchControl === "cancel_requested") throw new PromptCancellationRequested();
          if (dispatchControl === "lost_lease") throw new LostLease();
          // A prior worker may have dispatched this exact deterministic id and crashed. Only send
          // when the user message is absent; completion is tied to its assistant child rather than
          // to a global idle generation, which can advance during an unrelated reconnect.
          const dispatchBarrierRevision = activeRecorder.idleBarrierRevision();
          // Set before the call: a timed-out send may still have reached OpenCode.
          promptTurnBarrierRevision = dispatchBarrierRevision;
          const dispatchState = await dispatchPromptAfterAttachmentMount({
            mountAttachments: async () => {
              if (prompt.kind !== "follow_up") return;
              const attachmentMetadata = await tenant(job, (database) =>
                getRunPromptAttachments({
                  actor,
                  orgId: job.orgId,
                  runId: job.runId,
                  promptId: prompt.id,
                  database,
                }),
              );
              if (attachmentMetadata.length === 0) return;
              const attachmentFiles = await withBoundedSignal({
                parent: jobAbort.signal,
                timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
                timeoutMessage: "the prompt attachment download timed out",
                operation: (signal) => materializeRunAttachmentFiles({
                  attachments: attachmentMetadata,
                  fetchObject: ctx.fetchObject!,
                  signal,
                }),
              });
              await withBoundedSignal({
                parent: jobAbort.signal,
                timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
                timeoutMessage: "the prompt attachment upload timed out",
                operation: (signal) => ctx.runtime!.pushAttachments({
                  ref: activeRef,
                  attachments: attachmentFiles,
                  signal,
                }),
              });
            },
            getMessageState: () => withBoundedSignal({
              parent: jobAbort.signal,
              timeoutMs: OPENCODE_CALL_TIMEOUT_MS,
              timeoutMessage: "the OpenCode prompt lookup timed out",
              operation: (signal) => ctx.chat!.getMessageState(chatTarget, activeSessionId, prompt.messageId, signal),
            }),
            beforeSend: async () => {
              const marker = await tenant(job, (database) =>
                markRunPromptSendAttempted({
                  actor,
                  orgId: job.orgId,
                  runId: job.runId,
                  promptId: prompt.id,
                  workerId,
                  database,
                }),
              );
              if (marker === "run_cancel_requested") throw new CancellationRequested();
              if (marker === "prompt_cancel_requested") throw new PromptCancellationRequested();
              if (marker === "lost_lease") throw new LostLease();
              dispatchMayHaveReachedRuntime = true;
            },
            onMessageObserved: async (messageState) => {
              // Observing the deterministic id is already proof of an external side effect. Set
              // the conservative local guard before the database call so a racing stop cannot
              // downgrade this turn to the pre-dispatch path.
              dispatchMayHaveReachedRuntime = true;
              // A completed retry created no turn in this lease. Clear the synthetic revision
              // before the cancellation-capable marker call so a racing stop cannot wait for a
              // second idle barrier that will never arrive.
              if (messageState === "completed") promptTurnBarrierRevision = null;
              const marker = await tenant(job, (database) =>
                markRunPromptSendAttempted({
                  actor,
                  orgId: job.orgId,
                  runId: job.runId,
                  promptId: prompt.id,
                  workerId,
                  database,
                }),
              );
              if (marker === "run_cancel_requested") throw new CancellationRequested();
              if (marker === "prompt_cancel_requested") throw new PromptCancellationRequested();
              if (marker === "lost_lease") throw new LostLease();
            },
            sendPrompt: () => withBoundedSignal({
              parent: jobAbort.signal,
              timeoutMs: OPENCODE_CALL_TIMEOUT_MS,
              timeoutMessage: "the OpenCode prompt dispatch timed out",
              operation: (signal) => ctx.chat!.sendPrompt(
                chatTarget,
                activeSessionId,
                prompt.prompt,
                prompt.messageId,
                signal,
              ),
            }),
          });
          // `missing` is sent before the helper returns. A completed deterministic retry created no
          // new turn in this lease, so recorder.started already established its safe baseline.
          if (dispatchState === "completed") promptTurnBarrierRevision = null;
          await waitForPromptCompletion({
            job,
            actor,
            recorder,
            ctx,
            target: chatTarget,
            sessionId: activeSessionId,
            promptId: prompt.id,
            workerId,
            messageId: prompt.messageId,
            masterKey: ctx.masterKey,
            timeoutMs: activePlan.row.timeoutMs,
            shutdownSignal: jobAbort.signal,
          });
          // Keep a definitive end-of-turn scan even when tool-triggered scans already published.
          await artifactCollector.collectNow();
          const completion = await tenant(job, (database) =>
            completeRunPrompt({ actor, orgId: job.orgId, runId: job.runId, promptId: prompt.id, workerId, database }),
          );
          if (completion === "cancel_requested") throw new PromptCancellationRequested();
          if (completion === "lost_lease") throw new LostLease();
          activePromptId = null;
          await setPhase(job, actor, workerId, "record", { status: "running", lastActiveAt: new Date() });
        } catch (error) {
          if (error instanceof WorkerShutdown || error instanceof LostLease || error instanceof CancellationRequested) throw error;
          if (error instanceof PromptCancellationRequested) {
            await finishPromptCancellation(
              prompt,
              promptTurnBarrierRevision,
              dispatchMayHaveReachedRuntime,
            );
          } else {
            const failure = await tenant(job, (database) =>
              failRunPrompt({
                actor,
                orgId: job.orgId,
                runId: job.runId,
                promptId: prompt.id,
                workerId,
                errorCode: errorCode(error),
                userMessage: userFacingError(error, redactor),
                retry: isTransientRunFailure(error) && prompt.attempt < 3,
                backoffMs: 2 ** Math.max(0, prompt.attempt - 1) * 1_000,
                database,
              }),
            );
            if (failure === "cancel_requested") {
              await finishPromptCancellation(
                prompt,
                promptTurnBarrierRevision,
                dispatchMayHaveReachedRuntime,
              );
            } else {
              if (failure === "lost_lease") throw new LostLease();
              releaseSyntheticRecorderBusy(activeRecorder.state, dispatchMayHaveReachedRuntime);
              activePromptId = null;
              throw error;
            }
          }
        }
        continue;
      }

      if (!recorder.state.busy && recorder.state.idleAt && Date.now() - recorder.state.idleAt >= config.inactivityMs) {
        const gate = await tenant(job, (database) =>
          beginRunFreeze({ actor, orgId: job.orgId, runId: job.runId, workerId, database }),
        );
        if (gate === "prompt_pending") continue;
        if (gate === "cancel_requested") throw new CancellationRequested();
        if (gate === "lost_lease") throw new LostLease();
        break;
      }
      await sleep(PROMPT_POLL_MS, jobAbort.signal);
    }
    if (leaseLost) throw new LostLease();
    if (jobAbort.signal.aborted) {
      throw abortFailure(jobAbort.signal);
    }

    // `beginRunFreeze` already closed prompt admission under the run lock. Keep that phase through
    // final transcript collection so a racing API request cannot enqueue abandoned work.
    await saveFinalTranscript(job, actor, ctx, chatTarget, activeSessionId, redactor, jobAbort.signal);
    if (jobAbort.signal.aborted) throw leaseLost ? new LostLease() : abortFailure(jobAbort.signal);
    // Freeze/recovery retains its own definitive scan and coalesces with any last tool completion.
    await artifactCollector.collectNow();
    await setPhase(job, actor, workerId, "freeze");
    await timeoutExtender.stop();
    await recorder.stop();
    recorder = null;
    if (jobAbort.signal.aborted) throw leaseLost ? new LostLease() : abortFailure(jobAbort.signal);
    await withBoundedSignal({
      parent: jobAbort.signal,
      timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
      timeoutMessage: "the sandbox suspension timed out",
      operation: (signal) => ctx.runtime!.stop(activeRef, signal),
    });
    await settleRunSandboxUsage(job, activeRef, activationRevision);
    const frozenAt = new Date();
    await setPhase(job, actor, workerId, "complete", {
      status: "frozen",
      frozenAt,
      reactivatableUntil: new Date(frozenAt.getTime() + RUN_REACTIVATION_RETENTION_MS),
      sandboxCleanedAt: null,
    });
  } catch (error) {
    const durableIdleAt = recorder?.state.idleAt ?? null;
    await timeoutExtender.stop();
    await artifactCollector?.waitForIdle().catch(() => undefined);
    await recorder?.stop();
    recorder = null;
    if (!input.shutdownSignal.aborted) {
      const revoked = await terminalizeRevokedMembership({ job, workerId, ctx }).catch(() => false);
      if (revoked) return;
    }
    if (error instanceof WorkerShutdown || error instanceof LostLease || leaseLost || input.shutdownSignal.aborted) {
      // Deliberately keep the job leased. Another replica resumes it after expiry without tearing
      // down a healthy sandbox during a normal deployment.
      return;
    }
    if (error instanceof RuntimeInterrupted && config.sandboxLifecycleV2) {
      if (!(await refreshLease()) || leaseLost) return;
      if (target && sessionId) {
        await saveFinalTranscript(
          job,
          actor,
          ctx,
          target,
          sessionId,
          redactor,
          AbortSignal.timeout(10_000),
        ).catch(() => undefined);
      }
      let sandboxState = error.sandboxState;
      if (sandboxState !== "missing" && ref) {
        const stopped = await ctx.runtime!
          .stop(ref, AbortSignal.timeout(SANDBOX_CONTROL_TIMEOUT_MS))
          .catch(() => false);
        sandboxState = stopped ? "retained" : "unknown";
      }
      if (ref) await settleRunSandboxUsage(job, ref, activationRevision).catch(() => undefined);
      if (
        activePromptId === null
        && durableIdleAt !== null
        && sandboxState !== "unknown"
      ) {
        const frozen = await tenant(job, (database) => freezeRunAfterRuntimeLossByWorker({
          actor,
          orgId: job.orgId,
          runId: job.runId,
          workerId,
          sandboxState,
          database,
        })).catch(() => "lost_lease" as const);
        if (frozen === "frozen") {
          sandboxLifecycleLog("info", "run_frozen_after_runtime_loss", {
            runId: job.runId,
            activationRevision,
            code: error.code,
            sandboxState,
          });
          return;
        }
        if (frozen === "lost_lease") return;
      }
      const interrupted = await tenant(job, (database) => interruptRunByWorker({
        actor,
        orgId: job.orgId,
        runId: job.runId,
        workerId,
        errorCode: error.code,
        userMessage: error.message,
        sandboxState,
        database,
      })).catch(() => false);
      sandboxLifecycleLog(interrupted ? "warn" : "error", "run_interrupted", {
        runId: job.runId,
        activationRevision,
        code: error.code,
        sandboxState,
        promptActive: activePromptId !== null,
      });
      return;
    }
    let cancellationRequested = error instanceof CancellationRequested;
    if (!cancellationRequested) {
      const latest = await readRunControl(job).catch(() => null);
      cancellationRequested = Boolean(latest?.cancelRequestedAt || latest?.status === "canceled");
    }
    if (cancellationRequested) {
      finalizingCancellation = true;
      if (!(await refreshLease()) || leaseLost) return;
      const contextStable = await abortConversationForRetention({
        chat: ctx.chat!,
        target,
        sessionId,
        signal: AbortSignal.timeout(10_000),
      });
      if (target && sessionId) {
        await saveFinalTranscript(
          job,
          actor,
          ctx,
          target,
          sessionId,
          redactor,
          AbortSignal.timeout(10_000),
        ).catch(() => undefined);
      }
      let retained = false;
      let cleaned = false;
      if (ref) {
        if (!contextStable) {
          cleaned = await teardownSandbox(ctx.runtime!, ref);
        } else {
          try {
            const stopped = await ctx.runtime!.stop(ref, AbortSignal.timeout(SANDBOX_CONTROL_TIMEOUT_MS));
            ({ retained, cleaned } = cancellationStateAfterStop(stopped));
          } catch {
            cleaned = await teardownSandbox(ctx.runtime!, ref);
          }
        }
      }
      if (ref && (retained || cleaned)) {
        await settleRunSandboxUsage(job, ref, activationRevision).catch(() => undefined);
      }
      try {
        await markCanceled({ job, actor, workerId, cleaned, retained });
      } catch {
        await terminalizeRevokedMembership({ job, workerId, ctx }).catch(() => false);
      }
      return;
    }

    if (input.shutdownSignal.aborted || leaseLost) return;
    if (target && sessionId) {
      await saveFinalTranscript(
        job,
        actor,
        ctx,
        target,
        sessionId,
        redactor,
        AbortSignal.timeout(10_000),
      ).catch(() => undefined);
    }
    const code = errorCode(error);
    const message = userFacingError(error, redactor);
    const outcome = await tenant(job, (database) =>
      failOrRetryRunJob({
        actor,
        orgId: job.orgId,
        runId: job.runId,
        workerId,
        errorCode: code,
        userMessage: message,
        transient: isTransientRunFailure(error),
        backoffMs: 2 ** Math.max(0, job.attempt - 1) * 1_000,
        redactor,
        database,
      }),
    ).catch(() => "lost_lease" as const);
    const failureEvent = runFailureEvent(outcome, { attempt: job.attempt, code, message });
    if (failureEvent) {
      // failOrRetryRunJob atomically released this worker's lease before returning the retry
      // outcome. The resulting status event is still legitimate, but no longer lease-guarded.
      await appendEvents(job, actor, [failureEvent], redactor, false).catch(() => undefined);
    }
    if (outcome === "cancel_requested") {
      finalizingCancellation = true;
      if (!(await refreshLease()) || leaseLost) return;
      const contextStable = await abortConversationForRetention({
        chat: ctx.chat!,
        target,
        sessionId,
        signal: AbortSignal.timeout(10_000),
      });
      let retained = false;
      let cleaned = false;
      if (ref) {
        if (!contextStable) {
          cleaned = await teardownSandbox(ctx.runtime!, ref);
        } else {
          try {
            const stopped = await ctx.runtime!.stop(ref, AbortSignal.timeout(SANDBOX_CONTROL_TIMEOUT_MS));
            ({ retained, cleaned } = cancellationStateAfterStop(stopped));
          } catch {
            cleaned = await teardownSandbox(ctx.runtime!, ref);
          }
        }
      }
      if (ref && (retained || cleaned)) {
        await settleRunSandboxUsage(job, ref, activationRevision).catch(() => undefined);
      }
      try {
        await markCanceled({ job, actor, workerId, cleaned, retained });
      } catch {
        await terminalizeRevokedMembership({ job, workerId, ctx }).catch(() => false);
      }
      return;
    }
    if (outcome === "lost_lease") {
      await terminalizeRevokedMembership({ job, workerId, ctx }).catch(() => false);
    }
    if (outcome === "failed" && ref) {
      const cleaned = await teardownSandbox(ctx.runtime!, ref);
      if (cleaned) {
        await settleRunSandboxUsage(job, ref, activationRevision).catch(() => undefined);
        await tenant(job, (database) =>
          updateRunWorkerState({
            actor,
            orgId: job.orgId,
            runId: job.runId,
            sandboxCleanedAt: new Date(),
            database,
          }),
        ).catch(() => undefined);
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(leaseWatchdog);
    clearInterval(controlWatcher);
    input.shutdownSignal.removeEventListener("abort", onShutdown);
    await timeoutExtender.stop();
    await recorder?.stop();
    if (plan) {
      for (const key of Object.keys(plan.env)) delete plan.env[key];
      plan.injectedLiterals.length = 0;
      plan.serverPassword = "";
    }
    if (target) target.password = "";
    redactor.clear();
  }
}

export async function startRunSupervisor(): Promise<Supervisor | null> {
  const enabledSetting = process.env.COMPANION_RUNS_ENABLED?.trim().toLowerCase();
  if (enabledSetting !== "true" && enabledSetting !== "1") {
    console.info("run supervisor disabled by COMPANION_RUNS_ENABLED");
    return null;
  }
  const vercel = vercelConfigFromEnv();
  const goldenSnapshotId = process.env.COMPANION_GOLDEN_SNAPSHOT_ID?.trim() || null;
  let masterKey: Buffer;
  try {
    masterKey = loadSecretsMasterKey();
  } catch {
    console.info("run supervisor disabled: secrets master key is unavailable");
    return null;
  }
  if (!vercel || !goldenSnapshotId) {
    masterKey.fill(0);
    console.info("run supervisor disabled: Vercel Sandbox or golden snapshot is unavailable");
    return null;
  }

  const config = runWorkerConfig();
  const modelCatalog = createModelCatalog();
  const runtime = createVercelRuntime(vercel);
  const chat = createOpencodeRunChatRuntime();
  const ctx: RunControlContext = {
    masterKey,
    goldenSnapshotId,
    opencodeVersion: process.env.OPENCODE_VERSION?.trim() || null,
    region: process.env.COMPANION_SANDBOX_REGION?.trim() || "iad1",
    timeoutMs: boundedInteger(process.env.COMPANION_SANDBOX_TIMEOUT_MS, 300_000, { min: 10_000, max: 3_600_000 }),
    resolveModelKeys: (model) => modelCatalog.resolveModel(model),
    runtimeAvailable: true,
    runtimeMessage: null,
    runtime,
    chat,
    runTenant: withTenantContext,
    fetchArchive: (key, signal) => getSkillArchive({ key, signal }),
    fetchObject: (key, signal) => getSkillArchive({ key, signal }),
  };
  const workerId = `${process.env.HOSTNAME?.trim() || "worker"}:${process.pid}:${randomUUID()}`;
  const shutdown = new AbortController();
  const active = new Map<string, Promise<void>>();
  let claimRunning = false;
  const readinessIntervalMs = Math.min(config.heartbeatMs, 5_000);
  const readinessTtlSeconds = Math.max(5, Math.min(300, Math.ceil(readinessIntervalMs * 3 / 1_000)));
  let readinessHeartbeating = false;
  const advertiseReadiness = async () => {
    if (shutdown.signal.aborted || readinessHeartbeating) return;
    readinessHeartbeating = true;
    try {
      await heartbeatRunWorker({ workerId, ttlSeconds: readinessTtlSeconds, database: db });
    } finally {
      readinessHeartbeating = false;
    }
  };
  try {
    await advertiseReadiness();
  } catch (error) {
    masterKey.fill(0);
    throw error;
  }
  const readinessTimer = setInterval(() => void advertiseReadiness().catch(() => undefined), readinessIntervalMs);

  const claim = async () => {
    if (shutdown.signal.aborted || claimRunning) return;
    const capacity = config.concurrency - active.size;
    if (capacity <= 0) return;
    claimRunning = true;
    try {
      const jobs = await claimRunJobs({
        workerId,
        limit: capacity,
        leaseSeconds: config.leaseSeconds,
        database: db,
      });
      for (const job of jobs) {
        if (active.has(job.id)) continue;
        const lifecycleEnabledForOrg = config.sandboxLifecycleV2
          && (
            config.sandboxLifecycleV2OrgIds.size === 0
            || config.sandboxLifecycleV2OrgIds.has(job.orgId)
          );
        const task = processClaimedJob({
          job,
          workerId,
          ctx,
          config: { ...config, sandboxLifecycleV2: lifecycleEnabledForOrg },
          shutdownSignal: shutdown.signal,
        })
          .catch((error) => {
            // `processClaimedJob` normally persists every failure itself. If an invariant escapes that
            // boundary, log identifiers + a bounded classification only; never an SDK error/message.
            console.error("run job processor escaped durable failure handling", {
              jobId: job.id,
              runId: job.runId,
              code: errorCode(error),
            });
          })
          .finally(() => { active.delete(job.id); });
        active.set(job.id, task);
      }
    } catch {
      // A database outage is retried by the next bounded claim tick; no payload is logged.
    } finally {
      claimRunning = false;
    }
  };

  await claim();
  const timer = setInterval(() => void claim(), config.claimIntervalMs);
  const prewarmScheduler = createRunPrewarmScheduler({
    workerId,
    concurrency: config.prewarmConcurrency,
    leaseSeconds: config.leaseSeconds,
    ctx,
    shutdownSignal: shutdown.signal,
  });
  const prewarmEnabled = !["false", "0"].includes(process.env.COMPANION_RUN_PREWARM_ENABLED?.trim().toLowerCase() ?? "");
  const prewarmTick = async () => {
    // Real run claims always get first look at the queue and use an independent concurrency budget.
    await claim();
    if (prewarmEnabled) await prewarmScheduler.run();
    await prewarmScheduler.cleanup();
  };
  const prewarmTimer = setInterval(() => void prewarmTick().catch(() => undefined), config.claimIntervalMs);
  void prewarmTick().catch(() => undefined);
  const cleanupScheduler = createRunCleanupScheduler({
    workerId,
    concurrency: config.concurrency,
    leaseSeconds: config.leaseSeconds,
    runtime,
    region: ctx.region,
    timeoutMs: ctx.timeoutMs,
  });
  const cleanup = () => cleanupScheduler.run().catch(() => undefined);
  const cleanupTimer = setInterval(() => void cleanup(), config.cleanupIntervalMs);
  void cleanup();
  const runtimeReconciler = config.sandboxLifecycleV2
    ? createRunRuntimeReconciler({
        workerId,
        concurrency: config.concurrency,
        leaseSeconds: config.leaseSeconds,
        runtime,
        region: ctx.region,
        orgIds: config.sandboxLifecycleV2OrgIds,
      })
    : null;
  const reconcileRuntime = () => runtimeReconciler?.run().catch(() => undefined);
  const runtimeReconcileTimer = runtimeReconciler
    ? setInterval(() => void reconcileRuntime(), 60_000)
    : null;
  void reconcileRuntime();
  let retentionRunning = false;
  const retain = async () => {
    if (retentionRunning || shutdown.signal.aborted) return;
    retentionRunning = true;
    try {
      // The narrow SECURITY DEFINER function deletes only events whose run has been terminal >24h.
      while ((await cleanupExpiredRunEvents({ limit: 1_000, database: db })) === 1_000) {
        if (shutdown.signal.aborted) break;
      }
      if (!shutdown.signal.aborted) await sweepRunAttachmentOrphans();
      if (!shutdown.signal.aborted) await sweepRunArtifacts();
    } catch {
      // Best-effort maintenance; the next interval retries without affecting active runs.
    } finally {
      retentionRunning = false;
    }
  };
  const retentionTimer = setInterval(() => void retain(), config.retentionIntervalMs);
  void retain();
  console.info("run supervisor started", { concurrency: config.concurrency });
  return {
    async stop() {
      clearInterval(timer);
      clearInterval(prewarmTimer);
      clearInterval(cleanupTimer);
      if (runtimeReconcileTimer) clearInterval(runtimeReconcileTimer);
      clearInterval(retentionTimer);
      clearInterval(readinessTimer);
      shutdown.abort();
      await removeRunWorkerHeartbeat({ workerId, database: db }).catch(() => undefined);
      await cleanupScheduler.stop();
      await runtimeReconciler?.stop();
      await prewarmScheduler.stop();
      await Promise.allSettled(active.values());
      masterKey.fill(0);
    },
  };
}
