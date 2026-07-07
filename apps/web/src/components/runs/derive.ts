import type { ModelRow, ModelsResponse } from "@companion/contracts";

/** Pure derivations for the run launcher's model picker and chat surface. */

/* ---- Grouped-by-provider model picker ------------------------------------------------ */

export interface ModelProviderVM {
  id: string;
  name: string;
  /** Env var name(s) the provider's API key can be supplied under. */
  envKeys: string[];
  /** True when the current user (or the workspace) has a saved connection for this provider. */
  connected: boolean;
}

export interface ModelGroupVM {
  provider: ModelProviderVM;
  models: ModelRow[];
}

/** Map the models-response providers to the picker VM (defaults to disconnected when absent). */
export function toModelProviders(response: ModelsResponse): ModelProviderVM[] {
  return response.providers.map((p) => ({
    id: p.id,
    name: p.name,
    envKeys: p.env_keys,
    connected: p.connected,
  }));
}

/**
 * Group the model catalog by provider, sorted connected-first then alphabetical, and keep only
 * groups that still have at least one model. `connectedOverride` lets the launcher flip a provider
 * to connected locally (after a successful Connect) without re-fetching the whole catalog.
 */
export function groupModelsByProvider(
  models: ModelRow[],
  providers: ModelProviderVM[],
  connectedOverride?: ReadonlySet<string>,
): ModelGroupVM[] {
  const byProvider = new Map<string, ModelRow[]>();
  for (const model of models) {
    const list = byProvider.get(model.provider);
    if (list) list.push(model);
    else byProvider.set(model.provider, [model]);
  }
  // Providers named in the catalog but missing from the providers[] list still get a group
  // (env_keys unknown → cannot connect; the models are simply disabled).
  const known = new Map(providers.map((p) => [p.id, p]));
  const ids = new Set<string>([...providers.map((p) => p.id), ...byProvider.keys()]);
  const groups: ModelGroupVM[] = [];
  for (const id of ids) {
    const rows = byProvider.get(id) ?? [];
    if (rows.length === 0) continue;
    const base = known.get(id);
    const provider: ModelProviderVM = {
      id,
      name: base?.name ?? rows[0]?.provider_name ?? id,
      envKeys: base?.envKeys ?? [],
      connected: (connectedOverride?.has(id) ?? false) || (base?.connected ?? false),
    };
    groups.push({ provider, models: rows });
  }
  groups.sort((a, b) => {
    if (a.provider.connected !== b.provider.connected) return a.provider.connected ? -1 : 1;
    return a.provider.name.localeCompare(b.provider.name);
  });
  return groups;
}

/** Filter model groups by a search query, keeping a provider header whenever it has any match. */
export function filterModelGroups(groups: ModelGroupVM[], query: string): ModelGroupVM[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: ModelGroupVM[] = [];
  for (const group of groups) {
    const providerHit =
      group.provider.name.toLowerCase().includes(q) || group.provider.id.toLowerCase().includes(q);
    const models = providerHit
      ? group.models
      : group.models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q) ||
            m.provider_name.toLowerCase().includes(q),
        );
    if (models.length > 0) out.push({ provider: group.provider, models });
  }
  return out;
}

/** The first model of the first connected provider (the launcher's default selection), or null. */
export function firstConnectedModel(groups: ModelGroupVM[]): string | null {
  for (const group of groups) {
    if (group.provider.connected && group.models[0]) return group.models[0].id;
  }
  return null;
}

/** True when the given model id belongs to a provider the user has connected. */
export function modelProviderConnected(groups: ModelGroupVM[], modelId: string): boolean {
  for (const group of groups) {
    if (group.models.some((m) => m.id === modelId)) return group.provider.connected;
  }
  return false;
}

/* ---- Chat: per-tool icon ----------------------------------------------------------- */

/**
 * Map an OpenCode tool name to a Lucide icon name (see {@link Icon}) so a chat tool row reads at a
 * glance — a shell run, a file read, a web fetch. Unknown tools fall back to a generic code glyph.
 */
export function toolIcon(tool: string): string {
  switch (tool.toLowerCase()) {
    case "bash":
    case "shell":
      return "terminal";
    case "read":
    case "cat":
      return "file-text";
    case "write":
      return "file-pen-line";
    case "edit":
    case "patch":
      return "square-pen";
    case "grep":
    case "glob":
    case "search":
      return "search";
    case "webfetch":
    case "fetch":
      return "globe";
    case "list":
    case "ls":
      return "folder";
    case "task":
    case "agent":
      return "bot";
    case "todowrite":
    case "todoread":
      return "check";
    default:
      return "code";
  }
}
