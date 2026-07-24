/** Server-only rollout gate for persistent Cowork Projects. */
export function projectsFeatureEnabled(): boolean {
  const value = process.env.COMPANION_PROJECTS_ENABLED?.trim().toLowerCase();
  return value === "true" || value === "1";
}
