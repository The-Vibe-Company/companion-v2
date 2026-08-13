import type { Companion } from "@companion/contracts";

/**
 * The shared Box a Companion reads its chip from. THE-330 made the Box a workspace resource: every
 * Companion of a team workspace shares one org Box, and a personal workspace shares one Box per
 * owner. The key mirrors the pool the API projects from, so a runtime answer read for one Companion
 * is an answer for every Companion that runs on the same Box.
 */
export function companionPoolKey(companion: Companion, orgKind: "personal" | "team"): string {
  return orgKind === "personal" ? `personal:${companion.owner_id}` : "org";
}

/**
 * The pool-owned half of a runtime projection, re-scoped for the Companion it is being applied to.
 * Only the provider selection belongs to the Companion itself; everything else describes the shared
 * Box. A Viewer never receives the Box id or the desktop flag, so the broadcast withholds them the
 * same way the read model does, and it never invents an error line for a reader the server would
 * word it differently for: a state that is not `error` simply clears the previous reason.
 */
function poolRuntime(target: Companion, pool: Companion["runtime"]): Companion["runtime"] {
  const viewer = target.access === "viewer";
  return {
    ...pool,
    provider_ids: target.runtime.provider_ids,
    box_id: viewer ? null : pool.box_id,
    desktop_available: viewer ? false : pool.desktop_available,
    last_error: pool.state !== "error"
      ? null
      : (viewer ? target.runtime.last_error : pool.last_error),
  };
}

/**
 * Apply one runtime answer — a wake, a stop, a status read, a live observation — to every loaded
 * Companion that shares the answered Box. Without this a wake updates only the Companion it was
 * pressed on, and opening a sibling shows the chip from before the wake even though both run on the
 * same machine.
 *
 * A Viewer's projection carries no Box id, so it can only speak for the Companion it was read for.
 */
export function applyCompanionRuntime(
  companions: Companion[],
  updated: Companion,
  orgKind: "personal" | "team",
): Companion[] {
  const shared = updated.access !== "viewer";
  const key = companionPoolKey(updated, orgKind);
  return companions.map((companion) => {
    if (companion.id === updated.id) return updated;
    if (!shared || companionPoolKey(companion, orgKind) !== key) return companion;
    return { ...companion, runtime: poolRuntime(companion, updated.runtime) };
  });
}
