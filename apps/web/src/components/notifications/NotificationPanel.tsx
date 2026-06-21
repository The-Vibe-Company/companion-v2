"use client";

import { useEffect, useState } from "react";
import type { NotificationRow } from "@companion/contracts";
import { Icon } from "../Icon";
import { notificationSnippet, notificationText, relativeTime } from "./notificationCopy";

/** Lucide icon name per notification type. */
function iconFor(n: NotificationRow): string {
  if (n.type === "skill.comment_reply" || n.type === "skill.comment_added") return "reply";
  if (n.type === "skill.archived") return "archive";
  return "arrow-up-circle";
}

export function NotificationPanel({
  notifications,
  loading,
  onOpenItem,
}: {
  notifications: NotificationRow[];
  loading: boolean;
  onOpenItem: (n: NotificationRow) => void;
}) {
  // Stamp "now" once on mount so relative times don't recompute every render (and stay SSR-safe).
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="notif-panel" role="region" aria-label="Notifications">
      <div className="notif-panel__head">Notifications</div>
      {loading && notifications.length === 0 ? (
        <div className="notif-panel__empty">Loading…</div>
      ) : notifications.length === 0 ? (
        <div className="notif-panel__empty">No notifications.</div>
      ) : (
        <ul className="notif-panel__list">
          {notifications.map((n) => {
            const snippet = notificationSnippet(n);
            return (
              <li key={n.id}>
                <button
                  type="button"
                  className={"notif-item" + (n.read_at ? "" : " notif-item--unread")}
                  onClick={() => onOpenItem(n)}
                >
                  <span className="notif-item__icon">
                    <Icon name={iconFor(n)} size={15} />
                  </span>
                  <span className="notif-item__body">
                    <span className="notif-item__title">{notificationText(n)}</span>
                    {snippet ? <span className="notif-item__snippet">{snippet}</span> : null}
                    <span className="notif-item__time">{relativeTime(n.created_at, now)}</span>
                  </span>
                  {n.read_at ? null : <span className="notif-item__dot" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
