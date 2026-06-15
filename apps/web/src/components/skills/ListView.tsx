"use client";

import { Icon } from "../Icon";
import { TeamAvatar } from "../org/TeamAvatar";
import type { SkillVM, TeamVM } from "@/lib/types";
import { visibilityMeta, vdot } from "./blocks";
import { chipParts, type Filter, type ViewDef } from "./filters";
import { FilterAdd } from "./FilterMenu";
import { ViewTab } from "./ViewTab";

function VisibilityCell({ skill }: { skill: SkillVM }) {
  const meta = visibilityMeta(skill);
  const teams = skill.visibility.teams;
  const shownTeams = teams.slice(0, 3);
  const extraTeams = teams.length - shownTeams.length;
  const teamNames = teams.map((team) => team.name).join(", ");
  const label =
    teams.length > 0
      ? skill.visibility.everyone
        ? `Everyone; teams: ${teamNames}`
        : `Teams: ${teamNames}`
      : meta.label;
  return (
    <span className="crow__scope" title={label} aria-label={label}>
      <Icon name={meta.icon} size={11} />
      {teams.length > 0 ? (
        <>
          {skill.visibility.everyone && <span className="crow__scopeText crow__scopeText--base">Everyone</span>}
          <span className="crow__teampile" aria-hidden="true">
            {shownTeams.map((team) => (
              <TeamAvatar className="crow__teamdot" key={team.slug} team={team} />
            ))}
            {extraTeams > 0 && <span className="crow__teamdot crow__teamdot--more">+{extraTeams}</span>}
          </span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        <span className="crow__scopeText">{meta.label}</span>
      )}
    </span>
  );
}

export function ListView({
  skills,
  onOpen,
  onToggleStar,
  onUpload,
  lastId,
  views,
  activeViewId,
  onSelectView,
  onRenameView,
  onDeleteView,
  filters,
  onToggleFilter,
  onRemoveFilter,
  canSaveView,
  onSaveView,
  onClearFilters,
  preferenceStatus,
  onRetryPreferences,
  owners,
  teams,
  viewCounts,
}: {
  skills: SkillVM[];
  onOpen: (id: string) => void;
  onToggleStar: (id: string) => void;
  onUpload: () => void;
  lastId: string | null;
  views: ViewDef[];
  activeViewId: string | null;
  onSelectView: (id: string) => void;
  onRenameView: (id: string, name: string) => void;
  onDeleteView: (id: string) => void;
  filters: Filter[];
  onToggleFilter: (type: Filter["type"], value: string) => void;
  onRemoveFilter: (f: Filter) => void;
  canSaveView: boolean;
  onSaveView: () => void;
  onClearFilters: () => void;
  preferenceStatus: "idle" | "saving" | "saved" | "error";
  onRetryPreferences: () => void;
  owners: string[];
  teams: TeamVM[];
  viewCounts: Record<string, number>;
}) {
  return (
    <>
      <header className="sh">
        <h2 className="sh__title">Skills</h2>
        <span className="sh__count tnum">{skills.length}</span>
        <span className="sh__spacer" />
        <button className="btn-primary" onClick={onUpload}>
          <Icon name="upload" size={14} />
          Upload skill
        </button>
      </header>

      <div className="viewbar" role="tablist" aria-label="Views">
        {views.map((v) => (
          <ViewTab
            key={v.id}
            view={v}
            active={activeViewId === v.id}
            count={viewCounts[v.id] ?? 0}
            onSelect={onSelectView}
            onRename={onRenameView}
            onDelete={onDeleteView}
          />
        ))}
      </div>

      <div className="filterbar">
        <FilterAdd owners={owners} teams={teams} filters={filters} onToggle={onToggleFilter} />
        {filters.map((f) => {
          const p = chipParts(f);
          return (
            <span className="fchip" key={f.type + f.value}>
              <span className="lead">
                <Icon name={p.icon} size={12} />
              </span>
              {p.key && <span className="fchip__key">{p.key}:</span>}
              <span className="fchip__val">{p.val}</span>
              <button className="fchip__x" onClick={() => onRemoveFilter(f)} aria-label="Remove filter">
                <Icon name="x" size={12} />
              </button>
            </span>
          );
        })}
        {filters.length > 0 && (
          <button className="clearfilters" onClick={onClearFilters}>
            Clear
          </button>
        )}
        <span className="filterbar__spacer" />
        {canSaveView && (
          <button className="saveview" onClick={onSaveView}>
            <Icon name="bookmark-plus" size={13} />
            Save view
          </button>
        )}
        {preferenceStatus !== "idle" && (
          <span className={"prefstatus prefstatus--" + preferenceStatus} role="status" aria-live="polite">
            {preferenceStatus === "saving" && "Saving"}
            {preferenceStatus === "saved" && "Saved"}
            {preferenceStatus === "error" && (
              <>
                Not saved
                <button className="prefstatus__retry" onClick={onRetryPreferences}>
                  Retry
                </button>
              </>
            )}
          </span>
        )}
      </div>

      <div className="clist">
        <div className="chead">
          <span></span>
          <span>Skill</span>
          <span>Visibility</span>
          <span>Version</span>
          <span className="r">Stars</span>
          <span className="r">Updated</span>
        </div>
        {skills.map((s) => (
          <div key={s.id} className={"crow" + (lastId === s.id ? " is-active" : "")}>
            <button
              type="button"
              className="crow__hit"
              aria-label={`Open skill ${s.id}`}
              onClick={() => onOpen(s.id)}
            />
            <span className={"vdot vdot--" + vdot(s.validation)} />
            <span className="crow__name">
              {s.id}
              {s.validation === "invalid" && (
                <span className="invalid-pill">
                  <Icon name="alert-triangle" size={10} />
                  invalid
                </span>
              )}
            </span>
            <VisibilityCell skill={s} />
            <span className="ver">{s.version ?? "—"}</span>
            <span className="r">
              <button
                type="button"
                className={"stars" + (s.starred ? " is-on" : "")}
                title={s.starred ? "Unstar this skill" : "Star this skill"}
                aria-pressed={s.starred}
                aria-label={(s.starred ? "Unstar" : "Star") + " " + s.id}
                onClick={() => onToggleStar(s.id)}
              >
                <Icon name="star" size={13} />
                <span className="tnum">{s.stars}</span>
              </button>
            </span>
            <span className="r when">{s.updated}</span>
          </div>
        ))}
        {!skills.length && (
          <div className="empty">
            <Icon name="search-x" size={22} style={{ color: "var(--color-faint)" }} />
            <div className="empty__title">No skills match</div>
            <div className="empty__desc">
              No skills match this view. Clear the filters to see the full registry.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
