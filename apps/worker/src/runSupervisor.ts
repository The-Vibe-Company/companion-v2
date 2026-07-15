import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { RunChatEvent, RunPhase } from "@companion/contracts";
import {
  createRunRedactor,
  loadSecretsMasterKey,
  RunRuntimeError,
  SecretConfigurationError,
  type RunRedactor,
  type RunStreamingRedactor,
  type SandboxRef,
} from "@companion/core";
import {
  appendRunEvents,
  beginRunFreeze,
  claimNextRunPrompt,
  claimRunJobs,
  cleanupExpiredRunEvents,
  completeRunPrompt,
  failOrRetryRunJob,
  failRunPrompt,
  getRunWorkerLeaseControl,
  heartbeatRunWorker,
  heartbeatRunJob,
  heartbeatRunPrompt,
  getRunPromptAttachments,
  loadRunExecutionPlan,
  materializeRunAttachmentFiles,
  materializeRunWorkspace,
  persistRunTranscript,
  removeRunWorkerHeartbeat,
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
} from "@companion/core/services";
import { db, schema, withTenantContext, type Db } from "@companion/db";
import {
  createModelCatalog,
  createOpencodeRunChatRuntime,
  createVercelRuntime,
  vercelConfigFromEnv,
} from "@companion/sandbox";
import { getSkillArchive } from "@companion/storage";
import { boundedInteger, runWorkerConfig, type RunWorkerConfig } from "./config";
import type { Supervisor } from "./billingSupervisor";
import { createRunCleanupScheduler } from "./runCleanup";

const PROMPT_POLL_MS = 250;
const ACL_RECHECK_MS = 15_000;
const OPENCODE_CALL_TIMEOUT_MS = 30_000;
const SANDBOX_CONTROL_TIMEOUT_MS = 60_000;

class WorkerShutdown extends Error {}
class LostLease extends Error {}
class CancellationRequested extends Error {}

function abortFailure(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new WorkerShutdown();
}

interface RunControlState {
  status: "queued" | "starting" | "running" | "frozen" | "error" | "canceled";
  phase: RunPhase;
  cancelRequestedAt: Date | null;
  sandboxName: string | null;
  sandboxId: string | null;
  sandboxDomain: string | null;
  opencodeSessionId: string | null;
  timeoutMs: number;
}

interface RecorderState {
  busy: boolean;
  idleAt: number | null;
  fatal: { code: string; message: string } | null;
}

interface RecorderHandle {
  state: RecorderState;
  started: Promise<void>;
  stop(): Promise<void>;
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

export function createSandboxTimeoutExtender(runtime: NonNullable<RunControlContext["runtime"]>): {
  activate(ref: SandboxRef): void;
  stop(): Promise<void>;
} {
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeRef: SandboxRef | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const refresh = () => {
    if (stopped || !activeRef || !runtime.extendTimeout || inFlight) return;
    const { extensionMs } = sandboxTimeoutExtensionSchedule(activeRef.timeoutMs);
    inFlight = runtime.extendTimeout(activeRef, extensionMs, AbortSignal.timeout(10_000)).catch(() => undefined).finally(() => {
      inFlight = null;
    });
  };

  return {
    activate(ref) {
      if (stopped || timer || !runtime.extendTimeout) return;
      activeRef = ref;
      const { intervalMs } = sandboxTimeoutExtensionSchedule(ref.timeoutMs);
      // Extending immediately gives a deployment at any point in the first interval a full lease.
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

function startRecorder(input: {
  job: ClaimedRunJob;
  actor: ActorContext;
  ctx: RunControlContext;
  target: { domain: string; password: string };
  sessionId: string;
  redactor: RunRedactor;
  config: RunWorkerConfig;
  shutdownSignal: AbortSignal;
}): RecorderHandle {
  const chat = input.ctx.chat!;
  const state: RecorderState = { busy: false, idleAt: null, fatal: null };
  const abort = new AbortController();
  const recorderSignal = AbortSignal.any([abort.signal, input.shutdownSignal]);
  const streams = new Map<string, RunStreamingRedactor>();
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
    await tenant(input.job, (database) =>
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
  };

  const loop = (async () => {
    let reconnectMs = input.config.recorderReconnectMinMs;
    recorderLoop: while (!stopped && !input.shutdownSignal.aborted) {
      try {
        let connected = false;
        let resolveConnected!: () => void;
        const connection = new Promise<void>((resolve) => { resolveConnected = resolve; });
        const connectionAbort = new AbortController();
        const connectionTimer = setTimeout(
          () => connectionAbort.abort(new RunRuntimeError("the run recorder could not connect")),
          OPENCODE_CALL_TIMEOUT_MS,
        );
        const streamSignal = AbortSignal.any([recorderSignal, connectionAbort.signal]);
        const iterator = chat
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
          }
          reconnectMs = input.config.recorderReconnectMinMs;
        }
      } catch {
        if (stopped || input.shutdownSignal.aborted) break;
      }
      if (stopped || input.shutdownSignal.aborted) break;
      await appendEvents(
        input.job,
        input.actor,
        [{ type: "status", state: "retry", attempt: null, message: "Reconnecting to the run recorder" }],
        input.redactor,
      ).catch(() => undefined);
      await sleep(reconnectMs, recorderSignal).catch(() => undefined);
      reconnectMs = Math.min(input.config.recorderReconnectMaxMs, reconnectMs * 2);
    }
  })();

  return {
    state,
    started,
    async stop() {
      stopped = true;
      abort.abort();
      await loop.catch(() => undefined);
      for (const stream of streams.values()) stream.clear();
      streams.clear();
    },
  };
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
}): Promise<void> {
  const now = new Date();
  await tenant(input.job, async (database) => {
    const updated = await updateRunWorkerState({
      actor: input.actor,
      orgId: input.job.orgId,
      runId: input.job.runId,
      workerId: input.workerId,
      status: "canceled",
      phase: "complete",
      frozenAt: now,
      ...(input.cleaned ? { sandboxCleanedAt: now } : {}),
      database,
    });
    if (!updated) throw new LostLease();
    await database
      .update(schema.skillRunPrompts)
      .set({ status: "canceled", leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(
        and(
          eq(schema.skillRunPrompts.orgId, input.job.orgId),
          eq(schema.skillRunPrompts.runId, input.job.runId),
          inArray(schema.skillRunPrompts.status, ["queued", "processing"]),
        ),
      );
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
  const cleaned = await teardownSandbox(
    input.ctx.runtime!,
    sandboxRefFromPersisted(input.job, input.ctx, control),
  );
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
  let heartbeating = false;
  let activePromptId: string | null = null;
  // Keep all claim-data validation inside the durable error handler below. A malformed decoder must
  // release/retry the lease instead of rejecting before `try` and leaving an eternal reclaim loop.
  let leaseDeadline = Date.now() + config.leaseSeconds * 1_000;
  const heartbeat = setInterval(() => {
    if (heartbeating || jobAbort.signal.aborted) return;
    heartbeating = true;
    void tenant(job, async (database) => {
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
      })
      .catch(() => {
        // A transient DB outage is allowed only until the last confirmed lease deadline.
        if (Date.now() >= leaseDeadline) {
          leaseLost = true;
          abortJob(new LostLease());
        }
      })
      .finally(() => { heartbeating = false; });
  }, config.heartbeatMs);
  const leaseWatchdog = setInterval(() => {
    if (Date.now() < leaseDeadline || jobAbort.signal.aborted) return;
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
  let plan: RunExecutionPlan | null = null;
  let ref: SandboxRef | null = null;
  let redactor = createRunRedactor([]);
  let target: { domain: string; password: string } | null = null;
  let sessionId: string | null = null;
  const timeoutExtender = createSandboxTimeoutExtender(ctx.runtime!);
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
    if (initialControl.phase === "freeze") {
      // The previous replica persisted freeze before provider teardown. Repeating destroy is safe;
      // forking here would recreate an empty sandbox and trust a dead OpenCode session. Reconcile a
      // final transcript snapshot from the existing session when its pinned inputs remain valid.
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
      await timeoutExtender.stop();
      const cleaned = await teardownSandbox(ctx.runtime!, ref);
      await setPhase(job, actor, workerId, "complete", {
        status: "frozen",
        frozenAt: new Date(),
        ...(cleaned ? { sandboxCleanedAt: new Date() } : {}),
      });
      return;
    }
    await setPhase(job, actor, workerId, "resolve_inputs", { status: "starting", errorCode: null, userMessage: null });
    const activePlan = await tenant(job, (database) =>
      loadRunExecutionPlan({ actor, orgId: job.orgId, runId: job.runId, masterKey: ctx.masterKey, database }),
    );
    plan = activePlan;
    redactor = createRunRedactor(activePlan.injectedLiterals);
    const workspace = await withBoundedSignal({
      parent: jobAbort.signal,
      timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
      timeoutMessage: "the run workspace download timed out",
      operation: (signal) => materializeRunWorkspace({
        plan: activePlan,
        fetchArchive: ctx.fetchArchive!,
        fetchObject: ctx.fetchObject!,
        signal,
      }),
    });
    const activeRef = sandboxRef(activePlan, ctx);
    ref = activeRef;

    await setPhase(job, actor, workerId, "fork");
    const sandbox = await withBoundedSignal({
      parent: jobAbort.signal,
      timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
      timeoutMessage: "the sandbox fork timed out",
      operation: (signal) => ctx.runtime!.forkFromGolden({
        ref: activeRef,
        goldenSnapshotId: activePlan.row.goldenSnapshotId!,
        signal,
      }),
    });
    activeRef.sandboxId = sandbox.sandboxId;
    timeoutExtender.activate(activeRef);
    await setPhase(job, actor, workerId, "push_workspace", {
      sandboxId: sandbox.sandboxId,
      sandboxDomain: sandbox.domain,
    });
    await withBoundedSignal({
      parent: jobAbort.signal,
      timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS,
      timeoutMessage: "the sandbox workspace upload timed out",
      operation: (signal) => ctx.runtime!.pushWorkspace({ ref: activeRef, files: workspace, signal }),
    });

    await setPhase(job, actor, workerId, "start_server");
    // Access can change while the sandbox boots or archives upload. Revalidate every pinned skill
    // secret and the dedicated provider credential before anything reaches the workload.
    const beforeSecretInjection = await readRunControl(job);
    if (beforeSecretInjection.cancelRequestedAt || beforeSecretInjection.status === "canceled") {
      throw new CancellationRequested();
    }
    await revalidatePinnedSecrets(job, actor, ctx.masterKey);
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
      domain: sandbox.domain,
      password: activePlan.serverPassword,
      shutdownSignal: jobAbort.signal,
    });
    const chatTarget = { domain: sandbox.domain, password: activePlan.serverPassword };
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

    recorder = startRecorder({
      job,
      actor,
      ctx,
      target: chatTarget,
      sessionId: activeSessionId,
      redactor,
      config,
      shutdownSignal: jobAbort.signal,
    });
    // The adapter resolves `started` only after OpenCode's event subscription is established.
    // Bound the handshake so a permanently broken SSE route becomes a retryable job failure.
    await Promise.race([
      recorder.started,
      sleep(30_000, jobAbort.signal).then(() => {
        throw new RunRuntimeError("the run recorder could not connect");
      }),
    ]);

    let nextAclCheck = Date.now() + ACL_RECHECK_MS;
    while (!jobAbort.signal.aborted) {
      const control = await readRunControl(job);
      if (control.cancelRequestedAt || control.status === "canceled") throw new CancellationRequested();
      if (recorder.state.fatal) throw new RunRuntimeError(recorder.state.fatal.message);
      if (Date.now() >= nextAclCheck) {
        await revalidatePinnedSecrets(job, actor, ctx.masterKey);
        nextAclCheck = Date.now() + ACL_RECHECK_MS;
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
        recorder.state.busy = true;
        await setPhase(job, actor, workerId, "prompt", { status: "running", lastActiveAt: new Date() });
        try {
          const beforeSend = await readRunControl(job);
          if (beforeSend.cancelRequestedAt || beforeSend.status === "canceled") {
            throw new CancellationRequested();
          }
          if (prompt.kind === "follow_up") {
            const attachmentMetadata = await tenant(job, (database) =>
              getRunPromptAttachments({
                actor,
                orgId: job.orgId,
                runId: job.runId,
                promptId: prompt.id,
                database,
              }),
            );
            if (attachmentMetadata.length > 0) {
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
            }
          }
          // A prior worker may have dispatched this exact deterministic id and crashed. Only send
          // when the user message is absent; completion is tied to its assistant child rather than
          // to a global idle generation, which can advance during an unrelated reconnect.
          const messageState = await withBoundedSignal({
            parent: jobAbort.signal,
            timeoutMs: OPENCODE_CALL_TIMEOUT_MS,
            timeoutMessage: "the OpenCode prompt lookup timed out",
            operation: (signal) => ctx.chat!.getMessageState(chatTarget, activeSessionId, prompt.messageId, signal),
          });
          if (messageState === "missing") {
            await withBoundedSignal({
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
            });
          } else if (messageState === "error") {
            throw new RunRuntimeError("OpenCode could not complete the prompt");
          }
          await waitForPromptCompletion({
            job,
            actor,
            recorder,
            ctx,
            target: chatTarget,
            sessionId: activeSessionId,
            messageId: prompt.messageId,
            masterKey: ctx.masterKey,
            timeoutMs: activePlan.row.timeoutMs,
            shutdownSignal: jobAbort.signal,
          });
          const promptCompleted = await tenant(job, (database) =>
            completeRunPrompt({ actor, orgId: job.orgId, runId: job.runId, promptId: prompt.id, workerId, database }),
          );
          if (!promptCompleted) throw new LostLease();
          activePromptId = null;
          await setPhase(job, actor, workerId, "record", { status: "running", lastActiveAt: new Date() });
        } catch (error) {
          if (error instanceof WorkerShutdown || error instanceof LostLease || error instanceof CancellationRequested) throw error;
          const promptFailed = await tenant(job, (database) =>
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
          if (!promptFailed) throw new LostLease();
          activePromptId = null;
          throw error;
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
    await setPhase(job, actor, workerId, "freeze");
    await timeoutExtender.stop();
    await recorder.stop();
    recorder = null;
    if (jobAbort.signal.aborted) throw leaseLost ? new LostLease() : abortFailure(jobAbort.signal);
    const cleaned = await teardownSandbox(ctx.runtime!, activeRef);
    await setPhase(job, actor, workerId, "complete", {
      status: "frozen",
      frozenAt: new Date(),
      ...(cleaned ? { sandboxCleanedAt: new Date() } : {}),
    });
  } catch (error) {
    await timeoutExtender.stop();
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
    let cancellationRequested = error instanceof CancellationRequested;
    if (!cancellationRequested) {
      const latest = await readRunControl(job).catch(() => null);
      cancellationRequested = Boolean(latest?.cancelRequestedAt || latest?.status === "canceled");
    }
    if (cancellationRequested) {
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
      const cleaned = ref ? await teardownSandbox(ctx.runtime!, ref) : false;
      try {
        await markCanceled({ job, actor, workerId, cleaned });
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
      const cleaned = ref ? await teardownSandbox(ctx.runtime!, ref) : false;
      try {
        await markCanceled({ job, actor, workerId, cleaned });
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
        const task = processClaimedJob({ job, workerId, ctx, config, shutdownSignal: shutdown.signal })
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
  let retentionRunning = false;
  const retain = async () => {
    if (retentionRunning || shutdown.signal.aborted) return;
    retentionRunning = true;
    try {
      // The narrow SECURITY DEFINER function deletes only events whose run has been terminal >24h.
      while ((await cleanupExpiredRunEvents({ limit: 1_000, database: db })) === 1_000) {
        if (shutdown.signal.aborted) break;
      }
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
      clearInterval(cleanupTimer);
      clearInterval(retentionTimer);
      clearInterval(readinessTimer);
      shutdown.abort();
      await removeRunWorkerHeartbeat({ workerId, database: db }).catch(() => undefined);
      await cleanupScheduler.stop();
      await Promise.allSettled(active.values());
      masterKey.fill(0);
    },
  };
}
