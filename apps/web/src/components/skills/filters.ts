import type { SkillVM } from "@/lib/types";
import { SCOPE_ICON } from "./blocks";

export interface Filter {
  type: "scope" | "status" | "starred" | "owner" | "team";
  value: string;
}

export interface ViewDef {
  id: string;
  name: string;
  icon: string;
  filters: Filter[];
  custom?: boolean;
}

export const BUILTIN_VIEWS: ViewDef[] = [
  { id: "all", name: "All", icon: "layers", filters: [] },
  { id: "starred", name: "Starred", icon: "star", filters: [{ type: "starred", value: "true" }] },
  { id: "public", name: "Public", icon: "globe", filters: [{ type: "scope", value: "public" }] },
  {
    id: "attention",
    name: "Needs attention",
    icon: "alert-triangle",
    filters: [
      { type: "status", value: "invalid" },
      { type: "status", value: "validating" },
    ],
  },
];

export function filtersKey(fs: Filter[]): string {
  return fs.map((f) => f.type + ":" + f.value).sort().join("|");
}

function matchOne(s: SkillVM, type: string, v: string): boolean {
  if (type === "scope") return s.scope === v;
  if (type === "status") return s.validation === v;
  if (type === "starred") return s.starred === true;
  if (type === "owner") return s.owner.name === v;
  if (type === "team") return s.teamSlug === v;
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
  if (f.type === "scope") return { icon: SCOPE_ICON[f.value] ?? "globe", key: "scope", val: f.value };
  if (f.type === "status")
    return {
      icon: f.value === "invalid" ? "alert-triangle" : f.value === "valid" ? "check" : "loader",
      key: "status",
      val: f.value,
    };
  if (f.type === "starred") return { icon: "star", key: "", val: "starred" };
  if (f.type === "owner") return { icon: "user", key: "owner", val: f.value };
  if (f.type === "team") return { icon: "users", key: "team", val: f.value };
  return { icon: "filter", key: f.type, val: f.value };
}
