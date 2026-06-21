import type { NotificationRow } from "@companion/contracts";

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Relationship-aware copy for a notification. The same event reads differently depending on WHY the
 * recipient got it (their `reason`) — an installer sees "update available", a starrer just "new
 * version", a thread participant "replied to your comment".
 */
export function notificationText(n: NotificationRow): string {
  const slug = str(n.metadata.slug) ?? n.skill_slug;
  const actor = str(n.actor_name) ?? "Someone";
  const version = str(n.metadata.version);

  if (n.type === "skill.version_published") {
    if (n.reason === "installer") return `Update available for ${slug}${version ? ` (v${version})` : ""}`;
    return `New version of ${slug}${version ? ` (v${version})` : ""}`;
  }
  if (n.type === "skill.comment_reply") {
    if (n.reason === "thread_participant") return `${actor} replied to your comment on ${slug}`;
    if (n.reason === "owner") return `${actor} replied in a thread on your skill ${slug}`;
    return `${actor} replied in a thread on ${slug}`;
  }
  if (n.type === "skill.comment_added") return `${actor} commented on ${slug}`;
  if (n.type === "skill.archived") return `${slug} was archived`;
  return `Activity on ${slug}`;
}

/** A short snippet to show under the title for reply notifications (the reply body). */
export function notificationSnippet(n: NotificationRow): string | null {
  return str(n.metadata.snippet);
}

/** Compact relative time ("just now", "3m", "2h", "5d") — no dependency, stable for SSR-free use. */
export function relativeTime(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}
