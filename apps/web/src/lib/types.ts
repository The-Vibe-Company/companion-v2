import type { Scope, SkillListRow, ValidationState } from "@companion/contracts";
import { formatBytes, formatDate, relativeTime } from "./format";

export interface SkillOwnerVM {
  name: string;
  initials: string;
  handle: string | null;
  team: string | null;
}

/** The UI-facing skill shape consumed by the ported direction-C+C components. */
export interface SkillVM {
  uuid: string; // db id
  id: string; // slug (the displayed machine name)
  scope: Scope;
  version: string | null;
  validation: ValidationState;
  description: string;
  error: string | null;
  owner: SkillOwnerVM;
  tools: string[];
  size: string;
  license: string | null;
  checksum: string | null;
  created: string; // formatted date (server-computed)
  updated: string; // relative label (server-computed)
  stars: number;
  starred: boolean;
  team: string | null; // team display name (visibility team)
  teamSlug: string | null; // team slug (for filtering)
}

/** Map a skill_list_v row to the UI view-model. Date formatting runs server-side. */
export function mapSkill(row: SkillListRow): SkillVM {
  return {
    uuid: row.id,
    id: row.slug,
    scope: row.scope,
    version: row.current_version,
    validation: row.validation,
    description: row.description,
    error: row.validation_error,
    owner: {
      name: row.owner_name,
      initials: row.owner_initials,
      handle: row.owner_handle,
      team: row.team_name,
    },
    tools: row.tools ?? [],
    size: formatBytes(row.size_bytes),
    license: row.license,
    checksum: row.checksum,
    created: formatDate(row.created_at),
    updated: relativeTime(row.updated_at),
    stars: row.star_count,
    starred: row.starred,
    team: row.team_name,
    teamSlug: row.team_slug,
  };
}

export interface TeamVM {
  id: string; // slug
  name: string;
  initial: string;
}

export interface MeVM {
  id: string;
  name: string;
  initials: string;
}
