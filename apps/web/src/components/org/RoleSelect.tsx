"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { RoleDot } from "./primitives";
import { ORG_ROLES, ORG_ROLE_ORDER, type RoleDef } from "./roles";

/** Role pick-list (button + popover). Disabled shows just the dot+label with a lock reason. */
export function RoleSelect({
  role,
  roles,
  order,
  canManage,
  lockReason,
  onChange,
}: {
  role: string;
  roles?: Record<string, RoleDef>;
  order?: string[];
  canManage: boolean;
  lockReason?: string;
  onChange: (r: string) => void;
}) {
  const map = roles || ORG_ROLES;
  const ord = order || ORG_ROLE_ORDER;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open]);

  const disabled = !canManage;
  return (
    <span className="og-role" ref={ref}>
      <button
        className="og-role__btn"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={disabled ? lockReason || "" : "Change role"}
      >
        <RoleDot role={role} />
        {map[role] ? map[role].label : role}
        <span className="caret">
          <Icon name="chevron-down" size={13} />
        </span>
      </button>
      {open && (
        <div className="og-menu" role="menu">
          {ord.map((r) => (
            <button key={r} className="og-menu__item" onClick={() => { onChange(r); setOpen(false); }}>
              <RoleDot role={r} />
              <span className="og-menu__txt">
                <div className="og-menu__name">{map[r]?.label ?? r}</div>
                <div className="og-menu__desc">{map[r]?.desc ?? ""}</div>
              </span>
              {r === role && (
                <span className="og-menu__check">
                  <Icon name="check" size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
