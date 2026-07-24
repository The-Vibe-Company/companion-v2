import { hasInternalProductAccess } from "@companion/core";

function envFlagEnabled(name: "COMPANION_PROJECTS_ENABLED" | "COMPANION_RUNS_ENABLED"): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/** Server-only rollout gate for persistent Cowork Projects. */
export function projectsFeatureEnabled(email: string): boolean {
  return hasInternalProductAccess(email) && envFlagEnabled("COMPANION_PROJECTS_ENABLED");
}

/** Server-only rollout gate for one-shot Run Skill sessions. */
export function runSkillFeatureEnabled(email: string): boolean {
  return hasInternalProductAccess(email) && envFlagEnabled("COMPANION_RUNS_ENABLED");
}
