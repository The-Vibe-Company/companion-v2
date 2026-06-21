"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationRow } from "@companion/contracts";
import { fetchNotifications, fetchUnreadNotificationCount, markNotificationsRead } from "@/lib/queries";
import { Icon } from "../Icon";
import { NotificationPanel } from "./NotificationPanel";

const POLL_MS = 60_000;

/**
 * Bell + unread badge in the sidebar brand row. There are no websockets in this stack, so the count
 * is polled every 60s (and refreshed on window focus and on open). Opening the panel loads the latest
 * notifications and marks the shown unread ones read.
 */
export function NotificationBell({ onOpenSkill }: { onOpenSkill: (slug: string) => void }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
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

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openPanel = useCallback(async () => {
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
  }, [refreshCount]);

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
        type="button"
        className="notif-bell"
        onClick={toggle}
        aria-label={count > 0 ? `Notifications (${count} unread)` : "Notifications"}
        aria-expanded={open}
        title="Notifications"
      >
        <Icon name="bell" size={14} />
        {count > 0 ? <span className="notif-badge">{count > 9 ? "9+" : count}</span> : null}
      </button>
      {open ? <NotificationPanel notifications={items} loading={loading} onOpenItem={onOpenItem} /> : null}
    </div>
  );
}
