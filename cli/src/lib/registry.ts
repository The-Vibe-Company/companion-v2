import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { packDir, resolvePin } from "@companion/skills";
import type { DriftState, LockedSkill } from "@companion/contracts";

export interface RegistryInfo {
  exists: boolean;
  id: string | null;
  currentVersion: string | null;
  versions: string[];
}

/** Look up a skill's current version + version list (RLS-filtered). */
export async function getRegistryInfo(supabase: SupabaseClient, slug: string): Promise<RegistryInfo> {
  const { data: skill } = await supabase
    .from("skill_list_v")
    .select("id, current_version")
    .eq("slug", slug)
    .maybeSingle();
  if (!skill) return { exists: false, id: null, currentVersion: null, versions: [] };
  const id = (skill as { id: string }).id;
  const { data: vl } = await supabase.from("skill_versions").select("version").eq("skill_id", id);
  const versions = ((vl ?? []) as { version: string }[]).map((v) => v.version);
  return {
    exists: true,
    id,
    currentVersion: (skill as { current_version: string | null }).current_version,
    versions,
  };
}

/** Checksum the local working tree of a skill (null if not present / unpackable). */
export async function localChecksum(dir: string): Promise<string | null> {
  if (!existsSync(join(dir, "SKILL.md"))) return null;
  try {
    const r = await packDir(dir);
    return r.checksum;
  } catch {
    return null;
  }
}

/** The version a tracked skill should be at, given its pin and the registry. */
export function resolveTarget(pinned: string | null, reg: RegistryInfo): string | null {
  if (!reg.exists) return null;
  if (pinned && /^\d+\.\d+\.\d+/.test(pinned)) return pinned; // exact pin
  if (!pinned) return reg.currentVersion;
  return resolvePin(pinned, reg.versions);
}

const isExactPin = (p: string | null): boolean => !!p && /^\d+\.\d+\.\d+/.test(p);

/** Classify a tracked skill's drift state. */
export function classify(
  locked: LockedSkill,
  local: string | null,
  reg: RegistryInfo,
  target: string | null,
): DriftState {
  if (!reg.exists) return "not-published";
  if (local === null) return "missing";
  const edited = local !== locked.checksum;
  const advanced = target !== null && target !== locked.resolved;

  if (isExactPin(locked.pinned)) {
    if (edited) return "modified";
    if (reg.currentVersion && reg.currentVersion !== locked.resolved) return "pinned";
    return "up-to-date";
  }
  if (edited && advanced) return "conflict";
  if (edited) return "modified";
  if (advanced) return "outdated";
  return "up-to-date";
}
