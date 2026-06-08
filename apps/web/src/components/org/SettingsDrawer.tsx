"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { SettingsController } from "./SettingsApp";
import type { SettingsAppData, SettingsDialog, SettingsTab } from "./model";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SettingsDrawer({
  data,
  initialTab,
  initialDialog,
}: {
  data: SettingsAppData;
  initialTab: SettingsTab;
  initialDialog: SettingsDialog;
}) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => router.back(), [router]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      const activeDialog = panel?.querySelector<HTMLElement>(".og-scrim [role='dialog']");
      if (e.key === "Escape") {
        if (activeDialog) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const trapRoot = activeDialog ?? panel;
      const items = Array.from(trapRoot.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
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

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [close]);

  return (
    <div
      className="settings-drawer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="settings-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={panelRef}
        tabIndex={-1}
      >
        <SettingsController data={data} initialTab={initialTab} initialDialog={initialDialog} onClose={close} />
      </div>
    </div>
  );
}
