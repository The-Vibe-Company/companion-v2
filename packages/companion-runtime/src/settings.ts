import { RuntimeInvariantError } from "./errors";
import { runtimeSucceeded, type RuntimeWorkDisposition } from "./handler";
import type { LeaseSession } from "./leaseSession";
import type { RuntimeEngineDependencies } from "./ports";
import { retryIdempotentLifecycle, type IdempotentLifecycleCall } from "./retry";
import { activateRuntimeSettings } from "./settingsActivation";
import type { RuntimeObservationInput, SettingsRuntimeClaim } from "./types";

const SETTINGS_ACTIVATION_DEADLINE_MS = 10 * 60 * 1_000;

interface SettingsContext {
  claim: SettingsRuntimeClaim;
  session: LeaseSession;
  deps: RuntimeEngineDependencies;
}

function snapshot(context: SettingsContext) {
  const authorization = context.session.authorization;
  const clientSurface = context.claim.clientSurface;
  const settingsRevision = context.claim.targetSettingsRevision;
  const skillsRevision = context.claim.targetSkillsRevision;
  if (
    !authorization?.authorized
    || !authorization.boxId
    || authorization.runtimeGeneration !== context.claim.runtimeGeneration
    || authorization.desiredSettingsRevision !== settingsRevision
    || authorization.skillsRevision !== skillsRevision
    || skillsRevision === null
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
  const deadlineAt = context.claim.coldStartDeadlineAt
    ?? new Date(context.deps.clock.now().getTime() + SETTINGS_ACTIVATION_DEADLINE_MS);
  const lifecycle = async <T>(
    call: IdempotentLifecycleCall,
    effect: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => await retryIdempotentLifecycle({
    call,
    clock: context.deps.clock,
    jitter: context.deps.jitter,
    signal: context.session.signal,
    deadlineAt,
    operation: async () => await context.session.external(effect),
  });

  for (;;) {
    const authorization = await context.session.reauthorize();
    if (authorization.workCheckpoint === "applied") {
      if (!authorization.piInvocationId) {
        throw new RuntimeInvariantError({
          code: "settings_activation_missing",
          message: "The activated Pi invocation is unavailable.",
          action: "retry",
        });
      }
      await context.session.fencedMutation(async () =>
        await context.deps.store.publishMaterialSnapshot(context.session.fence, {
          piInvocationId: authorization.piInvocationId!,
        }));
      return runtimeSucceeded;
    }
    if (authorization.workCheckpoint !== "applying") {
      throw new RuntimeInvariantError({
        code: "settings_checkpoint_invalid",
        message: "Settings work reached an unsupported checkpoint.",
        action: "none",
      });
    }
    const frozen = snapshot(context);
    const activated = await activateRuntimeSettings({
      expectedSettingsRevision: frozen.settingsRevision,
      expectedSkillsRevision: frozen.skillsRevision,
      previousPiInvocationId: frozen.authorization.piInvocationId,
      deadlineAt,
      clock: context.deps.clock,
      signal: context.session.signal,
      stage: async () => {
        const material = await context.session.fencedMutation(async () =>
          await context.deps.materialProvider.getMaterial({
            store: context.deps.store,
            fence: context.session.fence,
            signal: context.session.signal,
          }));
        return await context.session.external(async (signal) => {
          // `getMaterial` may have completed a fenced OAuth generation CAS. The
          // mandatory pre-Box reauthorization performed by `external` is therefore
          // the authoritative ref set to pair with those material bytes.
          const live = snapshot(context);
          const staged = await context.deps.resourceStager.stageExistingBox({
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
          await context.session.fencedMutation(async () =>
            await context.deps.store.recordMaterialSnapshot(context.session.fence, {
              clientSurface: live.clientSurface,
              materialExpiresAt: staged.materialExpiresAt,
            }));
          return staged;
        });
      },
      restartPi: async () => await lifecycle("restart_pi", async (signal) => {
        const live = snapshot(context);
        return await context.deps.pi.restartPiDaemon({ boxId: live.boxId, signal });
      }),
      observePi: async () => await lifecycle("get_status", async (signal) => {
        const live = snapshot(context);
        return await context.deps.pi.piDaemonStatus({ boxId: live.boxId, signal });
      }),
    });
    const observation: Omit<RuntimeObservationInput, "expectedSequence"> = {
      runtimeGeneration: context.claim.runtimeGeneration,
      observedAt: context.deps.clock.now(),
      piState: activated.piState,
      piInvocationId: activated.piInvocationId,
      appliedSettingsRevision: activated.appliedSettingsRevision,
    };
    if (activated.appliedSkillsRevision !== null) {
      observation.appliedSkillsRevision = activated.appliedSkillsRevision;
    }
    await context.session.observe(observation);
    await context.session.fencedMutation(async () =>
      await context.deps.store.publishMaterialSnapshot(context.session.fence, {
        piInvocationId: activated.piInvocationId,
      }));
    return runtimeSucceeded;
  }
}
