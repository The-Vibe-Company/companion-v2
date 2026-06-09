"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button, EmptyState } from "@/components/cds";
import { SettingsController } from "./SettingsApp";
import type { SettingsAppData, SettingsDialog, SettingsTab } from "./model";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SettingsDrawerBackgroundGuard() {
  useEffect(() => {
    const drawer = document.querySelector<HTMLElement>(".settings-drawer");
    const parent = drawer?.parentElement;
    if (!drawer || !parent) return;

    const hiddenSiblings = Array.from(parent.children)
      .filter((node): node is HTMLElement => (
        node instanceof HTMLElement
        && node !== drawer
        && !node.contains(drawer)
        && node.tagName !== "SCRIPT"
        && node.tagName !== "STYLE"
        && node.tagName !== "NEXTJS-PORTAL"
        && node.tagName !== "NEXT-ROUTE-ANNOUNCER"
      ))
      .map((element) => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute("aria-hidden"),
      }));

    for (const { element } of hiddenSiblings) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }

    return () => {
      for (const { element, inert, ariaHidden } of hiddenSiblings) {
        element.inert = inert;
        if (ariaHidden === null) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", ariaHidden);
        }
      }
    };
  }, []);

  return null;
}

export function SettingsDrawer({
  data,
  initialTab,
  initialDialog,
  onRefreshData,
}: {
  data: SettingsAppData;
  initialTab: SettingsTab;
  initialDialog: SettingsDialog;
  onRefreshData?: () => Promise<SettingsAppData | null>;
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
      <SettingsDrawerBackgroundGuard />
      <div
        className="settings-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={panelRef}
        tabIndex={-1}
      >
        <SettingsController
          data={data}
          initialTab={initialTab}
          initialDialog={initialDialog}
          onClose={close}
          onRefreshData={onRefreshData}
        />
      </div>
    </div>
  );
}

export function SettingsDrawerError({
  message,
  busy,
  onClose,
  onRetry,
}: {
  message: string;
  busy: boolean;
  onClose: () => void;
  onRetry: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="settings-drawer">
      <SettingsDrawerBackgroundGuard />
      <div
        className="settings-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="og-set">
          <div className="og-set__top">
            <button className="og-set__back" onClick={onClose}>
              Back to skills
            </button>
            <div className="og-set__crumb">
              <b>Companion</b>
            </div>
          </div>
          <div className="og-pane">
            <div className="og-pane__inner">
              <EmptyState
                title="Couldn't load workspace"
                description={message}
                action={
                  <Button type="button" variant="secondary" disabled={busy} onClick={onRetry}>
                    Retry
                  </Button>
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
