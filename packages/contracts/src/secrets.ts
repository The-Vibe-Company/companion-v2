import { z } from "zod";
import { SEMVER_RE, SKILL_NAME_RE, SKILL_REQUIREMENT_KEY_RE } from "./frontmatter";

export const secretAudienceSchema = z.enum(["personal", "restricted", "organization"]);
export type SecretAudience = z.infer<typeof secretAudienceSchema>;

export const SECRET_VALUE_MAX_BYTES = 64 * 1024;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const secretOwnerSchema = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string(),
  avatar_url: z.string().nullable().default(null),
});

export const secretRecipientSchema = secretOwnerSchema;

/** Metadata-only read model. Secret values are deliberately absent. */
export const secretRowSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  name: z.string(),
  key: z.string(),
  audience: secretAudienceSchema,
  owner: secretOwnerSchema,
  recipients: z.array(secretRecipientSchema).default([]),
  current_version: z.number().int().positive(),
  last_rotated_at: z.string(),
  disabled_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  can_use: z.boolean(),
  can_manage: z.boolean(),
  usage_count: z.number().int().nonnegative().default(0),
});
export type SecretRow = z.infer<typeof secretRowSchema>;

const secretValueSchema = z.string().min(1, "secret value is required").superRefine((value, ctx) => {
  if (utf8ByteLength(value) > SECRET_VALUE_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "secret value must be at most 64 KiB" });
  }
});

export const createSecretInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    key: z.string().trim().max(128).regex(SKILL_REQUIREMENT_KEY_RE),
    value: secretValueSchema,
    audience: secretAudienceSchema.default("personal"),
    recipient_ids: z.array(z.string()).max(250).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.audience === "restricted" && value.recipient_ids.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipient_ids"], message: "restricted secrets require at least one recipient" });
    }
    if (value.audience !== "restricted" && value.recipient_ids.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipient_ids"], message: "recipients are only valid for restricted secrets" });
    }
  });
export type CreateSecretInput = z.infer<typeof createSecretInputSchema>;

export const updateSecretInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    key: z.string().trim().max(128).regex(SKILL_REQUIREMENT_KEY_RE).optional(),
    audience: secretAudienceSchema.optional(),
    recipient_ids: z.array(z.string()).max(250).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one field is required")
  .superRefine((value, ctx) => {
    if (value.audience === "restricted" && value.recipient_ids?.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipient_ids"], message: "restricted secrets require at least one recipient" });
    }
    if (value.audience && value.audience !== "restricted" && value.recipient_ids?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipient_ids"], message: "recipients are only valid for restricted secrets" });
    }
  });
export type UpdateSecretInput = z.infer<typeof updateSecretInputSchema>;

export const rotateSecretInputSchema = z.object({ value: secretValueSchema });
export type RotateSecretInput = z.infer<typeof rotateSecretInputSchema>;

export const secretSlotStatusSchema = z.enum([
  "personal",
  "shared",
  "required",
  "optional_missing",
]);

export const secretCandidateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  key: z.string(),
  owner: secretOwnerSchema,
  audience: secretAudienceSchema,
  personal: z.boolean(),
});

export const skillSecretSlotSchema = z.object({
  slot_id: z.string().uuid(),
  env_key: z.string().regex(SKILL_REQUIREMENT_KEY_RE),
  description: z.string(),
  required: z.boolean(),
  status: secretSlotStatusSchema,
  binding: secretCandidateSchema.nullable(),
  suggestion: secretCandidateSchema.nullable(),
  suggestion_confirmed: z.boolean(),
  candidates: z.array(secretCandidateSchema),
});

export const skillSecretConfigurationSchema = z.object({
  skill_id: z.string().uuid(),
  slug: z.string().regex(SKILL_NAME_RE),
  version: z.string().regex(SEMVER_RE).nullable(),
  slots: z.array(skillSecretSlotSchema),
  configured: z.boolean(),
  blockers: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
});
export type SkillSecretConfiguration = z.infer<typeof skillSecretConfigurationSchema>;

export const setSecretBindingInputSchema = z.object({ secret_id: z.string().uuid() });
export const setSecretSuggestionInputSchema = z.object({ secret_id: z.string().uuid() });

export const secretRetrievalSkillInputSchema = z.object({
  slug: z.string().regex(SKILL_NAME_RE),
  version: z.string().regex(SEMVER_RE).optional(),
});

export const secretRetrievalDirectInputSchema = z.object({
  secret_id: z.string().uuid(),
  env_key: z.string().regex(SKILL_REQUIREMENT_KEY_RE),
  profile: z.string().regex(SKILL_NAME_RE),
});

export const secretRetrievalPreflightInputSchema = z
  .object({
    operation_id: z.string().uuid(),
    skills: z.array(secretRetrievalSkillInputSchema).max(64).default([]),
    direct: z.array(secretRetrievalDirectInputSchema).max(64).default([]),
  })
  .refine((value) => value.skills.length > 0 || value.direct.length > 0, "at least one skill or direct secret is required");
export type SecretRetrievalPreflightInput = z.infer<typeof secretRetrievalPreflightInputSchema>;

export const secretRetrievalItemSchema = z.object({
  projection_id: z.string().uuid(),
  skill: z.string(),
  skill_version: z.string().nullable(),
  slot_id: z.string().uuid().nullable(),
  env_key: z.string(),
  required: z.boolean(),
  status: secretSlotStatusSchema,
  secret_id: z.string().uuid().nullable(),
  secret_version: z.number().int().positive().nullable(),
  secret_name: z.string().nullable(),
  owner_name: z.string().nullable(),
});

export const secretRetrievalPreflightSchema = z.object({
  plan_id: z.string().uuid(),
  operation_id: z.string().uuid(),
  expires_at: z.string(),
  items: z.array(secretRetrievalItemSchema),
  tombstones: z.array(z.object({ projection_id: z.string().uuid(), skill: z.string() })),
  blockers: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
});
export type SecretRetrievalPreflight = z.infer<typeof secretRetrievalPreflightSchema>;

export const createSecretGrantResultSchema = z.object({
  grant: z.string().startsWith("cmp_grant_"),
  expires_at: z.string(),
  item_count: z.number().int().nonnegative(),
});
export type CreateSecretGrantResult = z.infer<typeof createSecretGrantResultSchema>;

export const redeemSecretGrantInputSchema = z.object({ grant: z.string().startsWith("cmp_grant_") });

/** Dedicated plaintext response. No other contract may include `value`. */
export const redeemedSecretGrantSchema = z.object({
  operation_id: z.string().uuid(),
  items: z.array(
    z.object({
      projection_id: z.string().uuid(),
      skill: z.string(),
      skill_version: z.string().nullable(),
      slot_id: z.string().uuid().nullable(),
      env_key: z.string(),
      secret_id: z.string().uuid(),
      secret_version: z.number().int().positive(),
      value: z.string(),
    }),
  ),
  tombstones: z.array(z.object({ projection_id: z.string().uuid(), skill: z.string() })),
});
export type RedeemedSecretGrant = z.infer<typeof redeemedSecretGrantSchema>;
