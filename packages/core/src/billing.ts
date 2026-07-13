import {
  type BillingMode,
  type BillingOverview,
  type EffectivePlan,
  type EntitlementErrorBody,
  type EntitlementFeature,
  type EntitlementMode,
  type Entitlements,
  stripeSubscriptionStatusSchema,
} from "@companion/contracts";
import { db, type Db, schema } from "@companion/db";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { isOrgAdmin } from "./authz";

export const PRO_UNIT_AMOUNT_USD_CENTS = 1_000;
export const FREE_ORG_SKILL_LIMIT = 20;
export const PAYMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
export const BILLING_UPGRADE_URL = "/settings?view=billing";

export interface BillingRuntimeConfig {
  billingMode: BillingMode;
  entitlementMode: EntitlementMode;
  pilotOrgIds: ReadonlySet<string>;
  proOrgAllowlist: ReadonlySet<string>;
  checkoutEnabled: boolean;
  webhooksEnabled: boolean;
  stripePriceId?: string;
  stripePortalConfigurationId?: string;
}

function csvSet(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function envBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
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
): never {
  throw new EntitlementDeniedError({
    code,
    feature,
    message,
    effectivePlan: "free",
    upgradeUrl: BILLING_UPGRADE_URL,
    ...extra,
  });
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
    checkoutEnabled: billingEnabled && config.checkoutEnabled && canStartSubscription,
    portalEnabled: billingEnabled && !!billing?.stripeSubscriptionId,
  };
}
