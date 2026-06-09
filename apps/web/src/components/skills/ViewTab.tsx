"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import type { ViewDef } from "./filters";

export function ViewTab({
  view,
  active,
  count,
  onSelect,
  onRename,
  onDelete,
}: {
  view: ViewDef;
  active: boolean;
  count: number;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(view.name);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboardOpenRef = useRef(false);

  // Focus the rename input once the click event that opened it has fully
  // settled — using autoFocus here would be clobbered by the browser's
  // post-click focus reset (the clicked menu item unmounts), firing an
  // immediate blur that commits and exits rename mode.
  useEffect(() => {
    if (!renaming) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [renaming]);

  // Keep the cursor-anchored menu inside the viewport.
  useEffect(() => {
    if (!menuOpen) return;
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let x = menuPos.x;
    let y = menuPos.y;
    if (x + r.width > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - r.width - pad);
    if (y + r.height > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - r.height - pad);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [menuOpen, menuPos]);

  // When opened from the keyboard, move focus into the menu for navigation.
  useEffect(() => {
    if (menuOpen && keyboardOpenRef.current) {
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        keyboardOpenRef.current = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      if (keyboardOpenRef.current) buttonRef.current?.focus();
      keyboardOpenRef.current = false;
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const closeMenu = (returnFocus: boolean) => {
    setMenuOpen(false);
    if (returnFocus && keyboardOpenRef.current) buttonRef.current?.focus();
    keyboardOpenRef.current = false;
  };
  const openMenuAt = (x: number, y: number, fromKeyboard: boolean) => {
    keyboardOpenRef.current = fromKeyboard;
    setMenuPos({ x, y });
    setMenuOpen(true);
  };
  const startRename = () => {
    closeMenu(false);
    setDraft(view.name);
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    onRename(view.id, draft);
  };

  if (renaming) {
    return (
      <span className="vtab-wrap">
        <span className={"vtab" + (active ? " is-active" : "") + (view.custom ? " vtab--custom" : "")}>
          <Icon name={view.icon} size={14} />
          <input
            ref={inputRef}
            className="vtab__rename"
            value={draft}
            maxLength={128}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            aria-label="Rename view"
          />
        </span>
      </span>
    );
  }

  return (
    <span className="vtab-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        role="tab"
        aria-selected={active}
        aria-haspopup={view.custom ? "menu" : undefined}
        aria-expanded={view.custom ? menuOpen : undefined}
        className={"vtab" + (active ? " is-active" : "") + (view.custom ? " vtab--custom" : "")}
        onClick={() => onSelect(view.id)}
        onContextMenu={
          view.custom
            ? (e) => {
                e.preventDefault();
                openMenuAt(e.clientX, e.clientY, false);
              }
            : undefined
        }
        onKeyDown={
          view.custom
            ? (e) => {
                // Shift+F10 / the Menu key are the keyboard equivalents of a
                // right-click, so keyboard users can reach Rename/Delete too.
                if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                  e.preventDefault();
                  const r = buttonRef.current?.getBoundingClientRect();
                  openMenuAt(r ? r.left : 0, r ? r.bottom + 4 : 0, true);
                }
              }
            : undefined
        }
      >
        <Icon name={view.icon} size={14} />
        {view.name}
        <span className="vtab__count tnum">{count}</span>
      </button>
      {menuOpen && view.custom && (
        <div
          className="vmenu"
          role="menu"
          ref={menuRef}
          style={{ top: menuPos.y, left: menuPos.x }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
            if (!items.length) return;
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          <button className="fmenu__item" role="menuitem" onClick={startRename}>
            <span className="ico">
              <Icon name="pencil" size={14} />
            </span>
            <span className="lbl">Rename</span>
          </button>
          <button
            className="fmenu__item vmenu__danger"
            role="menuitem"
            onClick={() => {
              closeMenu(true);
              onDelete(view.id);
            }}
          >
            <span className="ico">
              <Icon name="trash-2" size={14} />
            </span>
            <span className="lbl">Delete</span>
          </button>
        </div>
      )}
    </span>
  );
}
