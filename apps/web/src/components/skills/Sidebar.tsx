"use client";

import { useState } from "react";
import { Icon } from "../Icon";
import { OrgSwitcher } from "../org/OrgSwitcher";
import { orgRole } from "../org/roles";
import type { SettingsIntent } from "../org/model";
import type { OrgVM, TeamVM } from "@/lib/types";

export function Sidebar({
  orgs,
  currentOrg,
  onSwitchOrg,
  onOnboard,
  onOpenSettings,
  onWarmSettings,
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
  orgs: OrgVM[];
  currentOrg: OrgVM;
  onSwitchOrg: (id: string) => void;
  onOnboard: (mode: "create" | "join") => void;
  onOpenSettings: (intent?: SettingsIntent) => void;
  onWarmSettings: () => void;
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
  const warmSettings = () => onWarmSettings();

  return (
    <aside className="side">
      <div className="side__brand">
        <OrgSwitcher orgs={orgs} current={currentOrg} onSwitch={onSwitchOrg} onOnboard={onOnboard} />
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
            <button
              className="side__addteam"
              title="New team"
              aria-label="New team"
              onFocus={warmSettings}
              onMouseDown={warmSettings}
              onClick={() => onOpenSettings({ tab: "teams", dialog: "team" })}
              onPointerEnter={warmSettings}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
        )}
        {teams.map((tm) => {
          const open = expanded.has(tm.id);
          return (
            <div className="teamblock" key={tm.id}>
              <div className="teamitem">
                <button className="teamitem__main" onClick={() => toggle(tm.id)} aria-expanded={open}>
                  <span className={"teamitem__chev" + (open ? " is-open" : "")}>
                    <Icon name="chevron-right" size={13} />
                  </span>
                  <span className="teamavatar">{tm.initial}</span>
                  <span className="teamitem__name">{tm.name}</span>
                </button>
                <button
                  className="teamitem__gear"
                  title={tm.name + " settings"}
                  aria-label={tm.name + " settings"}
                  onFocus={warmSettings}
                  onMouseDown={warmSettings}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSettings({ tab: "teams" });
                  }}
                  onPointerEnter={warmSettings}
                >
                  <Icon name="settings" size={14} />
                </button>
              </div>
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
      <button
        className="side__foot side__foot--btn"
        onFocus={warmSettings}
        onMouseDown={warmSettings}
        onClick={() => onOpenSettings()}
        onPointerEnter={warmSettings}
      >
        <Icon name="settings" size={14} /> Settings
        <span className="side__foot__role">{orgRole(currentOrg.myRole).label.toLowerCase()}</span>
      </button>
    </aside>
  );
}
