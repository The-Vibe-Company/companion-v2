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

/** Organization-wide sandbox minute pool for the current UTC calendar month. */
export const sandboxUsageOverviewSchema = z.object({
  enabled: z.boolean(),
  enforced: z.boolean(),
  limit_minutes: z.number().int().nonnegative().nullable(),
  used_minutes: z.number().int().nonnegative(),
  reserved_minutes: z.number().int().nonnegative(),
  remaining_minutes: z.number().int().nonnegative().nullable(),
  minutes_per_seat: z.number().int().positive(),
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
});
export type SandboxUsageOverview = z.infer<typeof sandboxUsageOverviewSchema>;

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
  sandboxUsage: sandboxUsageOverviewSchema,
  checkoutEnabled: z.boolean(),
  portalEnabled: z.boolean(),
});
export type BillingOverview = z.infer<typeof billingOverviewSchema>;

export const billingPaymentMethodPreviewSchema = z.object({
  type: z.string().min(1),
  brand: z.string().min(1).nullable(),
  last4: z.string().regex(/^\d{4}$/).nullable(),
  expMonth: z.number().int().min(1).max(12).nullable(),
  expYear: z.number().int().positive().nullable(),
});
export type BillingPaymentMethodPreview = z.infer<typeof billingPaymentMethodPreviewSchema>;

export const billingInvoiceStatusSchema = z.enum(["open", "paid", "uncollectible", "void"]);
export type BillingInvoiceStatus = z.infer<typeof billingInvoiceStatusSchema>;

export const billingInvoicePreviewSchema = z.object({
  number: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  amountDue: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: billingInvoiceStatusSchema,
  hostedInvoiceUrl: z.string().url().nullable(),
});
export type BillingInvoicePreview = z.infer<typeof billingInvoicePreviewSchema>;

export const billingPreviewSchema = z.object({
  paymentMethod: billingPaymentMethodPreviewSchema.nullable(),
  latestInvoice: billingInvoicePreviewSchema.nullable(),
});
export type BillingPreview = z.infer<typeof billingPreviewSchema>;

export const entitlementErrorCodeSchema = z.enum([
  "upgrade_required",
  "org_skill_limit_reached",
  "catalog_frozen",
  "sandbox_plan_required",
  "sandbox_quota_exhausted",
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
  "sandbox_runs",
]);
export type EntitlementFeature = z.infer<typeof entitlementFeatureSchema>;

export const entitlementErrorSchema = z.object({
  code: entitlementErrorCodeSchema,
  feature: entitlementFeatureSchema,
  message: z.string(),
  effectivePlan: effectivePlanSchema,
  limit: z.number().int().nonnegative().optional(),
  current: z.number().int().nonnegative().optional(),
  upgradeUrl: z.string().optional(),
});
export type EntitlementErrorBody = z.infer<typeof entitlementErrorSchema>;
