import type { Companion } from "@companion/contracts";

/**
 * When this reader last had each Companion's thread open, kept per device.
 *
 * Read state is a property of the person and the browser they are reading in, not of the workspace,
 * so it stays in `localStorage` rather than becoming a synced control-plane fact: a Companion is
 * shared, and one member opening a thread must not mark it read for everybody else. Storage is
 * addressed by organization so switching workspaces cannot leak one workspace's read state onto
 * another's rows.
 */
export type CompanionViewedMap = Record<string, string>;

function storageKey(orgId: string): string {
  return `companions:last-viewed:${orgId}`;
}

/** Every access is guarded: private mode, a full quota, and a disabled store all read as "unread". */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readViewed(orgId: string): CompanionViewedMap {
  try {
    const raw = storage()?.getItem(storageKey(orgId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const viewed: CompanionViewedMap = {};
    for (const [companionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") viewed[companionId] = value;
    }
    return viewed;
  } catch {
    return {};
  }
}

/**
 * Record that this reader has the thread open, and answer with the map that now applies. A stored
 * timestamp only ever moves forward, so a slow poll answering after a newer one cannot make a thread
 * unread again.
 */
export function markViewed(
  orgId: string,
  companionId: string,
  iso: string,
): CompanionViewedMap {
  const current = readViewed(orgId);
  if (current[companionId] && current[companionId]! >= iso) return current;
  const next = { ...current, [companionId]: iso };
  try {
    storage()?.setItem(storageKey(orgId), JSON.stringify(next));
  } catch {
    // A device that cannot remember what was read shows the dot again; that is the safe direction.
  }
  return next;
}

/**
 * Whether someone else has written on this thread since this reader last opened it.
 *
 * A reader's own message is never unread — the surface would otherwise mark every thread the moment
 * it was written in — and a thread that has never been opened is unread as soon as it has a message,
 * because "never looked" and "looked before this arrived" mean the same thing to the reader.
 */
export function isUnread(
  companion: Pick<Companion, "id" | "last_message">,
  viewerId: string,
  viewed: CompanionViewedMap,
): boolean {
  const last = companion.last_message;
  if (!last) return false;
  if (last.author_id !== null && last.author_id === viewerId) return false;
  const seenAt = viewed[companion.id];
  if (!seenAt) return true;
  return last.created_at > seenAt;
}
