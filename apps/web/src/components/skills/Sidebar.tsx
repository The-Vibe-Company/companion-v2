"use client";

import { useEffect, useRef, useState } from "react";
import type { LabelColor, LabelIcon } from "@companion/contracts";
import { LABEL_COLORS, LABEL_ICONS, labelDisplayNameToPath } from "@companion/contracts";
import { Icon } from "../Icon";
import { OrgSwitcher } from "../org/OrgSwitcher";
import { WorkspaceAvatar } from "../org/WorkspaceAvatar";
import type { OrgVM } from "@/lib/types";
import type { TreeRow } from "./SkillsApp";

/** A `position: fixed` popover anchored at the cursor, clamped to the viewport (the `.side__nav`
 * scroll container would clip an absolutely-positioned menu — see the viewbar-clipping memory). */
function LabelMenu({
  row,
  pos,
  onClose,
  onSetColor,
  onSetIcon,
  onAddSublabel,
  onRename,
  onDelete,
}: {
  row: TreeRow;
  pos: { x: number; y: number };
  onClose: () => void;
  onSetColor: (path: string, color: LabelColor | null) => void;
  onSetIcon: (path: string, icon: LabelIcon | null) => void;
  onAddSublabel: (parentPath: string) => void;
  onRename: (from: string, to: string, displayName?: string) => void;
  onDelete: (path: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const rowLabel = row.displayName ?? row.leafName;
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

export function Sidebar({
  orgs,
  currentOrg,
  onSwitchOrg,
  onOnboard,
  onOpenSettings,
  onWarmSettings,
  treeRows,
  expanded,
  onToggleExpand,
  selection,
  totalCount,
  starredCount,
  onOpenPalette,
  onSelectAll,
  onSelectStarred,
  onSelectLabel,
  onCreateLabel,
  onSetLabelColor,
  onSetLabelIcon,
  onRenameLabel,
  onDeleteLabel,
  onSelectLocal,
  onSelectArchived,
  localActive,
  localUpdateCount,
  archivedActive,
  archivedCount,
  mobileOpen,
  onToggleMobile,
  onCloseMobile,
}: {
  orgs: OrgVM[];
  currentOrg: OrgVM;
  onSwitchOrg: (id: string) => void;
  onOnboard: (mode: "create" | "join") => void;
  onOpenSettings: () => void;
  onWarmSettings: () => void;
  /** Flat, depth-ordered label rows derived from skills + explicit labels (stable lexicographic sort). */
  treeRows: TreeRow[];
  expanded: Set<string>;
  onToggleExpand: (path: string) => void;
  /** The active org-wide scope selection (drives which slice of skills the list shows). */
  selection: { kind: "all" | "starred" | "nolabel" | "label"; label?: string };
  totalCount: number;
  starredCount: number;
  onOpenPalette: () => void;
  onSelectAll: () => void;
  onSelectStarred: () => void;
  onSelectLabel: (path: string) => void;
  /** Create an empty folder and select it (the org-root `+` inline input). */
  onCreateLabel: (path: string, displayName?: string) => void;
  onSetLabelColor: (path: string, color: LabelColor | null) => void;
  onSetLabelIcon: (path: string, icon: LabelIcon | null) => void;
  onRenameLabel: (from: string, to: string, displayName?: string) => void;
  onDeleteLabel: (path: string) => void;
  onSelectLocal: () => void;
  onSelectArchived: () => void;
  localActive: boolean;
  localUpdateCount: number;
  archivedActive: boolean;
  archivedCount: number;
  mobileOpen: boolean;
  onToggleMobile: () => void;
  onCloseMobile: () => void;
}) {
  const [menu, setMenu] = useState<{ row: TreeRow; pos: { x: number; y: number } } | null>(null);
  // The inline new-folder input on the org-root row (top-level) and per-label "add sublabel" seed.
  const [newFolderSeed, setNewFolderSeed] = useState<string | null>(null);
  const [newFolderValue, setNewFolderValue] = useState("");
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  const warmSettings = () => onWarmSettings();
  const runAndClose = (action: () => void) => {
    action();
    onCloseMobile();
  };

  // Only top-level rows whose ancestors are all expanded are visible (chevron-collapse).
  const visibleRows = treeRows.filter((row) => {
    if (row.depth === 0) return true;
    const segments = row.path.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      if (!expanded.has(segments.slice(0, i).join("/"))) return false;
    }
    return true;
  });

  const openNewFolder = (seed: string) => {
    setNewFolderSeed(seed);
    setNewFolderValue(seed ? seed + "/" : "");
    queueMicrotask(() => newFolderInputRef.current?.focus());
  };
  const cancelNewFolder = () => {
    setNewFolderSeed(null);
    setNewFolderValue("");
  };
  const commitNewFolder = () => {
    const raw = newFolderValue.trim().replace(/\/+$/, "");
    cancelNewFolder();
    if (!raw) return;
    try {
      const path = labelDisplayNameToPath(raw);
      const displayName = raw.split("/").filter(Boolean).pop()?.trim() ?? raw;
      runAndClose(() => onCreateLabel(path, displayName));
    } catch {
      return;
    }
  };

  const labelIcon = (row: TreeRow): string => {
    if (row.icon) return row.icon;
    if (row.hasChildren) return expanded.has(row.path) ? "folder-open" : "folder";
    return "tag";
  };

  return (
    <aside className={"side" + (mobileOpen ? " side--mobile-open" : "")}>
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
        <button
          className={"navitem" + (selection.kind === "all" && !localActive && !archivedActive ? " navitem--active" : "")}
          aria-current={selection.kind === "all" && !localActive && !archivedActive ? "page" : undefined}
          onClick={() => runAndClose(onSelectAll)}
          title="All skills"
        >
          <span className="navitem__ico">
            <Icon name="layers" />
          </span>
          <span className="navitem__label">All skills</span>
          <span className="navitem__count tnum">{totalCount}</span>
        </button>
        <button
          className={"navitem" + (selection.kind === "starred" && !localActive && !archivedActive ? " navitem--active" : "")}
          aria-current={selection.kind === "starred" && !localActive && !archivedActive ? "page" : undefined}
          onClick={() => runAndClose(onSelectStarred)}
          title="Starred skills"
        >
          <span className="navitem__ico">
            <Icon name="star" />
          </span>
          <span className="navitem__label">Starred</span>
          <span className="navitem__count tnum">{starredCount}</span>
        </button>

        {/* Org-root row: avatar + name selects All; hover reveals the new-folder `+`. */}
        <div className="side__grouplabel side__grouplabel--row lblroot">
          <button
            type="button"
            className="lblroot__main"
            onClick={() => runAndClose(onSelectAll)}
            title={currentOrg.name + " — all skills"}
          >
            <WorkspaceAvatar org={currentOrg} className="lblroot__av" size={18} />
            <span className="lblroot__name">{currentOrg.name}</span>
          </button>
          <button
            className="side__addteam"
            title="New folder"
            aria-label="New folder"
            onClick={() => openNewFolder("")}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>

        {newFolderSeed !== null && (
          <div className="lblnew" style={{ paddingLeft: 8 + (newFolderSeed ? 16 : 0) }}>
            <span className="lblnew__ico">
              <Icon name="folder" size={15} />
            </span>
            <input
              ref={newFolderInputRef}
              className="lblnew__input"
              value={newFolderValue}
              placeholder="marketing/seo…"
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
        )}

        {visibleRows.map((row) => {
          const active = selection.kind === "label" && selection.label === row.path && !localActive && !archivedActive;
          const isOpen = expanded.has(row.path);
          return (
            <div
              className={"lblrow" + (active ? " lblrow--active" : "")}
              key={row.path}
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
                onClick={() =>
                  runAndClose(() => {
                    onSelectLabel(row.path);
                    // Clicking a folder with children also opens/closes it (matches the chevron + the original design).
                    if (row.hasChildren) onToggleExpand(row.path);
                  })
                }
                title={row.path}
              >
                <span className="lblrow__ico" style={row.color ? { color: row.color } : undefined}>
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
                  setMenu({ row, pos: { x: r.left, y: r.bottom + 4 } });
                }}
              >
                <Icon name="more-horizontal" size={15} />
              </button>
            </div>
          );
        })}

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
          onClose={() => setMenu(null)}
          onSetColor={onSetLabelColor}
          onSetIcon={onSetLabelIcon}
          onAddSublabel={(parent) => openNewFolder(parent)}
          onRename={onRenameLabel}
          onDelete={onDeleteLabel}
        />
      )}
    </aside>
  );
}
