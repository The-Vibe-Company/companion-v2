"use client";

import { useEffect, type ReactNode } from "react";
import { Icon } from "../Icon";
import type { SeedUser } from "./model";

export function Avatar({ u, size = 30, cls = "og-mav" }: { u: SeedUser; size?: number; cls?: string }) {
  return (
    <span className={cls} style={{ width: size, height: size }}>
      {u.initials}
    </span>
  );
}

export function RoleDot({ role }: { role: string }) {
  return <span className={"og-role__dot og-role__dot--" + role} />;
}

/** Modal dialog shell (scrim + Esc to close), shared by invite / create / join / onboarding. */
export function Dialog({
  icon,
  title,
  desc,
  children,
  foot,
  onClose,
  className = "og-dialog",
}: {
  icon: string;
  title: string;
  desc: string;
  children?: ReactNode;
  foot?: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="og-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={className} role="dialog" aria-modal="true">
        <div className="og-dialog__head">
          <span className="og-dialog__ic">
            <Icon name={icon} size={17} />
          </span>
          <div style={{ flex: 1 }}>
            <h3 className="og-dialog__t">{title}</h3>
            <p className="og-dialog__d">{desc}</p>
          </div>
          <button className="iconbtn og-dialog__x" onClick={onClose} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="og-dialog__body">{children}</div>
        <div className="og-dialog__foot">{foot}</div>
      </div>
    </div>
  );
}
