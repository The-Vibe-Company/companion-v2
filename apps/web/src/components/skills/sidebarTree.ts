import type { LabelColor, LabelIcon, LabelVM } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";

/** One flattened node of the derived label tree rendered in the shared application sidebar. */
export interface TreeRow {
  path: string;
  leafName: string;
  displayName: string | null;
  depth: number;
  count: number;
  color: LabelColor | null;
  icon: LabelIcon | null;
  hasChildren: boolean;
}

/**
 * Derive the flattened label tree from skills and explicit label rows. Intermediate parents are
 * synthesized and roll-up counts are de-duplicated per skill.
 */
export function deriveTreeRows(skills: SkillVM[], labels: LabelVM[]): TreeRow[] {
  const appearance = new Map<string, { displayName: string | null; color: LabelColor | null; icon: LabelIcon | null }>();
  const paths = new Set<string>();
  const childPaths = new Set<string>();
  const counts = new Map<string, Set<string>>();

  const ensureAncestors = (path: string) => {
    const segments = path.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const current = segments.slice(0, index).join("/");
      paths.add(current);
      if (index < segments.length) childPaths.add(current);
    }
  };

  for (const label of labels) {
    appearance.set(label.path, { displayName: label.displayName, color: label.color, icon: label.icon });
    ensureAncestors(label.path);
  }
  for (const skill of skills) {
    for (const path of skill.labels ?? []) {
      if (!path) continue;
      ensureAncestors(path);
      const segments = path.split("/");
      for (let index = 1; index <= segments.length; index += 1) {
        const current = segments.slice(0, index).join("/");
        let contributors = counts.get(current);
        if (!contributors) counts.set(current, (contributors = new Set()));
        contributors.add(skill.uuid);
      }
    }
  }

  return [...paths]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => {
      const segments = path.split("/");
      const style = appearance.get(path);
      return {
        path,
        leafName: segments[segments.length - 1] ?? path,
        displayName: style?.displayName ?? null,
        depth: segments.length - 1,
        count: counts.get(path)?.size ?? 0,
        color: style?.color ?? null,
        icon: style?.icon ?? null,
        hasChildren: childPaths.has(path),
      };
    });
}
