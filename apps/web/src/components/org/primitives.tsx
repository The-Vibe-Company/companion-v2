"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "../Icon";
import { UserAvatar } from "../UserAvatar";
import type { SeedUser } from "./model";

export function Avatar({ u, size = 30, cls = "og-mav" }: { u: SeedUser; size?: number; cls?: string }) {
  return <UserAvatar className={cls} avatarUrl={u.avatarUrl} initials={u.initials} size={size} />;
}

export function RoleDot({ role }: { role: string }) {
  return <span className={"og-role__dot og-role__dot--" + role} />;
}

/** Modal dialog shell (scrim + Esc to close), shared by invite / create / join / onboarding. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  icon,
  iconDanger,
  title,
  desc,
  children,
  foot,
  onClose,
  closeDisabled = false,
  className = "og-dialog",
}: {
  icon: string;
  iconDanger?: boolean;
  title: string;
  desc: string;
  children?: ReactNode;
  foot?: ReactNode;
  onClose: () => void;
  /** Prevent dismissal while an operation has an ambiguous external outcome. */
  closeDisabled?: boolean;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  onCloseRef.current = onClose;
  closeDisabledRef.current = closeDisabled;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog)?.focus();

    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.target instanceof Element && e.target.closest("[data-esc-guard]")) return;
        e.preventDefault();
        e.stopPropagation();
        if (closeDisabledRef.current) return;
        onCloseRef.current();
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
  }, []);

  return (
    <div className="og-scrim" onMouseDown={(e) => { if (!closeDisabled && e.target === e.currentTarget) onClose(); }}>
      <div className={className} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} ref={dialogRef} tabIndex={-1}>
        <div className="og-dialog__head">
          <span className={"og-dialog__ic" + (iconDanger ? " og-dialog__ic--danger" : "")}>
            <Icon name={icon} size={17} />
          </span>
          <div style={{ flex: 1 }}>
            <h3 className="og-dialog__t" id={titleId}>{title}</h3>
            <p className="og-dialog__d" id={descriptionId}>{desc}</p>
          </div>
          <button className="iconbtn og-dialog__x" onClick={onClose} aria-label="Close" disabled={closeDisabled}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="og-dialog__body">{children}</div>
        <div className="og-dialog__foot">{foot}</div>
      </div>
    </div>
  );
}
