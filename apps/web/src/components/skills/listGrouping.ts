import type { LabelColor, LabelIcon, LabelVM, SkillIcon } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";

export type SkillListGroupKind = "folder" | "installed" | "unfiled";

export interface SkillListIcon {
  name: SkillIcon | LabelIcon | "package";
  color: LabelColor | null;
}

export interface GroupedSkillRow {
  skill: SkillVM;
  relativePaths: string[];
  icon: SkillListIcon;
}

export interface SkillListGroup {
  key: string;
  kind: SkillListGroupKind;
  path: string | null;
  label: string;
  icon: LabelIcon | "folder";
  color: LabelColor | null;
  rows: GroupedSkillRow[];
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function pathPrefixes(path: string): string[] {
  const segments = path.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/** Drop an assigned ancestor when a more-specific assigned descendant carries the same context. */
export function mostSpecificPaths(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  return unique.filter((path) => !unique.some((candidate) => candidate.startsWith(`${path}/`)));
}

function displayPath(path: string, appearance: Map<string, LabelVM>): string {
  const segments = path.split("/");
  return segments
    .map((segment, index) => appearance.get(segments.slice(0, index + 1).join("/"))?.displayName ?? segment)
    .join(" / ");
}

/**
 * Resolve the closest custom folder icon. Depth wins; canonical path order makes equal-depth ties
 * stable across server responses and optimistic client updates.
 */
export function resolveSkillListIcon(
  skill: Pick<SkillVM, "icon" | "labels">,
  labels: LabelVM[],
  paths: string[] = skill.labels,
): SkillListIcon {
  if (skill.icon) return { name: skill.icon, color: null };
  const appearance = new Map(labels.map((label) => [label.path, label]));
  const candidates = [...new Set(paths.flatMap(pathPrefixes))]
    .map((path) => ({ path, appearance: appearance.get(path) }))
    .filter(
      (candidate): candidate is { path: string; appearance: LabelVM & { icon: LabelIcon } } =>
        candidate.appearance?.icon != null,
    )
    .sort((left, right) => pathDepth(right.path) - pathDepth(left.path) || left.path.localeCompare(right.path));
  const resolved = candidates[0];
  return resolved
    ? { name: resolved.appearance.icon, color: resolved.appearance.color }
    : { name: "package", color: null };
}

export function groupSkillsByRoot(
  skills: SkillVM[],
  labels: LabelVM[],
  library: "mine" | "org",
): SkillListGroup[] {
  const appearance = new Map(labels.map((label) => [label.path, label]));
  const roots = new Map<string, SkillListGroup>();
  const installed: SkillListGroup = {
    key: "installed",
    kind: "installed",
    path: null,
    label: "Installed",
    icon: "package",
    color: null,
    rows: [],
  };
  const unfiled: SkillListGroup = {
    key: "unfiled",
    kind: "unfiled",
    path: null,
    label: "Without folder",
    icon: "folder",
    color: null,
    rows: [],
  };

  for (const skill of skills) {
    if (library === "mine" && skill.source === "installed") {
      installed.rows.push({ skill, relativePaths: [], icon: resolveSkillListIcon(skill, labels, []) });
      continue;
    }
    const specificPaths = mostSpecificPaths(skill.labels);
    const pathsByRoot = new Map<string, string[]>();
    for (const path of specificPaths) {
      const root = path.split("/")[0];
      if (!root) continue;
      pathsByRoot.set(root, [...(pathsByRoot.get(root) ?? []), path]);
    }
    if (pathsByRoot.size === 0) {
      unfiled.rows.push({ skill, relativePaths: [], icon: resolveSkillListIcon(skill, labels, []) });
      continue;
    }
    for (const [root, paths] of pathsByRoot) {
      let group = roots.get(root);
      if (!group) {
        const rootAppearance = appearance.get(root);
        group = {
          key: `folder:${root}`,
          kind: "folder",
          path: root,
          label: rootAppearance?.displayName ?? root,
          icon: rootAppearance?.icon ?? "folder",
          color: rootAppearance?.color ?? null,
          rows: [],
        };
        roots.set(root, group);
      }
      const relativePaths = paths
        .filter((path) => path !== root)
        .map((path) => displayPath(path, appearance).split(" / ").slice(1).join(" / "));
      group.rows.push({ skill, relativePaths, icon: resolveSkillListIcon(skill, labels, paths) });
    }
  }

  return [
    ...[...roots.values()].sort((left, right) => (left.path ?? "").localeCompare(right.path ?? "")),
    ...(installed.rows.length ? [installed] : []),
    ...(unfiled.rows.length ? [unfiled] : []),
  ];
}
