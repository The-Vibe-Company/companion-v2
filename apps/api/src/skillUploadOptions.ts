import type { TeamRole } from "@companion/contracts";

export interface UploadOptionTeam {
  id: string;
  slug: string;
  name: string;
  color: string | null;
  icon: string | null;
  teamRole: TeamRole;
}

export function buildSkillUploadOptions(teams: UploadOptionTeam[]) {
  return {
    // The owner is the single access axis: `owner_team` null = Personal (private); a team slug =
    // owned by that team (workspace-visible). Default to Personal.
    defaults: {
      owner_team: null as string | null,
    },
    teams: teams.map((team) => ({
      id: team.id,
      slug: team.slug,
      name: team.name,
      color: team.color,
      icon: team.icon,
      teamRole: team.teamRole,
      canOwn: team.teamRole === "admin" || team.teamRole === "editor",
    })),
  };
}
