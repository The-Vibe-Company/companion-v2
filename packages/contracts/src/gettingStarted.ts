import { z } from "zod";

export const gettingStartedStepSchema = z.enum([
  "companion_install",
  "local_review",
  "org_review",
]);
export type GettingStartedStep = z.infer<typeof gettingStartedStepSchema>;

export const recordGettingStartedStepInputSchema = z.object({
  step: gettingStartedStepSchema,
  agent: z.string().trim().min(1).max(120).optional(),
});
export type RecordGettingStartedStepInput = z.infer<typeof recordGettingStartedStepInputSchema>;

const nullableTimestamp = z.string().datetime().nullable();

export const gettingStartedStateSchema = z.object({
  companion_installed_at: nullableTimestamp,
  local_reviewed_at: nullableTimestamp,
  org_reviewed_at: nullableTimestamp,
  completed_at: nullableTimestamp,
  dismissed_at: nullableTimestamp,
  completed: z.boolean(),
  first_incomplete_step: gettingStartedStepSchema.nullable(),
});
export type GettingStartedState = z.infer<typeof gettingStartedStateSchema>;
