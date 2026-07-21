import type { LabelColor, LabelIcon, LabelVM, SkillIcon } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";

export type SkillListGroupKind = "folder" | "direct" | "installed" | "unfiled";

export interface SkillListIcon {
  name: SkillIcon | LabelIcon | "package";
  color: LabelColor | null;
}

export interface GroupedSkillRow {
  skill: SkillVM;
  relativePaths: SkillListPath[];
  icon: SkillListIcon;
}

export interface SkillListPath {
  path: string;
  label: string;
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

/** Keep only folder assignments that belong to the selected sidebar branch. */
export function pathsInLabelScope(paths: string[], activeLabel: string | null): string[] {
  if (!activeLabel) return paths;
  return paths.filter((path) => path === activeLabel || path.startsWith(`${activeLabel}/`));
}

function displayRelativePath(path: string, groupPath: string, appearance: Map<string, LabelVM>): string {
  const segments = path.split("/");
  const groupDepth = pathDepth(groupPath);
  return segments
    .slice(groupDepth)
    .map(
      (segment, index) =>
        appearance.get(segments.slice(0, groupDepth + index + 1).join("/"))?.displayName ?? segment,
    )
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
  activeLabel: string | null = null,
): SkillListGroup[] {
  const appearance = new Map(labels.map((label) => [label.path, label]));
  const roots = new Map<string, SkillListGroup>();
  const scopedPaths = new Map(
    skills.map((skill) => [skill, mostSpecificPaths(pathsInLabelScope(skill.labels, activeLabel))]),
  );
  const hasScopedDescendants =
    activeLabel !== null &&
    [...scopedPaths.values()].some((paths) => paths.some((path) => path.startsWith(`${activeLabel}/`)));
  const groupDepth = activeLabel ? pathDepth(activeLabel) + (hasScopedDescendants ? 1 : 0) : 1;
  const activeAppearance = activeLabel ? appearance.get(activeLabel) : null;
  const direct: SkillListGroup = {
    key: `direct:${activeLabel ?? "root"}`,
    kind: "direct",
    path: activeLabel,
    label: "Without subfolder",
    icon: activeAppearance?.icon ?? "folder",
    color: activeAppearance?.color ?? null,
    rows: [],
  };
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
    // A folder route is an occurrence-scoped view: a skill filed in several roots must not leak
    // back into those other roots after the membership filter has selected it.
    const specificPaths = scopedPaths.get(skill) ?? [];
    const pathsByRoot = new Map<string, string[]>();
    let filedDirectly = false;
    for (const path of specificPaths) {
      if (activeLabel && hasScopedDescendants && path === activeLabel) {
        filedDirectly = true;
        direct.rows.push({
          skill,
          relativePaths: [],
          icon: resolveSkillListIcon(skill, labels, [path]),
        });
        continue;
      }
      const root = path.split("/").slice(0, groupDepth).join("/");
      if (!root) continue;
      pathsByRoot.set(root, [...(pathsByRoot.get(root) ?? []), path]);
    }
    if (pathsByRoot.size === 0 && !filedDirectly) {
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
          label: rootAppearance?.displayName ?? root.split("/").at(-1) ?? root,
          icon: rootAppearance?.icon ?? "folder",
          color: rootAppearance?.color ?? null,
          rows: [],
        };
        roots.set(root, group);
      }
      const relativePaths = paths
        .filter((path) => path !== root)
        .map((path) => ({ path, label: displayRelativePath(path, root, appearance) }));
      group.rows.push({ skill, relativePaths, icon: resolveSkillListIcon(skill, labels, paths) });
    }
  }

  return [
    ...[...roots.values()].sort((left, right) => (left.path ?? "").localeCompare(right.path ?? "")),
    ...(direct.rows.length ? [direct] : []),
    ...(installed.rows.length ? [installed] : []),
    ...(unfiled.rows.length ? [unfiled] : []),
  ];
}
