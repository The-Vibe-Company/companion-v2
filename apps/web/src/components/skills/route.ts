/**
 * The skills route encodes which library + slice is shown plus the open skill detail. There are two
 * libraries: `mine` (the private "My Skills" — authored personal skills + installed org skills) and
 * `org` (the flat org-wide library). Within a library, selection is by the starred/installed shortcuts
 * (mine only) or the folder tree (a `label` path). The `local` (Companion skills) and `archived` views
 * are library-independent and sit at the sidebar bottom. The default surface is `mine` / `all`.
 */
export type SkillsLibrary = "mine" | "org";

export type SkillsRoute =
  | { lib: "mine"; kind: "all"; skill?: string }
  | { lib: "mine"; kind: "starred"; skill?: string }
  | { lib: "mine"; kind: "installed"; skill?: string }
  | { lib: "mine"; kind: "label"; label: string; skill?: string }
  | { lib: "org"; kind: "all"; skill?: string }
  | { lib: "org"; kind: "label"; label: string; skill?: string }
  | { kind: "local" }
  | { kind: "archived"; skill?: string };

export type SkillsSearchParams =
  | URLSearchParams
  | string
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

export type SkillsRouteSource = "default" | "explicit";

/** The library a route belongs to (`local`/`archived` are library-independent → null). */
export function skillsRouteLib(route: SkillsRoute): SkillsLibrary | null {
  return "lib" in route ? route.lib : null;
}

export function skillShareHref(token: string): string {
  return `/s/${encodeURIComponent(token)}`;
}

export function parseSkillShareTokenPath(pathname: string): string | null {
  const match = pathname.match(/^\/s\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

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
  return params &&
    (firstParam(params, "lib") !== null ||
      firstParam(params, "view") !== null ||
      firstParam(params, "skill") !== null)
    ? "explicit"
    : "default";
}

export function parseSkillsRoute(input: SkillsSearchParams): SkillsRoute {
  const params = searchParamsFrom(input);
  if (!params) return { lib: "mine", kind: "all" };

  const lib = firstParam(params, "lib");
  const view = firstParam(params, "view");
  const skill = firstParam(params, "skill")?.trim() || undefined;

  // Library-independent bottom views. `local` keeps its legacy name (the UI label is "Companion skills").
  if (view === "local" || view === "companion") return { kind: "local" };
  if (view === "archived") return { kind: "archived", skill };

  if (lib === "org") {
    if (view === "label") {
      const label = firstParam(params, "label")?.trim();
      return label ? { lib: "org", kind: "label", label, skill } : { lib: "org", kind: "all", skill };
    }
    return { lib: "org", kind: "all", skill };
  }

  // Default library is `mine`.
  if (view === "starred") return { lib: "mine", kind: "starred", skill };
  if (view === "installed") return { lib: "mine", kind: "installed", skill };
  if (view === "label") {
    const label = firstParam(params, "label")?.trim();
    return label ? { lib: "mine", kind: "label", label, skill } : { lib: "mine", kind: "all", skill };
  }
  // Legacy `view=nolabel` had no replacement under the two-library model — land on My Skills.
  return { lib: "mine", kind: "all", skill };
}

export function skillsRouteHref(route: SkillsRoute): string {
  if (route.kind === "local") return "/skills?view=local";
  const params: string[] = [];
  if (route.kind === "archived") {
    params.push("view=archived");
  } else {
    if (route.lib === "org") params.push("lib=org");
    if (route.kind === "starred") params.push("view=starred");
    else if (route.kind === "installed") params.push("view=installed");
    else if (route.kind === "label") params.push("view=label", `label=${encodeURIComponent(route.label)}`);
    // kind === "all" emits no `view` (the default within a library).
  }
  if (route.skill) params.push(`skill=${encodeURIComponent(route.skill)}`);
  return params.length ? `/skills?${params.join("&")}` : "/skills";
}

export function skillsRouteKey(route: SkillsRoute): string {
  let base: string;
  if (route.kind === "local" || route.kind === "archived") base = route.kind;
  else if (route.kind === "label") base = `${route.lib}:label:${route.label}`;
  else base = `${route.lib}:${route.kind}`;
  return route.kind !== "local" && route.skill ? `${base}:skill:${route.skill}` : base;
}

export function skillsRouteWithoutSkill(route: SkillsRoute): SkillsRoute {
  switch (route.kind) {
    case "all":
      return { lib: route.lib, kind: "all" };
    case "starred":
      return { lib: "mine", kind: "starred" };
    case "installed":
      return { lib: "mine", kind: "installed" };
    case "label":
      return { lib: route.lib, kind: "label", label: route.label };
    case "archived":
      return { kind: "archived" };
    case "local":
      return { kind: "local" };
  }
}

export function skillsRouteWithSkill(route: SkillsRoute, skill: string): SkillsRoute {
  switch (route.kind) {
    case "all":
      return { lib: route.lib, kind: "all", skill };
    case "starred":
      return { lib: "mine", kind: "starred", skill };
    case "installed":
      return { lib: "mine", kind: "installed", skill };
    case "label":
      return { lib: route.lib, kind: "label", label: route.label, skill };
    case "archived":
      return { kind: "archived", skill };
    case "local":
      return { kind: "local" };
  }
}
