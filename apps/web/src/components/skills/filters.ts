import { skillFilterSchema, type SkillFilter } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";

export type Filter = SkillFilter;

export function filtersKey(fs: Filter[]): string {
  return fs.map((f) => f.type + ":" + f.value).sort().join("|");
}

// The in-list filter bar narrows by validation status and dependency relationships; label folders
// are selected from the sidebar, not here.
function matchOne(s: SkillVM, type: string, v: string): boolean {
  if (type === "status") return s.validation === v;
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
  if (f.type === "status")
    return {
      icon: f.value === "invalid" ? "alert-triangle" : f.value === "valid" ? "check" : "loader",
      key: "status",
      val: f.value,
    };
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
