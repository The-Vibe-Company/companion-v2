"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import type { OrgVM } from "@/lib/types";
import { orgRole } from "./roles";

/** Sidebar brand-area workspace switcher: switch orgs, or create / join one. */
export function OrgSwitcher({
  orgs,
  current,
  onSwitch,
  onOnboard,
}: {
  orgs: OrgVM[];
  current: OrgVM;
  onSwitch: (id: string) => void;
  onOnboard: (mode: "create" | "join") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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

  return (
    <div className="og-switch" ref={ref}>
      <button className="og-switch__btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <WorkspaceAvatar
          org={current}
          className={"og-switch__av" + (current.kind === "personal" && !current.logoUrl ? " og-switch__av--personal" : "")}
          size={26}
        />
        <span className="og-switch__meta">
          <span className="og-switch__name" title={current.name}>{current.name}</span>
        </span>
        <span className="og-switch__chev">
          <Icon name="chevrons-up-down" size={15} />
        </span>
      </button>
      {open && (
        <div className="og-pop" role="menu">
          <div className="og-pop__label">Switch workspace</div>
          {orgs.map((o) => (
            <button key={o.id} className="og-pop__item" onClick={() => { onSwitch(o.id); setOpen(false); }}>
              <WorkspaceAvatar
                org={o}
                className={"og-switch__av" + (o.kind === "personal" && !o.logoUrl ? " og-switch__av--personal" : "")}
                size={22}
              />
              <span className="og-pop__name">{o.name}</span>
              <span className="og-pop__role">{orgRole(o.myRole).label.toLowerCase()}</span>
              {o.id === current.id && (
                <span className="og-pop__check">
                  <Icon name="check" size={15} />
                </span>
              )}
            </button>
          ))}
          <div className="og-pop__div" />
          <button className="og-pop__action" onClick={() => { onOnboard("create"); setOpen(false); }}>
            <Icon name="plus" size={16} />
            Create workspace
          </button>
          <button className="og-pop__action" onClick={() => { onOnboard("join"); setOpen(false); }}>
            <Icon name="log-in" size={16} />
            Join workspace
          </button>
        </div>
      )}
    </div>
  );
}
