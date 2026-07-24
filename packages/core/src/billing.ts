import {
  type BillingMode,
  type BillingOverview,
  type EffectivePlan,
  type EntitlementErrorBody,
  type EntitlementFeature,
  type EntitlementMode,
  type Entitlements,
  type RunPreferences,
  type SandboxUsageOverview,
  stripeSubscriptionStatusSchema,
} from "@companion/contracts";
import { db, type Db, schema } from "@companion/db";
import { and, count, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { isOrgAdmin } from "./authz";

export const PRO_UNIT_AMOUNT_USD_CENTS = 1_000;
export const FREE_ORG_SKILL_LIMIT = 20;
export const PAYMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
export const BILLING_UPGRADE_URL = "/settings?view=billing";
export const DEFAULT_SANDBOX_MINUTES_PER_SEAT = 250;
export const SANDBOX_PREWARM_RESERVATION_MS = 5 * 60_000;
export const SANDBOX_RUN_ACTIVATION_RESERVATION_MS = 10 * 60_000;
export const SANDBOX_FOLLOWUP_RESERVATION_MS = 7 * 60_000;
const SANDBOX_RESERVATION_TTL_MS = 15 * 60_000;

export interface BillingRuntimeConfig {
  billingMode: BillingMode;
  entitlementMode: EntitlementMode;
  pilotOrgIds: ReadonlySet<string>;
  proOrgAllowlist: ReadonlySet<string>;
  checkoutEnabled: boolean;
  webhooksEnabled: boolean;
  stripePriceId?: string;
  stripePortalConfigurationId?: string;
  sandboxMinutesPerSeat?: number;
  sandboxMaxSessionMs?: number;
}

function csvSet(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function envBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function boundedPositiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

export function billingRuntimeConfig(env: NodeJS.ProcessEnv = process.env): BillingRuntimeConfig {
  const billingMode: BillingMode = env.COMPANION_BILLING_MODE === "stripe" ? "stripe" : "disabled";
  const entitlementModeRaw = env.COMPANION_ENTITLEMENTS_MODE;
  const entitlementMode: EntitlementMode =
    entitlementModeRaw === "observe" || entitlementModeRaw === "pilot" || entitlementModeRaw === "enforce"
      ? entitlementModeRaw
      : "off";
  return {
    billingMode,
    entitlementMode,
    pilotOrgIds: csvSet(env.COMPANION_ENTITLEMENT_PILOT_ORGS),
    proOrgAllowlist: csvSet(env.COMPANION_PRO_ORG_ALLOWLIST),
    checkoutEnabled: billingMode === "stripe" && envBoolean(env.COMPANION_CHECKOUT_ENABLED),
    webhooksEnabled: billingMode === "stripe" && envBoolean(env.COMPANION_STRIPE_WEBHOOKS_ENABLED),
    stripePriceId: env.STRIPE_PRO_PRICE_ID?.trim() || undefined,
    stripePortalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID?.trim() || undefined,
    sandboxMinutesPerSeat: boundedPositiveInteger(
      env.COMPANION_SANDBOX_MINUTES_PER_SEAT,
      DEFAULT_SANDBOX_MINUTES_PER_SEAT,
      100_000,
    ),
    sandboxMaxSessionMs: Math.max(
      600_000,
      boundedPositiveInteger(env.COMPANION_SANDBOX_MAX_SESSION_MS, 3_600_000, 3_600_000),
    ),
  };
}

export function assertBillingEnvironmentConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const config = billingRuntimeConfig(env);
  if (config.billingMode !== "stripe") return;
  const required = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRO_PRICE_ID", "STRIPE_PORTAL_CONFIGURATION_ID"] as const;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`Stripe billing mode requires: ${missing.join(", ")}`);
}

export interface RawBillingState {
  stripeStatus: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: Date | null;
}

export function computeSubscriptionPlan(
  state: RawBillingState | null,
  now: Date = new Date(),
): EffectivePlan {
  if (!state?.stripeStatus) return "free";
  if (state.stripeStatus === "active") {
    if (state.cancelAtPeriodEnd && state.currentPeriodEnd && state.currentPeriodEnd.getTime() <= now.getTime()) {
      return "free";
    }
    return "pro";
  }
  if ((state.stripeStatus === "past_due" || state.stripeStatus === "unpaid") && state.graceEndsAt) {
    return state.graceEndsAt.getTime() > now.getTime() ? "pro" : "free";
  }
  // Trials are intentionally unsupported; a Stripe-side misconfiguration must not grant Pro.
  return "free";
}

function isEnforcedForOrg(config: BillingRuntimeConfig, orgId: string): boolean {
  if (config.billingMode === "disabled" || config.entitlementMode === "off" || config.entitlementMode === "observe") {
    return false;
  }
  if (config.entitlementMode === "pilot") return config.pilotOrgIds.has(orgId);
  return true;
}

export async function getEntitlements(input: {
  orgId: string;
  database?: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<Entitlements> {
  const database = input.database ?? db;
  const config = input.config ?? billingRuntimeConfig();
  if (config.billingMode === "disabled" || config.entitlementMode === "off") {
    return {
      effectivePlan: "pro",
      computedPlan: "pro",
      billingMode: config.billingMode,
      entitlementMode: config.entitlementMode,
      enforced: false,
      personalSkills: true,
      skillHistory: true,
      orgSkillLimit: null,
      catalogFrozen: false,
    };
  }
  const row = await database.query.billingSubscriptions.findFirst({
    where: eq(schema.billingSubscriptions.orgId, input.orgId),
  });
  const allowlisted = config.proOrgAllowlist.has(input.orgId);
  const computedPlan = allowlisted ? "pro" : computeSubscriptionPlan(row ?? null, input.now);
  const enforced = isEnforcedForOrg(config, input.orgId);
  const effectivePlan: EffectivePlan = enforced ? computedPlan : "pro";
  const [orgCount] = await database
    .select({ value: count() })
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.scope, "org")));
  const current = Number(orgCount?.value ?? 0);
  return {
    effectivePlan,
    computedPlan,
    billingMode: config.billingMode,
    entitlementMode: config.entitlementMode,
    enforced,
    personalSkills: effectivePlan === "pro",
    skillHistory: effectivePlan === "pro",
    orgSkillLimit: effectivePlan === "free" ? FREE_ORG_SKILL_LIMIT : null,
    catalogFrozen: effectivePlan === "free" && current > FREE_ORG_SKILL_LIMIT,
  };
}

export class EntitlementDeniedError extends Error {
  readonly status = 403;
  constructor(public readonly body: EntitlementErrorBody) {
    super(body.message);
    this.name = "EntitlementDeniedError";
  }
}

function denied(
  code: EntitlementErrorBody["code"],
  feature: EntitlementFeature,
  message: string,
  extra: Pick<EntitlementErrorBody, "limit" | "current"> = {},
  effectivePlan: EffectivePlan = "free",
): never {
  throw new EntitlementDeniedError({
    code,
    feature,
    message,
    effectivePlan,
    upgradeUrl: BILLING_UPGRADE_URL,
    ...extra,
  });
}

function sandboxPeriod(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

function roundedMinuteMs(ms: number): number {
  return Math.max(0, Math.ceil(ms / 60_000) * 60_000);
}

async function activeSandboxSeats(orgId: string, database: Db): Promise<number> {
  const rows = await database
    .select({ value: count() })
    .from(schema.memberships)
    .where(eq(schema.memberships.orgId, orgId));
  return Math.max(1, Number(rows[0]?.value ?? 0));
}

/** Current shared sandbox-minute pool. Reservations are visible so concurrent launches cannot overspend it. */
export async function getSandboxUsageOverview(input: {
  orgId: string;
  database?: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
  entitlements?: Entitlements;
  activeSeats?: number;
}): Promise<SandboxUsageOverview> {
  const database = input.database ?? db;
  const config = input.config ?? billingRuntimeConfig();
  const now = input.now ?? new Date();
  const period = sandboxPeriod(now);
  const minutesPerSeat = config.sandboxMinutesPerSeat ?? DEFAULT_SANDBOX_MINUTES_PER_SEAT;
  if (config.billingMode === "disabled") {
    return {
      enabled: false,
      enforced: false,
      limit_minutes: null,
      used_minutes: 0,
      reserved_minutes: 0,
      remaining_minutes: null,
      minutes_per_seat: minutesPerSeat,
      period_start: period.start.toISOString(),
      period_end: period.end.toISOString(),
    };
  }
  const [entitlements, seats, usageResult] = await Promise.all([
    input.entitlements ?? getEntitlements({ orgId: input.orgId, database, now, config }),
    input.activeSeats ?? activeSandboxSeats(input.orgId, database),
    database.execute(sql`
      select "used_ms" as "usedMs", "reserved_ms" as "reservedMs"
      from companion_sandbox_usage_totals(
        ${input.orgId}::uuid,
        ${period.start.toISOString()}::timestamp with time zone,
        ${period.end.toISOString()}::timestamp with time zone,
        ${now.toISOString()}::timestamp with time zone
      )
    `),
  ]);
  const totals = Array.from(
    usageResult as unknown as Iterable<{ usedMs: number | string; reservedMs: number | string }>,
  )[0] ?? { usedMs: 0, reservedMs: 0 };
  const usedMinutes = Math.ceil(Number(totals.usedMs) / 60_000);
  const reservedMinutes = Math.ceil(Number(totals.reservedMs) / 60_000);
  const limitMinutes = entitlements.effectivePlan === "pro" ? seats * minutesPerSeat : 0;
  return {
    enabled: true,
    enforced: entitlements.enforced,
    limit_minutes: limitMinutes,
    used_minutes: usedMinutes,
    reserved_minutes: reservedMinutes,
    remaining_minutes: Math.max(0, limitMinutes - usedMinutes - reservedMinutes),
    minutes_per_seat: minutesPerSeat,
    period_start: period.start.toISOString(),
    period_end: period.end.toISOString(),
  };
}

async function lockSandboxQuota(database: Db, orgId: string, periodStart: Date): Promise<void> {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:sandbox-quota:${orgId}:${periodStart.toISOString()}`}))`);
}

function assertSandboxCapacity(usage: SandboxUsageOverview, requestedMs: number): void {
  if (!usage.enforced || usage.limit_minutes === null) return;
  const requestedMinutes = Math.ceil(requestedMs / 60_000);
  const current = usage.used_minutes + usage.reserved_minutes;
  if (usage.limit_minutes === 0) {
    denied("sandbox_plan_required", "sandbox_runs", "Sandbox runs are available on Pro.", {
      current,
      limit: 0,
    });
  }
  if ((usage.remaining_minutes ?? 0) < requestedMinutes) {
    denied(
      "sandbox_quota_exhausted",
      "sandbox_runs",
      `This workspace has ${usage.remaining_minutes ?? 0} sandbox minutes left this month.`,
      { current, limit: usage.limit_minutes },
      "pro",
    );
  }
}

export interface SandboxUsageReservationInput {
  orgId: string;
  creatorId: string;
  kind: "prewarm" | "run" | "project";
  sourceId: string;
  sandboxName: string;
  activationRevision: number;
  reservationMs: number;
  database: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}

export interface SandboxRuntimeBudget {
  /** Maximum provider session lifetime admitted for this activation. */
  limitMs: number;
}

export interface ProjectUsageAdmission {
  activationRevision: number;
  reservationMs: number;
}

export function projectPromptUsageDecision(input: {
  currentActivationRevision: number;
  pendingActivationRevision?: number | null;
  openActivationRevision: number | null;
  billingDisabled?: boolean;
}): ProjectUsageAdmission {
  if (input.billingDisabled) {
    return {
      activationRevision: Math.max(1, input.currentActivationRevision),
      reservationMs: 0,
    };
  }
  if (input.openActivationRevision !== null) {
    return {
      activationRevision: input.openActivationRevision,
      reservationMs: SANDBOX_FOLLOWUP_RESERVATION_MS,
    };
  }
  return {
    activationRevision:
      input.pendingActivationRevision
      ?? input.currentActivationRevision + 1,
    reservationMs: SANDBOX_RUN_ACTIVATION_RESERVATION_MS,
  };
}

/** Reserve the exact initial/reactivation slice for a persistent Project workspace. */
export async function reserveProjectActivationUsage(input: {
  orgId: string;
  creatorId: string;
  projectId: string;
  sandboxName: string;
  activationRevision: number;
  database: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<ProjectUsageAdmission> {
  const config = input.config ?? billingRuntimeConfig();
  await reserveSandboxUsage({
    orgId: input.orgId,
    creatorId: input.creatorId,
    kind: "project",
    sourceId: input.projectId,
    sandboxName: input.sandboxName,
    activationRevision: input.activationRevision,
    reservationMs: SANDBOX_RUN_ACTIVATION_RESERVATION_MS,
    database: input.database,
    now: input.now,
    config,
  });
  return {
    activationRevision: input.activationRevision,
    reservationMs:
      config.billingMode === "disabled"
        ? 0
        : SANDBOX_RUN_ACTIVATION_RESERVATION_MS,
  };
}

/**
 * Admit one accepted Project prompt while the caller holds the Project workspace row lock.
 *
 * An open activation receives exactly one follow-up slice. If the prior activation was settled,
 * the command owns the next exact reactivation slice instead. The organization quota advisory lock
 * inside the billing primitives serializes this with prompts accepted in other Projects.
 */
export async function admitProjectPromptUsage(input: {
  orgId: string;
  creatorId: string;
  projectId: string;
  sandboxName: string;
  currentActivationRevision: number;
  pendingActivationRevision?: number | null;
  database: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<ProjectUsageAdmission> {
  const config = input.config ?? billingRuntimeConfig();
  if (config.billingMode === "disabled") {
    return projectPromptUsageDecision({
      ...input,
      openActivationRevision: null,
      billingDisabled: true,
    });
  }
  const openRows = await input.database
    .select({
      activationRevision: schema.sandboxUsageSessions.activationRevision,
    })
    .from(schema.sandboxUsageSessions)
    .where(
      and(
        eq(schema.sandboxUsageSessions.orgId, input.orgId),
        eq(schema.sandboxUsageSessions.kind, "project"),
        eq(schema.sandboxUsageSessions.sourceId, input.projectId),
        isNull(schema.sandboxUsageSessions.endedAt),
      ),
    )
    .orderBy(desc(schema.sandboxUsageSessions.activationRevision))
    .limit(1)
    .for("update");
  const open = openRows[0];
  const decision = projectPromptUsageDecision({
    ...input,
    openActivationRevision: open?.activationRevision ?? null,
  });
  if (!open) {
    return reserveProjectActivationUsage({
      ...input,
      activationRevision: decision.activationRevision,
      config,
    });
  }
  await extendSandboxUsageReservation({
    orgId: input.orgId,
    kind: "project",
    sourceId: input.projectId,
    activationRevision: open.activationRevision,
    additionalMs: SANDBOX_FOLLOWUP_RESERVATION_MS,
    database: input.database,
    now: input.now,
    config,
  });
  return {
    activationRevision: decision.activationRevision,
    reservationMs: decision.reservationMs,
  };
}

function sandboxRuntimeBudgetForRow(
  row: typeof schema.sandboxUsageSessions.$inferSelect,
  now: Date,
): SandboxRuntimeBudget {
  const periodEnd = new Date(Date.UTC(
    row.periodStart.getUTCFullYear(),
    row.periodStart.getUTCMonth() + 1,
    1,
  ));
  const startsAt = row.startedAt ?? now;
  return {
    limitMs: Math.max(0, Math.min(row.reservedMs, periodEnd.getTime() - startsAt.getTime())),
  };
}

async function enforcedSandboxRuntimeBudget(input: {
  row: typeof schema.sandboxUsageSessions.$inferSelect;
  orgId: string;
  database: Db;
  now: Date;
  config: BillingRuntimeConfig;
}): Promise<SandboxRuntimeBudget | null> {
  const entitlements = await getEntitlements({
    orgId: input.orgId,
    database: input.database,
    now: input.now,
    config: input.config,
  });
  if (!entitlements.enforced) return null;
  const budget = sandboxRuntimeBudgetForRow(input.row, input.now);
  const elapsedMs = input.row.startedAt ? input.now.getTime() - input.row.startedAt.getTime() : 0;
  if (budget.limitMs <= 0 || elapsedMs >= budget.limitMs) {
    denied(
      "sandbox_quota_exhausted",
      "sandbox_runs",
      "This sandbox has reached its reserved runtime budget.",
      {},
      entitlements.effectivePlan,
    );
  }
  return budget;
}

/** Reserve one provider session atomically with the command that can create or resume it. */
export async function reserveSandboxUsage(input: SandboxUsageReservationInput): Promise<void> {
  const config = input.config ?? billingRuntimeConfig();
  if (config.billingMode === "disabled") return;
  const now = input.now ?? new Date();
  const period = sandboxPeriod(now);
  await lockSandboxQuota(input.database, input.orgId, period.start);
  const existing = await input.database.query.sandboxUsageSessions.findFirst({
    where: and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.kind, input.kind),
      eq(schema.sandboxUsageSessions.sourceId, input.sourceId),
      eq(schema.sandboxUsageSessions.activationRevision, input.activationRevision),
    ),
  });
  if (existing) return;
  const usage = await getSandboxUsageOverview({ orgId: input.orgId, database: input.database, now, config });
  assertSandboxCapacity(usage, input.reservationMs);
  await input.database.insert(schema.sandboxUsageSessions).values({
    orgId: input.orgId,
    creatorId: input.creatorId,
    kind: input.kind,
    sourceId: input.sourceId,
    sandboxName: input.sandboxName,
    activationRevision: input.activationRevision,
    periodStart: period.start,
    reservedMs: input.reservationMs,
    reservationExpiresAt: new Date(now.getTime() + SANDBOX_RESERVATION_TTL_MS),
  });
}

export function sandboxReservationCapacityRequest(input: {
  reservedMs: number;
  additionalMs: number;
  startedAt: Date | null;
  reservationExpiresAt: Date;
  periodStart: Date;
  now: Date;
}): {
  requestedMs: number;
  reviveInCurrentPeriod: boolean;
} {
  const currentPeriod = sandboxPeriod(input.now);
  const movedToNewPeriod =
    input.periodStart.getTime() !== currentPeriod.start.getTime();
  const expiredBeforeStart =
    input.startedAt === null && input.reservationExpiresAt <= input.now;
  const reviveInCurrentPeriod =
    input.startedAt === null && (movedToNewPeriod || expiredBeforeStart);
  return {
    requestedMs:
      input.additionalMs + (reviveInCurrentPeriod ? input.reservedMs : 0),
    reviveInCurrentPeriod,
  };
}

/** Add budget for another prompt while preserving the same live provider session. */
export async function extendSandboxUsageReservation(input: {
  orgId: string;
  kind?: "run" | "project";
  sourceId: string;
  activationRevision: number;
  additionalMs: number;
  database: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<void> {
  const config = input.config ?? billingRuntimeConfig();
  if (config.billingMode === "disabled") return;
  const now = input.now ?? new Date();
  const period = sandboxPeriod(now);
  await lockSandboxQuota(input.database, input.orgId, period.start);
  const row = await input.database.query.sandboxUsageSessions.findFirst({
    where: and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.kind, input.kind ?? "run"),
      eq(schema.sandboxUsageSessions.sourceId, input.sourceId),
      eq(schema.sandboxUsageSessions.activationRevision, input.activationRevision),
    ),
  });
  if (!row || row.endedAt) return;
  const capacity = sandboxReservationCapacityRequest({
    reservedMs: row.reservedMs,
    additionalMs: input.additionalMs,
    startedAt: row.startedAt,
    reservationExpiresAt: row.reservationExpiresAt,
    periodStart: row.periodStart,
    now,
  });
  const usage = await getSandboxUsageOverview({ orgId: input.orgId, database: input.database, now, config });
  // An expired/unstarted reservation is absent from usage totals. Re-admit its full prior slice
  // together with this prompt, otherwise refreshing it below would silently oversubscribe quota.
  assertSandboxCapacity(usage, capacity.requestedMs);
  const reservedMs = row.reservedMs + input.additionalMs;
  const effectivePeriodStart = capacity.reviveInCurrentPeriod
    ? period.start
    : row.periodStart;
  const periodEnd = new Date(Date.UTC(
    effectivePeriodStart.getUTCFullYear(),
    effectivePeriodStart.getUTCMonth() + 1,
    1,
  ));
  const runtimeDeadlineAt = row.runtimePolicy === "budgeted" && row.startedAt
    ? new Date(Math.min(
        row.startedAt.getTime() + reservedMs,
        row.startedAt.getTime() + (config.sandboxMaxSessionMs ?? 3_600_000),
        periodEnd.getTime(),
      ))
    : row.runtimeDeadlineAt;
  await input.database
    .update(schema.sandboxUsageSessions)
    .set({
      periodStart: effectivePeriodStart,
      reservedMs,
      runtimeDeadlineAt,
      reservationExpiresAt: new Date(now.getTime() + SANDBOX_RESERVATION_TTL_MS),
      updatedAt: now,
    })
    .where(eq(schema.sandboxUsageSessions.id, row.id));
  if (runtimeDeadlineAt && (input.kind ?? "run") === "run") {
    await input.database
      .update(schema.skillRuns)
      .set({ runtimeDeadlineAt, updatedAt: now })
      .where(and(
        eq(schema.skillRuns.orgId, input.orgId),
        eq(schema.skillRuns.id, input.sourceId),
        eq(schema.skillRuns.activationRevision, input.activationRevision),
      ));
  }
}

/** Transfer an already-running warm-up into its run and reserve the run's remaining activation. */
export async function adoptSandboxUsageReservation(input: {
  orgId: string;
  creatorId: string;
  prewarmId: string;
  runId: string;
  sandboxName: string;
  reservationMs: number;
  database: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<void> {
  const config = input.config ?? billingRuntimeConfig();
  if (config.billingMode === "disabled") return;
  const now = input.now ?? new Date();
  const period = sandboxPeriod(now);
  await lockSandboxQuota(input.database, input.orgId, period.start);
  const existingRun = await input.database.query.sandboxUsageSessions.findFirst({
    where: and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.kind, "run"),
      eq(schema.sandboxUsageSessions.sourceId, input.runId),
      eq(schema.sandboxUsageSessions.activationRevision, 0),
    ),
  });
  if (existingRun) return;
  const row = await input.database.query.sandboxUsageSessions.findFirst({
    where: and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.kind, "prewarm"),
      eq(schema.sandboxUsageSessions.sourceId, input.prewarmId),
    ),
  });
  if (!row) {
    const usage = await getSandboxUsageOverview({ orgId: input.orgId, database: input.database, now, config });
    assertSandboxCapacity(usage, input.reservationMs);
    await input.database.insert(schema.sandboxUsageSessions).values({
      orgId: input.orgId,
      creatorId: input.creatorId,
      kind: "run",
      sourceId: input.runId,
      sandboxName: input.sandboxName,
      activationRevision: 0,
      periodStart: period.start,
      reservedMs: input.reservationMs,
      reservationExpiresAt: new Date(now.getTime() + SANDBOX_RESERVATION_TTL_MS),
    });
    return;
  }
  const additionalReservationMs = Math.max(0, input.reservationMs - row.reservedMs);
  const usage = await getSandboxUsageOverview({ orgId: input.orgId, database: input.database, now, config });
  assertSandboxCapacity(usage, additionalReservationMs);
  await input.database
    .update(schema.sandboxUsageSessions)
    .set({
      kind: "run",
      sourceId: input.runId,
      activationRevision: 0,
      reservedMs: Math.max(row.reservedMs, input.reservationMs),
      reservationExpiresAt: new Date(now.getTime() + SANDBOX_RESERVATION_TTL_MS),
      updatedAt: now,
    })
    .where(eq(schema.sandboxUsageSessions.id, row.id));
}

/** Revalidate an aged durable reservation immediately before any provider call. */
export async function refreshSandboxUsageReservation(input: {
  orgId: string;
  sandboxName: string;
  activationRevision: number;
  database: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<SandboxRuntimeBudget | null> {
  const config = input.config ?? billingRuntimeConfig();
  if (config.billingMode === "disabled") return null;
  const now = input.now ?? new Date();
  const period = sandboxPeriod(now);
  await lockSandboxQuota(input.database, input.orgId, period.start);
  const row = await input.database.query.sandboxUsageSessions.findFirst({
    where: and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.sandboxName, input.sandboxName),
      eq(schema.sandboxUsageSessions.activationRevision, input.activationRevision),
    ),
  });
  if (!row) throw new Error("sandbox usage reservation is missing");
  if (row.endedAt) throw new Error("sandbox usage reservation is already settled");
  if (row.startedAt) {
    return enforcedSandboxRuntimeBudget({ row, orgId: input.orgId, database: input.database, now, config });
  }
  const movedToNewPeriod = row.periodStart.getTime() !== period.start.getTime();
  if (movedToNewPeriod || row.reservationExpiresAt <= now) {
    const usage = await getSandboxUsageOverview({ orgId: input.orgId, database: input.database, now, config });
    assertSandboxCapacity(usage, row.reservedMs);
  }
  const nextRow = { ...row, periodStart: movedToNewPeriod ? period.start : row.periodStart };
  await input.database
    .update(schema.sandboxUsageSessions)
    .set({
      periodStart: movedToNewPeriod ? period.start : row.periodStart,
      reservationExpiresAt: new Date(now.getTime() + SANDBOX_RESERVATION_TTL_MS),
      updatedAt: now,
    })
    .where(and(eq(schema.sandboxUsageSessions.id, row.id), sql`${schema.sandboxUsageSessions.endedAt} is null`));
  return enforcedSandboxRuntimeBudget({ row: nextRow, orgId: input.orgId, database: input.database, now, config });
}

/** Read the admitted provider lifetime so workers only extend a sandbox after more minutes are reserved. */
export async function getSandboxRuntimeBudget(input: {
  orgId: string;
  sandboxName: string;
  activationRevision: number;
  database?: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<SandboxRuntimeBudget | null> {
  const database = input.database ?? db;
  const config = input.config ?? billingRuntimeConfig();
  if (config.billingMode === "disabled") return null;
  const now = input.now ?? new Date();
  const row = await database.query.sandboxUsageSessions.findFirst({
    where: and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.sandboxName, input.sandboxName),
      eq(schema.sandboxUsageSessions.activationRevision, input.activationRevision),
    ),
  });
  if (!row || row.endedAt) return { limitMs: 0 };
  return enforcedSandboxRuntimeBudget({ row, orgId: input.orgId, database, now, config });
}

export async function startSandboxUsage(input: {
  orgId: string;
  sandboxName: string;
  activationRevision: number;
  runtimePolicy?: "safety_capped" | "budgeted";
  runtimeDeadlineAt?: Date;
  database?: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<Date | null> {
  const database = input.database ?? db;
  if ((input.config ?? billingRuntimeConfig()).billingMode === "disabled") return null;
  const now = input.now ?? new Date();
  const rows = await database
    .update(schema.sandboxUsageSessions)
    .set({
      startedAt: sql`coalesce(
        ${schema.sandboxUsageSessions.startedAt},
        ${now.toISOString()}::timestamp with time zone
      )`,
      runtimePolicy: input.runtimePolicy ?? "safety_capped",
      ...(input.runtimeDeadlineAt
        ? {
            runtimeDeadlineAt: sql`case
              when ${schema.sandboxUsageSessions.runtimeDeadlineAt} is null
                then ${input.runtimeDeadlineAt.toISOString()}::timestamp with time zone
              else least(
                ${schema.sandboxUsageSessions.runtimeDeadlineAt},
                ${input.runtimeDeadlineAt.toISOString()}::timestamp with time zone
              )
            end`,
          }
        : {}),
      reservationExpiresAt: new Date(now.getTime() + SANDBOX_RESERVATION_TTL_MS),
      updatedAt: now,
    })
    .where(and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.sandboxName, input.sandboxName),
      eq(schema.sandboxUsageSessions.activationRevision, input.activationRevision),
      sql`${schema.sandboxUsageSessions.endedAt} is null`,
    ))
    .returning({ startedAt: schema.sandboxUsageSessions.startedAt });
  return rows[0]?.startedAt ?? null;
}

export async function settleSandboxUsage(input: {
  orgId: string;
  sandboxName: string;
  activationRevision: number;
  database?: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<void> {
  const database = input.database ?? db;
  if ((input.config ?? billingRuntimeConfig()).billingMode === "disabled") return;
  const now = input.now ?? new Date();
  const row = await database.query.sandboxUsageSessions.findFirst({
    where: and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.sandboxName, input.sandboxName),
      eq(schema.sandboxUsageSessions.activationRevision, input.activationRevision),
    ),
  });
  if (!row || row.endedAt) return;
  const runtimeDeadlineAt = row.runtimeDeadlineAt ?? await getSandboxRuntimeDeadline({
    orgId: input.orgId,
    sandboxName: input.sandboxName,
    activationRevision: input.activationRevision,
    database,
  });
  const effectiveEnd = runtimeDeadlineAt && runtimeDeadlineAt < now ? runtimeDeadlineAt : now;
  const elapsedMs = row.startedAt ? Math.max(1, effectiveEnd.getTime() - row.startedAt.getTime()) : 0;
  const maximumMs = runtimeDeadlineAt && row.startedAt
    ? Math.max(0, runtimeDeadlineAt.getTime() - row.startedAt.getTime())
    : Number.POSITIVE_INFINITY;
  const settledMs = row.startedAt ? Math.min(roundedMinuteMs(elapsedMs), maximumMs) : 0;
  await database
    .update(schema.sandboxUsageSessions)
    .set({ endedAt: now, settledMs, updatedAt: now })
    .where(and(eq(schema.sandboxUsageSessions.id, row.id), sql`${schema.sandboxUsageSessions.endedAt} is null`));
}

/** Persist redacted provider truth for reconciliation and usage audits. */
export async function recordSandboxRuntimeObservation(input: {
  orgId: string;
  sandboxName: string;
  activationRevision: number;
  state: "running" | "stopped" | "missing";
  expiresAt: Date | null;
  database?: Db;
  now?: Date;
}): Promise<void> {
  const database = input.database ?? db;
  const now = input.now ?? new Date();
  await database
    .update(schema.sandboxUsageSessions)
    .set({
      lastProviderState: input.state,
      providerExpiresAt: input.expiresAt,
      lastProviderCheckedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.sandboxName, input.sandboxName),
      eq(schema.sandboxUsageSessions.activationRevision, input.activationRevision),
      sql`${schema.sandboxUsageSessions.endedAt} is null`,
    ));
}

export async function getSandboxRuntimeDeadline(input: {
  orgId: string;
  sandboxName: string;
  activationRevision: number;
  database?: Db;
}): Promise<Date | null> {
  const database = input.database ?? db;
  const row = await database.query.sandboxUsageSessions.findFirst({
    columns: { runtimeDeadlineAt: true },
    where: and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.sandboxName, input.sandboxName),
      eq(schema.sandboxUsageSessions.activationRevision, input.activationRevision),
      sql`${schema.sandboxUsageSessions.endedAt} is null`,
    ),
  });
  if (row?.runtimeDeadlineAt) return row.runtimeDeadlineAt;
  const run = await database.query.skillRuns.findFirst({
    columns: { runtimeDeadlineAt: true },
    where: and(
      eq(schema.skillRuns.orgId, input.orgId),
      eq(schema.skillRuns.sandboxName, input.sandboxName),
      eq(schema.skillRuns.activationRevision, input.activationRevision),
    ),
  });
  return run?.runtimeDeadlineAt ?? null;
}

/** Settle the newest open activation when deferred cleanup only carries the durable sandbox name. */
export async function settleLatestSandboxUsage(input: {
  orgId: string;
  sandboxName: string;
  database?: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<void> {
  const database = input.database ?? db;
  if ((input.config ?? billingRuntimeConfig()).billingMode === "disabled") return;
  const row = await database.query.sandboxUsageSessions.findFirst({
    where: and(
      eq(schema.sandboxUsageSessions.orgId, input.orgId),
      eq(schema.sandboxUsageSessions.sandboxName, input.sandboxName),
      sql`${schema.sandboxUsageSessions.endedAt} is null`,
    ),
    orderBy: desc(schema.sandboxUsageSessions.activationRevision),
  });
  if (!row) return;
  await settleSandboxUsage({
    orgId: input.orgId,
    sandboxName: input.sandboxName,
    activationRevision: row.activationRevision,
    database,
    now: input.now,
    config: input.config,
  });
}

async function assertSandboxMember(database: Db, actorId: string, orgId: string): Promise<void> {
  const row = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, actorId)),
  });
  if (!row) throw new Error("not a member of this organization");
}

export async function getRunPreferences(input: {
  actorId: string;
  orgId: string;
  database?: Db;
}): Promise<RunPreferences> {
  const database = input.database ?? db;
  await assertSandboxMember(database, input.actorId, input.orgId);
  const row = await database.query.userRunPreferences.findFirst({
    where: and(
      eq(schema.userRunPreferences.orgId, input.orgId),
      eq(schema.userRunPreferences.userId, input.actorId),
    ),
  });
  return { prewarm_enabled: row?.prewarmEnabled ?? true };
}

export async function updateRunPreferences(input: {
  actorId: string;
  orgId: string;
  prewarmEnabled: boolean;
  database?: Db;
}): Promise<RunPreferences> {
  const database = input.database ?? db;
  await assertSandboxMember(database, input.actorId, input.orgId);
  await database
    .insert(schema.userRunPreferences)
    .values({ orgId: input.orgId, userId: input.actorId, prewarmEnabled: input.prewarmEnabled })
    .onConflictDoUpdate({
      target: [schema.userRunPreferences.orgId, schema.userRunPreferences.userId],
      set: { prewarmEnabled: input.prewarmEnabled, updatedAt: new Date() },
    });
  return { prewarm_enabled: input.prewarmEnabled };
}

export async function assertPersonalSkillsEntitled(input: {
  orgId: string;
  database?: Db;
  feature?: EntitlementFeature;
}): Promise<void> {
  const entitlements = await getEntitlements(input);
  if (!entitlements.personalSkills) {
    denied("upgrade_required", input.feature ?? "personal_skills", "Personal skills are available on Pro.");
  }
}

export async function assertSkillHistoryEntitled(input: { orgId: string; database?: Db }): Promise<void> {
  const entitlements = await getEntitlements(input);
  if (!entitlements.skillHistory) {
    denied("upgrade_required", "skill_history", "Version history is available on Pro.");
  }
}

export async function assertOrgSkillMutationEntitled(input: {
  orgId: string;
  feature: Extract<
    EntitlementFeature,
    "org_skill_create" | "org_skill_publish" | "org_skill_restore" | "org_skill_rename"
  >;
  isCreate: boolean;
  database?: Db;
  lock?: boolean;
}): Promise<void> {
  const database = input.database ?? db;
  if (input.lock) {
    await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:skill-quota:${input.orgId}`}))`);
  }
  const entitlements = await getEntitlements({ orgId: input.orgId, database });
  if (entitlements.effectivePlan === "pro") return;
  const [row] = await database
    .select({ value: count() })
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.scope, "org")));
  const current = Number(row?.value ?? 0);
  if (current > FREE_ORG_SKILL_LIMIT) {
    denied(
      "catalog_frozen",
      input.feature,
      `This Free workspace has ${current} organization skills. The catalog is read-only until it returns to Pro.`,
      { current, limit: FREE_ORG_SKILL_LIMIT },
    );
  }
  if (input.isCreate && current >= FREE_ORG_SKILL_LIMIT) {
    denied(
      "org_skill_limit_reached",
      "org_skill_create",
      `Free includes up to ${FREE_ORG_SKILL_LIMIT} organization skills. Upgrade to create another.`,
      { current, limit: FREE_ORG_SKILL_LIMIT },
    );
  }
}

/** Durable outbox marker written in the same transaction as membership changes. */
export async function markSeatSyncPending(orgId: string, database: Db, now = new Date()): Promise<void> {
  await database
    .update(schema.billingSubscriptions)
    .set({
      seatSyncStatus: "pending",
      seatSyncRequestedAt: now,
      nextRetryAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(and(eq(schema.billingSubscriptions.orgId, orgId), isNotNull(schema.billingSubscriptions.stripeSubscriptionId)));
}

export async function getBillingOverview(input: {
  actorId: string;
  orgId: string;
  database?: Db;
  now?: Date;
  config?: BillingRuntimeConfig;
}): Promise<BillingOverview> {
  const database = input.database ?? db;
  const config = input.config ?? billingRuntimeConfig();
  const now = input.now ?? new Date();
  const [membership, activeSeatsRow, orgSkillRow, personalSkillRow, billing] = await Promise.all([
    database.query.memberships.findFirst({
      where: and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.actorId)),
    }),
    database.select({ value: count() }).from(schema.memberships).where(eq(schema.memberships.orgId, input.orgId)),
    database
      .select({ value: count() })
      .from(schema.skills)
      .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.scope, "org"))),
    database
      .select({ value: count() })
      .from(schema.skills)
      .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.scope, "personal"))),
    database.query.billingSubscriptions.findFirst({ where: eq(schema.billingSubscriptions.orgId, input.orgId) }),
  ]);
  if (!membership) throw new Error("not a member of this organization");
  const activeSeats = Math.max(1, Number(activeSeatsRow[0]?.value ?? 0));
  const entitlements = await getEntitlements({ orgId: input.orgId, database, now, config });
  const sandboxUsage = await getSandboxUsageOverview({
    orgId: input.orgId,
    database,
    now,
    config,
    entitlements,
    activeSeats,
  });
  const stripeStatus = stripeSubscriptionStatusSchema.safeParse(billing?.stripeStatus).success
    ? stripeSubscriptionStatusSchema.parse(billing?.stripeStatus)
    : null;
  const billingEnabled = config.billingMode === "stripe";
  const canStartSubscription = !billing?.stripeSubscriptionId || stripeStatus === "canceled" || stripeStatus === "incomplete_expired";
  return {
    billingEnabled,
    canManage: isOrgAdmin(membership.orgRole),
    entitlements,
    unitAmount: PRO_UNIT_AMOUNT_USD_CENTS,
    currency: "usd",
    interval: "month",
    activeSeats,
    syncedSeats: billing?.syncedQuantity ?? null,
    estimatedMonthlySubtotal: activeSeats * PRO_UNIT_AMOUNT_USD_CENTS,
    stripeStatus,
    seatSyncStatus: !billingEnabled || !billing?.stripeSubscriptionId ? "not_applicable" : billing.seatSyncStatus,
    currentPeriodEnd: billing?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: billing?.cancelAtPeriodEnd ?? false,
    graceEndsAt: billing?.graceEndsAt?.toISOString() ?? null,
    nextReconcileAt: billing?.nextRetryAt?.toISOString() ?? null,
    lastError: billing?.lastError ?? null,
    orgSkillCount: Number(orgSkillRow[0]?.value ?? 0),
    hiddenPersonalSkillCount: entitlements.personalSkills ? 0 : Number(personalSkillRow[0]?.value ?? 0),
    sandboxUsage,
    checkoutEnabled: billingEnabled && config.checkoutEnabled && canStartSubscription,
    portalEnabled: billingEnabled && !!billing?.stripeSubscriptionId,
  };
}
