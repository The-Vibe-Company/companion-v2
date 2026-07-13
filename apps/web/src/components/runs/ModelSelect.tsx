"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RunModelOption } from "@companion/contracts";
import { Icon } from "../Icon";

function contextHint(context: number | null): string | null {
  if (!context) return null;
  return `${Math.round(context / 1000)}k context`;
}

type MenuPosition = { left: number; top: number; width: number };

/** Compact, top-layer model picker. Readiness comes from run-options and cannot be bypassed. */
export function ModelSelect({
  options,
  model,
  onSelectModel,
  onManageModels,
  disabled = false,
}: {
  options: RunModelOption[];
  model: string;
  onSelectModel: (id: string) => void;
  onManageModels: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = options.find((option) => option.model.id === model) ?? null;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return options.filter((option) =>
      !needle || `${option.model.id} ${option.model.name} ${option.model.provider_name}`.toLowerCase().includes(needle),
    );
  }, [options, query]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const estimatedHeight = Math.min(430, 92 + options.length * 58);
      const top = rect.top > estimatedHeight + 12
        ? Math.max(12, rect.top - estimatedHeight - 6)
        : Math.min(window.innerHeight - estimatedHeight - 12, rect.bottom + 6);
      setPosition({ left, top: Math.max(12, top), width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !position || !menu || typeof menu.showPopover !== "function") return;
    if (!menu.matches(":popover-open")) menu.showPopover();
  }, [open, position]);

  const close = () => {
    setOpen(false);
    setQuery("");
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const menu = open && position ? (
    <div
      className="modelsel__menu modelsel__menu--portal"
      role="dialog"
      aria-label="Select model"
      id={menuId}
      popover="manual"
      data-esc-guard
      ref={menuRef}
      style={{ left: position.left, top: position.top, width: position.width }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
        if (!items.length) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        items[(next + items.length) % items.length]?.focus();
      }}
    >
      <div className="modelsel__search">
        <Icon name="search" size={12} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          aria-label="Search models"
          autoFocus
        />
      </div>
      <div className="modelsel__list" role="listbox" aria-label="Models">
        {visible.map((option) => {
          const ready = option.readiness === "ready";
          const hint = option.message ?? option.model.description ?? contextHint(option.model.context);
          return (
            <button
              type="button"
              role="option"
              aria-selected={model === option.model.id}
              aria-disabled={!ready}
              disabled={!ready}
              className={`modelsel__item${model === option.model.id ? " is-sel" : ""}`}
              key={option.model.id}
              onClick={() => {
                onSelectModel(option.model.id);
                close();
              }}
            >
              <span className="modelsel__item-txt">
                <span className="modelsel__item-name">{option.model.name}</span>
                <span className="modelsel__item-hint">
                  <code>{option.model.id}</code>{hint ? ` · ${hint}` : ""}
                </span>
              </span>
              <span className={`modelsel__readiness modelsel__readiness--${option.readiness}`}>
                {ready ? "Ready" : option.readiness === "provider_disconnected" ? "Connect provider" : "Unavailable"}
              </span>
              {model === option.model.id && <Icon name="check" size={13} className="modelsel__item-check" />}
            </button>
          );
        })}
        {visible.length === 0 && <div className="modelsel__empty">No models match.</div>}
      </div>
      <div className="modelsel__foot">
        <button type="button" className="modelsel__add" onClick={onManageModels}>
          <Icon name="settings" size={12} />
          Manage models and provider secrets
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div
      className="modelsel"
      data-esc-guard={open || undefined}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="modelsel__btn"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={selected ? `Model: ${selected.model.name}` : "Select model"}
      >
        <Icon name="bot" size={12} className="modelsel__lead" />
        <b>{selected?.model.name ?? "Select model"}</b>
        <Icon name="chevron-down" size={12} className="modelsel__caret" />
      </button>
      {menu}
    </div>
  );
}
