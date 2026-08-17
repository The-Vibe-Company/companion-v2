import { bumpCompanionSkillRevisionV2 } from "@companion/core";
import type { ActorContext } from "@companion/core/services";
import { withTenantContext } from "@companion/db";

/**
 * Mark every selecting Companion stale after a Skills Hub publish. Runtime v2 applies the new
 * revision after the active turn settles and before the next one; this API path never contacts Box.
 */
export async function syncPublishedSkillToOnlineCompanions(input: {
  orgId: string;
  skillId: string;
  actor: ActorContext;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  // The kill switch blocks claims, not desired-state invalidations. Persist this revision even
  // while runtime execution is disabled so re-enable cannot treat a stale Box as current.
  await withTenantContext(
    { orgId: input.orgId, userId: input.actor.id },
    (database) => bumpCompanionSkillRevisionV2({
      orgId: input.orgId,
      skillId: input.skillId,
      database,
    }),
  );
}
