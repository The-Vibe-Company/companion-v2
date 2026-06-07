"use client";

import { useState } from "react";
import { Icon } from "../Icon";
import type { MeVM, TeamVM } from "@/lib/types";

export function Sidebar({
  workspace,
  me,
  teams,
  totalCount,
  myCount,
  teamCounts,
  activeTeam,
  isMine,
  workspaceActive,
  onOpenPalette,
  onSelectMine,
  onSelectAll,
  onSelectTeam,
}: {
  workspace: string;
  me: MeVM;
  teams: TeamVM[];
  totalCount: number;
  myCount: number;
  teamCounts: Record<string, number>;
  activeTeam: string | null;
  isMine: boolean;
  workspaceActive: boolean;
  onOpenPalette: () => void;
  onSelectMine: () => void;
  onSelectAll: () => void;
  onSelectTeam: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(teams[0] ? [teams[0].id] : []));
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <aside className="side">
      <div className="side__brand">
        <span className="brandmark">C</span>
        <div style={{ minWidth: 0 }}>
          <div className="brandname">Companion</div>
          <div className="brandsub">{workspace}</div>
        </div>
        <button className="side__search" onClick={onOpenPalette} title="Search (⌘K)" aria-label="Search">
          <Icon name="search" size={14} />
          <span className="kbd">⌘K</span>
        </button>
      </div>
      <nav className="side__nav" aria-label="Primary">
        <button
          className={"navitem" + (isMine ? " navitem--active" : "")}
          aria-current={isMine ? "page" : undefined}
          onClick={onSelectMine}
        >
          <span className="navitem__ico">
            <Icon name="user" />
          </span>
          My skills
          <span className="navitem__count tnum">{myCount}</span>
        </button>

        <div className="side__grouplabel">Workspace</div>
        <button
          className={"navitem" + (workspaceActive ? " navitem--active" : "")}
          aria-current={workspaceActive ? "page" : undefined}
          onClick={onSelectAll}
        >
          <span className="navitem__ico">
            <Icon name="package" />
          </span>
          Skills
          <span className="navitem__count">{totalCount}</span>
        </button>
        <button className="navitem navitem--muted" disabled tabIndex={-1}>
          <span className="navitem__ico">
            <Icon name="square-stack" />
          </span>
          Agents
          <span className="navitem__soon">soon</span>
        </button>

        {teams.length > 0 && (
          <div className="side__grouplabel side__grouplabel--row">
            Your teams<span className="n">{teams.length}</span>
          </div>
        )}
        {teams.map((tm) => {
          const open = expanded.has(tm.id);
          return (
            <div className="teamblock" key={tm.id}>
              <button className="teamitem" onClick={() => toggle(tm.id)} aria-expanded={open}>
                <span className={"teamitem__chev" + (open ? " is-open" : "")}>
                  <Icon name="chevron-right" size={13} />
                </span>
                <span className="teamavatar">{tm.initial}</span>
                <span className="teamitem__name">{tm.name}</span>
              </button>
              {open && (
                <div className="teamsub">
                  <button
                    className={"navitem navitem--sub" + (activeTeam === tm.id ? " navitem--active" : "")}
                    aria-current={activeTeam === tm.id ? "page" : undefined}
                    onClick={() => onSelectTeam(tm.id)}
                  >
                    <span className="navitem__ico">
                      <Icon name="package" size={15} />
                    </span>
                    Skills
                    <span className="navitem__count">{teamCounts[tm.id] || 0}</span>
                  </button>
                  <button className="navitem navitem--sub navitem--muted" disabled tabIndex={-1}>
                    <span className="navitem__ico">
                      <Icon name="square-stack" size={15} />
                    </span>
                    Agents
                    <span className="navitem__soon">soon</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="side__foot">
        <Icon name="user" size={13} /> {me.name} · {teams.length} {teams.length === 1 ? "team" : "teams"}
      </div>
    </aside>
  );
}
