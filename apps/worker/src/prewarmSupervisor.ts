import {
  claimRunPrewarmCleanups,
  claimRunPrewarms,
  completeRunPrewarmCleanup,
  heartbeatClaimedRunPrewarm,
  loadRunPrewarmPlan,
  materializeRunPrewarmSkills,
  purgeRunPrewarms,
  releaseClaimedRunPrewarm,
  teardownSandbox,
  updateClaimedRunPrewarm,
  type ActorContext,
  type RunControlContext,
  type ClaimedRunPrewarm,
} from "@companion/core/services";
import { db, withTenantContext } from "@companion/db";

const CONTROL_TIMEOUT_MS = 60_000;

function actorFor(prewarm: ClaimedRunPrewarm): ActorContext {
  return { id: prewarm.creatorId, email: "", name: "Prewarm owner" };
}

async function processPrewarm(input: {
  prewarm: ClaimedRunPrewarm;
  workerId: string;
  leaseSeconds: number;
  ctx: RunControlContext;
  shutdownSignal: AbortSignal;
}): Promise<void> {
  const { prewarm, workerId, ctx } = input;
  const actor = actorFor(prewarm);
  const tenant = <T>(fn: Parameters<typeof withTenantContext<T>>[1]) =>
    withTenantContext({ orgId: prewarm.orgId, userId: prewarm.creatorId }, fn);
  const heartbeat = setInterval(() => {
    void tenant((database) => heartbeatClaimedRunPrewarm({
      actor,
      orgId: prewarm.orgId,
      prewarmId: prewarm.id,
      workerId,
      leaseSeconds: input.leaseSeconds,
      database,
    })).catch(() => undefined);
  }, Math.max(1_000, Math.floor(input.leaseSeconds * 1_000 / 3)));
  const signal = AbortSignal.any([input.shutdownSignal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]);
  let sandboxIdentity: { sandboxId: string; domain: string } | null = null;
  try {
    const plan = await tenant((database) => loadRunPrewarmPlan({
      actor,
      orgId: prewarm.orgId,
      prewarmId: prewarm.id,
      database,
    }));
    if (plan.row.status === "canceled" || plan.row.clientLeaseExpiresAt <= new Date() || plan.row.absoluteExpiresAt <= new Date()) return;
    const ownsBeforeFork = await tenant((database) => updateClaimedRunPrewarm({
      actor, orgId: prewarm.orgId, prewarmId: prewarm.id, workerId, phase: "fork", database,
    }));
    if (!ownsBeforeFork) return;
    const ref = {
      sandboxName: plan.row.sandboxName,
      sandboxId: plan.row.sandboxId,
      region: ctx.region,
      timeoutMs: plan.row.timeoutMs,
    };
    const sandbox = await ctx.runtime!.forkFromGolden({
      ref,
      goldenSnapshotId: plan.row.goldenSnapshotId,
      signal,
    });
    sandboxIdentity = sandbox;
    ref.sandboxId = sandbox.sandboxId;
    const owns = await tenant((database) => updateClaimedRunPrewarm({
      actor,
      orgId: prewarm.orgId,
      prewarmId: prewarm.id,
      workerId,
      phase: "push_skills",
      sandboxId: sandbox.sandboxId,
      sandboxDomain: sandbox.domain,
      database,
    }));
    if (!owns) return;
    const refreshed = await tenant((database) => loadRunPrewarmPlan({ actor, orgId: prewarm.orgId, prewarmId: prewarm.id, database }));
    if (refreshed.row.status === "canceled" && !refreshed.row.adoptedRunId) return;
    const skills = await materializeRunPrewarmSkills(refreshed, ctx.fetchArchive!, signal);
    await ctx.runtime!.pushSkillBundles({ ref, skills, signal });
    await tenant((database) => updateClaimedRunPrewarm({
      actor,
      orgId: prewarm.orgId,
      prewarmId: prewarm.id,
      workerId,
      phase: "ready",
      status: "ready",
      sandboxId: sandbox.sandboxId,
      sandboxDomain: sandbox.domain,
      errorCode: null,
      complete: true,
      database,
    }));
  } catch {
    await tenant((database) => updateClaimedRunPrewarm({
      actor,
      orgId: prewarm.orgId,
      prewarmId: prewarm.id,
      workerId,
      status: "failed",
      errorCode: "prewarm_failed",
      complete: true,
      database,
    })).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
    await tenant((database) => releaseClaimedRunPrewarm({
      actor,
      orgId: prewarm.orgId,
      prewarmId: prewarm.id,
      workerId,
      sandboxId: sandboxIdentity?.sandboxId,
      sandboxDomain: sandboxIdentity?.domain,
      database,
    })).catch(() => undefined);
  }
}

export interface RunPrewarmScheduler {
  run(): Promise<void>;
  cleanup(): Promise<void>;
  stop(): Promise<void>;
}

export function createRunPrewarmScheduler(input: {
  workerId: string;
  concurrency: number;
  leaseSeconds: number;
  ctx: RunControlContext;
  shutdownSignal: AbortSignal;
}): RunPrewarmScheduler {
  const active = new Map<string, Promise<void>>();
  let stopped = false;
  let claiming: Promise<void> | null = null;
  let cleaning: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    if (stopped || claiming) return claiming ?? undefined;
    const capacity = input.concurrency - active.size;
    if (capacity <= 0) return;
    claiming = (async () => {
      const claims = await claimRunPrewarms({
        workerId: input.workerId,
        limit: capacity,
        leaseSeconds: input.leaseSeconds,
        database: db,
      });
      for (const prewarm of claims) {
        if (stopped || active.has(prewarm.id)) continue;
        const task = processPrewarm({
          prewarm,
          workerId: input.workerId,
          leaseSeconds: input.leaseSeconds,
          ctx: input.ctx,
          shutdownSignal: input.shutdownSignal,
        }).finally(() => active.delete(prewarm.id));
        active.set(prewarm.id, task);
      }
    })().finally(() => { claiming = null; });
    await claiming;
  };

  const cleanup = async (): Promise<void> => {
    if (stopped || cleaning) return cleaning ?? undefined;
    cleaning = (async () => {
      const claims = await claimRunPrewarmCleanups({
        workerId: input.workerId,
        limit: input.concurrency,
        leaseSeconds: input.leaseSeconds,
        database: db,
      });
      await Promise.allSettled(claims.map(async (claim) => {
        const cleaned = await teardownSandbox(input.ctx.runtime!, {
          sandboxName: claim.sandboxName,
          sandboxId: claim.sandboxId,
          region: input.ctx.region,
          timeoutMs: claim.timeoutMs,
        });
        if (cleaned) await completeRunPrewarmCleanup({
          orgId: claim.orgId,
          prewarmId: claim.id,
          workerId: input.workerId,
          database: db,
        });
      }));
      await purgeRunPrewarms({ database: db }).catch(() => undefined);
    })().finally(() => { cleaning = null; });
    await cleaning;
  };

  return {
    run,
    cleanup,
    async stop() {
      stopped = true;
      await Promise.allSettled([claiming, cleaning, ...active.values()].filter(Boolean) as Promise<unknown>[]);
    },
  };
}
