/**
 * The skills route encodes which slice of the org's skills is shown plus the open skill detail.
 * Skills are flat and org-wide; selection is by the shared label tree (a `label` path or the
 * `nolabel` pseudo-folder), the starred/archived views, or the Companion (local) skills section.
 */
export type SkillsRoute =
  | { kind: "all"; skill?: string }
  | { kind: "starred"; skill?: string }
  | { kind: "nolabel"; skill?: string }
  | { kind: "label"; label: string; skill?: string }
  | { kind: "local" }
  | { kind: "archived"; skill?: string };

export type SkillsSearchParams =
  | URLSearchParams
  | string
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

export type SkillsRouteSource = "default" | "explicit";

function firstParam(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function searchParamsFrom(input: SkillsSearchParams): URLSearchParams | Record<string, string | string[] | undefined> | null {
  const query = typeof input === "string" && input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
  return (
    typeof query === "string"
      ? new URLSearchParams(query.startsWith("?") ? query.slice(1) : query)
      : query ?? null
  );
}

export function skillsRouteSource(input: SkillsSearchParams): SkillsRouteSource {
  const params = searchParamsFrom(input);
  return params && (firstParam(params, "view") !== null || firstParam(params, "skill") !== null)
    ? "explicit"
    : "default";
}

export function parseSkillsRoute(input: SkillsSearchParams): SkillsRoute {
  const params = searchParamsFrom(input);
  if (!params) return { kind: "all" };

  const view = firstParam(params, "view");
  const skill = firstParam(params, "skill")?.trim() || undefined;
  if (view === "starred") return { kind: "starred", skill };
  if (view === "nolabel") return { kind: "nolabel", skill };
  if (view === "local") return { kind: "local" };
  if (view === "archived") return { kind: "archived", skill };
  if (view === "label") {
    // The label param is a slash-separated path; URLSearchParams already decoded it.
    const label = firstParam(params, "label")?.trim();
    return label ? { kind: "label", label, skill } : { kind: "all", skill };
  }
  return { kind: "all", skill };
}

export function skillsRouteHref(route: SkillsRoute): string {
  const params: string[] = [];
  if (route.kind === "starred") params.push("view=starred");
  if (route.kind === "nolabel") params.push("view=nolabel");
  if (route.kind === "local") params.push("view=local");
  if (route.kind === "archived") params.push("view=archived");
  if (route.kind === "label") {
    params.push("view=label", `label=${encodeURIComponent(route.label)}`);
  }
  if (route.kind !== "local" && route.skill) params.push(`skill=${encodeURIComponent(route.skill)}`);
  return params.length ? `/skills?${params.join("&")}` : "/skills";
}

export function skillsRouteKey(route: SkillsRoute): string {
  const base = route.kind === "label" ? `label:${route.label}` : route.kind;
  return route.kind !== "local" && route.skill ? `${base}:skill:${route.skill}` : base;
}

export function skillsRouteWithoutSkill(route: SkillsRoute): SkillsRoute {
  if (route.kind === "all") return { kind: "all" };
  if (route.kind === "starred") return { kind: "starred" };
  if (route.kind === "nolabel") return { kind: "nolabel" };
  if (route.kind === "label") return { kind: "label", label: route.label };
  if (route.kind === "archived") return { kind: "archived" };
  return { kind: "local" };
}

export function skillsRouteWithSkill(route: SkillsRoute, skill: string): SkillsRoute {
  if (route.kind === "all") return { kind: "all", skill };
  if (route.kind === "starred") return { kind: "starred", skill };
  if (route.kind === "nolabel") return { kind: "nolabel", skill };
  if (route.kind === "label") return { kind: "label", label: route.label, skill };
  if (route.kind === "archived") return { kind: "archived", skill };
  return { kind: "all", skill };
}
