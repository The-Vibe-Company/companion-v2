import { RuntimeInvariantError } from "./errors";
import { runtimeSucceeded, type RuntimeWorkDisposition } from "./handler";
import type { LeaseSession } from "./leaseSession";
import type { RuntimeEngineDependencies } from "./ports";
import type { RuntimeAuthorization, SettingsRuntimeClaim } from "./types";

interface SettingsContext {
  claim: SettingsRuntimeClaim;
  session: LeaseSession;
  deps: RuntimeEngineDependencies;
}

function snapshot(context: SettingsContext): {
  authorization: RuntimeAuthorization;
  clientSurface: SettingsRuntimeClaim["clientSurface"];
  settingsRevision: bigint;
  skillsRevision: number | null;
  boxId: string;
} {
  const authorization = context.session.authorization;
  const clientSurface = context.claim.clientSurface;
  const settingsRevision = context.claim.targetSettingsRevision;
  const skillsRevision = clientSurface === "native_mobile"
    ? null
    : context.claim.targetSkillsRevision;
  if (
    !authorization?.authorized
    || !authorization.boxId
    || authorization.runtimeGeneration !== context.claim.runtimeGeneration
    || authorization.desiredSettingsRevision !== settingsRevision
    || (clientSurface !== "native_mobile" && authorization.skillsRevision !== skillsRevision)
    || (clientSurface !== "native_mobile" && skillsRevision === null)
  ) {
    throw new RuntimeInvariantError({
      code: "settings_snapshot_invalid",
      message: "The claimed settings snapshot is no longer valid.",
      action: "retry",
    });
  }
  return {
    authorization,
    clientSurface,
    settingsRevision,
    skillsRevision,
    boxId: authorization.boxId,
  };
}

export async function handleSettings(
  context: SettingsContext,
): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    if (authorization.workCheckpoint === "applied") return runtimeSucceeded;
    if (authorization.workCheckpoint !== "applying") {
      throw new RuntimeInvariantError({
        code: "settings_checkpoint_invalid",
        message: "Settings work reached an unsupported checkpoint.",
        action: "none",
      });
    }
    const frozen = snapshot(context);
    const material = await context.session.fencedMutation(async () =>
      await context.deps.materialProvider.getMaterial({
        store: context.deps.store,
        fence: context.session.fence,
      }));
    const staged = await context.session.external(async (signal) => {
      // `getMaterial` may have completed a fenced OAuth generation CAS. The
      // mandatory pre-Box reauthorization performed by `external` is therefore
      // the authoritative ref set to pair with those material bytes.
      const live = snapshot(context);
      return await context.deps.resourceStager.stageExistingBox({
        orgId: context.claim.orgId,
        companionId: context.claim.companionId,
        boxId: live.boxId,
        allowBoxCreate: false,
        authorization: live.authorization,
        material,
        clientSurface: live.clientSurface,
        targetSettingsRevision: live.settingsRevision,
        targetSkillsRevision: live.skillsRevision,
        signal,
      });
    });
    if (
      staged.diskLayoutVersion !== 14
      || staged.appliedSettingsRevision !== frozen.settingsRevision
      || staged.appliedSkillsRevision !== frozen.skillsRevision
    ) {
      throw new RuntimeInvariantError({
        code: "settings_apply_mismatch",
        message: "The Box did not apply the exact claimed settings snapshot.",
        action: "retry",
      });
    }
    await context.session.observe({
      runtimeGeneration: context.claim.runtimeGeneration,
      observedAt: context.deps.clock.now(),
      appliedSettingsRevision: frozen.settingsRevision,
      ...(frozen.skillsRevision === null
        ? {}
        : { appliedSkillsRevision: frozen.skillsRevision }),
    });
  }
}
