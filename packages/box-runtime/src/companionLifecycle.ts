import { randomUUID } from "node:crypto";
import {
  CompanionProviderError,
  CompanionRuntimeTransitionError,
  COMPANION_RUNTIME_START_BUDGET_MS,
  claimCompanionDelivery,
  claimCompanionRuntimeStart,
  claimCompanionRuntimeStop,
  getCompanionForRuntime,
  listCompanionRuntimeSkillPackages,
  listPendingCompanionMessages,
  recordCompanionPiProjectionWithEffects,
  recordCompanionTimeoutRestart,
  releaseCompanionDelivery,
  renewCompanionDelivery,
  resolveCompanionProviderAuth,
  resolveCompanionPluginInjection,
  updateCompanionRuntime,
} from "@companion/core";
import { issueApiToken } from "@companion/core/services";
import type {
  CompanionPiEntry,
  CompanionPiProjectionResult,
  CompanionPiToolCompletion,
} from "@companion/core";
import type {
  Companion,
  CompanionThread,
  StartCompanionRuntimeInput,
} from "@companion/contracts";
import { withTenantContext, schema } from "@companion/db";
import { packDir, skillChecksum, toTar } from "@companion/skills";
import { COMPANION_SKILL_KEY, companionSkillDir } from "@companion/companion-skill";
import { getSkillArchive } from "@companion/storage";
import { eq } from "drizzle-orm";
import { getCompanionSkillPackage } from "./companionSkillPackage";
import {
  BoxRuntimeProviderError,
  COMPANION_PI_DISK_LAYOUT_VERSION,
  type CompanionBoxRuntime,
} from "./boxCompanionRuntime";
import {
  CompanionRuntimeStartBudgetError,
  companionRuntimeErrorMessage,
} from "./companionRuntimeError";

/** The resolved caller a lifecycle operation runs as; the API resolves it from its Hono context. */
export interface CompanionLifecycleActor {
  id: string;
  email: string;
  name: string;
}

/**
 * Everything a lifecycle operation needs beyond its arguments: the resolved tenant, the process
 * environment, and how to build a Box adapter. The API routes resolve `{actor, orgId}` exactly as
 * their `tenant()` helper does and hand the rest through, so a future worker process can drive the
 * same lifecycle without a Hono context.
 */
export interface CompanionLifecycleContext {
  actor: CompanionLifecycleActor;
  orgId: string;
  env: NodeJS.ProcessEnv;
  runtimeFactory: () => CompanionBoxRuntime;
}

/**
 * One wake's deadline. Each step of a start bounds itself, but their sum did not, so a step that
 * hung — an object-storage read with no timeout of its own, a Box call that never answered — kept the
 * `provisioning` claim it had already written and recorded no reason for it. This is the clock that
 * ends such a wake: the signal cancels whatever it is waiting on, and `aborted` is how a callback
 * that outlived it knows it no longer owns the lifecycle.
 *
 * The timer is an ordinary cleared one rather than `AbortSignal.timeout`, so a wake that finished in
 * a second does not leave a three-minute timer holding the process awake behind it.
 */
function startBudget(): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new CompanionRuntimeStartBudgetError(COMPANION_RUNTIME_START_BUDGET_MS)),
    COMPANION_RUNTIME_START_BUDGET_MS,
  );
  timer.unref?.();
  return { signal: controller.signal, release: () => clearTimeout(timer) };
}

/**
 * Fail this step as soon as the wake's budget does, whatever the step is waiting on. `Promise.race`
 * subscribes to both sides, so an abort that arrives after the wake already settled rejects a
 * promise that is still handled rather than surfacing as an unhandled rejection.
 */
function withinBudget<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const expiry = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  return Promise.race([work, expiry]);
}

export function recordProjection(input: {
  actor: CompanionLifecycleActor;
  orgId: string;
  companionId: string;
  entries: CompanionPiEntry[];
  toolCompletions?: CompanionPiToolCompletion[];
  piLogOffset?: number;
  piLogRewound?: boolean;
  deliveredOrdinal?: number;
  acceptedDeliveryOrdinal?: number;
  timeoutDeliveryOrdinal?: number;
}): Promise<CompanionPiProjectionResult> {
  return withTenantContext(
    { orgId: input.orgId, userId: input.actor.id },
    (database) => recordCompanionPiProjectionWithEffects({ ...input, database }),
  );
}

/**
 * Hand persisted messages to Pi in order and record how far delivery reached. The tenant-scoped
 * renewable lease spans acknowledgement and watermark update: another API replica re-reads pending
 * state after the first commits instead of sending the same turn twice. A refusal is normally not
 * an error for the caller because the durable tail remains retryable.
 */
export async function deliverCompanionMessages(
  ctx: CompanionLifecycleContext,
  input: {
    companionId: string;
    boxId: string;
    runtime: CompanionBoxRuntime;
    /** A completed wake must surface any Pi refusal instead of silently stranding its current turn. */
    throwOnRefusal?: boolean;
  },
): Promise<{ thread: CompanionThread; deliveredOrdinal: number } | null> {
  const claimId = randomUUID();
  const claimed = await withTenantContext(
    { orgId: ctx.orgId, userId: ctx.actor.id },
    (database) => claimCompanionDelivery({
      actor: ctx.actor,
      orgId: ctx.orgId,
      companionId: input.companionId,
      claimId,
      leaseSeconds: 600,
      database,
    }),
  ).catch(() => false);
  if (!claimed) return null;
  let refusal: unknown;
  const renewLease = () => withTenantContext(
    { orgId: ctx.orgId, userId: ctx.actor.id },
    (database) => renewCompanionDelivery({
      actor: ctx.actor,
      orgId: ctx.orgId,
      companionId: input.companionId,
      claimId,
      leaseSeconds: 600,
      database,
    }),
  ).catch(() => false);
  try {
    // The caller's pending/timeout fields preceded the lease. Re-read after winning it so an
    // overlapping request that already accepted this tail turns this call into a no-op rather than
    // a busy-Pi restart of the valid turn it just began.
    const current = await withTenantContext(
      { orgId: ctx.orgId, userId: ctx.actor.id },
      (database) => listPendingCompanionMessages({
        actor: ctx.actor,
        orgId: ctx.orgId,
        companionId: input.companionId,
        database,
      }),
    );
    if (current.pending.length === 0) return null;

    let deliveredOrdinal: number | undefined;
    try {
      if (current.timeoutRecoveryPending) {
        // A prompt acknowledgement also covers a follow-up queued behind an old streaming turn.
        // The lease makes this idle check authoritative: no competing delivery can start a valid
        // turn between this probe/recycle and the watermark recorded below.
        if (!await renewLease()) return null;
        const ready = await input.runtime.healPiDaemon({ boxId: input.boxId, requireIdle: true });
        if (ready.daemonState !== "running") {
          throw new BoxRuntimeProviderError(
            ready.detail ?? "Pi did not become ready to accept messages",
            409,
          );
        }
        if (!await renewLease()) return null;
      }
      for (const message of current.pending) {
        if (!await renewLease()) break;
        const prompt = () => input.runtime.prompt({
          boxId: input.boxId,
          message: message.content,
          requestId: message.event_id,
        });
        try {
          await prompt();
        } catch (error) {
          // A wake that just committed Online owns the handoff promised by #314. Surface its first
          // refusal and project Error instead of hiding it behind an in-request recycle; the saved
          // tail stays pending for the next explicit send. Ordinary online delivery may still use
          // THE-370's Pi-only heal and one acknowledged retry below.
          if (input.throwOnRefusal) {
            refusal = error;
            break;
          }
          // Missing acknowledgement leaves the original prompt's state ambiguous. Require idle
          // while holding the lease; a busy process may have accepted it after our read boundary,
          // so recycling it before the one retry avoids queuing a duplicate behind that turn.
          if (!await renewLease()) {
            refusal = error;
            break;
          }
          const healed = await input.runtime.healPiDaemon({
            boxId: input.boxId,
            requireIdle: true,
          });
          if (healed.daemonState !== "running") {
            refusal = new BoxRuntimeProviderError(
              healed.detail ?? "Pi did not become ready to accept messages",
              409,
            );
            break;
          }
          if (!await renewLease()) {
            refusal = error;
            break;
          }
          try {
            await prompt();
          } catch (retryError) {
            refusal = retryError;
            break;
          }
        }
        deliveredOrdinal = message.ordinal;
        if (!await renewLease()) break;
      }
    } catch (error) {
      refusal = error;
      // Leave the undelivered tail pending instead of losing it or failing the persisted send.
    }

    const result = deliveredOrdinal === undefined
      ? null
      : await recordProjection({
          actor: ctx.actor,
          orgId: ctx.orgId,
          companionId: input.companionId,
          entries: [],
          // A lost lease stops every further Pi action, but an acknowledgement already received is
          // still safe to watermark monotonically so the next owner cannot duplicate that prefix.
          deliveredOrdinal,
          acceptedDeliveryOrdinal: deliveredOrdinal,
          timeoutDeliveryOrdinal: current.timeoutRecoveryPending ? deliveredOrdinal : undefined,
        }).then(({ thread }) => ({ thread, deliveredOrdinal }));

    // Preserve #314's visible post-wake refusal while the delivery lease still orders health with
    // every other producer. A later accepted retry can clear this Error; a stale producer cannot
    // overwrite a lifecycle transition because the row state and Box id are revalidated here.
    const ownsHealthUpdate = await renewLease();
    if (
      ownsHealthUpdate
      && ((input.throwOnRefusal && refusal !== undefined) || (result && refusal === undefined))
    ) {
      await withTenantContext(
        { orgId: ctx.orgId, userId: ctx.actor.id },
        async (database) => {
          const companion = await getCompanionForRuntime({
            actor: ctx.actor,
            orgId: ctx.orgId,
            companionId: input.companionId,
            database,
          });
          if (
            companion.runtime.box_id !== input.boxId
            || companion.runtime.state !== "running"
          ) return;
          await updateCompanionRuntime({
            actor: ctx.actor,
            orgId: ctx.orgId,
            companionId: input.companionId,
            expectedUpdatedAt: new Date(companion.updated_at),
            patch: refusal === undefined
              ? {
                  runtimeState: "running",
                  daemonState: "running",
                  observedAt: new Date(),
                }
              : {
                  runtimeState: "error",
                  daemonState: "error",
                  lastError: companionRuntimeErrorMessage(refusal),
                  observedAt: new Date(),
                },
            database,
          }).catch((error) => {
            if (!(error instanceof CompanionRuntimeTransitionError)) throw error;
          });
        },
      );
    }

    // Move the Box idle clock only after Pi accepted at least one durable message. A failed prompt
    // remains pending and therefore cannot lengthen the machine's lifetime.
    if (result) {
      await input.runtime.refreshTtl({ boxId: input.boxId }).catch(() => undefined);
    }
    if (input.throwOnRefusal && refusal !== undefined) throw refusal;
    return result;
  } catch (error) {
    if (input.throwOnRefusal && refusal !== undefined) throw refusal;
    // The send is already durable. A lease/read/watermark failure must leave it visibly pending,
    // never turn that persisted action into a 500 that invites a second client-generated id.
    return null;
  } finally {
    await withTenantContext(
      { orgId: ctx.orgId, userId: ctx.actor.id },
      (database) => releaseCompanionDelivery({
        actor: ctx.actor,
        orgId: ctx.orgId,
        companionId: input.companionId,
        claimId,
        database,
      }),
    ).catch(() => undefined);
  }
}

/**
 * Claim and start one Companion through the same lifecycle path for an explicit Wake or a
 * persisted message. The Box adapter owns the warm decision, so an already-active layout-6 Pi
 * returns before resource injection or any systemd start.
 *
 * The claim is written before any of that work, so every step after it runs under one budget: a
 * wake that hangs or that answers with something other than a running Pi records why and leaves a
 * retryable `error`, because the alternative — the bug this bounds — is a Companion that reports
 * Starting until somebody reads the Box's own state to find out nothing is happening.
 */
export async function startCompanionRuntime(
  ctx: CompanionLifecycleContext,
  companionId: string,
  body: StartCompanionRuntimeInput,
  options: {
    allowBoxWake?: boolean;
    restartPi?: boolean;
    timeoutRestartOrdinal?: number | null;
    allowArchiveResume?: boolean;
  } = {},
): Promise<{ companion: Companion; runtime: CompanionBoxRuntime; ready: boolean }> {
  let failureContext:
    | {
        actor: CompanionLifecycleActor;
        orgId: string;
      }
    | undefined;
  let mutation:
    | {
        actor: CompanionLifecycleActor;
        orgId: string;
        companion: Awaited<ReturnType<typeof getCompanionForRuntime>>;
        provider: Awaited<ReturnType<typeof resolveCompanionProviderAuth>>;
        plugins: Awaited<ReturnType<typeof resolveCompanionPluginInjection>>;
        skillPackages: Awaited<ReturnType<typeof listCompanionRuntimeSkillPackages>>;
        hubEnv: Record<string, string>;
        /** Revalidated after the lifecycle claim so a delayed request cannot recycle Pi twice. */
        timeoutRestartPending: boolean;
      }
    | undefined;
  /**
   * The Box-assignment write, while it is in flight. A start abandoned at its deadline can already
   * be inside this write, and what it writes is `provisioning`, so the failure path waits for it
   * before recording its own state: the reason a wake failed has to be the last word on the row.
   */
  let boxAssignment: Promise<unknown> | undefined;
  const budget = startBudget();
  try {
    mutation = await withinBudget(
      withTenantContext({ orgId: ctx.orgId, userId: ctx.actor.id }, async (database) => {
        const actor = ctx.actor;
        const orgId = ctx.orgId;
        failureContext = { actor, orgId };
        const provider = await resolveCompanionProviderAuth({
          actor, orgId, companionId, database,
        });
        const plugins = body.client_surface === "native_mobile"
          ? { accounts: [], credentials: [] }
          : await resolveCompanionPluginInjection({
              actor, orgId, companionId, database,
            });
        const companion = await claimCompanionRuntimeStart({
          actor,
          orgId,
          companionId,
          allowArchiveResume: options.allowArchiveResume,
          database,
        });
        const timeoutRestartPending = options.timeoutRestartOrdinal !== null
          && options.timeoutRestartOrdinal !== undefined
          ? await listPendingCompanionMessages({ actor, orgId, companionId, database })
            .then((state) => state.timeoutRestartPending
              && state.timeoutRecoveryOrdinal === options.timeoutRestartOrdinal)
          : false;
        const skillPackages = body.client_surface === "native_mobile"
          ? []
          : await listCompanionRuntimeSkillPackages({ actor, orgId, companionId, database });
        const hubEnv: Record<string, string> = {};
        if (body.client_surface !== "native_mobile") {
          const apiUrl = (ctx.env.COMPANION_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
          hubEnv.COMPANION_API_URL = apiUrl;
          hubEnv.COMPANION_WORKSPACE_ID = orgId;
          let ownerActor = actor.id === companion.owner_id
            ? actor
            : null;
          if (!ownerActor) {
            const [owner] = await database
              .select({
                id: schema.user.id,
                email: schema.user.email,
                name: schema.user.name,
              })
              .from(schema.user)
              .where(eq(schema.user.id, companion.owner_id))
              .limit(1);
            if (owner) {
              ownerActor = {
                id: owner.id,
                email: owner.email,
                name: owner.name || owner.email,
              };
            }
          }
          if (ownerActor) {
            const scopes = companion.can_write_skills
              ? (["skills:read", "skills:write"] as const)
              : (["skills:read"] as const);
            const issued = await issueApiToken({
              actor: ownerActor,
              orgId,
              scopes: [...scopes],
              name: `Companion ${companionId} Skills Hub`,
              ttlMs: 6 * 60 * 60 * 1000,
              source: { type: "companion", companionId },
              database,
            });
            hubEnv.COMPANION_DELEGATION_TOKEN = issued.token;
          }
        }
        return {
          actor,
          orgId,
          companion,
          provider,
          plugins,
          skillPackages,
          hubEnv,
          timeoutRestartPending,
        };
      }),
      budget.signal,
    );
    const modelId = mutation.companion.model_id;
    if (!modelId) {
      throw new CompanionProviderError(
        "provider_model_invalid",
        "Choose a model before starting this Companion.",
        mutation.provider.providerId,
      );
    }
    // A pending skill revision means the Box does not run the saved list yet (a save while it
    // slept, a failed publish push, an archived selection). A warm shortcut would keep it stale
    // forever while settings promise "reapplies on next start", so a pending start restages —
    // the same Pi recycle an online skills change already performs. Never for native_mobile,
    // which stages no library skills.
    const skillsPending = body.client_surface !== "native_mobile"
      && mutation.companion.runtime.skills_applied_revision
        < mutation.companion.runtime.skills_revision;
    const librarySkills = await withinBudget(
      // Object storage has no timeout of its own, so these reads are held to the wake's deadline
      // like every other step: a bucket that stops answering must not become a Companion that
      // reports Starting with a Box nobody has contacted yet.
      Promise.all(mutation.skillPackages.map(async (skill) => {
        const archive = await getSkillArchive({
          key: skill.storagePath,
          signal: budget.signal,
        });
        if (skillChecksum(toTar(archive)) !== skill.checksum) {
          throw new BoxRuntimeProviderError(
            `stored skill package no longer matches ${skill.slug}@${skill.version}`,
            502,
          );
        }
        return {
          slug: skill.slug,
          version: skill.version,
          checksum: skill.checksum,
          archive,
        };
      })),
      budget.signal,
    );
    // Bundled Companion agent skill is always staged on web/mobile-web so Pi can reach the Skills
    // Hub. selected_skill_ids are additional library packages; empty selection stages only this.
    const skills = body.client_surface === "native_mobile"
      ? []
      : await withinBudget((async () => {
        const bundled = await getCompanionSkillPackage();
        const packed = await packDir(companionSkillDir());
        const agentSkill = {
          slug: COMPANION_SKILL_KEY,
          version: bundled.version,
          checksum: packed.checksum,
          archive: packed.archive,
        };
        return [
          agentSkill,
          ...librarySkills.filter((skill) => skill.slug !== COMPANION_SKILL_KEY),
        ];
      })(), budget.signal);
    const runtime = ctx.runtimeFactory();
    const refreshRuntimeLayout =
      mutation.companion.runtime.disk_layout_version !== COMPANION_PI_DISK_LAYOUT_VERSION;
    const observed = await withinBudget(runtime.start({
      signal: budget.signal,
      companionId,
      orgId: mutation.orgId,
      boxId: mutation.companion.runtime.box_id,
      clientSurface: body.client_surface,
      providerAuth: {
        [mutation.provider.providerId]: mutation.provider.authEntry,
      },
      modelId,
      instructions: mutation.companion.persona,
      // Skipping the write preserves a subscription token Pi refreshed on disk. A layout refresh
      // remains a cold resource-injection path, but it does not replace current provider auth or
      // recycle a warm Pi; staged resources load on its next natural start.
      replaceProviderAuth:
        !mutation.companion.runtime.box_id
        || mutation.companion.runtime.provider_credential_generation
          !== mutation.provider.credentialGeneration,
      // Extensions are loaded when Pi starts. Refreshing files beneath an already-running layout
      // is not enough: recycle that daemon once so every live Box actually gains the new guard.
      // A pending skill revision recycles too — a warm shortcut would keep the Box's staged
      // skills stale while settings promise "reapplies on next start".
      restartPi: (
        options.restartPi === true
        && (options.timeoutRestartOrdinal == null || mutation.timeoutRestartPending)
      ) || refreshRuntimeLayout || skillsPending,
      refreshRuntimeLayout,
      allowBoxWake: options.allowBoxWake,
      mcpCredentials: body.client_surface === "native_mobile"
        ? []
        : [...mutation.plugins.credentials, ...body.mcp_credentials],
      mcpAccounts: body.client_surface === "native_mobile"
        ? []
        : [...mutation.plugins.accounts, ...body.mcp_accounts],
      skills,
      hubEnv: mutation.hubEnv,
      // `null` clears the recorded Box: the adapter found that the id this row carried names a
      // machine this Companion does not own, so no other path may reach it either.
      onBoxAssigned: async (boxId) => {
        // A start abandoned at the deadline may still reach this point, and the reason for that
        // failure is already on the row. Re-claiming `provisioning` here would erase it and put the
        // Companion back into the state this budget exists to end. Refusing rather than returning is
        // what says so: the adapter reads a rejected assignment as a Box no row points at and puts
        // that Box back to sleep, which returning as if the id were recorded would skip.
        if (budget.signal.aborted) throw budget.signal.reason;
        const write = withTenantContext(
          { orgId: mutation!.orgId, userId: mutation!.actor.id },
          (database) => updateCompanionRuntime({
            actor: mutation!.actor,
            orgId: mutation!.orgId,
            companionId,
            patch: { boxId, runtimeState: "provisioning", daemonState: "starting" },
            database,
          }),
        );
        boxAssignment = write.catch(() => undefined);
        await write;
      },
    }), budget.signal);
    // A graceful Box archive may still be snapshotting after the adapter's bounded poll. That is
    // a truthful waiting state, not a failed start: preserve it without last_error so the same
    // full-Box restart or a later wake can resume once the provider reports `archived`.
    const archiveInFlight = observed.runtimeState === "stopping"
      && observed.daemonState === "stopped";
    const noWakeArchiveCompleted = options.allowBoxWake === false
      && observed.runtimeState === "stopped"
      && observed.daemonState === "stopped";
    if (archiveInFlight || noWakeArchiveCompleted) {
      const companion = await withinBudget(
        withTenantContext(
          { orgId: mutation.orgId, userId: mutation.actor.id },
          (database) => updateCompanionRuntime({
            actor: mutation!.actor,
            orgId: mutation!.orgId,
            companionId,
            patch: {
              boxId: observed.boxId,
              runtimeState: observed.runtimeState,
              // `stopping` + `starting` is the durable archive-resume intent. It distinguishes an
              // accepted wake/restart from an explicit stop or the Owner's deletion lock, while the
              // runtime chip continues to project the truthful top-level Stopping state.
              // A no-wake settings apply or Pi-only restart must not inherit that intent merely
              // because Box began archiving during its observation race.
              daemonState: archiveInFlight && options.allowBoxWake !== false
                ? "starting"
                : "stopped",
              desktopAvailable: observed.desktopAvailable,
              observedAt: new Date(),
            },
            database,
          }),
        ),
        budget.signal,
      );
      return { companion, runtime, ready: false };
    }
    // A start that returns is otherwise a start that finished, so anything other than a running Pi
    // is a failure with an observation attached rather than a wake still in progress. Writing a
    // provisioning observation back verbatim would leave a Companion stuck on Starting.
    if (observed.runtimeState !== "running" || observed.daemonState !== "running") {
      throw new BoxRuntimeProviderError(
        `Box ${observed.boxId} answered this wake as ${observed.runtimeState}`
        + ` with Pi ${observed.daemonState} instead of running`,
        502,
      );
    }
    const companion = await withinBudget(
      withTenantContext(
        { orgId: mutation.orgId, userId: mutation.actor.id },
        async (database) => {
          const companion = await updateCompanionRuntime({
            actor: mutation!.actor,
            orgId: mutation!.orgId,
            companionId,
            patch: {
              boxId: observed.boxId,
              runtimeState: observed.runtimeState,
              daemonState: observed.daemonState,
              providerIds: [mutation!.provider.providerId],
              providerCredentialGeneration: mutation!.provider.credentialGeneration,
              diskLayoutVersion: COMPANION_PI_DISK_LAYOUT_VERSION,
              desktopAvailable: observed.desktopAvailable,
              // The staged set matches the revision read in the claim transaction. Recorded only
              // when this start actually staged: native_mobile stages no library skills, and a
              // warm shortcut (`staged: false`) left the Box running whatever was staged before —
              // writing "applied" for either would show "up to date" for packages the Box never
              // received.
              ...(body.client_surface !== "native_mobile" && observed.staged !== false
                ? {
                    skillsAppliedRevision: mutation!.companion.runtime.skills_revision,
                    skillsLastError: null,
                  }
                : {}),
              observedAt: new Date(),
              startedAt: new Date(),
            },
            database,
          });
          if (mutation!.timeoutRestartPending
            && options.timeoutRestartOrdinal !== null
            && options.timeoutRestartOrdinal !== undefined) {
            await recordCompanionTimeoutRestart({
              actor: mutation!.actor,
              orgId: mutation!.orgId,
              companionId,
              timeoutOrdinal: options.timeoutRestartOrdinal,
              database,
            });
          }
          return companion;
        },
      ),
      budget.signal,
    );
    return { companion, runtime, ready: true };
  } catch (raised) {
    // Cancellation surfaces as whatever call was in flight when the deadline landed, so the reason
    // this wake reports is the budget it spent rather than a bare abort from one Box request.
    const error = budget.signal.aborted ? budget.signal.reason : raised;
    // Cancellation does not wait for the call it interrupted, so a Box assignment still in flight
    // would otherwise write `provisioning` over the failure recorded here.
    await boxAssignment;
    // A pre-claim transition conflict means another request owns the wake. Preserve its
    // provisioning lock; all other authorized failures remain visible through last_error.
    const context = mutation
      ?? (error instanceof CompanionRuntimeTransitionError ? undefined : failureContext);
    if (context) {
      await withTenantContext(
        { orgId: context.orgId, userId: context.actor.id },
        (database) => updateCompanionRuntime({
          actor: context.actor,
          orgId: context.orgId,
          companionId,
          patch: {
            runtimeState: "error",
            daemonState: "error",
            // Keep the reason beside the durable message so a failed automatic wake remains
            // diagnosable and retrying that same message can claim the lifecycle again.
            lastError: companionRuntimeErrorMessage(error),
            observedAt: new Date(),
          },
          database,
        }),
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    budget.release();
  }
}

/**
 * Stop and archive one Companion through the lifecycle claim used by the public stop route and by
 * a full-Box restart. Keeping the failure write here gives both callers the same retryable Error
 * state and prevents a restart from inventing a second, subtly different stop path.
 */
export async function stopCompanionRuntime(
  ctx: CompanionLifecycleContext,
  companionId: string,
): Promise<Companion> {
  let mutation:
    | {
        actor: CompanionLifecycleActor;
        orgId: string;
        companion: Awaited<ReturnType<typeof claimCompanionRuntimeStop>>;
      }
    | undefined;
  try {
    mutation = await withTenantContext(
      { orgId: ctx.orgId, userId: ctx.actor.id },
      async (database) => {
        const actor = ctx.actor;
        const orgId = ctx.orgId;
        const companion = await claimCompanionRuntimeStop({
          actor, orgId, companionId, database,
        });
        return { actor, orgId, companion };
      },
    );
    const claimed = mutation;
    const observed = await ctx.runtimeFactory().stop({ boxId: claimed.companion.runtime.box_id! });
    return withTenantContext(
      { orgId: claimed.orgId, userId: claimed.actor.id },
      (database) => updateCompanionRuntime({
        actor: claimed.actor,
        orgId: claimed.orgId,
        companionId,
        // A delete may claim this Companion while the Box archive is in flight. Do not let this
        // older stop completion clear the deletion lock after the archive succeeds.
        expectedUpdatedAt: new Date(claimed.companion.updated_at),
        patch: {
          runtimeState: observed.runtimeState,
          daemonState: observed.daemonState,
          desktopAvailable: observed.desktopAvailable,
          observedAt: new Date(),
          stoppedAt: new Date(),
        },
        database,
      }),
    );
  } catch (error) {
    if (mutation) {
      await withTenantContext(
        { orgId: mutation.orgId, userId: mutation.actor.id },
        (database) => updateCompanionRuntime({
          actor: mutation!.actor,
          orgId: mutation!.orgId,
          companionId,
          expectedUpdatedAt: new Date(mutation!.companion.updated_at),
          patch: {
            runtimeState: "error",
            daemonState: "error",
            lastError: companionRuntimeErrorMessage(error),
            observedAt: new Date(),
          },
          database,
        }),
      ).catch(() => undefined);
    }
    throw error;
  }
}
