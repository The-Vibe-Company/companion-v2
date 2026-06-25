import type { LocalSkillRow } from "@companion/contracts";

export const REQUIRED_LOCAL_SKILL_KEY = "companion";

export function requiresCompanionSkillInstall(skills: LocalSkillRow[] | null | undefined): boolean {
  const companion = skills?.find((skill) => skill.key === REQUIRED_LOCAL_SKILL_KEY);
  return companion?.status === "none" || !companion;
}
