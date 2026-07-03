"use client";

import { useMemo, useState } from "react";
import type { AgentsUpdateNotice } from "@companion/contracts";
import { Icon } from "../Icon";
import { LIB_NAMES } from "../libraryNames";
import type { AgentVM } from "@/lib/types";
import type { AgentsLibrary } from "./route";
import { agentCounts, filterAgents, statusDot, summaryLine, type AgentsSort } from "./derive";

const GRID = { gridTemplateColumns: "minmax(200px,1fr) 92px 110px 96px 158px 92px", minWidth: 840 } as const;

/** Short display tail of an OpenCode `provider/model` ref (the full id stays in the title). */
function modelTail(model: string): string {
  const i = model.indexOf("/");
  return i === -1 ? model : model.slice(i + 1);
}

/** The fleet list screen: header + update banner + search/sort bar + the agents table. */
export function AgentsListView({
  lib,
  label,
  agents,
  updates,
  onOpenAgent,
  onOpenCreate,
  onOpenUpdate,
}: {
  lib: AgentsLibrary;
  label: string | null;
  agents: AgentVM[];
  updates: AgentsUpdateNotice[];
  onOpenAgent: (slug: string) => void;
  onOpenCreate: () => void;
  onOpenUpdate: (skillSlug: string) => void;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<AgentsSort>("recent");

  const counts = useMemo(() => agentCounts(agents), [agents]);
  const scoped = useMemo(() => filterAgents(agents, { label }), [agents, label]);
  const rows = useMemo(() => filterAgents(agents, { label, query: q, sort }), [agents, label, q, sort]);
  const notice = updates[0] ?? null;

  return (
    <div data-screen-label="Agents list" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <header className="sh">
        <nav className="sh__crumb" aria-label="Library">
          <span className="sh__crumbseg">
            <span className="sh__crumbpar">{LIB_NAMES[lib]}</span>
          </span>
          {label && (
            <span className="sh__crumbseg">
              <Icon name="chevron-right" size={12} />
              <span className="sh__crumbpar">Agents</span>
            </span>
          )}
        </nav>
        <h2 className="sh__title">{label ?? "Agents"}</h2>
        <span className="sh__count tnum">{scoped.length}</span>
        <span className="sh__spacer" />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--color-faint)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {summaryLine(counts)}
        </span>
        <button type="button" className="btn-primary" onClick={onOpenCreate}>
          <Icon name="plus" size={14} />
          New agent
        </button>
      </header>

      {notice && !q && (
        <div className="ls-banner ls-banner--warn">
          <span className="ls-banner__ico">
            <Icon name="refresh-cw" size={15} />
          </span>
          <span className="ls-banner__text">
            <strong>
              {notice.slug} {notice.latest_version}
            </strong>{" "}
            released. {notice.affected_count} {notice.affected_count === 1 ? "agent is" : "agents are"} on older
            versions.
          </span>
          <button type="button" className="ls-banner__action" onClick={() => onOpenUpdate(notice.slug)}>
            Review &amp; push
          </button>
        </div>
      )}

      <div className="listbar">
        <span className="listbar__search">
          <Icon name="search" size={14} />
          <input
            className="listbar__input"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search agents"
            aria-label="Search agents in this view"
          />
        </span>
        <span className="listbar__spacer" />
        <label className="listbar__sort">
          <Icon name="chevrons-up-down" size={13} />
          <select
            className="listbar__sortsel"
            value={sort}
            onChange={(e) => setSort(e.target.value as AgentsSort)}
            aria-label="Sort agents"
          >
            <option value="recent">Last active</option>
            <option value="name">Name (A–Z)</option>
          </select>
        </label>
      </div>

      <div className="clist">
        {rows.length > 0 && (
          <>
            <div className="chead" style={GRID}>
              <span>Agent</span>
              <span>Status</span>
              <span>Client</span>
              <span>Model</span>
              <span>Skills</span>
              <span className="r">Last active</span>
            </div>
            {rows.map((agent) => (
              <div className="crow" style={GRID} key={agent.id}>
                <button
                  type="button"
                  className="crow__hit"
                  onClick={() => onOpenAgent(agent.id)}
                  aria-label={`Open agent ${agent.id}`}
                />
                <span className="crow__name">
                  <span className={statusDot(agent.status)} />
                  {agent.id}
                  <span className="crow__desc">{agent.description}</span>
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--color-muted)" }}>
                  {agent.status}
                </span>
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--color-muted)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {agent.client ?? "—"}
                </span>
                <span className="ver" title={agent.model}>
                  {modelTail(agent.model)}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    color: "var(--color-muted)",
                  }}
                >
                  {agent.skills.length} {agent.skills.length === 1 ? "skill" : "skills"}
                  {agent.outdatedCount > 0 && <span className="ag-outpill">{agent.outdatedCount} outdated</span>}
                </span>
                <span className="r when">{agent.lastActive}</span>
              </div>
            ))}
          </>
        )}
        {rows.length === 0 &&
          (agents.length === 0 && !label ? (
            // True first-run empty: the whole library has no agents (and no label scope).
            <div className="empty">
              <Icon name="bot" size={22} style={{ color: "var(--color-faint)" }} />
              <div className="empty__title">No agents yet</div>
              <div className="empty__desc">
                Provision your first one. Pick skills from the registry and Companion runs them in an isolated sandbox.
              </div>
              <button type="button" className="btn-primary" onClick={onOpenCreate}>
                <Icon name="plus" size={14} />
                New agent
              </button>
            </div>
          ) : (
            // A label and/or search is active but nothing matches — scope-consistent, never "first run".
            <div className="empty">
              <div className="empty__title">No agents match</div>
              <div className="empty__desc">
                {label
                  ? "No agents are filed under this label. Clear the filter to see the whole fleet."
                  : "Clear the search to see the whole fleet."}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
