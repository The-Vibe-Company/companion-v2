import { skillFilterSchema, type SkillFilter, type SkillSavedView } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";
import { VISIBILITY_ICON } from "./blocks";

export type Filter = SkillFilter;

export interface ViewDef {
  id: string;
  name: string;
  icon: string;
  filters: Filter[];
  custom?: true;
}

export type SavedViewDef = SkillSavedView;

export const BUILTIN_VIEWS: ViewDef[] = [
  { id: "all", name: "All", icon: "layers", filters: [] },
];

export function filtersKey(fs: Filter[]): string {
  return fs.map((f) => f.type + ":" + f.value).sort().join("|");
}

function matchOne(s: SkillVM, type: string, v: string): boolean {
  if (type === "visibility") {
    // Owner kind is the access axis: team-owned (workspace-visible) vs personal (private).
    if (v === "team") return s.owner.kind === "team";
    if (v === "personal") return s.owner.kind === "user";
    return false;
  }
  if (type === "status") return s.validation === v;
  if (type === "starred") return s.starred === true;
  // Owner is matched by the principal id (user id for Personal, team id for Team-owned), NOT the
  // display name — two people with the same name no longer collide into each other's "mine".
  if (type === "owner") return s.owner.id === v;
  if (type === "team") return s.teamSlugs.includes(v);
  if (type === "deps") {
    if (v === "has") return s.requiresCount > 0;
    if (v === "used") return s.usedByCount > 0;
    return false;
  }
  return true;
}

export function matchFilters(s: SkillVM, filters: Filter[]): boolean {
  if (!filters.length) return true;
  const byType: Record<string, string[]> = {};
  filters.forEach((f) => {
    (byType[f.type] = byType[f.type] || []).push(f.value);
  });
  return Object.keys(byType).every((type) => (byType[type] ?? []).some((v) => matchOne(s, type, v)));
}

export function chipParts(f: Filter): { icon: string; key: string; val: string } {
  if (f.type === "visibility") return { icon: VISIBILITY_ICON[f.value] ?? "circle", key: "visibility", val: f.value };
  if (f.type === "status")
    return {
      icon: f.value === "invalid" ? "alert-triangle" : f.value === "valid" ? "check" : "loader",
      key: "status",
      val: f.value,
    };
  if (f.type === "starred") return { icon: "star", key: "", val: "starred" };
  if (f.type === "owner") return { icon: "user", key: "owner", val: f.value };
  if (f.type === "team") return { icon: "users", key: "team", val: f.value };
  if (f.type === "deps")
    return {
      icon: f.value === "has" ? "package" : "corner-down-right",
      key: "deps",
      val: f.value === "has" ? "has dependencies" : "used as dependency",
    };
  return { icon: "filter", key: "", val: "" };
}

export function makeFilter(type: Filter["type"], value: string): Filter | null {
  const parsed = skillFilterSchema.safeParse({ type, value });
  return parsed.success ? parsed.data : null;
}
