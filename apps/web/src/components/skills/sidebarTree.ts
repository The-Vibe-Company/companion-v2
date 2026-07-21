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

function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : path.slice(0, index);
}

function flattenRows(rows: TreeRow[], preferredPaths: string[]): TreeRow[] {
  const rank = new Map<string, number>();
  preferredPaths.forEach((path, index) => {
    if (!rank.has(path)) rank.set(path, index);
  });
  const children = new Map<string | null, TreeRow[]>();
  for (const row of rows) {
    const parent = parentPath(row.path);
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => {
      const leftRank = rank.get(left.path);
      const rightRank = rank.get(right.path);
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.path.localeCompare(right.path);
    });
  }
  const flattened: TreeRow[] = [];
  const visit = (parent: string | null) => {
    for (const row of children.get(parent) ?? []) {
      flattened.push(row);
      visit(row.path);
    }
  };
  visit(null);
  return flattened;
}

/**
 * Derive the flattened label tree from skills and explicit label rows. Intermediate parents are
 * synthesized and roll-up counts are de-duplicated per skill.
 */
export function deriveTreeRows(skills: SkillVM[], labels: LabelVM[], preferredPaths: string[] = []): TreeRow[] {
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

  const rows = [...paths].map((path) => {
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
  return flattenRows(rows, preferredPaths);
}

/** Return a complete depth-first preference after moving one category before/after a sibling. */
export function reorderTreeRows(
  rows: TreeRow[],
  from: string,
  target: string,
  position: "before" | "after",
): string[] | null {
  if (from === target || parentPath(from) !== parentPath(target)) return null;
  const siblings = rows.filter((row) => parentPath(row.path) === parentPath(from)).map((row) => row.path);
  if (!siblings.includes(from) || !siblings.includes(target)) return null;
  const nextSiblings = siblings.filter((path) => path !== from);
  const targetIndex = nextSiblings.indexOf(target);
  nextSiblings.splice(targetIndex + (position === "after" ? 1 : 0), 0, from);
  const children = new Map<string | null, string[]>();
  for (const row of rows) {
    const parent = parentPath(row.path);
    const paths = children.get(parent) ?? [];
    paths.push(row.path);
    children.set(parent, paths);
  }
  children.set(parentPath(from), nextSiblings);
  const preferred: string[] = [];
  const visit = (parent: string | null) => {
    for (const path of children.get(parent) ?? []) {
      preferred.push(path);
      visit(path);
    }
  };
  visit(null);
  return preferred;
}

/** Keep a renamed subtree in place, or append it to the end of a new parent's sibling list. */
export function remapTreeOrder(order: string[], from: string, to: string, appendToNewParent = false): string[] {
  const within = (path: string) => path === from || path.startsWith(from + "/");
  const remapped = [...new Set(order.map((path) => (within(path) ? to + path.slice(from.length) : path)))];
  if (!appendToNewParent || parentPath(from) === parentPath(to)) return remapped;
  const subtree = remapped.filter((path) => path === to || path.startsWith(to + "/"));
  const rest = remapped.filter((path) => !subtree.includes(path));
  const siblings = rest.filter((path) => parentPath(path) === parentPath(to));
  if (siblings.length === 0) return [...rest, ...subtree];
  const lastSibling = siblings[siblings.length - 1]!;
  let insertAt = rest.indexOf(lastSibling) + 1;
  while (insertAt < rest.length && rest[insertAt]!.startsWith(lastSibling + "/")) insertAt += 1;
  return [...rest.slice(0, insertAt), ...subtree, ...rest.slice(insertAt)];
}

export function removeTreeOrderPath(order: string[], path: string): string[] {
  return order.filter((candidate) => candidate !== path && !candidate.startsWith(path + "/"));
}
