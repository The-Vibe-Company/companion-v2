/**
 * The agents console route encodes which library slice is shown plus the open screen. Agents live in
 * the same two libraries as skills: `mine` ("My Companions" — personal agents) and `org` (flat
 * org-wide fleet). Screens: the fleet list (optionally filtered to a group label), the create form,
 * an agent detail (which renders the provisioning card while the agent is provisioning — same URL,
 * reload-safe), and the skill-update fan-out. The chat surface is a separate page
 * (`/w/<workspace>/agents/<slug>/chat`), not a query view.
 */
export type AgentsLibrary = "mine" | "org";

export type AgentsRoute =
  | { lib: AgentsLibrary; kind: "list"; label?: string }
  | { lib: AgentsLibrary; kind: "create" }
  | { lib: AgentsLibrary; kind: "detail"; agent: string }
  | { lib: AgentsLibrary; kind: "update"; skill: string };

export type AgentsSearchParams =
  | URLSearchParams
  | string
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

function firstParam(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function searchParamsFrom(
  input: AgentsSearchParams,
): URLSearchParams | Record<string, string | string[] | undefined> | null {
  const query = typeof input === "string" && input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
  return typeof query === "string"
    ? new URLSearchParams(query.startsWith("?") ? query.slice(1) : query)
    : (query ?? null);
}

export function parseAgentsRoute(input: AgentsSearchParams): AgentsRoute {
  const params = searchParamsFrom(input);
  if (!params) return { lib: "mine", kind: "list" };

  const lib: AgentsLibrary = firstParam(params, "lib") === "org" ? "org" : "mine";
  const view = firstParam(params, "view");
  const agent = firstParam(params, "agent")?.trim();

  if (agent) return { lib, kind: "detail", agent };
  if (view === "new") return { lib, kind: "create" };
  if (view === "update") {
    const skill = firstParam(params, "skill")?.trim();
    if (skill) return { lib, kind: "update", skill };
    return { lib, kind: "list" };
  }
  const label = firstParam(params, "label")?.trim();
  return label ? { lib, kind: "list", label } : { lib, kind: "list" };
}

export function agentsRouteHref(route: AgentsRoute): string {
  const params: string[] = [];
  if (route.lib === "org") params.push("lib=org");
  switch (route.kind) {
    case "list":
      if (route.label) params.push(`label=${encodeURIComponent(route.label)}`);
      break;
    case "create":
      params.push("view=new");
      break;
    case "detail":
      params.push(`agent=${encodeURIComponent(route.agent)}`);
      break;
    case "update":
      params.push("view=update", `skill=${encodeURIComponent(route.skill)}`);
      break;
  }
  return params.length ? `/agents?${params.join("&")}` : "/agents";
}

export function agentsRouteKey(route: AgentsRoute): string {
  switch (route.kind) {
    case "list":
      return route.label ? `${route.lib}:list:${route.label}` : `${route.lib}:list`;
    case "create":
      return `${route.lib}:create`;
    case "detail":
      return `${route.lib}:detail:${route.agent}`;
    case "update":
      return `${route.lib}:update:${route.skill}`;
  }
}

/** The full-viewport chat page for one agent (outside the console shell). */
export function agentChatHref(workspaceSlug: string, agentSlug: string): string {
  return `/w/${encodeURIComponent(workspaceSlug)}/agents/${encodeURIComponent(agentSlug)}/chat`;
}
