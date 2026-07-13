import { createHash, randomUUID } from "node:crypto";
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
  claimNextRunPrompt,
  claimRunJobs,
  cleanupExpiredRunEvents,
  completeRunPrompt,
  failOrRetryRunJob,
  failRunPrompt,
  getDecryptedProviderKey,
  heartbeatRunJob,
  heartbeatRunPrompt,
  loadRunExecutionPlan,
  materializeRunWorkspace,
  persistRunTranscript,
  publishRunArtifact,
  RunBusyError,
  RunValidationError,
  teardownSandbox,
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

const ARTIFACT_MAX_FILES = 20;
const ARTIFACT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const PROMPT_POLL_MS = 250;
const ACL_RECHECK_MS = 15_000;

class WorkerShutdown extends Error {}
class LostLease extends Error {}
class CancellationRequested extends Error {}

interface RunControlState {
  status: "queued" | "starting" | "running" | "frozen" | "error" | "canceled";
  cancelRequestedAt: Date | null;
}

interface RecorderState {
  busy: boolean;
  idleGeneration: number;
  idleAt: number | null;
  fatal: { code: string; message: string } | null;
}

interface RecorderHandle {
  state: RecorderState;
  started: Promise<void>;
  stop(): Promise<void>;
}

function actorForJob(job: ClaimedRunJob): ActorContext {
  // Core authorization uses the stable user id. Display fields are intentionally never logged.
  return { id: job.creatorId, email: "", name: "Run owner" };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new WorkerShutdown());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new WorkerShutdown());
      },
      { once: true },
    );
  });
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
      .select({ status: schema.skillRuns.status, cancelRequestedAt: schema.skillRuns.cancelRequestedAt })
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
): Promise<void> {
  if (events.length === 0) return;
  await tenant(job, (database) =>
    appendRunEvents({ actor, orgId: job.orgId, runId: job.runId, events, redactor, database }),
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

function eventFingerprint(event: RunChatEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("base64url");
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
  const state: RecorderState = { busy: false, idleGeneration: 0, idleAt: null, fatal: null };
  const abort = new AbortController();
  const streams = new Map<string, RunStreamingRedactor>();
  let stopped = false;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const recent: string[] = [];
  const recentSet = new Set<string>();

  const remember = (event: RunChatEvent) => {
    const fingerprint = eventFingerprint(event);
    recent.push(fingerprint);
    recentSet.add(fingerprint);
    if (recent.length > 200) {
      const removed = recent.shift()!;
      if (!recent.includes(removed)) recentSet.delete(removed);
    }
  };

  const persistSnapshot = async () => {
    const items = await chat.loadItems(input.target, input.sessionId);
    await tenant(input.job, (database) =>
      persistRunTranscript({
        actor: input.actor,
        orgId: input.job.orgId,
        runId: input.job.runId,
        items,
        redactor: input.redactor,
        database,
      }),
    );
  };

  const loop = (async () => {
    let first = true;
    let reconnectMs = input.config.recorderReconnectMinMs;
    while (!stopped && !input.shutdownSignal.aborted) {
      let replaying = !first;
      first = false;
      try {
        const iterator = chat
          .streamEvents(input.target, input.sessionId, abort.signal, resolveStarted)
          [Symbol.asyncIterator]();
        let next = iterator.next();
        while (!stopped && !input.shutdownSignal.aborted) {
          const result = await next;
          if (result.done) break;
          const event = result.value;
          next = iterator.next();
          const fingerprint = eventFingerprint(event);
          if (replaying && recentSet.has(fingerprint)) continue;
          replaying = false;
          remember(event);
          if (event.type === "status") state.busy = event.state !== "idle";
          if (event.type === "run.error") state.fatal = { code: event.code, message: event.message };
          const normalized = redactStreamEvent(event, input.redactor, streams);
          await appendEvents(input.job, input.actor, normalized, input.redactor);
          if (event.type === "session.idle") {
            await persistSnapshot();
            state.busy = false;
            state.idleAt = Date.now();
            state.idleGeneration += 1;
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
      await sleep(reconnectMs).catch(() => undefined);
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

async function waitForPromptIdle(input: {
  job: ClaimedRunJob;
  actor: ActorContext;
  recorder: RecorderHandle;
  generation: number;
  masterKey: Buffer;
  timeoutMs: number;
  shutdownSignal: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + Math.max(60_000, input.timeoutMs);
  let nextAclCheck = Date.now() + ACL_RECHECK_MS;
  while (input.recorder.state.idleGeneration <= input.generation) {
    if (input.shutdownSignal.aborted) throw new WorkerShutdown();
    if (input.recorder.state.fatal) {
      throw new RunRuntimeError(input.recorder.state.fatal.message);
    }
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
): Promise<void> {
  const items = await ctx.chat!.loadItems(target, sessionId);
  await tenant(job, (database) =>
    persistRunTranscript({ actor, orgId: job.orgId, runId: job.runId, items, redactor, database }),
  );
}

function artifactContentType(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  if (extension === "html") return "text/html; charset=utf-8";
  if (extension === "json") return "application/json";
  if (extension === "csv") return "text/csv; charset=utf-8";
  if (extension === "txt" || extension === "md") return "text/plain; charset=utf-8";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "pdf") return "application/pdf";
  return "application/octet-stream";
}

async function collectAndPublishArtifacts(input: {
  job: ClaimedRunJob;
  actor: ActorContext;
  ctx: RunControlContext;
  ref: SandboxRef;
  redactor: RunRedactor;
}): Promise<void> {
  let vanish: Awaited<ReturnType<typeof getDecryptedProviderKey>> = null;
  try {
    vanish = await tenant(input.job, (database) =>
      getDecryptedProviderKey({
        actor: input.actor,
        orgId: input.job.orgId,
        provider: "vanish",
        masterKey: input.ctx.masterKey,
        database,
      }),
    );
  } catch {
    await appendEvents(
      input.job,
      input.actor,
      [{ type: "run.warning", code: "vanish_unavailable", message: "Artifact sharing is temporarily unavailable", phase: "collect_artifacts" }],
      input.redactor,
    ).catch(() => undefined);
    return;
  }
  if (!vanish) return;

  try {
    let files: Awaited<ReturnType<NonNullable<RunControlContext["runtime"]>["collectFiles"]>>;
    try {
      files = await input.ctx.runtime!.collectFiles({
        ref: input.ref,
        dir: "artifacts",
        maxFiles: ARTIFACT_MAX_FILES,
        maxFileBytes: ARTIFACT_MAX_FILE_BYTES,
      });
    } catch {
      await appendEvents(
        input.job,
        input.actor,
        [{ type: "run.warning", code: "artifact_collect_failed", message: "Artifacts could not be collected", phase: "collect_artifacts" }],
        input.redactor,
      );
      return;
    }

    for (const [index, file] of files.entries()) {
      const redactedPath = input.redactor.redactText(file.path);
      const safePath = redactedPath === file.path ? file.path : `artifact-${index + 1}`;
      try {
        const contentDigest = createHash("sha256")
          .update(file.path)
          .update("\0")
          .update(file.data)
          .digest("base64url");
        const published = await publishRunArtifact({
          apiKey: vanish.value,
          filename: safePath,
          bytes: file.data,
          idempotencyKey: `run:${input.job.runId}:artifact:${file.byteSize}:${contentDigest}`,
        });
        await tenant(input.job, (database) =>
          database
            .insert(schema.skillRunArtifacts)
            .values({
              orgId: input.job.orgId,
              runId: input.job.runId,
              path: safePath,
              fileName: safePath.split("/").pop() || safePath,
              contentType: artifactContentType(safePath),
              byteSize: file.byteSize,
              vanishId: published.id,
              url: published.url,
              expiresAt: published.expiresAt ? new Date(published.expiresAt) : null,
            })
            .onConflictDoUpdate({
              target: [schema.skillRunArtifacts.orgId, schema.skillRunArtifacts.runId, schema.skillRunArtifacts.path],
              set: {
                vanishId: published.id,
                url: published.url,
                expiresAt: published.expiresAt ? new Date(published.expiresAt) : null,
                byteSize: file.byteSize,
                publishedAt: new Date(),
              },
            }),
        );
      } catch {
        await appendEvents(
          input.job,
          input.actor,
          [{ type: "run.warning", code: "vanish_publish_failed", message: `Artifact ${safePath} could not be shared`, phase: "collect_artifacts" }],
          input.redactor,
        );
      }
    }
  } finally {
    vanish.value = "";
  }
}

async function markCanceled(input: {
  job: ClaimedRunJob;
  actor: ActorContext;
  workerId: string;
  cleaned: boolean;
}): Promise<void> {
  const now = new Date();
  await tenant(input.job, async (database) => {
    await updateRunWorkerState({
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
  const onShutdown = () => jobAbort.abort();
  input.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  let leaseLost = false;
  let heartbeating = false;
  let activePromptId: string | null = null;
  let leaseDeadline = job.leaseExpiresAt?.getTime() ?? Date.now() + config.leaseSeconds * 1_000;
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
      const promptOwned = activePromptId
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
          jobAbort.abort();
        } else {
          leaseDeadline = Date.now() + config.leaseSeconds * 1_000;
        }
      })
      .catch(() => {
        // A transient DB outage is allowed only until the last confirmed lease deadline.
        if (Date.now() >= leaseDeadline) {
          leaseLost = true;
          jobAbort.abort();
        }
      })
      .finally(() => { heartbeating = false; });
  }, config.heartbeatMs);
  const leaseWatchdog = setInterval(() => {
    if (Date.now() < leaseDeadline || jobAbort.signal.aborted) return;
    leaseLost = true;
    jobAbort.abort();
  }, Math.min(config.heartbeatMs, 1_000));

  let recorder: RecorderHandle | null = null;
  let plan: RunExecutionPlan | null = null;
  let redactor = createRunRedactor([]);
  let target: { domain: string; password: string } | null = null;
  let sessionId: string | null = null;
  try {
    const initialControl = await readRunControl(job);
    if (initialControl.status === "canceled" || initialControl.cancelRequestedAt) throw new CancellationRequested();
    await setPhase(job, actor, workerId, "resolve_inputs", { status: "starting", errorCode: null, userMessage: null });
    plan = await tenant(job, (database) =>
      loadRunExecutionPlan({ actor, orgId: job.orgId, runId: job.runId, masterKey: ctx.masterKey, database }),
    );
    redactor = createRunRedactor(plan.injectedLiterals);
    const workspace = await materializeRunWorkspace({
      plan,
      fetchArchive: ctx.fetchArchive!,
      fetchObject: ctx.fetchObject!,
    });
    const ref = sandboxRef(plan, ctx);

    await setPhase(job, actor, workerId, "fork");
    const sandbox = await ctx.runtime!.forkFromGolden({ ref, goldenSnapshotId: plan.row.goldenSnapshotId! });
    ref.sandboxId = sandbox.sandboxId;
    await setPhase(job, actor, workerId, "push_workspace", {
      sandboxId: sandbox.sandboxId,
      sandboxDomain: sandbox.domain,
    });
    await ctx.runtime!.pushWorkspace({ ref, files: workspace });

    await setPhase(job, actor, workerId, "start_server");
    // Access can change while the sandbox boots or archives upload. Revalidate every pinned vault
    // reference at the last possible boundary before any credential reaches the workload.
    await revalidatePinnedSecrets(job, actor, ctx.masterKey);
    const env = plan.env;
    await ctx.runtime!.startServer({ ref, env });
    for (const key of Object.keys(env)) delete env[key];
    plan.injectedLiterals.length = 0;

    await setPhase(job, actor, workerId, "healthcheck");
    await ctx.runtime!.healthCheck({ ref, domain: sandbox.domain, password: plan.serverPassword });
    target = { domain: sandbox.domain, password: plan.serverPassword };

    await setPhase(job, actor, workerId, "create_session");
    const title = `companion-run:${job.runId}`;
    if (plan.row.opencodeSessionId) {
      sessionId = plan.row.opencodeSessionId;
    } else {
      const existing = await ctx.chat!.findSessionByTitle(target, title);
      sessionId = existing?.id ?? (await ctx.chat!.createSession(target, title)).id;
    }
    await setPhase(job, actor, workerId, "prompt", {
      status: "running",
      opencodeSessionId: sessionId,
      lastActiveAt: new Date(),
    });

    recorder = startRecorder({
      job,
      actor,
      ctx,
      target,
      sessionId,
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
        const generation = recorder.state.idleGeneration;
        recorder.state.busy = true;
        await setPhase(job, actor, workerId, "prompt", { status: "running", lastActiveAt: new Date() });
        try {
          const beforeSend = await readRunControl(job);
          if (beforeSend.cancelRequestedAt || beforeSend.status === "canceled") {
            throw new CancellationRequested();
          }
          await ctx.chat!.sendPrompt(target, sessionId, prompt.prompt, prompt.messageId);
          await waitForPromptIdle({
            job,
            actor,
            recorder,
            generation,
            masterKey: ctx.masterKey,
            timeoutMs: plan.row.timeoutMs,
            shutdownSignal: jobAbort.signal,
          });
          await tenant(job, (database) =>
            completeRunPrompt({ actor, orgId: job.orgId, runId: job.runId, promptId: prompt.id, workerId, database }),
          );
          activePromptId = null;
          await setPhase(job, actor, workerId, "collect_artifacts", { status: "running", lastActiveAt: new Date() });
          await collectAndPublishArtifacts({ job, actor, ctx, ref, redactor });
          await setPhase(job, actor, workerId, "record", { status: "running", lastActiveAt: new Date() });
        } catch (error) {
          if (error instanceof WorkerShutdown || error instanceof LostLease || error instanceof CancellationRequested) throw error;
          await tenant(job, (database) =>
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
          activePromptId = null;
          throw error;
        }
        continue;
      }

      if (!recorder.state.busy && recorder.state.idleAt && Date.now() - recorder.state.idleAt >= config.inactivityMs) {
        break;
      }
      await sleep(PROMPT_POLL_MS, jobAbort.signal);
    }
    if (leaseLost) throw new LostLease();
    if (jobAbort.signal.aborted) throw new WorkerShutdown();

    await setPhase(job, actor, workerId, "collect_artifacts");
    await saveFinalTranscript(job, actor, ctx, target, sessionId, redactor);
    await collectAndPublishArtifacts({ job, actor, ctx, ref, redactor });
    if (jobAbort.signal.aborted) throw leaseLost ? new LostLease() : new WorkerShutdown();
    await setPhase(job, actor, workerId, "freeze");
    await recorder.stop();
    recorder = null;
    if (jobAbort.signal.aborted) throw leaseLost ? new LostLease() : new WorkerShutdown();
    const cleaned = await teardownSandbox(ctx.runtime!, ref);
    await setPhase(job, actor, workerId, "complete", {
      status: "frozen",
      frozenAt: new Date(),
      ...(cleaned ? { sandboxCleanedAt: new Date() } : {}),
    });
  } catch (error) {
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
      await recorder?.stop();
      recorder = null;
      if (target && sessionId) {
        await saveFinalTranscript(job, actor, ctx, target, sessionId, redactor).catch(() => undefined);
      }
      const cleaned = plan ? await teardownSandbox(ctx.runtime!, sandboxRef(plan, ctx)) : true;
      await markCanceled({ job, actor, workerId, cleaned });
      return;
    }

    await recorder?.stop();
    recorder = null;
    if (input.shutdownSignal.aborted || leaseLost) return;
    if (target && sessionId) {
      await saveFinalTranscript(job, actor, ctx, target, sessionId, redactor).catch(() => undefined);
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
      await appendEvents(job, actor, [failureEvent], redactor).catch(() => undefined);
    }
    if (outcome === "cancel_requested") {
      const cleaned = plan ? await teardownSandbox(ctx.runtime!, sandboxRef(plan, ctx)) : true;
      await markCanceled({ job, actor, workerId, cleaned });
      return;
    }
    if (outcome === "failed" && plan) {
      const cleaned = await teardownSandbox(ctx.runtime!, sandboxRef(plan, ctx));
      if (cleaned) {
        await tenant(job, (database) =>
          updateRunWorkerState({
            actor,
            orgId: job.orgId,
            runId: job.runId,
            phase: "cleanup",
            sandboxCleanedAt: new Date(),
            database,
          }),
        ).catch(() => undefined);
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(leaseWatchdog);
    input.shutdownSignal.removeEventListener("abort", onShutdown);
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
    fetchArchive: (key) => getSkillArchive({ key }),
    fetchObject: (key) => getSkillArchive({ key }),
  };
  const workerId = `${process.env.HOSTNAME?.trim() || "worker"}:${process.pid}:${randomUUID()}`;
  const shutdown = new AbortController();
  const active = new Map<string, Promise<void>>();
  let claimRunning = false;

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
          .catch(() => undefined)
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
      shutdown.abort();
      await cleanupScheduler.stop();
      await Promise.allSettled(active.values());
      masterKey.fill(0);
    },
  };
}
