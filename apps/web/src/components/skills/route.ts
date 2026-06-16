export type SkillsRoute =
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "team"; team: string }
  | { kind: "local" }
  | { kind: "archived" };

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
  return params && firstParam(params, "view") !== null ? "explicit" : "default";
}

export function parseSkillsRoute(input: SkillsSearchParams): SkillsRoute {
  const params = searchParamsFrom(input);
  if (!params) return { kind: "all" };

  const view = firstParam(params, "view");
  if (view === "mine") return { kind: "mine" };
  if (view === "local") return { kind: "local" };
  if (view === "archived") return { kind: "archived" };
  if (view === "team") {
    const team = firstParam(params, "team")?.trim();
    return team ? { kind: "team", team } : { kind: "all" };
  }
  return { kind: "all" };
}

export function skillsRouteHref(route: SkillsRoute): string {
  if (route.kind === "mine") return "/skills?view=mine";
  if (route.kind === "local") return "/skills?view=local";
  if (route.kind === "archived") return "/skills?view=archived";
  if (route.kind === "team") {
    return `/skills?view=team&team=${encodeURIComponent(route.team)}`;
  }
  return "/skills";
}

export function skillsRouteKey(route: SkillsRoute): string {
  return route.kind === "team" ? `team:${route.team}` : route.kind;
}
