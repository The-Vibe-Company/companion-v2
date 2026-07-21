"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { LabelVM, SkillGroupBy } from "@companion/contracts";
import { Icon } from "../Icon";
import { UserAvatar } from "../UserAvatar";
import type { SkillContributorVM, SkillVM } from "@/lib/types";
import { InstallMark } from "./blocks";
import { chipParts, type Filter } from "./filters";
import { FilterAdd } from "./FilterMenu";
import {
  groupSkillsByRoot,
  pathsInLabelScope,
  resolveSkillListIcon,
  type GroupedSkillRow,
  type SkillListPath,
} from "./listGrouping";
import { resolveSkillActions, skillActionPermissions, type SkillAction } from "./skillActions";

type SortKey = "default" | "name";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "default", label: "Recently updated" },
  { key: "name", label: "Slug (A–Z)" },
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

function peopleLabel(skill: SkillVM): string {
  const modifierNames = peopleFor(skill)
    .filter((person) => person.role === "modifier")
    .map((person) => person.name);
  if (modifierNames.length === 0) return `Created by ${skill.authorName}.`;
  return `Created by ${skill.authorName}. Updated by ${modifierNames.join(", ")}.`;
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
          className={`avatar people__avatar people__avatar--${person.role}`}
          avatarUrl={person.avatarUrl}
          initials={person.initials}
          size={22}
        />
      ))}
      {hidden > 0 ? <span className="people__more">+{hidden}</span> : null}
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

function PathOverflow({ paths, kind }: { paths: SkillListPath[]; kind: "folder" | "subfolder" }) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  const plural = kind === "folder" ? "folders" : "subfolders";
  const canonicalPaths = paths.map(({ path }) => path);
  const tooltipText = paths.map(({ label, path }) => (label === path ? path : `${label} (${path})`)).join(", ");
  const label = `${paths.length} more ${paths.length === 1 ? kind : plural}: ${canonicalPaths.join(", ")}`;

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const showTooltip = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 100);
  }, [cancelClose]);
  const positionTooltip = useCallback(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;
    const anchor = trigger.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const padding = 12;
    const gap = 6;
    let left = anchor.right + gap;
    if (left + box.width > window.innerWidth - padding) left = anchor.left - box.width - gap;
    left = Math.min(Math.max(padding, left), window.innerWidth - padding - box.width);
    const centeredTop = anchor.top + anchor.height / 2 - box.height / 2;
    const top = Math.min(Math.max(padding, centeredTop), window.innerHeight - padding - box.height);
    setPosition((current) => (current.left === left && current.top === top ? current : { left, top }));
  }, []);

  useLayoutEffect(() => {
    if (open) positionTooltip();
  }, [open, positionTooltip]);
  useEffect(() => {
    if (!open) return;
    const dismissTooltip = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      cancelClose();
      setOpen(false);
    };
    document.addEventListener("keydown", dismissTooltip);
    window.addEventListener("resize", positionTooltip);
    window.addEventListener("scroll", positionTooltip, true);
    return () => {
      document.removeEventListener("keydown", dismissTooltip);
      window.removeEventListener("resize", positionTooltip);
      window.removeEventListener("scroll", positionTooltip, true);
    };
  }, [cancelClose, open, positionTooltip]);
  useEffect(() => () => cancelClose(), [cancelClose]);

  return (
    <>
      <span
        ref={triggerRef}
        className="crow__label crow__label--more"
        data-folders={canonicalPaths.join(", ")}
        role="listitem"
        aria-label={label}
        aria-describedby={open ? tooltipId : undefined}
        tabIndex={0}
        onMouseEnter={showTooltip}
        onMouseLeave={scheduleClose}
        onFocus={showTooltip}
        onBlur={scheduleClose}
      >
        +{paths.length}
      </span>
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              ref={tooltipRef}
              id={tooltipId}
              className="crow__labeltooltip"
              role="tooltip"
              style={position}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              {tooltipText}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

function SkillPaths({ paths, kind }: { paths: SkillListPath[]; kind: "folder" | "subfolder" }) {
  if (paths.length === 0) return null;
  const visible = paths.slice(0, 2);
  const hidden = paths.slice(2);
  const label = kind === "folder" ? "Folders" : "Subfolders";
  return (
    <span className={`crow__labels${kind === "subfolder" ? " crow__labels--relative" : ""}`} role="list" aria-label={label}>
      {visible.map(({ path, label: pathLabel }) => (
        <span
          className="crow__label"
          key={path}
          title={path}
          role="listitem"
          aria-label={`${kind === "folder" ? "Folder" : "Subfolder"}: ${path}`}
        >
          <span className="crow__labeltext">{pathLabel}</span>
        </span>
      ))}
      {hidden.length > 0 ? <PathOverflow paths={hidden} kind={kind} /> : null}
    </span>
  );
}

function SkillRow({
  row,
  library,
  actorId,
  labels,
  activeLabel,
  flat,
  lastId,
  dragSkillId,
  onOpen,
  onPrimaryAction,
  onSkillStartDrag,
}: {
  row: GroupedSkillRow;
  library: "mine" | "org";
  actorId: string;
  labels: LabelVM[];
  activeLabel: string | null;
  flat: boolean;
  lastId: string | null;
  dragSkillId: string | null;
  onOpen: (id: string) => void;
  onPrimaryAction: (skill: SkillVM, action: SkillAction) => void;
  onSkillStartDrag: (id: string, event: PointerEvent<HTMLElement>) => void;
}) {
  const skill = row.skill;
  const canDrag = !(library === "mine" && skill.source === "installed");
  const dragging = canDrag && dragSkillId === skill.id;
  const primary = resolveSkillActions(skill, skillActionPermissions(skill, actorId)).primary;
  const scopedPaths = pathsInLabelScope(skill.labels, activeLabel);
  const icon = flat ? resolveSkillListIcon(skill, labels, scopedPaths) : row.icon;
  return (
    <div
      data-skill-slug={skill.id}
      className={`crow${lastId === skill.id ? " is-active" : ""}${dragging ? " crow--dragging" : ""}`}
      title={peopleLabel(skill)}
      onPointerDown={
        canDrag
          ? (event) => {
              if (event.button !== 0) return;
              onSkillStartDrag(skill.id, event);
            }
          : undefined
      }
    >
      <button type="button" className="crow__hit" aria-label={`Open skill ${skill.id}`} onClick={() => onOpen(skill.id)} />
      <span className="crow__skill">
        <span className="crow__skillicon" style={icon.color ? { color: icon.color } : undefined}>
          <Icon name={icon.name} size={15} />
        </span>
        <span className="crow__name">
          <span className="crow__title">{skill.id}</span>
          <ValidationMarker skill={skill} />
          <InstallMark state={skill.installStatus} />
        </span>
        <SkillPaths
          paths={flat ? scopedPaths.map((path) => ({ path, label: path })) : row.relativePaths}
          kind={flat ? "folder" : "subfolder"}
        />
      </span>
      <PeopleStack skill={skill} />
      <span className="r when when--by" title={`Updated by ${skill.updaterName} · ${skill.updated}`}>
        <UserAvatar
          className="avatar"
          avatarUrl={skill.updaterAvatarUrl}
          initials={skill.updaterInitials}
          size={14}
          style={{ fontSize: 7 }}
        />
        {skill.updated}
      </span>
      <span className="crow__primary r">
        {primary ? (
          <button
            type="button"
            className="rowact rowact--primary"
            aria-label={`${primary.label} ${skill.id}`}
            title={primary.label}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onPrimaryAction(skill, primary)}
          >
            <Icon name={primary.icon} size={12} />
            <span className="rowact__label">{primary.contextualLabel ?? primary.label}</span>
          </button>
        ) : null}
      </span>
      <span className="crow__mobilemeta">
        <span>{skill.updated}</span>
        <span className="crow__mobile-install">
          <InstallMark state={skill.installStatus} />
        </span>
      </span>
    </div>
  );
}

function collapsedStorageKey(workspaceId: string, library: "mine" | "org"): string {
  return `companion:skills:collapsed-groups:v1:${workspaceId}:${library}`;
}

export function ListView({
  skills,
  labels,
  workspaceId,
  library,
  scopeKind,
  activeLabel,
  breadcrumb,
  groupBy,
  onGroupByChange,
  onOpen,
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
  labels: LabelVM[];
  workspaceId: string;
  library: "mine" | "org";
  scopeKind: "all" | "installed" | "label";
  activeLabel: string | null;
  breadcrumb: string[];
  groupBy: SkillGroupBy;
  onGroupByChange: (groupBy: SkillGroupBy) => void;
  onOpen: (id: string) => void;
  onUpload: () => void;
  actorId: string;
  onPrimaryAction: (skill: SkillVM, action: SkillAction) => void;
  lastId: string | null;
  filters: Filter[];
  onToggleFilter: (type: Filter["type"], value: string) => void;
  onRemoveFilter: (filter: Filter) => void;
  onClearFilters: () => void;
  preferenceStatus: "idle" | "saving" | "saved" | "error";
  onRetryPreferences: () => void;
  dragSkillId: string | null;
  onSkillStartDrag: (id: string, event: PointerEvent<HTMLElement>) => void;
  upgradeNotice?: string | null;
  onUpgrade?: () => void;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("default");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const title = breadcrumb[breadcrumb.length - 1] ?? "All skills";
  const storageKey = collapsedStorageKey(workspaceId, library);

  useEffect(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
      setCollapsed(new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []));
    } catch {
      setCollapsed(new Set());
    }
  }, [storageKey]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? skills.filter(
          (skill) =>
            skill.id.toLowerCase().includes(needle) ||
            skill.display?.name?.toLowerCase().includes(needle) ||
            skill.description.toLowerCase().includes(needle),
        )
      : skills;
    if (sort === "default") return matched;
    return [...matched].sort((left, right) => left.id.localeCompare(right.id));
  }, [skills, q, sort]);
  const groups = useMemo(
    () => groupSkillsByRoot(shown, labels, library, activeLabel),
    [activeLabel, labels, library, shown],
  );

  const toggleGroup = useCallback(
    (key: string) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try {
          window.localStorage.setItem(storageKey, JSON.stringify([...next].sort()));
        } catch {
          // Per-device folding is best-effort; the list remains fully usable without storage.
        }
        return next;
      });
    },
    [storageKey],
  );

  const rowProps = {
    library,
    actorId,
    labels,
    activeLabel,
    lastId,
    dragSkillId,
    onOpen,
    onPrimaryAction,
    onSkillStartDrag,
  };

  return (
    <>
      <header className="sh">
        <nav className="sh__crumb" aria-label="Folder">
          {breadcrumb.slice(0, -1).map((segment, index) => (
            <span className="sh__crumbseg" key={index}>
              {index > 0 ? <Icon name="chevron-right" size={12} /> : null}
              <span className="sh__crumbpar">{segment}</span>
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

      {upgradeNotice ? (
        <div className="entitlement-bar" role="status">
          <Icon name="lock" size={14} />
          <span>{upgradeNotice}</span>
          <button className="btn-sec" onClick={onUpgrade}>View plans</button>
        </div>
      ) : null}

      <div className="listbar">
        <span className="listbar__search">
          <Icon name="search" size={14} />
          <input
            className="listbar__input"
            type="search"
            placeholder="Search skills"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            aria-label="Search skills in this view"
          />
        </span>
        <span className="listbar__spacer" />
        <span className="listbar__group" role="group" aria-label="Group skills">
          <button type="button" aria-pressed={groupBy === "folder"} onClick={() => onGroupByChange("folder")}>Grouped</button>
          <button type="button" aria-pressed={groupBy === "none"} onClick={() => onGroupByChange("none")}>Flat</button>
        </span>
        <label className="listbar__sort">
          <Icon name="chevrons-up-down" size={13} />
          <select
            className="listbar__sortsel"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            aria-label="Sort skills"
          >
            {SORT_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </label>
      </div>

      <div className="filterbar">
        <FilterAdd filters={filters} onToggle={onToggleFilter} />
        {filters.map((filter) => {
          const parts = chipParts(filter);
          return (
            <span className="fchip" key={filter.type + filter.value}>
              <span className="lead"><Icon name={parts.icon} size={12} /></span>
              {parts.key ? <span className="fchip__key">{parts.key}:</span> : null}
              <span className="fchip__val">{parts.val}</span>
              <button className="fchip__x" onClick={() => onRemoveFilter(filter)} aria-label="Remove filter">
                <Icon name="x" size={12} />
              </button>
            </span>
          );
        })}
        {filters.length > 0 ? <button className="clearfilters" onClick={onClearFilters}>Clear</button> : null}
        <span className="filterbar__spacer" />
        {preferenceStatus !== "idle" ? (
          <span className={`prefstatus prefstatus--${preferenceStatus}`} role="status" aria-live="polite">
            {preferenceStatus === "saving" ? "Saving" : null}
            {preferenceStatus === "saved" ? "Saved" : null}
            {preferenceStatus === "error" ? (
              <>Not saved<button className="prefstatus__retry" onClick={onRetryPreferences}>Retry</button></>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className={`clist${groupBy === "folder" ? " clist--grouped" : ""}`}>
        <div className="chead">
          <span>Skill</span>
          <span>People</span>
          <span className="r">Updated</span>
          <span className="r">Action</span>
        </div>
        {groupBy === "folder"
          ? groups.map((group) => {
              if (group.kind === "direct") {
                return group.rows.map((row) => (
                  <SkillRow key={`${group.key}:${row.skill.id}`} row={row} flat={false} {...rowProps} />
                ));
              }
              const searching = !!q.trim();
              const isCollapsed = !searching && collapsed.has(group.key);
              const headingId = `skill-group-${group.key.replace(/[^a-z0-9-]/gi, "-")}`;
              const rowsId = `${headingId}-rows`;
              return (
                <section className="cgroup" key={group.key} aria-labelledby={headingId}>
                  <h3 className="cgroup__heading" id={headingId}>
                    <button
                      type="button"
                      className="cgroup__toggle"
                      aria-expanded={!isCollapsed}
                      aria-controls={rowsId}
                      disabled={searching}
                      onClick={() => toggleGroup(group.key)}
                    >
                      <span className="cgroup__icon" style={group.color ? { color: group.color } : undefined}>
                        <Icon name={group.icon} size={15} />
                      </span>
                      <span className="cgroup__name">{group.label}</span>
                      <span className="cgroup__count tnum">{group.rows.length}</span>
                      <span className={`cgroup__chevron${isCollapsed ? "" : " is-open"}`}><Icon name="chevron-right" size={13} /></span>
                    </button>
                  </h3>
                  <div className="cgroup__rows" id={rowsId} hidden={isCollapsed}>
                    {group.rows.map((row) => (
                      <SkillRow key={`${group.key}:${row.skill.id}`} row={row} flat={false} {...rowProps} />
                    ))}
                  </div>
                </section>
              );
            })
          : shown.map((skill) => (
              <SkillRow
                key={skill.id}
                row={{ skill, relativePaths: [], icon: resolveSkillListIcon(skill, labels) }}
                flat
                {...rowProps}
              />
            ))}
        {!shown.length ? (
          <div className="empty">
            <Icon name="search-x" size={22} style={{ color: "var(--color-faint)" }} />
            <div className="empty__title">{q.trim() ? "No skills match" : "Nothing here yet"}</div>
            <div className="empty__desc">
              {q.trim()
                ? "No skills match your search. Clear the search or filters to see this view in full."
                : scopeKind === "installed"
                  ? "You have not installed any organization skills yet. Open one in Organization to install it."
                  : library === "mine"
                    ? "No skills in My Skills yet. Add a skill, or install one from the organization library."
                    : "No organization skills match this view. Clear the filters to see them all."}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
