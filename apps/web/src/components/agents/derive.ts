import type { AgentStatus } from "@companion/contracts";
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
