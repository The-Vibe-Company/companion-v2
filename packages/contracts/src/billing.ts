import { z } from "zod";

export const effectivePlanSchema = z.enum(["free", "pro"]);
export type EffectivePlan = z.infer<typeof effectivePlanSchema>;

export const billingModeSchema = z.enum(["disabled", "stripe"]);
export type BillingMode = z.infer<typeof billingModeSchema>;

export const entitlementModeSchema = z.enum(["off", "observe", "pilot", "enforce"]);
export type EntitlementMode = z.infer<typeof entitlementModeSchema>;

export const seatSyncStatusSchema = z.enum(["not_applicable", "synced", "pending", "error"]);
export type SeatSyncStatus = z.infer<typeof seatSyncStatusSchema>;

export const stripeSubscriptionStatusSchema = z.enum([
  "active",
  "past_due",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
  "canceled",
  "trialing",
]);
export type StripeSubscriptionStatus = z.infer<typeof stripeSubscriptionStatusSchema>;

export const entitlementsSchema = z.object({
  effectivePlan: effectivePlanSchema,
  computedPlan: effectivePlanSchema,
  billingMode: billingModeSchema,
  entitlementMode: entitlementModeSchema,
  enforced: z.boolean(),
  personalSkills: z.boolean(),
  skillHistory: z.boolean(),
  orgSkillLimit: z.number().int().positive().nullable(),
  catalogFrozen: z.boolean(),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

export const billingOverviewSchema = z.object({
  billingEnabled: z.boolean(),
  canManage: z.boolean(),
  entitlements: entitlementsSchema,
  unitAmount: z.number().int().nonnegative(),
  currency: z.literal("usd"),
  interval: z.literal("month"),
  activeSeats: z.number().int().positive(),
  syncedSeats: z.number().int().nonnegative().nullable(),
  estimatedMonthlySubtotal: z.number().int().nonnegative(),
  stripeStatus: stripeSubscriptionStatusSchema.nullable(),
  seatSyncStatus: seatSyncStatusSchema,
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  graceEndsAt: z.string().nullable(),
  nextReconcileAt: z.string().nullable(),
  lastError: z.string().nullable(),
  orgSkillCount: z.number().int().nonnegative(),
  hiddenPersonalSkillCount: z.number().int().nonnegative(),
  checkoutEnabled: z.boolean(),
  portalEnabled: z.boolean(),
});
export type BillingOverview = z.infer<typeof billingOverviewSchema>;

export const entitlementErrorCodeSchema = z.enum([
  "upgrade_required",
  "org_skill_limit_reached",
  "catalog_frozen",
]);
export type EntitlementErrorCode = z.infer<typeof entitlementErrorCodeSchema>;

export const entitlementFeatureSchema = z.enum([
  "personal_skills",
  "skill_history",
  "org_skill_create",
  "org_skill_publish",
  "org_skill_restore",
  "org_skill_rename",
  "skill_share",
]);
export type EntitlementFeature = z.infer<typeof entitlementFeatureSchema>;

export const entitlementErrorSchema = z.object({
  code: entitlementErrorCodeSchema,
  feature: entitlementFeatureSchema,
  message: z.string(),
  effectivePlan: effectivePlanSchema,
  limit: z.number().int().positive().optional(),
  current: z.number().int().nonnegative().optional(),
  upgradeUrl: z.string(),
});
export type EntitlementErrorBody = z.infer<typeof entitlementErrorSchema>;
