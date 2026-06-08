"use client";

import { useEffect, useRef, type ReactNode } from "react";
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
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog)?.focus();

    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (item) => item.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", k, true);
    return () => {
      document.removeEventListener("keydown", k, true);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="og-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={className} role="dialog" aria-modal="true" ref={dialogRef} tabIndex={-1}>
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
