import type { AgentModelRow, AgentModelsResponse, AgentsUpdateNotice, AgentStatus } from "@companion/contracts";
import { RESERVED_AGENT_SECRET_KEYS } from "@companion/contracts";
import type { AgentVM, SkillVM } from "@/lib/types";

/** Pure derivations shared by the agents console views and the sidebar. */

export interface AgentCounts {
  total: number;
  running: number;
  sleeping: number;
  provisioning: number;
  error: number;
  outdated: number;
}

export function agentCounts(agents: AgentVM[]): AgentCounts {
  return {
    total: agents.length,
    running: agents.filter((a) => a.status === "running").length,
    sleeping: agents.filter((a) => a.status === "sleeping").length,
    provisioning: agents.filter((a) => a.status === "provisioning").length,
    error: agents.filter((a) => a.status === "error").length,
    outdated: agents.filter((a) => a.outdatedCount > 0).length,
  };
}

export function summaryLine(counts: AgentCounts): string {
  return `Running ${counts.running} · Sleeping ${counts.sleeping} · Outdated ${counts.outdated} · Errors ${counts.error}`;
}

/** Status dot class; the UI always pairs it with the status word (never color alone). */
export function statusDot(status: AgentStatus): string {
  const map: Record<AgentStatus, string> = {
    running: "vdot--ok",
    sleeping: "vdot--unknown",
    provisioning: "vdot--warn",
    error: "vdot--down",
  };
  return `vdot ${map[status]}`;
}

export function statusBadge(status: AgentStatus): string {
  const map: Record<AgentStatus, string> = {
    running: "ls-badge--ok",
    sleeping: "ls-badge--neutral",
    provisioning: "ls-badge--warn",
    error: "vbadge--down",
  };
  return map[status];
}

/** Kebab a raw agent name for the slug / chat-URL preview. */
export function kebabName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function outdatedSkills(agent: AgentVM): AgentVM["skills"] {
  return agent.skills.filter((s) => s.outdated);
}

/* ---- Create form: required secrets from the selected skills --------------------- */

export interface SecretRequirementRow {
  key: string;
  /** Skill slugs that require it, in selection order. */
  by: string[];
  required: boolean;
}

/**
 * Union of the secret/env requirements declared by the selected registry skills, deduped by key.
 * Registry rows are SkillVMs — `requirements` comes from the skill's manifest.
 */
export function deriveSecretRows(selectedSlugs: string[], registry: SkillVM[]): SecretRequirementRow[] {
  const bySlug = new Map(registry.map((s) => [s.id, s]));
  const rows = new Map<string, SecretRequirementRow>();
  for (const slug of selectedSlugs) {
    const skill = bySlug.get(slug);
    for (const req of skill?.requirements ?? []) {
      const existing = rows.get(req.key);
      if (existing) {
        if (!existing.by.includes(slug)) existing.by.push(slug);
        existing.required = existing.required || req.required !== false;
      } else {
        rows.set(req.key, { key: req.key, by: [slug], required: req.required !== false });
      }
    }
  }
  return [...rows.values()];
}

/* ---- Sidebar: per-library Agents root + group labels ----------------------------- */

export interface AgentLabelRow {
  name: string;
  count: number;
  icon: string;
  color: string;
}

export interface AgentsNavSide {
  count: number;
  updateDot: boolean;
  labels: AgentLabelRow[];
}

export interface AgentsNavData {
  mine: AgentsNavSide;
  org: AgentsNavSide;
}

/**
 * Deterministic label cosmetics: a fixed palette (the design's label colors), picked by name hash so
 * the same label always renders the same color/icon without any persisted config.
 */
const LABEL_PALETTE: ReadonlyArray<{ icon: string; color: string }> = [
  { icon: "sparkles", color: "#0969da" },
  { icon: "key", color: "#8957e5" },
  { icon: "users", color: "#1a7f37" },
  { icon: "megaphone", color: "#b76100" },
  { icon: "code", color: "#2da44e" },
  { icon: "rocket", color: "#cf222e" },
];

export function groupLabelMeta(name: string): { icon: string; color: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const entry = LABEL_PALETTE[Math.abs(hash) % LABEL_PALETTE.length];
  return entry ?? { icon: "tag", color: "var(--color-faint)" };
}

function navSide(agents: AgentVM[]): AgentsNavSide {
  const byLabel = new Map<string, number>();
  for (const agent of agents) {
    if (agent.groupLabel) byLabel.set(agent.groupLabel, (byLabel.get(agent.groupLabel) ?? 0) + 1);
  }
  const labels = [...byLabel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count, ...groupLabelMeta(name) }));
  return {
    count: agents.length,
    updateDot: agents.some((a) => a.outdatedCount > 0),
    labels,
  };
}

export function deriveAgentNav(mine: AgentVM[], org: AgentVM[]): AgentsNavData {
  return { mine: navSide(mine), org: navSide(org) };
}

/* ---- List filtering ---------------------------------------------------------------- */

export type AgentsSort = "recent" | "name";

export function filterAgents(
  agents: AgentVM[],
  input: { label?: string | null; query?: string; sort?: AgentsSort },
): AgentVM[] {
  const q = (input.query ?? "").trim().toLowerCase();
  let rows = agents.filter((a) => {
    if (input.label && a.groupLabel !== input.label) return false;
    if (q && !a.id.toLowerCase().includes(q) && !(a.client ?? "").toLowerCase().includes(q)) return false;
    return true;
  });
  if (input.sort === "name") {
    rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  }
  return rows;
}

/* ---- Create form: grouped-by-provider model picker ------------------------------- */

export interface ModelProviderVM {
  id: string;
  name: string;
  /** Env var name(s) the provider's API key can be supplied under. */
  envKeys: string[];
  /** True when the current user has a saved connection (API key) for this provider. */
  connected: boolean;
}

export interface ModelGroupVM {
  provider: ModelProviderVM;
  models: AgentModelRow[];
}

/** Map the models-response providers to the picker VM (defaults to disconnected when absent). */
export function toModelProviders(response: AgentModelsResponse): ModelProviderVM[] {
  return response.providers.map((p) => ({
    id: p.id,
    name: p.name,
    envKeys: p.env_keys,
    connected: p.connected,
  }));
}

/**
 * Group the model catalog by provider, sorted connected-first then alphabetical, and keep only
 * groups that still have at least one model. `connectedOverride` lets the CreateView flip a provider
 * to connected locally (after a successful Connect) without re-fetching the whole catalog.
 */
export function groupModelsByProvider(
  models: AgentModelRow[],
  providers: ModelProviderVM[],
  connectedOverride?: ReadonlySet<string>,
): ModelGroupVM[] {
  const byProvider = new Map<string, AgentModelRow[]>();
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

/** The first model of the first connected provider (the create form's default selection), or null. */
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

/* ---- Detail form: agent variable name validation ---------------------------------- */

const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a user-entered agent variable name; returns an inline error string or null when valid. */
export function validateSecretKey(raw: string, existingKeys: readonly string[] = []): string | null {
  const key = raw.trim();
  if (!key) return "Enter a variable name.";
  if (!ENV_VAR_RE.test(key)) return "Use letters, digits and underscores (e.g. API_TOKEN).";
  if (RESERVED_AGENT_SECRET_KEYS.includes(key)) return "This name is reserved by the runtime.";
  if (existingKeys.includes(key)) return "This variable already exists.";
  return null;
}

/* ---- List: live update notices recomputed from the current agent rows ------------- */

/**
 * Recompute the "a newer skill version affects N agents" notices from the LIVE agent rows, so a push
 * that lands a fresh version updates (or clears) the banner without a server round-trip. One notice
 * per outdated skill slug, ordered by affected-count desc then slug.
 */
export function deriveUpdateNotices(agents: AgentVM[]): AgentsUpdateNotice[] {
  const bySlug = new Map<string, { skillId: string; latest: string; count: number }>();
  for (const agent of agents) {
    for (const skill of agent.skills) {
      if (!skill.outdated || !skill.latest) continue;
      const existing = bySlug.get(skill.id);
      if (existing) {
        existing.count += 1;
        // Track the highest latest version seen (string compare is enough for the banner label).
        if (skill.latest > existing.latest) existing.latest = skill.latest;
      } else {
        bySlug.set(skill.id, { skillId: skill.skillId, latest: skill.latest, count: 1 });
      }
    }
  }
  return [...bySlug.entries()]
    .map(([slug, v]) => ({
      skill_id: v.skillId,
      slug,
      latest_version: v.latest,
      affected_count: v.count,
      released_at: null,
    }))
    .sort((a, b) => b.affected_count - a.affected_count || a.slug.localeCompare(b.slug));
}
