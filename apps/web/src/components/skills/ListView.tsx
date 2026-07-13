"use client";

import { useMemo, useState, type PointerEvent } from "react";
import { Icon } from "../Icon";
import { UserAvatar } from "../UserAvatar";
import type { SkillContributorVM, SkillVM } from "@/lib/types";
import { InstallMark } from "./blocks";
import { chipParts, type Filter } from "./filters";
import { FilterAdd } from "./FilterMenu";
import {
  resolveSkillActions,
  skillActionPermissions,
  type SkillAction,
} from "./skillActions";

type SortKey = "default" | "name" | "stars";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  // "default" preserves the server order (most recently updated first).
  { key: "default", label: "Recently updated" },
  { key: "name", label: "Name (A–Z)" },
  { key: "stars", label: "Most starred" },
];

type Person = SkillContributorVM & { role: "creator" | "modifier" };

function peopleFor(skill: SkillVM): Person[] {
  const people: Person[] = [
    {
      id: skill.authorId,
      name: skill.authorName,
      initials: skill.authorInitials,
      avatarUrl: skill.authorAvatarUrl,
      role: "creator",
    },
  ];
  const seen = new Set([skill.authorId]);
  for (const modifier of skill.modifiers) {
    if (seen.has(modifier.id)) continue;
    seen.add(modifier.id);
    people.push({ ...modifier, role: "modifier" });
  }
  return people;
}

function formatNames(names: string[]): string {
  return names.join(", ");
}

function peopleLabel(skill: SkillVM): string {
  const modifierNames = peopleFor(skill)
    .filter((person) => person.role === "modifier")
    .map((person) => person.name);
  if (modifierNames.length === 0) return `Created by ${skill.authorName}.`;
  return `Created by ${skill.authorName}. Updated by ${formatNames(modifierNames)}.`;
}

function PeopleStack({ skill }: { skill: SkillVM }) {
  const people = peopleFor(skill);
  const visible = people.slice(0, 4);
  const hidden = people.length - visible.length;
  const label = peopleLabel(skill);
  return (
    <span className="people" aria-label={label} title={label}>
      {visible.map((person) => (
        <UserAvatar
          key={person.id}
          className={"avatar people__avatar people__avatar--" + person.role}
          avatarUrl={person.avatarUrl}
          initials={person.initials}
          size={22}
        />
      ))}
      {hidden > 0 && <span className="people__more">+{hidden}</span>}
    </span>
  );
}

function ValidationMarker({ skill }: { skill: SkillVM }) {
  if (skill.validation === "valid") return null;
  if (skill.validation === "invalid") {
    return (
      <span className="invalid-pill">
        <Icon name="alert-triangle" size={10} />
        invalid
      </span>
    );
  }
  return (
    <span className="invalid-pill invalid-pill--pending">
      <Icon name="loader" size={10} />
      validating
    </span>
  );
}

function depsLabel(skill: SkillVM): string {
  if (skill.requiresCount > 0) return `${skill.requiresCount} req`;
  if (skill.usedByCount > 0) return `${skill.usedByCount} used`;
  return "no deps";
}

export function ListView({
  skills,
  library,
  scopeKind,
  breadcrumb,
  onOpen,
  onToggleStar,
  onUpload,
  actorId,
  onPrimaryAction,
  lastId,
  filters,
  onToggleFilter,
  onRemoveFilter,
  onClearFilters,
  preferenceStatus,
  onRetryPreferences,
  dragSkillId,
  onSkillStartDrag,
  upgradeNotice = null,
  onUpgrade = () => {},
}: {
  skills: SkillVM[];
  /** Which library this list shows (drives scope-aware empty + upload copy). */
  library: "mine" | "org";
  scopeKind: "all" | "starred" | "installed" | "label";
  /** Folder breadcrumb for the active sidebar selection (e.g. ["marketing", "seo"]). */
  breadcrumb: string[];
  onOpen: (id: string) => void;
  onToggleStar: (id: string) => void;
  onUpload: () => void;
  actorId: string;
  onPrimaryAction: (skill: SkillVM, action: SkillAction) => void;
  lastId: string | null;
  filters: Filter[];
  onToggleFilter: (type: Filter["type"], value: string) => void;
  onRemoveFilter: (f: Filter) => void;
  onClearFilters: () => void;
  preferenceStatus: "idle" | "saving" | "saved" | "error";
  onRetryPreferences: () => void;
  dragSkillId: string | null;
  /** Begin a pointer drag from a skill row (the hook gates it behind a small move threshold,
   *  so a plain click still opens the skill). */
  onSkillStartDrag: (id: string, e: PointerEvent<HTMLElement>) => void;
  upgradeNotice?: string | null;
  onUpgrade?: () => void;
}) {
  // Search + sort are local list-view affordances (label/status filtering lives in the sidebar / chips).
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("default");

  const title = breadcrumb[breadcrumb.length - 1] ?? "All skills";

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? skills.filter(
          (s) => s.id.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle),
        )
      : skills;
    if (sort === "default") return matched;
    const out = [...matched];
    if (sort === "name") out.sort((a, b) => a.id.localeCompare(b.id));
    else if (sort === "stars") out.sort((a, b) => b.stars - a.stars || a.id.localeCompare(b.id));
    return out;
  }, [skills, q, sort]);

  return (
    <>
      <header className="sh">
        <nav className="sh__crumb" aria-label="Folder">
          {/* Ancestors only — the leaf segment is the <h2> title, so don't repeat it here. */}
          {breadcrumb.slice(0, -1).map((seg, i) => (
            <span className="sh__crumbseg" key={i}>
              {i > 0 && <Icon name="chevron-right" size={12} />}
              <span className="sh__crumbpar">{seg}</span>
            </span>
          ))}
        </nav>
        <h2 className="sh__title">{title}</h2>
        <span className="sh__count tnum">{skills.length}</span>
        <span className="sh__spacer" />
        <button className="btn-primary" onClick={onUpload}>
          <Icon name="plus" size={14} />
          Add skill
        </button>
      </header>

      {upgradeNotice && (
        <div className="entitlement-bar" role="status">
          <Icon name="lock" size={14} />
          <span>{upgradeNotice}</span>
          <button className="btn-sec" onClick={onUpgrade}>View plans</button>
        </div>
      )}

      <div className="listbar">
        <span className="listbar__search">
          <Icon name="search" size={14} />
          <input
            className="listbar__input"
            type="search"
            placeholder="Search skills"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search skills in this view"
          />
        </span>
        <span className="listbar__spacer" />
        <label className="listbar__sort">
          <Icon name="chevrons-up-down" size={13} />
          <select
            className="listbar__sortsel"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort skills"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="filterbar">
        <FilterAdd filters={filters} onToggle={onToggleFilter} />
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

      <div className="clist clist--deps">
        <div className="chead">
          <span>Skill</span>
          <span>People</span>
          <span>Version</span>
          <span>Deps</span>
          <span className="r">Stars</span>
          <span className="r">Updated</span>
          <span className="r">Action</span>
        </div>
        {shown.map((s) => {
          const canDrag = !(library === "mine" && s.source === "installed");
          const dragging = canDrag && dragSkillId === s.id;
          const primary = resolveSkillActions(s, skillActionPermissions(s, actorId)).primary;
          return (
            <div
              key={s.id}
              className={"crow" + (lastId === s.id ? " is-active" : "") + (dragging ? " crow--dragging" : "")}
              title={peopleLabel(s)}
              onPointerDown={
                canDrag
                  ? (e) => {
                      if (e.button !== 0) return;
                      onSkillStartDrag(s.id, e);
                    }
                  : undefined
              }
            >
              <button
                type="button"
                className="crow__hit"
                aria-label={`Open skill ${s.id}`}
                onClick={() => onOpen(s.id)}
              />
              <span className="crow__name">
                {s.id}
                <ValidationMarker skill={s} />
                {s.description ? <span className="crow__desc">{s.description}</span> : null}
                <InstallMark state={s.installStatus} />
              </span>
              <PeopleStack skill={s} />
              <span className="ver">{s.version ?? "—"}</span>
              <span className="crow__deps">
                {s.requiresCount > 0 ? (
                  <span
                    className={"depspill" + (s.depWarn ? " depspill--warn" : "")}
                    title={`${s.requiresCount} dependency${s.requiresCount === 1 ? "" : "ies"}`}
                  >
                    <Icon name="package" size={11} />
                    {s.requiresCount}
                  </span>
                ) : s.usedByCount > 0 ? (
                  <span className="depspill depspill--used" title={`Used by ${s.usedByCount}`}>
                    <Icon name="corner-down-right" size={11} />
                    {s.usedByCount}
                  </span>
                ) : (
                  <span style={{ color: "var(--color-faint)" }}>—</span>
                )}
              </span>
              <span className="crow__stars r">
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
              <span className="r when when--by" title={`Updated by ${s.updaterName} · ${s.updated}`}>
                <UserAvatar
                  className="avatar"
                  avatarUrl={s.updaterAvatarUrl}
                  initials={s.updaterInitials}
                  size={14}
                  style={{ fontSize: 7 }}
                />
                {s.updated}
              </span>
              <span className="crow__primary r">
                {primary ? (
                  <button
                    type="button"
                    className="rowact rowact--primary"
                    aria-label={`${primary.label} ${s.id}`}
                    title={primary.label}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onPrimaryAction(s, primary)}
                  >
                    <Icon name={primary.icon} size={12} />
                    <span className="rowact__label">{primary.compactLabel ?? primary.label}</span>
                  </button>
                ) : null}
              </span>
              <span className="crow__mobilemeta">
                <span>v{s.version ?? "—"}</span>
                <span>{depsLabel(s)}</span>
                <span>{s.updated}</span>
                <span className="crow__mobile-install">
                  <InstallMark state={s.installStatus} />
                </span>
              </span>
            </div>
          );
        })}
        {!shown.length && (
          <div className="empty">
            <Icon name="search-x" size={22} style={{ color: "var(--color-faint)" }} />
            <div className="empty__title">{q.trim() ? "No skills match" : "Nothing here yet"}</div>
            <div className="empty__desc">
              {q.trim()
                ? "No skills match your search. Clear the search or filters to see this view in full."
                : scopeKind === "installed"
                  ? "You have not installed any organization skills yet. Open one in Organization to install it."
                  : scopeKind === "starred"
                    ? "No starred skills yet. Star a skill to keep it here."
                    : library === "mine"
                      ? "No skills in My Skills yet. Add a skill, or install one from the organization library."
                      : "No organization skills match this view. Clear the filters to see them all."}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
