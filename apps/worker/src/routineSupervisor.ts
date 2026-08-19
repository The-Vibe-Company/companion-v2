import { randomUUID } from "node:crypto";
import {
  claimDueCompanionRoutines,
  companionsEnabled,
  failCompanionRoutineFire,
  fireCompanionRoutine,
  nextRoutineFireAt,
  routineFireMessageId,
  sanitizeCompanionRuntimeError,
} from "@companion/core";
import { db } from "@companion/db";
import type { Supervisor } from "./billingSupervisor";

const CLAIM_INTERVAL_MS = 15_000;
const CLAIM_LIMIT = 25;
const LEASE_SECONDS = 60;
const FIRE_CONCURRENCY = 4;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Companion routine fire failed";
  return sanitizeCompanionRuntimeError(message).slice(0, 500);
}

function classifyRoutineFireError(error: unknown): {
  code: "owner_access_revoked" | "companion_retired" | "invalid_cron" | "fire_failed";
  message: string;
} {
  const message = safeError(error);
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (
    code === "42501"
    || /not a workspace member|editor access is required|owner access/i.test(message)
  ) {
    return { code: "owner_access_revoked", message };
  }
  if (code === "55000" && /retired/i.test(message)) {
    return { code: "companion_retired", message };
  }
  if (/invalid_cron|cron expression|did not produce a future fire/i.test(message)) {
    return { code: "invalid_cron", message };
  }
  return { code: "fire_failed", message };
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  }));
}

async function fireClaim(input: {
  workerId: string;
  claim: Awaited<ReturnType<typeof claimDueCompanionRoutines>>[number];
}): Promise<void> {
  const now = new Date();
  const nextFireAt = nextRoutineFireAt({
    cron: input.claim.cron,
    timezone: input.claim.timezone,
    after: input.claim.scheduledFor,
    now,
  });
  const clientMessageId = routineFireMessageId({
    routineId: input.claim.routineId,
    scheduledFor: input.claim.scheduledFor,
  });
  try {
    await fireCompanionRoutine({
      workerId: input.workerId,
      orgId: input.claim.orgId,
      routineId: input.claim.routineId,
      clientMessageId,
      scheduledFor: input.claim.scheduledFor,
      nextFireAt,
      database: db,
    });
  } catch (error) {
    const classified = classifyRoutineFireError(error);
    await failCompanionRoutineFire({
      workerId: input.workerId,
      orgId: input.claim.orgId,
      routineId: input.claim.routineId,
      errorCode: classified.code,
      errorMessage: classified.message,
      nextFireAt,
      database: db,
    }).catch(() => undefined);
  }
}

export async function startRoutineSupervisor(input: {
  intervalMs?: number;
} = {}): Promise<Supervisor | null> {
  if (!companionsEnabled()) {
    console.info("Companion routine supervisor disabled");
    return null;
  }
  const workerId = `${process.env.HOSTNAME?.trim() || "worker"}:routines:${process.pid}:${randomUUID()}`;
  let stopped = false;
  let running: Promise<void> | null = null;

  const batch = async () => {
    if (!companionsEnabled()) return;
    const claimed = await claimDueCompanionRoutines({
      workerId,
      limit: CLAIM_LIMIT,
      leaseSeconds: LEASE_SECONDS,
      database: db,
    });
    await mapWithConcurrency(claimed, FIRE_CONCURRENCY, async (claim) => {
      await fireClaim({ workerId, claim });
    });
  };
  const tick = () => {
    if (stopped || running) return;
    const operation = batch().catch((error) => {
      if (!stopped) console.warn(`Companion routine batch will retry (${safeError(error)})`);
    });
    running = operation;
    void operation.finally(() => { if (running === operation) running = null; });
  };
  tick();
  const timer = setInterval(tick, input.intervalMs ?? CLAIM_INTERVAL_MS);
  console.info("Companion routine supervisor started");
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (running) await running;
    },
  };
}
