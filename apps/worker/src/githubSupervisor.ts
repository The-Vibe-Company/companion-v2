import { randomUUID } from "node:crypto";
import {
  claimGitHubSyncDestinations,
  completeGitHubSync,
  failGitHubSync,
  getGitHubSyncPlan,
  isGitHubSyncFenceLive,
  lockGitHubSyncPublishFence,
  type ClaimedGitHubDestination,
  type GitHubSyncSkill,
} from "@companion/core/services";
import { withTenantContext } from "@companion/db";
import { GitHubAppClient, githubAppConfig, renderSkillRepository } from "@companion/github";
import { getSkillArchive } from "@companion/storage";
import { sql } from "drizzle-orm";
import type { Supervisor } from "./billingSupervisor";

const CLAIM_INTERVAL_MS = 15_000;
const ATTEMPT_TIMEOUT_MS = 240_000;
const FENCE_CHECK_INTERVAL_MS = 1_000;
const PUBLISH_TIMEOUT_MS = 30_000;
const TRANSACTION_HEARTBEAT_INTERVAL_MS = 1_000;
const ARCHIVE_FETCH_CONCURRENCY = 4;
const DESTINATION_CONCURRENCY = 2;
const MAX_MIRROR_SKILLS = 1_000;
const MAX_MIRROR_ARCHIVE_BYTES = 64 * 1024 * 1024;

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "GitHub synchronization failed";
  return error.message.replace(/(gh[oprsu]_[A-Za-z0-9_]+|Bearer\s+\S+)/gi, "[redacted]").slice(0, 1000);
}

async function mapWithConcurrency<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  }));
}

export async function loadGitHubSkillArchives(
  skills: GitHubSyncSkill[],
  loadArchive: (storagePath: string, signal?: AbortSignal) => Promise<Buffer> = (storagePath, signal) => getSkillArchive({ key: storagePath, signal }),
  signal?: AbortSignal,
): Promise<Array<GitHubSyncSkill & { archive: Buffer }>> {
  if (skills.length > MAX_MIRROR_SKILLS) throw new Error(`GitHub mirror exceeds the ${MAX_MIRROR_SKILLS}-skill safety limit`);
  const loaded = new Array<GitHubSyncSkill & { archive: Buffer }>(skills.length);
  let totalBytes = 0;
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener("abort", relayAbort, { once: true });
  const workers = Array.from({ length: Math.min(skills.length, ARCHIVE_FETCH_CONCURRENCY) }, async () => {
    while (!failed && cursor < skills.length) {
      const index = cursor++;
      const skill = skills[index]!;
      try {
        const archive = await loadArchive(skill.storagePath, controller.signal);
        totalBytes += archive.byteLength;
        if (totalBytes > MAX_MIRROR_ARCHIVE_BYTES) throw new Error("GitHub mirror exceeds the 64 MB archive safety limit");
        loaded[index] = { ...skill, archive };
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          controller.abort(error);
        }
      }
    }
  });
  await Promise.allSettled(workers);
  signal?.removeEventListener("abort", relayAbort);
  if (failed) throw failure;
  return loaded;
}

async function processGitHubSyncClaim(input: {
  claim: ClaimedGitHubDestination;
  workerId: string;
  client: GitHubAppClient;
  shutdownSignal: AbortSignal;
  attemptTimeoutMs: number;
  fenceCheckIntervalMs: number;
  publishTimeoutMs: number;
  transactionHeartbeatIntervalMs: number;
}): Promise<void> {
  const { claim, workerId } = input;
  const tenant = <T>(fn: Parameters<typeof withTenantContext<T>>[1]) =>
    withTenantContext({ orgId: claim.orgId, userId: workerId }, fn);
  const attemptAbort = new AbortController();
  const abortAttempt = (reason: unknown) => {
    if (!attemptAbort.signal.aborted) {
      attemptAbort.abort(reason instanceof Error ? reason : new Error("GitHub synchronization was aborted"));
    }
  };
  const onShutdown = () => abortAttempt(input.shutdownSignal.reason ?? new Error("GitHub sync supervisor stopped"));
  if (input.shutdownSignal.aborted) onShutdown();
  else input.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  const attemptTimeout = setTimeout(
    () => abortAttempt(new Error("GitHub synchronization attempt timed out")),
    input.attemptTimeoutMs,
  );
  const fence = {
    orgId: claim.orgId,
    destinationId: claim.destinationId,
    workerId,
    claimedRevision: claim.claimedRevision,
    leaseGeneration: claim.leaseGeneration,
  };
  let fenceCheck: Promise<void> | null = null;
  let fenceMonitorPaused = false;
  let finalized = false;

  const assertFence = (): Promise<void> => {
    attemptAbort.signal.throwIfAborted();
    if (fenceCheck) return fenceCheck;
    const operation: Promise<void> = tenant(async (database) => {
      const live = await isGitHubSyncFenceLive({ ...fence, database });
      if (!live) throw new Error("GitHub synchronization fence was lost");
    })
      .catch((error) => {
        abortAttempt(error);
        throw error;
      })
      .finally(() => {
        if (fenceCheck === operation) fenceCheck = null;
      });
    fenceCheck = operation;
    return operation;
  };
  const fenceMonitor = setInterval(() => {
    if (fenceMonitorPaused || finalized || attemptAbort.signal.aborted) return;
    void assertFence().catch(() => undefined);
  }, input.fenceCheckIntervalMs);

  try {
    // withTenantContext is itself a transaction. Keep this callback limited to the durable plan read;
    // archive I/O, rendering, and GitHub preparation must not hold a database connection or row locks.
    const plan = await tenant((database) => getGitHubSyncPlan({ ...fence, database }));
    attemptAbort.signal.throwIfAborted();
    const skills = await loadGitHubSkillArchives(plan.skills, undefined, attemptAbort.signal);
    attemptAbort.signal.throwIfAborted();
    const files = await renderSkillRepository({
      owner: plan.destination.owner,
      repo: plan.destination.name,
      skills,
      signal: attemptAbort.signal,
    });
    attemptAbort.signal.throwIfAborted();
    await input.client.writeRepository({
      installationId: plan.destination.installationId,
      repositoryId: plan.destination.repositoryId,
      owner: plan.destination.owner,
      repo: plan.destination.name,
      branch: plan.destination.defaultBranch,
      files,
      message: `chore(companion): sync ${skills.length} skill${skills.length === 1 ? "" : "s"}`,
      signal: attemptAbort.signal,
      assertFence,
      finalize: async ({ commitSha, branch, publish }) => {
        if (finalized) throw new Error("GitHub synchronization was finalized more than once");
        fenceMonitorPaused = true;
        try {
          // Drain a probe that began before the pause. Once the ordered row locks below are held, the
          // lock transaction is the fence and no separate probe should contend with it.
          if (fenceCheck) await fenceCheck;
          attemptAbort.signal.throwIfAborted();
          await tenant(async (database) => {
            await lockGitHubSyncPublishFence({ ...fence, database });
            attemptAbort.signal.throwIfAborted();

            const heartbeatAbort = new AbortController();
            const publishSignal = AbortSignal.any([
              attemptAbort.signal,
              heartbeatAbort.signal,
              AbortSignal.timeout(input.publishTimeoutMs),
            ]);
            let heartbeat: Promise<void> | null = null;
            let heartbeatFailure: unknown;
            const keepTransactionAlive = () => {
              if (heartbeat || publishSignal.aborted) return;
              const operation = database.execute(sql`select 1`)
                .then(() => undefined)
                .catch((error) => {
                  heartbeatFailure = error;
                  heartbeatAbort.abort(error);
                })
                .finally(() => {
                  if (heartbeat === operation) heartbeat = null;
                });
              heartbeat = operation;
            };

            // Verify the held transaction connection before beginning the sole externally visible
            // operation, then keep it active until that non-force ref publication settles.
            await database.execute(sql`select 1`);
            const heartbeatTimer = setInterval(keepTransactionAlive, input.transactionHeartbeatIntervalMs);
            try {
              await publish(publishSignal);
            } finally {
              clearInterval(heartbeatTimer);
              if (heartbeat) await heartbeat;
            }
            if (heartbeatFailure) throw heartbeatFailure;
            publishSignal.throwIfAborted();
            const completed = await completeGitHubSync({
              ...fence,
              commitSha,
              branch,
              skillCount: skills.length,
              database,
            });
            if (!completed) throw new Error("GitHub synchronization completion fence was lost");
            finalized = true;
          });
        } finally {
          fenceMonitorPaused = false;
        }
      },
    });
    if (!finalized) throw new Error("GitHub repository writer did not finalize synchronization");
  } finally {
    clearInterval(fenceMonitor);
    clearTimeout(attemptTimeout);
    input.shutdownSignal.removeEventListener("abort", onShutdown);
    await (fenceCheck as Promise<void> | null)?.catch(() => undefined);
  }
}

export async function startGitHubSupervisor(input: {
  intervalMs?: number;
  client?: GitHubAppClient;
  attemptTimeoutMs?: number;
  fenceCheckIntervalMs?: number;
  publishTimeoutMs?: number;
  transactionHeartbeatIntervalMs?: number;
} = {}): Promise<Supervisor | null> {
  const config = input.client?.config ?? githubAppConfig();
  if (!config) {
    console.info("GitHub sync supervisor disabled");
    return null;
  }
  const client = input.client ?? new GitHubAppClient(config);
  const workerId = `${process.env.HOSTNAME?.trim() || "worker"}:github:${process.pid}:${randomUUID()}`;
  let stopped = false;
  let running: Promise<void> | null = null;
  const shutdown = new AbortController();

  const batch = async () => {
    const claimed = await claimGitHubSyncDestinations({ workerId, limit: 5, leaseSeconds: 300 });
    await mapWithConcurrency(claimed, DESTINATION_CONCURRENCY, async (claim) => {
      try {
        await processGitHubSyncClaim({
          claim,
          workerId,
          client,
          shutdownSignal: shutdown.signal,
          attemptTimeoutMs: input.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS,
          fenceCheckIntervalMs: input.fenceCheckIntervalMs ?? FENCE_CHECK_INTERVAL_MS,
          publishTimeoutMs: input.publishTimeoutMs ?? PUBLISH_TIMEOUT_MS,
          transactionHeartbeatIntervalMs:
            input.transactionHeartbeatIntervalMs ?? TRANSACTION_HEARTBEAT_INTERVAL_MS,
        });
      } catch (error) {
        await withTenantContext({ orgId: claim.orgId, userId: workerId }, (database) => failGitHubSync({
          orgId: claim.orgId, destinationId: claim.destinationId, workerId,
          claimedRevision: claim.claimedRevision, leaseGeneration: claim.leaseGeneration,
          error: safeError(error), database,
        })).catch(() => false);
      }
    });
  };
  const tick = () => {
    if (stopped || running) return;
    const operation = batch().catch((error) => {
      if (!stopped) console.warn(`GitHub synchronization batch will retry (${safeError(error)})`);
    });
    running = operation;
    void operation.finally(() => { if (running === operation) running = null; });
  };
  tick();
  const timer = setInterval(tick, input.intervalMs ?? CLAIM_INTERVAL_MS);
  console.info("GitHub sync supervisor started");
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      shutdown.abort(new Error("GitHub sync supervisor stopped"));
      if (running) await running;
    },
  };
}
