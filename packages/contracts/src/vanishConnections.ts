import { z } from "zod";
import { secretAudienceSchema } from "./secrets";

/** Vanish remains a reference to the generic vault, separate from model-provider credentials. */
export const vanishConnectionRowSchema = z
  .object({
    key_name: z.literal("VANISH_API_KEY"),
    secret_id: z.string().uuid(),
    secret_name: z.string().min(1).max(120),
    secret_audience: secretAudienceSchema,
    secret_owner_name: z.string().min(1).max(240),
    scope: z.enum(["personal", "organization"]),
    set: z.literal(true),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type VanishConnectionRow = z.infer<typeof vanishConnectionRowSchema>;

export const vanishConnectionResponseSchema = z
  .object({ connection: vanishConnectionRowSchema.nullable() })
  .strict();
export type VanishConnectionResponse = z.infer<typeof vanishConnectionResponseSchema>;

export const setVanishConnectionInputSchema = z
  .object({ secret_id: z.string().uuid() })
  .strict();
export type SetVanishConnectionInput = z.infer<typeof setVanishConnectionInputSchema>;
