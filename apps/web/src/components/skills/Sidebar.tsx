"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { LabelColor, LabelIcon } from "@companion/contracts";
import { LABEL_COLORS, LABEL_ICONS, labelDisplayNameToPath } from "@companion/contracts";
import { Icon } from "../Icon";
import { OrgSwitcher } from "../org/OrgSwitcher";
import type { OrgVM } from "@/lib/types";
import type { SkillsLibrary } from "./route";
import type { ResolvedTarget } from "./dragGeometry";
import type { DragItem, TreeRow } from "./SkillsApp";

type SidebarSelection = { lib: SkillsLibrary; kind: "all" | "starred" | "installed" | "label"; label?: string } | null;
type MoveTarget = { path: string; label: string };

function labelParent(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i === -1 ? null : path.slice(0, i);
}

/** A `position: fixed` popover anchored at the cursor, clamped to the viewport (the `.side__nav`
 * scroll container would clip an absolutely-positioned menu — see the viewbar-clipping memory). */
function LabelMenu({
  row,
  pos,
  moveTargets,
  onClose,
  onSetColor,
  onSetIcon,
  onAddSublabel,
  onMove,
  onRename,
  onDelete,
}: {
  row: TreeRow;
  pos: { x: number; y: number };
  moveTargets: MoveTarget[];
  onClose: () => void;
  onSetColor: (path: string, color: LabelColor | null) => void;
  onSetIcon: (path: string, icon: LabelIcon | null) => void;
  onAddSublabel: (parentPath: string) => void;
  onMove: (targetParent: string | null) => void;
  onRename: (from: string, to: string, displayName?: string) => void;
  onDelete: (path: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const rowLabel = row.displayName ?? row.leafName;
  const parentPath = labelParent(row.path);
  const canMove = parentPath !== null || moveTargets.length > 0;
  const [renameValue, setRenameValue] = useState(rowLabel);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const commitRename = () => {
    const raw = renameValue.trim();
    setRenaming(false);
    if (!raw) return;
    const parent = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/") + 1) : "";
    let leafPath: string;
    try {
      leafPath = labelDisplayNameToPath(raw);
    } catch {
      return;
    }
    const to = parent + leafPath;
    const displayName = raw.replace(/\/+$/, "").split("/").filter(Boolean).pop()?.trim() ?? raw;
    if (to === row.path && displayName === rowLabel) return;
    onClose();
    onRename(row.path, to, displayName);
  };
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let left = pos.x;
    let top = pos.y;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [pos]);
  useEffect(() => {
    setMoving(false);
    setRenaming(false);
  }, [row.path]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className="menu menu--fixed lblmenu" role="menu" ref={menuRef}>
      <div className="menu__head">Color</div>
      <div className="lblmenu__swatches">
        <button
          type="button"
          className={"lblmenu__swatch lblmenu__swatch--none" + (row.color === null ? " is-sel" : "")}
          title="No color"
          aria-label="No color"
          aria-pressed={row.color === null}
          onClick={() => onSetColor(row.path, null)}
        >
          <Icon name="ban" size={13} />
        </button>
        {LABEL_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={"lblmenu__swatch" + (row.color === color ? " is-sel" : "")}
            style={{ background: color }}
            title={color}
            aria-label={color}
            aria-pressed={row.color === color}
            onClick={() => onSetColor(row.path, color)}
          />
        ))}
      </div>
      <div className="menu__head">Icon</div>
      <div className="lblmenu__icons">
        {LABEL_ICONS.map((icon) => (
          <button
            key={icon}
            type="button"
            className={"lblmenu__icon" + (row.icon === icon ? " is-sel" : "")}
            title={icon}
            aria-label={icon}
            aria-pressed={row.icon === icon}
            onClick={() => onSetIcon(row.path, icon)}
          >
            <Icon name={icon} size={15} />
          </button>
        ))}
      </div>
      <div className="menu__sep" />
      {renaming ? (
        <div className="lblmenu__rename">
          <input
            ref={renameInputRef}
            className="lblnew__input"
            value={renameValue}
            aria-label="Rename folder"
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenaming(false);
              }
            }}
            onBlur={() => setRenaming(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          className="menu__item"
          role="menuitem"
          onClick={() => {
            setRenameValue(row.displayName ?? row.leafName);
            setRenaming(true);
            queueMicrotask(() => renameInputRef.current?.focus());
          }}
        >
          <span className="ico">
            <Icon name="pencil" size={14} />
          </span>
          <span className="menu__label">Rename</span>
        </button>
      )}
      <button
        type="button"
        className="menu__item"
        role="menuitem"
        onClick={() => {
          onClose();
          onAddSublabel(row.path);
        }}
      >
        <span className="ico">
          <Icon name="plus" size={14} />
        </span>
        <span className="menu__label">Add sublabel</span>
      </button>
      {canMove && (
        <>
          <button
            type="button"
            className={"menu__item" + (moving ? " is-sel" : "")}
            role="menuitem"
            aria-label={`Move ${row.path}`}
            aria-expanded={moving}
            onClick={() => setMoving((value) => !value)}
          >
            <span className="ico">
              <Icon name="corner-down-right" size={14} />
            </span>
            <span className="menu__label">Move to...</span>
            <span className="menu__desc">{moving ? "Hide" : "Choose"}</span>
          </button>
          {moving && (
            <div className="lblmenu__move" role="group" aria-label={`Move ${row.path} to`}>
              {parentPath !== null && (
                <button
                  type="button"
                  className="menu__item"
                  onClick={() => {
                    onClose();
                    onMove(null);
                  }}
                  aria-label={`Move ${row.path} to top level`}
                >
                  <span className="ico">
                    <Icon name="folder" size={14} />
                  </span>
                  <span className="menu__label">Top level</span>
                  <span className="menu__desc">Root</span>
                </button>
              )}
              {moveTargets.map((target) => (
                <button
                  key={target.path}
                  type="button"
                  className="menu__item"
                  onClick={() => {
                    onClose();
                    onMove(target.path);
                  }}
                  aria-label={`Move ${row.path} to ${target.path}`}
                >
                  <span className="ico">
                    <Icon name="folder" size={14} />
                  </span>
                  <span className="menu__label">{target.label}</span>
                  <span className="menu__desc">{target.path}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <button
        type="button"
        className="menu__item menu__item--danger"
        role="menuitem"
        onClick={() => {
          onClose();
          onDelete(row.path);
        }}
      >
        <span className="ico">
          <Icon name="trash-2" size={14} />
        </span>
        <span className="menu__label">Delete folder</span>
      </button>
    </div>
  );
}

/** The folder rows of one library's tree (chevron/leaf, colored icon, name, count, options menu). */
function LabelTreeRows({
  lib,
  rows,
  expanded,
  activePath,
  drag,
  hovered,
  openPendingPath,
  dropDone,
  onToggleExpand,
  onSelect,
  onOpenMenu,
  onStartDrag,
}: {
  lib: SkillsLibrary;
  rows: TreeRow[];
  expanded: Set<string>;
  activePath: string | null;
  drag: DragItem | null;
  hovered: ResolvedTarget | null;
  openPendingPath: string | null;
  dropDone: ResolvedTarget | null;
  onToggleExpand: (path: string) => void;
  onSelect: (path: string) => void;
  onOpenMenu: (row: TreeRow, pos: { x: number; y: number }) => void;
  onStartDrag: (item: DragItem, e: PointerEvent<HTMLElement>) => void;
}) {
  const labelIcon = (row: TreeRow): string => {
    if (row.icon) return row.icon;
    if (row.hasChildren) return expanded.has(row.path) ? "folder-open" : "folder";
    return "tag";
  };
  // Only rows whose ancestors are all expanded are visible (chevron-collapse).
  const visibleRows = rows.filter((row) => {
    if (row.depth === 0) return true;
    const segments = row.path.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      if (!expanded.has(segments.slice(0, i).join("/"))) return false;
    }
    return true;
  });
  return (
    <>
      {visibleRows.map((row) => {
        const active = activePath === row.path;
        const isOpen = expanded.has(row.path);
        const dragging = drag?.kind === "label" && drag.lib === lib && drag.path === row.path;
        const dropOk = hovered?.kind === "label" && hovered.lib === lib && hovered.path === row.path;
        const dropJustDone = dropDone?.kind === "label" && dropDone.lib === lib && dropDone.path === row.path;
        const openPending = openPendingPath === row.path && dropOk && drag?.kind === "skill";
        const forceDropIconColor = dropOk || openPending || dropJustDone;
        return (
          <div
            className={
              "lblrow" +
              (active ? " lblrow--active" : "") +
              (dragging ? " lblrow--dragging" : "") +
              (dropOk ? " lblrow--dropok" : "") +
              (openPending ? " lblrow--openpending" : "") +
              (dropJustDone ? " lblrow--dropdone" : "")
            }
            key={row.path}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              onStartDrag({ kind: "label", lib, path: row.path, leaf: row.leafName }, e);
            }}
            data-skill-drop-kind="label"
            data-skill-drop-lib={lib}
            data-skill-drop-path={row.path}
            style={{ paddingLeft: 8 + row.depth * 14 }}
          >
            {row.hasChildren ? (
              <button
                type="button"
                className={"lblrow__chev" + (isOpen ? " is-open" : "")}
                aria-label={isOpen ? "Collapse" : "Expand"}
                aria-expanded={isOpen}
                onClick={() => onToggleExpand(row.path)}
              >
                <Icon name="chevron-right" size={13} />
              </button>
            ) : (
              <span className="lblrow__chev lblrow__chev--leaf" aria-hidden="true" />
            )}
            <button
              type="button"
              className="lblrow__main"
              aria-current={active ? "page" : undefined}
              onClick={() => {
                onSelect(row.path);
                if (row.hasChildren) onToggleExpand(row.path);
              }}
              title={row.path}
            >
              <span className="lblrow__ico" style={row.color && !forceDropIconColor ? { color: row.color } : undefined}>
                <Icon name={labelIcon(row)} size={15} />
              </span>
              <span className="lblrow__name">{row.displayName ?? row.leafName}</span>
              <span className="lblrow__count tnum">{row.count}</span>
            </button>
            <button
              type="button"
              className="lblrow__more"
              aria-label={row.path + " options"}
              title="Folder options"
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onOpenMenu(row, { x: r.left, y: r.bottom + 4 });
              }}
            >
              <Icon name="more-horizontal" size={15} />
            </button>
          </div>
        );
      })}
    </>
  );
}

export function Sidebar({
  orgs,
  currentOrg,
  onSwitchOrg,
  onOnboard,
  onOpenSettings,
  onWarmSettings,
  mineTreeRows,
  orgTreeRows,
  expanded,
  onToggleExpand,
  selection,
  mineCount,
  orgCount,
  starredCount,
  installedCount,
  installedUpdateCount,
  onOpenPalette,
  onSelectMineAll,
  onSelectOrgAll,
  onSelectStarred,
  onSelectInstalled,
  onSelectLabel,
  onCreateLabel,
  onSetLabelColor,
  onSetLabelIcon,
  onRenameLabel,
  onDeleteLabel,
  drag,
  hovered,
  openPendingPath,
  dropDone,
  onReparentLabel,
  onLabelStartDrag,
  onSelectLocal,
  onSelectArchived,
  localActive,
  localUpdateCount,
  archivedActive,
  archivedCount,
  mobileOpen,
  onToggleMobile,
  onCloseMobile,
  personalSkillsEnabled,
  onUpgrade,
}: {
  orgs: OrgVM[];
  currentOrg: OrgVM;
  onSwitchOrg: (id: string) => void;
  onOnboard: (mode: "create" | "join") => void;
  onOpenSettings: () => void;
  onWarmSettings: () => void;
  mineTreeRows: TreeRow[];
  orgTreeRows: TreeRow[];
  expanded: Set<string>;
  onToggleExpand: (path: string) => void;
  /** The active workspace selection, or null when a library-independent view (local/archived) is shown. */
  selection: SidebarSelection;
  mineCount: number;
  orgCount: number;
  starredCount: number;
  installedCount: number;
  installedUpdateCount: number;
  onOpenPalette: () => void;
  onSelectMineAll: () => void;
  onSelectOrgAll: () => void;
  onSelectStarred: () => void;
  onSelectInstalled: () => void;
  onSelectLabel: (lib: SkillsLibrary, path: string) => void;
  onCreateLabel: (lib: SkillsLibrary, path: string, displayName?: string) => void;
  onSetLabelColor: (lib: SkillsLibrary, path: string, color: LabelColor | null) => void;
  onSetLabelIcon: (lib: SkillsLibrary, path: string, icon: LabelIcon | null) => void;
  onRenameLabel: (lib: SkillsLibrary, from: string, to: string, displayName?: string) => void;
  onDeleteLabel: (lib: SkillsLibrary, path: string) => void;
  drag: DragItem | null;
  hovered: ResolvedTarget | null;
  openPendingPath: string | null;
  dropDone: ResolvedTarget | null;
  onReparentLabel: (lib: SkillsLibrary, from: string, targetParent: string | null) => void;
  onLabelStartDrag: (item: DragItem, e: PointerEvent<HTMLElement>) => void;
  onSelectLocal: () => void;
  onSelectArchived: () => void;
  localActive: boolean;
  localUpdateCount: number;
  archivedActive: boolean;
  archivedCount: number;
  mobileOpen: boolean;
  onToggleMobile: () => void;
  onCloseMobile: () => void;
  personalSkillsEnabled: boolean;
  onUpgrade: () => void;
}) {
  const [menu, setMenu] = useState<{ row: TreeRow; lib: SkillsLibrary; pos: { x: number; y: number } } | null>(null);
  // The inline new-folder input, scoped to the library whose `+` (or "add sublabel") opened it.
  const [newFolder, setNewFolder] = useState<{ lib: SkillsLibrary; seed: string } | null>(null);
  const [newFolderValue, setNewFolderValue] = useState("");
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const [mineOpen, setMineOpen] = useState(true);
  const [orgOpen, setOrgOpen] = useState(true);

  const warmSettings = () => onWarmSettings();
  const runAndClose = (action: () => void) => {
    action();
    onCloseMobile();
  };

  const rootDropOk = (lib: SkillsLibrary) => hovered?.kind === "root" && hovered.lib === lib;
  const rootDropDone = (lib: SkillsLibrary) => dropDone?.kind === "root" && dropDone.lib === lib;
  const skillDropMode = drag?.kind === "skill";

  // Library headers are pure drop targets — the pointer hook hit-tests these data attributes.
  const rootDropProps = (lib: SkillsLibrary) => ({
    "data-skill-drop-kind": "root" as const,
    "data-skill-drop-lib": lib,
  });

  const inWorkspace = !localActive && !archivedActive && selection !== null;
  const mineHeadActive = inWorkspace && selection!.lib === "mine" && selection!.kind === "all";
  const orgHeadActive = inWorkspace && selection!.lib === "org" && selection!.kind === "all";
  const activeMineLabel = inWorkspace && selection!.lib === "mine" && selection!.kind === "label" ? selection!.label ?? null : null;
  const activeOrgLabel = inWorkspace && selection!.lib === "org" && selection!.kind === "label" ? selection!.label ?? null : null;

  const openNewFolder = (lib: SkillsLibrary, seed: string) => {
    setNewFolder({ lib, seed });
    setNewFolderValue(seed ? seed + "/" : "");
    queueMicrotask(() => newFolderInputRef.current?.focus());
  };
  const cancelNewFolder = () => {
    setNewFolder(null);
    setNewFolderValue("");
  };
  const commitNewFolder = () => {
    const lib = newFolder?.lib;
    const raw = newFolderValue.trim().replace(/\/+$/, "");
    cancelNewFolder();
    if (!raw || !lib) return;
    try {
      const path = labelDisplayNameToPath(raw);
      const displayName = raw.split("/").filter(Boolean).pop()?.trim() ?? raw;
      runAndClose(() => onCreateLabel(lib, path, displayName));
    } catch {
      return;
    }
  };

  const newFolderRow = (lib: SkillsLibrary, placeholder: string) =>
    newFolder?.lib === lib ? (
      <div className="lblnew" style={{ paddingLeft: 8 + (newFolder.seed ? 16 : 0) }}>
        <span className="lblnew__ico">
          <Icon name="folder" size={15} />
        </span>
        <input
          ref={newFolderInputRef}
          className="lblnew__input"
          value={newFolderValue}
          placeholder={placeholder}
          aria-label="New folder path"
          onChange={(e) => setNewFolderValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitNewFolder();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelNewFolder();
            }
          }}
          onBlur={cancelNewFolder}
        />
      </div>
    ) : null;

  return (
    <aside className={"side" + (mobileOpen ? " side--mobile-open" : "") + (skillDropMode ? " side--skill-drop" : "")}>
      <div className="side__brand">
        <button
          className="side__toggle"
          type="button"
          onClick={onToggleMobile}
          aria-label={mobileOpen ? "Collapse navigation" : "Expand navigation"}
          aria-expanded={mobileOpen}
          title={mobileOpen ? "Collapse navigation" : "Expand navigation"}
        >
          <Icon name={mobileOpen ? "panel-left-close" : "panel-left-open"} size={15} />
        </button>
        <OrgSwitcher
          orgs={orgs}
          current={currentOrg}
          onSwitch={(id) => runAndClose(() => onSwitchOrg(id))}
          onOnboard={(mode) => runAndClose(() => onOnboard(mode))}
        />
        <button
          className="side__search"
          onClick={() => runAndClose(onOpenPalette)}
          title="Search (⌘K)"
          aria-label="Search"
        >
          <Icon name="search" size={14} />
        </button>
      </div>
      <nav className="side__nav" aria-label="Primary">
        {/* ===== MY SKILLS ===== */}
        <div
          className={
            "ml-libhead" +
            (mineHeadActive ? " is-active" : "") +
            (rootDropOk("mine") ? " ml-libhead--dropok" : "") +
            (rootDropDone("mine") ? " ml-libhead--dropdone" : "")
          }
          style={{ marginTop: 2 }}
          {...rootDropProps("mine")}
        >
          <button
            type="button"
            className={"ml-libhead__chev" + (mineOpen ? " is-open" : "")}
            aria-label={mineOpen ? "Collapse My Skills" : "Expand My Skills"}
            aria-expanded={mineOpen}
            onClick={() => setMineOpen((o) => !o)}
          >
            <Icon name={mineOpen ? "chevron-down" : "chevron-right"} size={16} />
          </button>
          <button
            type="button"
            className="ml-libhead__main"
            aria-current={mineHeadActive ? "page" : undefined}
            onClick={() => {
              setMineOpen(true);
              runAndClose(onSelectMineAll);
            }}
            title="My Skills"
          >
            <span className="ml-libhead__ico">
              <Icon name="user" size={16} />
            </span>
            <span className="ml-libhead__name">My Skills</span>
          </button>
          <span className="ml-libhead__count tnum">{mineCount}</span>
          <button className="side__addteam" title={personalSkillsEnabled ? "New personal folder" : "Personal skills require Pro"} aria-label={personalSkillsEnabled ? "New personal folder" : "View plans for personal skills"} onClick={() => personalSkillsEnabled ? openNewFolder("mine", "") : onUpgrade()}>
            <Icon name={personalSkillsEnabled ? "plus" : "lock"} size={14} />
          </button>
        </div>
        {mineOpen && (
          <div className="ml-kids">
            <button
              className={"navitem" + (inWorkspace && selection!.kind === "starred" ? " navitem--active" : "")}
              aria-current={inWorkspace && selection!.kind === "starred" ? "page" : undefined}
              onClick={() => runAndClose(onSelectStarred)}
              title="Starred skills"
            >
              <span className="navitem__ico">
                <Icon name="star" />
              </span>
              <span className="navitem__label">Starred</span>
              <span className="navitem__count tnum">{starredCount}</span>
            </button>
            <button
              className={"navitem" + (inWorkspace && selection!.kind === "installed" ? " navitem--active" : "")}
              aria-current={inWorkspace && selection!.kind === "installed" ? "page" : undefined}
              onClick={() => runAndClose(onSelectInstalled)}
              title={installedUpdateCount > 0 ? `${installedUpdateCount} update${installedUpdateCount === 1 ? "" : "s"} available` : "Installed from the organization"}
            >
              <span className="navitem__ico">
                <Icon name="download" />
              </span>
              <span className="navitem__label">Installed</span>
              {installedUpdateCount > 0 ? (
                <span
                  className="ml-updot"
                  title={`${installedUpdateCount} update${installedUpdateCount === 1 ? "" : "s"} available`}
                  aria-label={`${installedUpdateCount} update${installedUpdateCount === 1 ? "" : "s"} available`}
                />
              ) : (
                <span className="navitem__count tnum">{installedCount}</span>
              )}
            </button>
            {newFolderRow("mine", "drafts/research…")}
            <LabelTreeRows
              lib="mine"
              rows={mineTreeRows}
              expanded={expanded}
              activePath={activeMineLabel}
              drag={drag}
              hovered={hovered}
              openPendingPath={openPendingPath}
              dropDone={dropDone}
              onToggleExpand={onToggleExpand}
              onSelect={(path) => runAndClose(() => onSelectLabel("mine", path))}
              onOpenMenu={(row, pos) => setMenu({ row, lib: "mine", pos })}
              onStartDrag={onLabelStartDrag}
            />
          </div>
        )}

        {/* ===== ORGANIZATION ===== */}
        <div
          className={
            "ml-libhead" +
            (orgHeadActive ? " is-active" : "") +
            (rootDropOk("org") ? " ml-libhead--dropok" : "") +
            (rootDropDone("org") ? " ml-libhead--dropdone" : "")
          }
          style={{ marginTop: 4 }}
          {...rootDropProps("org")}
        >
          <button
            type="button"
            className={"ml-libhead__chev" + (orgOpen ? " is-open" : "")}
            aria-label={orgOpen ? "Collapse Organization" : "Expand Organization"}
            aria-expanded={orgOpen}
            onClick={() => setOrgOpen((o) => !o)}
          >
            <Icon name={orgOpen ? "chevron-down" : "chevron-right"} size={16} />
          </button>
          <button
            type="button"
            className="ml-libhead__main"
            aria-current={orgHeadActive ? "page" : undefined}
            onClick={() => {
              setOrgOpen(true);
              runAndClose(onSelectOrgAll);
            }}
            title="Organization"
          >
            <span className="ml-libhead__ico">
              <Icon name="building-2" size={16} />
            </span>
            <span className="ml-libhead__name">Organization</span>
          </button>
          <span className="ml-libhead__count tnum">{orgCount}</span>
          <button className="side__addteam" title="New org folder" aria-label="New org folder" onClick={() => openNewFolder("org", "")}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {orgOpen && (
          <div className="ml-kids">
            {newFolderRow("org", "marketing/seo…")}
            <LabelTreeRows
              lib="org"
              rows={orgTreeRows}
              expanded={expanded}
              activePath={activeOrgLabel}
              drag={drag}
              hovered={hovered}
              openPendingPath={openPendingPath}
              dropDone={dropDone}
              onToggleExpand={onToggleExpand}
              onSelect={(path) => runAndClose(() => onSelectLabel("org", path))}
              onOpenMenu={(row, pos) => setMenu({ row, lib: "org", pos })}
              onStartDrag={onLabelStartDrag}
            />
          </div>
        )}

        {/* ===== BOTTOM ===== */}
        <button
          className={"navitem navitem--bottom" + (localActive ? " navitem--active" : "")}
          aria-current={localActive ? "page" : undefined}
          onClick={() => runAndClose(onSelectLocal)}
          title="Companion skills"
        >
          <span className="navitem__ico">
            <Icon name="laptop" />
          </span>
          <span className="navitem__label">Companion skills</span>
          {localUpdateCount > 0 && (
            <span className="navitem__count navitem__count--warn tnum" title="Updates available">
              {localUpdateCount}
            </span>
          )}
        </button>
        <button
          className={"navitem" + (archivedActive ? " navitem--active" : "")}
          aria-current={archivedActive ? "page" : undefined}
          onClick={() => runAndClose(onSelectArchived)}
          title="Archived skills"
        >
          <span className="navitem__ico">
            <Icon name="archive" />
          </span>
          <span className="navitem__label">Archived</span>
          <span className="navitem__count tnum">{archivedCount}</span>
        </button>
      </nav>
      <button
        className="side__foot side__foot--btn"
        onFocus={warmSettings}
        onMouseDown={warmSettings}
        onClick={() => runAndClose(() => onOpenSettings())}
        onPointerEnter={warmSettings}
        title="Settings"
      >
        <Icon name="settings" size={14} /> <span className="side__foot__label">Settings</span>
      </button>
      {menu && (
        <LabelMenu
          row={menu.row}
          pos={menu.pos}
          moveTargets={(menu.lib === "mine" ? mineTreeRows : orgTreeRows)
            .filter((row) => {
              const currentParent = labelParent(menu.row.path);
              return (
                row.path !== menu.row.path &&
                row.path !== currentParent &&
                !row.path.startsWith(menu.row.path + "/")
              );
            })
            .map((row) => ({ path: row.path, label: row.displayName ?? row.leafName }))}
          onClose={() => setMenu(null)}
          onSetColor={(path, color) => onSetLabelColor(menu.lib, path, color)}
          onSetIcon={(path, icon) => onSetLabelIcon(menu.lib, path, icon)}
          onAddSublabel={(parent) => openNewFolder(menu.lib, parent)}
          onMove={(targetParent) => onReparentLabel(menu.lib, menu.row.path, targetParent)}
          onRename={(from, to, displayName) => onRenameLabel(menu.lib, from, to, displayName)}
          onDelete={(path) => onDeleteLabel(menu.lib, path)}
        />
      )}
    </aside>
  );
}
