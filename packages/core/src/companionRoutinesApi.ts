import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import type { CompanionRoutine } from "@companion/contracts";
import {
  COMPANION_ROUTINE_MIN_INTERVAL_MS,
  companionRoutineDraftSchema,
  companionRoutineProposalSchema,
  companionRoutineSchema,
} from "@companion/contracts";
import type { Db } from "@companion/db";

import { getCompanionDecisionV2 } from "./companionRuntimeApi";
import {
  computeNextFireAt,
  validateRoutineSchedule,
} from "./companionRoutines";

function rows<T>(result: unknown): T[] {
  return Array.from(result as Iterable<T>);
}

function hasDatabaseErrorCode(error: unknown, expected: string): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === expected) return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

export class CompanionRoutineNotFoundError extends Error {
  constructor() {
    super("companion routine not found");
    this.name = "CompanionRoutineNotFoundError";
  }
}

export class CompanionRoutineInvalidError extends Error {
  readonly code: "invalid_cron" | "invalid_timezone" | "interval_too_short";

  constructor(code: CompanionRoutineInvalidError["code"]) {
    super(
      code === "invalid_timezone"
        ? "Timezone must be a valid IANA name."
        : code === "interval_too_short"
          ? "Routines must fire at least five minutes apart."
          : "The cron expression is not valid.",
    );
    this.name = "CompanionRoutineInvalidError";
    this.code = code;
  }
}

function parseRoutine(value: unknown): CompanionRoutine {
  return companionRoutineSchema.parse(value);
}

/**
 * The driver refuses a bare `Date` bind, so every instant crosses as an ISO-8601 string. That is
 * also the exact precision `companion_routines.next_fire_at` stores, which keeps the claim/fire
 * fence comparable after the worker's round trip through JavaScript.
 */
function instant(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function scheduleNextFire(cron: string, timezone: string, enabled: boolean, after = new Date()): Date | null {
  if (!enabled) return null;
  const validated = validateRoutineSchedule({ cron, timezone, after });
  if (!validated.ok) throw new CompanionRoutineInvalidError(validated.code);
  return validated.nextFireAt;
}

export async function listCompanionRoutinesV2(input: {
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<CompanionRoutine[]> {
  const result = await input.database.execute(sql`
    select routine from public.companion_api_list_routines(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid
    )
  `);
  return rows<{ routine: unknown }>(result).map((row) => parseRoutine(row.routine));
}

export async function createCompanionRoutineV2(input: {
  orgId: string;
  companionId: string;
  id?: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled?: boolean;
  database: Db;
}): Promise<CompanionRoutine> {
  const draft = companionRoutineDraftSchema.parse({
    name: input.name,
    prompt: input.prompt,
    cron: input.cron,
    timezone: input.timezone,
    enabled: input.enabled ?? true,
  });
  const nextFireAt = scheduleNextFire(draft.cron, draft.timezone, draft.enabled);
  const result = await input.database.execute(sql`
    select public.companion_api_create_routine(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.id ?? randomUUID()}::uuid,
      ${draft.name},
      ${draft.prompt},
      ${draft.cron},
      ${draft.timezone},
      ${draft.enabled},
      ${instant(nextFireAt)}::timestamptz
    ) as routine
  `);
  const [row] = rows<{ routine: unknown }>(result);
  if (!row) throw new Error("failed to create Companion routine");
  return parseRoutine(row.routine);
}

export async function updateCompanionRoutineV2(input: {
  orgId: string;
  companionId: string;
  routineId: string;
  name?: string;
  prompt?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  database: Db;
}): Promise<CompanionRoutine> {
  const routines = await listCompanionRoutinesV2(input);
  const current = routines.find((routine) => routine.id === input.routineId);
  if (!current) throw new CompanionRoutineNotFoundError();
  const draft = companionRoutineDraftSchema.parse({
    name: input.name ?? current.name,
    prompt: input.prompt ?? current.prompt,
    cron: input.cron ?? current.cron,
    timezone: input.timezone ?? current.timezone,
    enabled: input.enabled ?? current.enabled,
  });
  const nextFireAt = scheduleNextFire(draft.cron, draft.timezone, draft.enabled);
  try {
    const result = await input.database.execute(sql`
      select public.companion_api_update_routine(
        ${input.orgId}::uuid,
        ${input.companionId}::uuid,
        ${input.routineId}::uuid,
        ${draft.name},
        ${draft.prompt},
        ${draft.cron},
        ${draft.timezone},
        ${draft.enabled},
        ${instant(nextFireAt)}::timestamptz
      ) as routine
    `);
    const [row] = rows<{ routine: unknown }>(result);
    if (!row) throw new Error("failed to update Companion routine");
    return parseRoutine(row.routine);
  } catch (error) {
    if (hasDatabaseErrorCode(error, "P0002")) throw new CompanionRoutineNotFoundError();
    throw error;
  }
}

export async function deleteCompanionRoutineV2(input: {
  orgId: string;
  companionId: string;
  routineId: string;
  database: Db;
}): Promise<void> {
  try {
    await input.database.execute(sql`
      select public.companion_api_delete_routine(
        ${input.orgId}::uuid,
        ${input.companionId}::uuid,
        ${input.routineId}::uuid
      )
    `);
  } catch (error) {
    if (hasDatabaseErrorCode(error, "P0002")) throw new CompanionRoutineNotFoundError();
    throw error;
  }
}

export async function answerCompanionRoutineDecisionV2(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  decision: "allow" | "deny";
  database: Db;
}): Promise<void> {
  let routineId: string | null = null;
  let nextFireAt: Date | null = null;
  if (input.decision === "allow") {
    const pending = await getCompanionDecisionV2({
      orgId: input.orgId,
      companionId: input.companionId,
      requestId: input.requestId,
      database: input.database,
    });
    const proposal = companionRoutineProposalSchema.parse(pending.proposal);
    nextFireAt = scheduleNextFire(proposal.cron, proposal.timezone, true);
    routineId = randomUUID();
  }
  await input.database.execute(sql`
    select * from public.companion_api_answer_routine_decision(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.requestId},
      ${input.decision},
      ${routineId}::uuid,
      ${instant(nextFireAt)}::timestamptz
    )
  `);
}

export async function claimDueCompanionRoutines(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  database: Db;
}): Promise<Array<{
  orgId: string;
  companionId: string;
  routineId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  scheduledFor: Date;
}>> {
  const result = await input.database.execute(sql`
    select * from public.companion_claim_due_routines(
      ${input.workerId},
      ${input.limit ?? 25},
      ${input.leaseSeconds ?? 60}
    )
  `);
  return rows<{
    org_id: string;
    companion_id: string;
    routine_id: string;
    name: string;
    prompt: string;
    cron: string;
    timezone: string;
    scheduled_for: Date | string;
  }>(result).map((row) => ({
    orgId: String(row.org_id),
    companionId: String(row.companion_id),
    routineId: String(row.routine_id),
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    scheduledFor: row.scheduled_for instanceof Date
      ? row.scheduled_for
      : new Date(row.scheduled_for),
  }));
}

export async function fireCompanionRoutine(input: {
  workerId: string;
  orgId: string;
  routineId: string;
  clientMessageId: string;
  scheduledFor: Date;
  nextFireAt: Date;
  database: Db;
}): Promise<{ outcome: string; replayed: boolean }> {
  const result = await input.database.execute(sql`
    select * from public.companion_fire_routine(
      ${input.workerId},
      ${input.orgId}::uuid,
      ${input.routineId}::uuid,
      ${input.clientMessageId}::uuid,
      ${instant(input.scheduledFor)}::timestamptz,
      ${instant(input.nextFireAt)}::timestamptz
    )
  `);
  const [row] = rows<{ outcome: string; replayed: boolean }>(result);
  if (!row) throw new Error("Companion routine fire returned no row");
  return { outcome: row.outcome, replayed: row.replayed };
}

export async function failCompanionRoutineFire(input: {
  workerId: string;
  orgId: string;
  routineId: string;
  errorCode: string;
  errorMessage: string;
  nextFireAt: Date | null;
  database: Db;
}): Promise<void> {
  await input.database.execute(sql`
    select public.companion_fail_routine_fire(
      ${input.workerId},
      ${input.orgId}::uuid,
      ${input.routineId}::uuid,
      ${input.errorCode},
      ${input.errorMessage},
      ${instant(input.nextFireAt)}::timestamptz
    )
  `);
}

export function nextRoutineFireAt(input: {
  cron: string;
  timezone: string;
  after: Date;
  now?: Date;
}): Date {
  const now = input.now ?? new Date();
  const computed = computeNextFireAt(input.cron, input.timezone, input.after);
  const floor = new Date(now.getTime() + COMPANION_ROUTINE_MIN_INTERVAL_MS);
  return computed.getTime() >= floor.getTime() ? computed : floor;
}