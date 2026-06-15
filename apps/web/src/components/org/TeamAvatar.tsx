"use client";

import type { CSSProperties } from "react";
import { TEAM_BRAND_COLORS } from "@companion/contracts";
import { hashColor, initialsOf } from "@/lib/settingsViewModel";

export interface TeamAvatarTeam {
  name: string;
  color?: string | null;
  icon?: string | null;
}

export function TeamAvatar({
  team,
  className,
}: {
  team: TeamAvatarTeam;
  className: string;
}) {
  const color =
    team.color && (TEAM_BRAND_COLORS as readonly string[]).includes(team.color)
      ? team.color
      : hashColor(team.name);
  const style = {
    "--team-brand-color": color,
    background: team.icon
      ? `color-mix(in oklch, ${color} 18%, var(--color-surface))`
      : color,
    color: team.icon ? "transparent" : "#fff",
  } as CSSProperties;

  return (
    <span className={className + " team-brand-avatar"} style={style} title={team.name}>
      {team.icon ? (
        <span className="team-brand-avatar__icon" aria-hidden="true">
          {team.icon}
        </span>
      ) : (
        initialsOf(team.name)
      )}
    </span>
  );
}
