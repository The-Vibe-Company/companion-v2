import { z } from "zod";

/**
 * The two operator restart scopes exposed by Companion settings. `pi` recycles only the daemon in
 * an already-running Box; `box` archives and resumes the whole machine. Neither target is a wake:
 * the API accepts this contract only while the Companion is observably online.
 */
export const restartCompanionRuntimeInputSchema = z.object({
  target: z.enum(["pi", "box"]),
}).strict();
export type RestartCompanionRuntimeInput = z.infer<typeof restartCompanionRuntimeInputSchema>;
