"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { NotificationRow } from "@companion/contracts";
import { fetchNotifications, fetchUnreadNotificationCount, markNotificationsRead } from "@/lib/queries";
import { Icon } from "../Icon";
import { NotificationPanel } from "./NotificationPanel";

const POLL_MS = 60_000;

/**
 * "Notifications" sidebar nav entry (below My skills) + unread badge. There are no websockets in this
 * stack, so the count is polled every 60s (and refreshed on window focus and on open). The dropdown is
 * rendered `position: fixed`, anchored to the nav item, because the sidebar nav has `overflow-y: auto`
 * which would otherwise clip an absolutely-positioned panel. Opening the panel loads the latest
 * notifications and marks the shown unread ones read.
 */
export function NotificationBell({ onOpenSkill }: { onOpenSkill: (slug: string) => void }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [panelPos, setPanelPos] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshCount = useCallback(async () => {
    try {
      const next = await fetchUnreadNotificationCount();
      // Guard against a poll/focus response landing after unmount.
      if (mountedRef.current) setCount(next);
    } catch {
      // Best-effort: a failed poll just leaves the last known count.
    }
  }, []);

  // Poll the unread count, and refresh when the tab regains focus.
  useEffect(() => {
    void refreshCount();
    const timer = setInterval(refreshCount, POLL_MS);
    const onFocus = () => void refreshCount();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshCount]);

  // Anchor the fixed panel just below the nav item, opening rightward from its left edge.
  const positionPanel = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setPanelPos({ top: Math.round(rect.bottom + 6), left: Math.round(rect.left) });
  }, []);

  // Close on outside click / Escape; reposition while open if the viewport changes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => positionPanel();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, positionPanel]);

  const openPanel = useCallback(async () => {
    positionPanel();
    setOpen(true);
    setLoading(true);
    try {
      const rows = await fetchNotifications({ limit: 30 });
      setItems(rows);
      const unreadIds = rows.filter((r) => !r.read_at).map((r) => r.id);
      if (unreadIds.length) {
        setCount(0); // optimistic
        await markNotificationsRead({ ids: unreadIds });
        // Reflect read state locally so the dots clear without a refetch.
        setItems((prev) => prev.map((r) => (unreadIds.includes(r.id) ? { ...r, read_at: new Date().toISOString() } : r)));
        void refreshCount();
      }
    } catch {
      // Leave whatever we have; the badge will recover on the next poll.
    } finally {
      setLoading(false);
    }
  }, [positionPanel, refreshCount]);

  const toggle = useCallback(() => {
    if (open) setOpen(false);
    else void openPanel();
  }, [open, openPanel]);

  const onOpenItem = useCallback(
    (n: NotificationRow) => {
      setOpen(false);
      onOpenSkill(n.skill_slug);
    },
    [onOpenSkill],
  );

  return (
    <div className="notif" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={"navitem notif-nav" + (open ? " navitem--active" : "")}
        onClick={toggle}
        aria-expanded={open}
        aria-label={count > 0 ? `Notifications (${count} unread)` : "Notifications"}
        title="Notifications"
      >
        <span className="navitem__ico">
          <Icon name="bell" />
        </span>
        <span className="navitem__label">Notifications</span>
        {count > 0 ? <span className="notif-navcount">{count > 99 ? "99+" : count}</span> : null}
      </button>
      {open ? (
        <NotificationPanel notifications={items} loading={loading} onOpenItem={onOpenItem} style={panelPos} />
      ) : null}
    </div>
  );
}
