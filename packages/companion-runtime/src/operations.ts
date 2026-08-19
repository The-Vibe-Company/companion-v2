import { AmbiguousExternalEffectError, RuntimeInvariantError } from "./errors";
import { mustAbandonRuntimeExecution } from "./executionControl";
import { runtimeSucceeded, type RuntimeWorkDisposition } from "./handler";
import type { LeaseSession } from "./leaseSession";
import type {
  BoxCreateResult,
  GenerationBox,
  GenerationBoxDiscovery,
  RuntimeEngineDependencies,
} from "./ports";
import { retryIdempotentLifecycle, type IdempotentLifecycleCall } from "./retry";
import {
  activateRuntimeSettings,
  type StagedRuntimeSettings,
} from "./settingsActivation";
import type {
  DuplicateCleanup,
  OperationRuntimeClaim,
  RuntimeAuthorization,
} from "./types";

export const BOX_WARM_TTL_SECONDS = 21_600;
const PROVIDER_POLL_INTERVAL_MS = 1_000;
const ABSENCE_CONFIRMATION_INTERVAL_MS = 30_000;
const PROVIDER_CALL_DEADLINE_MS = 30_000;
const OPERATION_DEADLINE_MS = 10 * 60 * 1_000;

interface OperationContext {
  claim: OperationRuntimeClaim;
  session: LeaseSession;
  deps: RuntimeEngineDependencies;
}

function isProviderNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { status?: unknown }).status === 404);
}

function requiredAuthorization(session: LeaseSession): RuntimeAuthorization {
  const authorization = session.authorization;
  if (!authorization?.authorized || authorization.runtimeGeneration === null) {
    throw new RuntimeInvariantError({
      code: "runtime_authorization_missing",
      message: "Runtime authorization was unavailable at an execution checkpoint.",
      action: "none",
    });
  }
  return authorization;
}

function requiredBoxId(session: LeaseSession): string {
  const boxId = requiredAuthorization(session).boxId;
  if (!boxId) {
    throw new RuntimeInvariantError({
      code: "box_unavailable",
      message: "The Companion Box is unavailable.",
      action: "restart_box",
    });
  }
  return boxId;
}

function workDeadline(context: OperationContext): Date {
  const operationDeadline = new Date(
    context.claim.operationStartedAt.getTime() + OPERATION_DEADLINE_MS,
  );
  const durable = requiredAuthorization(context.session).coldStartDeadlineAt
    ?? requiredAuthorization(context.session).absoluteDeadlineAt;
  return durable && durable < operationDeadline ? durable : operationDeadline;
}

function providerCallDeadline(context: OperationContext): Date {
  const local = new Date(context.deps.clock.now().getTime() + PROVIDER_CALL_DEADLINE_MS);
  const durable = workDeadline(context);
  return durable < local ? durable : local;
}

function requirePollingBudget(context: OperationContext, code: string, message: string): void {
  if (context.deps.clock.now().getTime() >= workDeadline(context).getTime()) {
    throw new RuntimeInvariantError({ code, message, action: "retry" });
  }
}

async function lifecycle<T>(
  context: OperationContext,
  call: IdempotentLifecycleCall,
  effect: (input: { signal: AbortSignal; authorization: RuntimeAuthorization }) => Promise<T>,
): Promise<T> {
  return await retryIdempotentLifecycle({
    call,
    clock: context.deps.clock,
    jitter: context.deps.jitter,
    signal: context.session.signal,
    deadlineAt: workDeadline(context),
    operation: async () => await context.session.external(async (signal) => await effect({
      signal,
      authorization: requiredAuthorization(context.session),
    })),
  });
}

async function observe(
  context: OperationContext,
  observation: Omit<Parameters<LeaseSession["observe"]>[0], "runtimeGeneration" | "observedAt">,
): Promise<void> {
  await context.session.observe({
    runtimeGeneration: context.claim.runtimeGeneration,
    observedAt: context.deps.clock.now(),
    ...observation,
  });
}

function exactGenerationName(claim: OperationRuntimeClaim): string {
  return `Companion ${claim.companionId} g${claim.runtimeGeneration.toString()}`;
}

function normalizedDiscovery(
  claim: OperationRuntimeClaim,
  discovery: GenerationBoxDiscovery,
  preferredBoxId: string | null,
): { canonical: GenerationBox | null; duplicates: GenerationBox[] } {
  if (discovery.name !== exactGenerationName(claim)) {
    throw new RuntimeInvariantError({
      code: "box_discovery_contract_invalid",
      message: "Box discovery returned an unexpected generation name.",
      action: "none",
    });
  }
  const boxes = new Map<string, GenerationBox>();
  for (const box of [discovery.canonical, ...discovery.duplicates]) {
    if (!box) continue;
    if (box.name !== discovery.name) {
      throw new RuntimeInvariantError({
        code: "box_discovery_contract_invalid",
        message: "Box discovery returned a non-matching resource.",
        action: "none",
      });
    }
    boxes.set(box.id, box);
  }
  const ordered = [...boxes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const canonical = preferredBoxId
    ? boxes.get(preferredBoxId) ?? null
    : ordered[0] ?? null;
  if (preferredBoxId && !canonical) {
    throw new RuntimeInvariantError({
      code: "box_identity_conflict",
      message: "Provider discovery did not contain the recorded Companion Box.",
      action: "none",
    });
  }
  return {
    canonical,
    duplicates: ordered.filter((box) => box.id !== canonical?.id),
  };
}

async function discover(context: OperationContext): Promise<{
  canonical: GenerationBox | null;
  duplicates: GenerationBox[];
}> {
  const result = await lifecycle(context, "list_boxes", async ({ signal }) =>
    await context.deps.box.findGenerationBoxes({
      companionId: context.claim.companionId,
      generation: context.claim.runtimeGeneration,
      deadlineAt: providerCallDeadline(context),
      signal,
    }));
  return normalizedDiscovery(context.claim, result, requiredAuthorization(context.session).boxId);
}

async function updateDuplicate(
  context: OperationContext,
  cleanup: DuplicateCleanup,
  nextStatus: DuplicateCleanup["status"],
  providerOperationId?: string,
): Promise<DuplicateCleanup> {
  return await context.session.fencedMutation(async () =>
    await context.deps.store.checkpointDuplicateCleanup(context.session.fence, {
      boxId: cleanup.boxId,
      expectedSequence: cleanup.checkpointSequence,
      nextStatus,
      ...(providerOperationId ? { providerOperationId } : {}),
    }));
}

async function deleteDuplicate(context: OperationContext, initial: DuplicateCleanup): Promise<void> {
  let cleanup = initial;
  if (cleanup.status === "pending") {
    let requested;
    try {
      requested = await lifecycle(context, "request_delete", async ({ signal }) =>
        await context.deps.box.requestPermanentDeletion({ boxId: cleanup.boxId, signal }));
    } catch (error) {
      if (!isProviderNotFound(error)) throw error;
      requested = { outcome: "absent" } as const;
    }
    cleanup = requested.outcome === "absent"
      ? await updateDuplicate(context, cleanup, "already_deleted")
      : await updateDuplicate(context, cleanup, "delete_requested", requested.operationId);
  }
  if (cleanup.status === "delete_requested") {
    cleanup = await updateDuplicate(
      context,
      cleanup,
      "waiting_deleted",
      cleanup.providerOperationId ?? undefined,
    );
  }
  while (cleanup.status === "waiting_deleted") {
    requirePollingBudget(
      context,
      "duplicate_box_delete_deadline_exceeded",
      "A duplicate Box did not finish deleting before its deadline.",
    );
    const operationId = cleanup.providerOperationId;
    if (!operationId) {
      throw new RuntimeInvariantError({
        code: "duplicate_delete_operation_missing",
        message: "Duplicate Box deletion lost its provider operation id.",
        action: "none",
      });
    }
    let result;
    try {
      result = await lifecycle(context, "poll_delete", async ({ signal }) =>
        await context.deps.box.pollPermanentDeletion({
          boxId: cleanup.boxId,
          operationId,
          signal,
        }));
    } catch (error) {
      if (!isProviderNotFound(error)) throw error;
      cleanup = await updateDuplicate(context, cleanup, "already_deleted", operationId);
      break;
    }
    if (result.status === "completed") {
      cleanup = await updateDuplicate(context, cleanup, "deleted", operationId);
      break;
    }
    // `blocked` is an in-progress provider status: poll until `completed` or the deadline.
    await context.deps.clock.sleep(PROVIDER_POLL_INTERVAL_MS, context.session.signal);
  }
  // SQL treats persisted duplicate-cleanup `blocked` as terminal (completed_at set, no resume
  // transition). New polls no longer write that status; this guard only covers leftover rows.
  if (cleanup.status === "blocked") {
    throw new RuntimeInvariantError({
      code: "duplicate_box_delete_blocked",
      message: "A duplicate generation Box could not be permanently deleted.",
      action: "none",
    });
  }
}

async function cleanDuplicates(context: OperationContext, duplicates: GenerationBox[]): Promise<void> {
  const cleanups = await context.session.fencedMutation(async () =>
    await context.deps.store.registerDuplicateCleanups(
      context.session.fence,
      duplicates.map((box) => box.id),
    ));
  for (const cleanup of cleanups) await deleteDuplicate(context, cleanup);
}

async function boxStatus(context: OperationContext, boxId: string): Promise<GenerationBox["state"]> {
  try {
    return (await lifecycle(context, "get_status", async ({ signal }) =>
      await context.deps.box.getStatus({ boxId, signal }))).state;
  } catch (error) {
    if (isProviderNotFound(error)) return "absent";
    throw error;
  }
}

function isReady(state: GenerationBox["state"]): boolean {
  return state === "ready" || state === "idle" || state === "running";
}

function logStageTiming(
  context: OperationContext,
  stage: "waiting_ready" | "installing_layout" | "starting_pi",
  startedAt: number,
): void {
  context.deps.log?.info({
    ts: context.deps.clock.now().toISOString(),
    event: "runtime.operation.stage",
    stage,
    durationMs: Math.max(0, context.deps.clock.now().getTime() - startedAt),
    companionId: context.claim.companionId,
    operationKind: context.claim.operationKind,
    boxId: context.session.authorization?.boxId ?? null,
  });
}

async function waitForReadyBox(context: OperationContext): Promise<void> {
  const startedAt = context.deps.clock.now().getTime();
  const boxId = requiredBoxId(context.session);
  for (;;) {
    requirePollingBudget(
      context,
      "box_start_deadline_exceeded",
      "The Companion Box did not become ready before its deadline.",
    );
    const state = await boxStatus(context, boxId);
    await observe(context, { boxId, boxState: state ?? "unknown" });
    if (isReady(state)) {
      logStageTiming(context, "waiting_ready", startedAt);
      return;
    }
    if (state === "absent" || state === "archived" || state === "error") {
      throw new RuntimeInvariantError({
        code: "box_start_failed",
        message: "The Companion Box did not become ready.",
        action: "restart_box",
      });
    }
    await context.deps.clock.sleep(PROVIDER_POLL_INTERVAL_MS, context.session.signal);
  }
}

async function stageCapturedResources(context: OperationContext): Promise<StagedRuntimeSettings> {
  const startedAt = context.deps.clock.now().getTime();
  const authorization = requiredAuthorization(context.session);
  if (
    authorization.clientSurface === null
    || authorization.desiredSettingsRevision === null
    || (authorization.clientSurface !== "native_mobile" && authorization.skillsRevision === null)
  ) {
    throw new RuntimeInvariantError({
      code: "runtime_resource_snapshot_missing",
      message: "The captured runtime resource snapshot is incomplete.",
      action: "none",
    });
  }
  const clientSurface = authorization.clientSurface;
  const targetSettingsRevision = authorization.desiredSettingsRevision;
  const targetSkillsRevision = clientSurface === "native_mobile"
    ? null
    : authorization.skillsRevision;
  const material = await context.session.fencedMutation(async () =>
    await context.deps.materialProvider.getMaterial({
      store: context.deps.store,
      fence: context.session.fence,
      signal: context.session.signal,
    }));
  const staged = await context.session.external(async (signal) =>
    await context.deps.resourceStager.stageExistingBox({
      orgId: context.claim.orgId,
      companionId: context.claim.companionId,
      boxId: requiredBoxId(context.session),
      allowBoxCreate: false,
      authorization: requiredAuthorization(context.session),
      material,
      clientSurface,
      targetSettingsRevision,
      targetSkillsRevision,
      signal,
    }));
  logStageTiming(context, "installing_layout", startedAt);
  return staged;
}

async function observeStagedResources(
  context: OperationContext,
  staged: StagedRuntimeSettings,
): Promise<void> {
  await observe(context, {
    diskLayoutVersion: staged.diskLayoutVersion,
    appliedSettingsRevision: staged.appliedSettingsRevision,
    ...(staged.appliedSkillsRevision === null
      ? {}
      : { appliedSkillsRevision: staged.appliedSkillsRevision }),
  });
}

async function startAndObservePi(context: OperationContext): Promise<void> {
  const startedAt = context.deps.clock.now().getTime();
  const previousInvocationId = requiredAuthorization(context.session).piInvocationId;
  const recycleWarmPi = context.claim.operationKind === "start" && previousInvocationId !== null;
  const result = await lifecycle(context, "start_pi", async ({ signal }) =>
    recycleWarmPi
      ? await context.deps.pi.restartPiDaemon({ boxId: requiredBoxId(context.session), signal })
      : await context.deps.pi.startPiDaemon({ boxId: requiredBoxId(context.session), signal }));
  if (
    result.state !== "idle"
    || !result.invocationId
    || (previousInvocationId !== null && result.invocationId === previousInvocationId)
  ) {
    throw new RuntimeInvariantError({
      code: "pi_start_failed",
      message: "Pi did not expose a new idle invocation after start.",
      action: "restart_pi",
    });
  }
  await observe(context, { piState: "idle", piInvocationId: result.invocationId });
  logStageTiming(context, "starting_pi", startedAt);
}

async function handleStart(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending":
        await context.session.checkpoint({ nextCheckpoint: "resolving_box" });
        break;
      case "resolving_box": {
        const discovery = await discover(context);
        await cleanDuplicates(context, discovery.duplicates);
        if (!discovery.canonical) {
          await observe(context, { boxState: "absent" });
          break;
        }
        const state = discovery.canonical.state
          ?? await boxStatus(context, discovery.canonical.id)
          ?? "unknown";
        await lifecycle(context, "apply_box_settings", async ({ signal }) =>
          await context.deps.box.applyGenerationBoxSettings({
            boxId: discovery.canonical!.id,
            companionId: context.claim.companionId,
            generation: context.claim.runtimeGeneration,
            ttlSeconds: BOX_WARM_TTL_SECONDS,
            deadlineAt: providerCallDeadline(context),
            signal,
          }));
        await observe(context, {
          boxId: discovery.canonical.id,
          boxState: state,
        });
        break;
      }
      case "box_absence_observed":
        await context.session.checkpoint({ nextCheckpoint: "creating_box" });
        break;
      case "creating_box": {
        // A takeover may reconcile the deterministic name, but it must never resend the POST.
        if (context.claim.checkpoint === "creating_box") {
          const discovery = await discover(context);
          await cleanDuplicates(context, discovery.duplicates);
          if (!discovery.canonical) throw new AmbiguousExternalEffectError("box_create_ambiguous");
          await lifecycle(context, "apply_box_settings", async ({ signal }) =>
            await context.deps.box.applyGenerationBoxSettings({
              boxId: discovery.canonical!.id,
              companionId: context.claim.companionId,
              generation: context.claim.runtimeGeneration,
              ttlSeconds: BOX_WARM_TTL_SECONDS,
              deadlineAt: providerCallDeadline(context),
              signal,
            }));
          await observe(context, {
            boxId: discovery.canonical.id,
            boxState: discovery.canonical.state ?? "unknown",
          });
          break;
        }
        let result: BoxCreateResult;
        let providerCallStarted = false;
        try {
          result = await context.session.external(async (signal) => {
            const deadlineAt = providerCallDeadline(context);
            providerCallStarted = true;
            return await context.deps.box.createGenerationBox({
              companionId: context.claim.companionId,
              generation: context.claim.runtimeGeneration,
              ttlSeconds: BOX_WARM_TTL_SECONDS,
              deadlineAt,
              signal,
            });
          });
        } catch (error) {
          if (!providerCallStarted || mustAbandonRuntimeExecution(error)) throw error;
          throw new AmbiguousExternalEffectError("box_create_ambiguous");
        }
        let boxId = result.boxId;
        if (result.outcome === "recovered") {
          const recovered = normalizedDiscovery(context.claim, result, result.boxId);
          await cleanDuplicates(context, recovered.duplicates);
          if (!recovered.canonical) {
            throw new AmbiguousExternalEffectError("box_create_ambiguous");
          }
          boxId = recovered.canonical.id;
        } else if (result.name !== exactGenerationName(context.claim)) {
          throw new AmbiguousExternalEffectError("box_create_ambiguous");
        }
        await observe(context, { boxId, boxState: "unknown" });
        break;
      }
      case "box_resolved":
      case "box_created": {
        const boxId = requiredBoxId(context.session);
        if (authorization.workCheckpoint === "box_resolved") {
          await lifecycle(context, "resume_box", async ({ signal }) =>
            await context.deps.box.resumeExistingBox({ boxId, signal }));
        }
        await lifecycle(context, "apply_box_settings", async ({ signal }) =>
          await context.deps.box.applyGenerationBoxSettings({
            boxId,
            companionId: context.claim.companionId,
            generation: context.claim.runtimeGeneration,
            ttlSeconds: BOX_WARM_TTL_SECONDS,
            deadlineAt: providerCallDeadline(context),
            signal,
          }));
        // Naming is the create/recovery idempotency boundary. Re-list after the
        // deterministic PATCH so a concurrent create that appeared during that
        // window is recorded in the durable child ledger before canonical work
        // can advance. Discovery keeps the already-recorded Box canonical.
        const namedDiscovery = await discover(context);
        if (namedDiscovery.canonical?.id !== boxId) {
          throw new RuntimeInvariantError({
            code: "box_identity_conflict",
            message: "Provider discovery did not preserve the recorded Companion Box.",
            action: "none",
          });
        }
        await cleanDuplicates(context, namedDiscovery.duplicates);
        await context.session.checkpoint({ nextCheckpoint: "waiting_ready" });
        break;
      }
      case "waiting_ready":
        await waitForReadyBox(context);
        break;
      case "box_ready_observed":
        await context.session.checkpoint({ nextCheckpoint: "installing_layout" });
        break;
      case "installing_layout":
        await observeStagedResources(context, await stageCapturedResources(context));
        await context.session.checkpoint({ nextCheckpoint: "starting_pi" });
        break;
      case "starting_pi":
        await startAndObservePi(context);
        break;
      case "pi_observed":
        await context.session.checkpoint({ nextCheckpoint: "pi_ready" });
        break;
      case "pi_ready":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The start operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function handleStop(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending":
        await context.session.checkpoint({ nextCheckpoint: "stopping_pi" });
        break;
      case "stopping_pi":
        if (authorization.boxId) {
          await lifecycle(context, "stop_pi", async ({ signal }) =>
            await context.deps.pi.stopPiDaemon({ boxId: requiredBoxId(context.session), signal }));
        }
        await context.session.checkpoint({ nextCheckpoint: "provider_stop_requested" });
        break;
      case "provider_stop_requested":
        if (authorization.boxId) {
          await lifecycle(context, "stop_box", async ({ signal }) =>
            await context.deps.box.stopExistingBox({ boxId: requiredBoxId(context.session), signal }));
        }
        await context.session.checkpoint({ nextCheckpoint: "waiting_archived" });
        break;
      case "waiting_archived": {
        if (!authorization.boxId) {
          throw new RuntimeInvariantError({
            code: "box_unavailable",
            message: "The Companion Box identity is unavailable for stop.",
            action: "none",
          });
        }
        requirePollingBudget(
          context,
          "box_stop_deadline_exceeded",
          "The Companion Box did not archive before its deadline.",
        );
        const state = await boxStatus(context, authorization.boxId);
        await observe(context, { boxId: authorization.boxId, boxState: state ?? "unknown" });
        if (state === "absent" || state === "error") {
          throw new RuntimeInvariantError({
            code: "box_stop_failed",
            message: "The Companion Box could not be observed as archived.",
            action: "retry",
          });
        }
        if (state !== "archived") {
          requirePollingBudget(
            context,
            "box_stop_deadline_exceeded",
            "The Companion Box did not archive before its deadline.",
          );
          await context.deps.clock.sleep(PROVIDER_POLL_INTERVAL_MS, context.session.signal);
        }
        break;
      }
      case "box_archived":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The stop operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function handleRestartPi(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending":
        await context.session.checkpoint({ nextCheckpoint: "restarting_pi" });
        break;
      case "restarting_pi":
        await lifecycle(context, "restart_pi", async ({ signal }) =>
          await context.deps.pi.restartPiDaemon({ boxId: requiredBoxId(context.session), signal }));
        await context.session.checkpoint({ nextCheckpoint: "starting_pi" });
        break;
      case "starting_pi": {
        const result = await lifecycle(context, "get_status", async ({ signal }) =>
          await context.deps.pi.piDaemonStatus({ boxId: requiredBoxId(context.session), signal }));
        if (result.state === "error" || result.state === "absent") {
          throw new RuntimeInvariantError({
            code: "pi_start_failed",
            message: "Pi failed while restarting.",
            action: "restart_pi",
          });
        }
        if (
          result.state !== "idle"
          || !result.invocationId
          || result.invocationId === authorization.piInvocationId
        ) {
          requirePollingBudget(
            context,
            "pi_restart_deadline_exceeded",
            "Pi did not expose a new idle invocation before the restart deadline.",
          );
          await context.deps.clock.sleep(PROVIDER_POLL_INTERVAL_MS, context.session.signal);
          break;
        }
        await observe(context, { piState: "idle", piInvocationId: result.invocationId });
        break;
      }
      case "pi_observed":
        await context.session.checkpoint({ nextCheckpoint: "pi_ready" });
        break;
      case "pi_ready":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The Pi restart operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function handleRestartBox(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending":
        await context.session.checkpoint({ nextCheckpoint: "restarting_box" });
        break;
      case "restarting_box":
        await lifecycle(context, "stop_box", async ({ signal }) =>
          await context.deps.box.stopExistingBox({ boxId: requiredBoxId(context.session), signal }));
        for (;;) {
          requirePollingBudget(
            context,
            "box_restart_deadline_exceeded",
            "The Companion Box did not archive before restart deadline.",
          );
          const state = await boxStatus(context, requiredBoxId(context.session));
          if (state === "archived") break;
          if (state === "absent" || state === "error") {
            throw new RuntimeInvariantError({
              code: "box_restart_failed",
              message: "The Companion Box could not be archived for restart.",
              action: "restart_box",
            });
          }
          await context.deps.clock.sleep(PROVIDER_POLL_INTERVAL_MS, context.session.signal);
        }
        await lifecycle(context, "resume_box", async ({ signal }) =>
          await context.deps.box.resumeExistingBox({ boxId: requiredBoxId(context.session), signal }));
        await context.session.checkpoint({ nextCheckpoint: "waiting_ready" });
        break;
      case "waiting_ready":
        await waitForReadyBox(context);
        break;
      case "box_ready_observed":
        await context.session.checkpoint({ nextCheckpoint: "installing_layout" });
        break;
      case "installing_layout":
        await observeStagedResources(context, await stageCapturedResources(context));
        await context.session.checkpoint({ nextCheckpoint: "starting_pi" });
        break;
      case "starting_pi":
        await startAndObservePi(context);
        break;
      case "pi_observed":
        await context.session.checkpoint({ nextCheckpoint: "pi_ready" });
        break;
      case "pi_ready":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The Box restart operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function handleApplySettings(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending":
        await context.session.checkpoint({ nextCheckpoint: "applying_settings" });
        break;
      case "applying_settings": {
        if (authorization.targetSettingsRevision === null) {
          throw new RuntimeInvariantError({
            code: "runtime_resource_snapshot_missing",
            message: "The captured runtime resource snapshot is incomplete.",
            action: "none",
          });
        }
        const activated = await activateRuntimeSettings({
          expectedSettingsRevision: authorization.targetSettingsRevision,
          expectedSkillsRevision: authorization.clientSurface === "native_mobile"
            ? null
            : authorization.targetSkillsRevision,
          previousPiInvocationId: authorization.piInvocationId,
          deadlineAt: workDeadline(context),
          clock: context.deps.clock,
          signal: context.session.signal,
          stage: async () => await stageCapturedResources(context),
          restartPi: async () => await lifecycle(context, "restart_pi", async ({ signal }) =>
            await context.deps.pi.restartPiDaemon({
              boxId: requiredBoxId(context.session),
              signal,
            })),
          observePi: async () => await lifecycle(context, "get_status", async ({ signal }) =>
            await context.deps.pi.piDaemonStatus({
              boxId: requiredBoxId(context.session),
              signal,
            })),
        });
        // Pi activation atomically moves the staged provider environment into user-runtime tmpfs.
        // Publish the revisions only together with proof of the new idle invocation; a takeover
        // before this observation safely repeats the idempotent stage + Pi restart sequence.
        await observe(context, {
          piState: activated.piState,
          piInvocationId: activated.piInvocationId,
          appliedSettingsRevision: activated.appliedSettingsRevision,
          ...(activated.appliedSkillsRevision === null
            ? {}
            : { appliedSkillsRevision: activated.appliedSkillsRevision }),
        });
        break;
      }
      case "settings_applied":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The settings operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function handleDelete(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending": {
        let boxId = authorization.boxId;
        if (!boxId) {
          const discovery = await discover(context);
          if (discovery.duplicates.length > 0) {
            throw new RuntimeInvariantError({
              code: "box_identity_conflict",
              message: "Deletion found multiple generation Boxes without a canonical identity.",
              action: "none",
            });
          }
          if (!discovery.canonical) {
            await observe(context, { boxState: "absent" });
            break;
          }
          boxId = discovery.canonical.id;
          await observe(context, {
            boxId,
            boxState: discovery.canonical.state ?? "unknown",
          });
          break;
        }
        const request = await requestPermanentDelete(context, boxId);
        if (request.outcome === "absent") {
          await observe(context, { boxState: "absent" });
          break;
        }
        await context.session.checkpoint({
          nextCheckpoint: "provider_delete_requested",
          providerOperationId: request.operationId,
        });
        break;
      }
      case "box_absence_observed": {
        requirePollingBudget(
          context,
          "box_delete_deadline_exceeded",
          "Box absence could not be confirmed before the delete deadline.",
        );
        await context.deps.clock.sleep(ABSENCE_CONFIRMATION_INTERVAL_MS, context.session.signal);
        const discovery = await discover(context);
        if (discovery.canonical) {
          await cleanDuplicates(context, discovery.duplicates);
          await observe(context, {
            boxId: discovery.canonical.id,
            boxState: discovery.canonical.state ?? "unknown",
          });
          const request = await requestPermanentDelete(context, discovery.canonical.id);
          if (request.outcome === "absent") {
            await observe(context, { boxState: "absent" });
            break;
          }
          await context.session.checkpoint({
            nextCheckpoint: "provider_delete_requested",
            providerOperationId: request.operationId,
          });
        } else {
          await observe(context, { boxState: "absent" });
        }
        break;
      }
      case "provider_delete_requested":
        await context.session.checkpoint({
          nextCheckpoint: "waiting_deleted",
          ...(authorization.providerOperationId
            ? { providerOperationId: authorization.providerOperationId }
            : {}),
        });
        break;
      case "waiting_deleted": {
        requirePollingBudget(
          context,
          "box_delete_deadline_exceeded",
          "Permanent Box deletion did not finish before its deadline.",
        );
        const boxId = requiredBoxId(context.session);
        const operationId = authorization.providerOperationId;
        if (!operationId) {
          throw new RuntimeInvariantError({
            code: "box_delete_operation_missing",
            message: "Permanent Box deletion lost its provider operation id.",
            action: "none",
          });
        }
        let poll;
        try {
          poll = await lifecycle(context, "poll_delete", async ({ signal }) =>
            await context.deps.box.pollPermanentDeletion({ boxId, operationId, signal }));
        } catch (error) {
          if (!isProviderNotFound(error)) throw error;
          poll = { status: "completed" } as const;
        }
        if (poll.status === "completed") {
          await observe(context, { boxState: "absent" });
        } else {
          // pending, processing, and blocked are all in-progress. Official Box docs poll until
          // `completed`; blocked has no completedAt, so treating it as terminal aborted deletes.
          await context.deps.clock.sleep(PROVIDER_POLL_INTERVAL_MS, context.session.signal);
        }
        break;
      }
      case "box_absent":
      case "provider_deleted":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The delete operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function requestPermanentDelete(
  context: OperationContext,
  boxId: string,
): Promise<Awaited<ReturnType<RuntimeEngineDependencies["box"]["requestPermanentDeletion"]>>> {
  try {
    return await lifecycle(context, "request_delete", async ({ signal }) =>
      await context.deps.box.requestPermanentDeletion({ boxId, signal }));
  } catch (error) {
    if (!isProviderNotFound(error)) throw error;
    return { outcome: "absent" };
  }
}

export async function handleOperation(
  context: OperationContext,
): Promise<RuntimeWorkDisposition> {
  switch (context.claim.operationKind) {
    case "start":
      return await handleStart(context);
    case "stop":
      return await handleStop(context);
    case "restart_pi":
      return await handleRestartPi(context);
    case "restart_box":
      return await handleRestartBox(context);
    case "apply_settings":
      return await handleApplySettings(context);
    case "delete":
      return await handleDelete(context);
  }
}
