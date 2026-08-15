import { z } from "zod";

/**
 * The two operator restart scopes exposed by Companion settings. `pi` recycles only the daemon in
 * an already-running Box; `box` archives and resumes the whole machine. A continuation repeats an
 * already-accepted full-Box restart without turning a delayed client retry into a second restart.
 */
export const restartCompanionRuntimeInputSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("pi") }).strict(),
  z.object({
    target: z.literal("box"),
    continuation: z.literal(true).optional(),
  }).strict(),
]);
export type RestartCompanionRuntimeInput = z.infer<typeof restartCompanionRuntimeInputSchema>;
