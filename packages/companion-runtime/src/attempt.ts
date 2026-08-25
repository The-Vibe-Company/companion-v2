/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Predates the incremental anti-slop gate; file reawakened by an unrelated budget/reliability edit, existing debt not rewritten here. */
import {
  AmbiguousExternalEffectError,
  RuntimeInvariantError,
  safeErrorFromUnknown,
  safeRuntimeError,
} from "./errors";
import { mustAbandonRuntimeExecution } from "./executionControl";
import { runtimeSucceeded, type RuntimeWorkDisposition } from "./handler";
import type { LeaseSession } from "./leaseSession";
import { BOX_WARM_TTL_SECONDS } from "./operations";
import {
  classifyPiJournalPage,
  validateBrokerCounters,
  validatePiJournalRead,
  type PiBrokerCounters,
} from "./piEvents";
import type { RuntimeEngineDependencies, StagedRuntimeAttachment } from "./ports";
import type { RuntimeVisibleTextRedactor } from "./projectionRedaction";
import { isCompanionAttachmentImage } from "@companion/contracts";
import { retryIdempotentLifecycle } from "./retry";
import { RuntimeStoreIndeterminateError } from "./store";
import { refreshWarmCompanionLayout } from "./layoutRefresh";
import type {
  AttemptRuntimeClaim,
  ModelInputCapability,
  RuntimeAttachment,
  RuntimeAuthorization,
  RuntimeOutputAttachment,
  RuntimeWorkMaterial,
} from "./types";

/**
 * How long the whole outbox harvest may take. It is generous enough for ten images over a slow Box
 * command transport and short enough that a turn's reply is never held behind a stuck read.
 */
const OUTBOX_HARVEST_BUDGET_MS = 90_000;

/**
 * How much of the turn's remaining authority the harvest leaves for recording its results and
 * settling. Spending the last of it on images would settle a finished turn `interrupted`.
 */
const OUTBOX_HARVEST_SETTLE_RESERVE_MS = 15_000;

/** A turn carrying an image requires a model that can actually see it. */
export function attachmentsIncludeImage(attachments: readonly RuntimeAttachment[]): boolean {
  return attachments.some((attachment) => isCompanionAttachmentImage(attachment.contentType));
}

/**
 * Tell Pi where the member's files are, in one deterministic block appended to their message.
 *
 * It is composed rather than stored: the transcript keeps what the member wrote, and the 16 KB
 * message cap stays exactly what it was. Every value interpolated here is already reduced to a
 * charset with no quoting, escaping, or newline in it, so the suffix cannot be steered by a filename.
 */
export function attachmentPromptSuffix(staged: readonly StagedRuntimeAttachment[]): string {
  if (staged.length === 0) return "";
  const lines = staged.map((attachment, index) =>
    `${index + 1}. ${attachment.path} (${attachment.contentType}, ${attachment.byteSize} bytes)`);
  const plural = staged.length === 1 ? "file" : "files";
  return `\n\n--- The user attached ${staged.length} ${plural}, staged read-only at:\n`
    + `${lines.join("\n")}\n`;
}

interface AttemptContext {
  claim: AttemptRuntimeClaim;
  session: LeaseSession;
  deps: RuntimeEngineDependencies;
}

function authorization(context: AttemptContext): RuntimeAuthorization {
  const value = context.session.authorization;
  if (!value?.authorized) {
    throw new RuntimeInvariantError({
      code: "runtime_authorization_missing",
      message: "Runtime authorization was unavailable for the active turn.",
      action: "none",
    });
  }
  return value;
}

function requiredRuntime(context: AttemptContext): {
  boxId: string;
  piInvocationId: string;
} {
  const value = authorization(context);
  if (
    !value.boxId
    || value.diskLayoutVersion !== 14
    || value.piState !== "idle"
    || !value.piInvocationId
  ) {
    throw new RuntimeInvariantError({
      code: "runtime_not_ready",
      message: "The Companion runtime is not ready for prompt dispatch.",
      action: "restart_pi",
    });
  }
  return { boxId: value.boxId, piInvocationId: value.piInvocationId };
}

function modelInputCapabilities(value: unknown): ModelInputCapability[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => item !== "text" && item !== "image")
  ) {
    throw new RuntimeInvariantError({
      code: "model_capabilities_unavailable",
      message: "Pi did not report valid input capabilities for the selected model.",
      action: "switch_model",
    });
  }
  return [...new Set(value)] as ModelInputCapability[];
}

export function requireModelInputCapability(
  input: readonly ModelInputCapability[],
  required: ModelInputCapability,
): void {
  if (!input.includes(required)) {
    throw new RuntimeInvariantError({
      code: required === "image" ? "model_image_input_unsupported" : "model_text_input_unsupported",
      message: required === "image"
        ? "The selected model does not support image input."
        : "The selected model does not support text input.",
      action: "switch_model",
    });
  }
}

async function material(context: AttemptContext): Promise<RuntimeWorkMaterial> {
  const value = await context.session.fencedMutation(async () =>
    await context.deps.materialProvider.getMaterial({
      store: context.deps.store,
      fence: context.session.fence,
      signal: context.session.signal,
    }));
  if (
    value.turnId !== context.claim.turnId
    || value.attemptId !== context.claim.workId
    || !value.messageEventId
    || typeof value.promptText !== "string"
    || value.promptText.length === 0
  ) {
    throw new RuntimeInvariantError({
      code: "turn_prompt_unavailable",
      message: "The accepted turn prompt is unavailable.",
      action: "none",
    });
  }
  return value;
}

async function brokerState(context: AttemptContext): Promise<{
  invocationId: string;
  layoutMarker: string | null;
  layoutCurrent: boolean;
  activeAttemptId: string | null;
  tailCursor: bigint;
  acknowledgedCursor: bigint;
  counters: PiBrokerCounters;
  modelInput: ModelInputCapability[];
}> {
  const state = await context.session.external(async (signal) => {
    const runtime = requiredRuntime(context);
    return await context.deps.pi.brokerState({ boxId: runtime.boxId, signal });
  });
  const counters = validateBrokerCounters(state.counters);
  const capabilities = modelInputCapabilities(state.modelInput);
  if (state.tailCursor < 0n || state.acknowledgedCursor < 0n || state.acknowledgedCursor > state.tailCursor) {
    throw new RuntimeInvariantError({
      code: "pi_broker_state_invalid",
      message: "Pi returned an invalid broker cursor state.",
      action: "restart_pi",
    });
  }
  return { ...state, counters, modelInput: capabilities };
}

async function refreshWarmTtl(context: AttemptContext): Promise<void> {
  try {
    await retryIdempotentLifecycle({
      call: "apply_box_settings",
      clock: context.deps.clock,
      jitter: context.deps.jitter,
      signal: context.session.signal,
      deadlineAt: authorization(context).absoluteDeadlineAt ?? undefined,
      operation: async () => await context.session.external(async (signal) => {
        await context.deps.box.setTtl({
          boxId: requiredRuntime(context).boxId,
          ttlSeconds: BOX_WARM_TTL_SECONDS,
          signal,
        });
      }),
    });
  } catch (error) {
    // Prompt acceptance is already durable. TTL is maintenance after the Box's
    // start-time six-hour TTL, so a provider failure must not abandon event
    // consumption or make this accepted attempt replayable. Lease/gate aborts
    // remain authoritative and are propagated.
    if (context.session.signal.aborted) {
      throw context.session.signal.reason ?? error;
    }
  }
}

function cumulativeCounters(input: {
  authorization: RuntimeAuthorization;
  broker: PiBrokerCounters;
  pageUnknown: number;
}): { unknown: number; malformed: number; oversized: number } {
  const currentUnknown = input.authorization.unknownEventCount ?? 0;
  const currentMalformed = input.authorization.malformedEventCount ?? 0;
  const currentOversized = input.authorization.oversizedEventCount ?? 0;
  return {
    unknown: Math.max(currentUnknown + input.pageUnknown, input.broker.unknownEvents),
    malformed: Math.max(currentMalformed, input.broker.malformedLines),
    oversized: Math.max(currentOversized, input.broker.oversizedLines),
  };
}

async function ackEvents(context: AttemptContext, through: bigint): Promise<void> {
  await retryIdempotentLifecycle({
    call: "ack_events",
    clock: context.deps.clock,
    jitter: context.deps.jitter,
    signal: context.session.signal,
    deadlineAt: authorization(context).absoluteDeadlineAt ?? undefined,
    operation: async () => await context.session.external(async (signal) => {
      const acknowledged = await context.deps.pi.ackBrokerEvents({
        boxId: requiredRuntime(context).boxId,
        through,
        signal,
      });
      if (acknowledged < through) {
        throw new RuntimeInvariantError({
          code: "pi_broker_ack_invalid",
          message: "Pi did not acknowledge the projected event cursor.",
          action: "restart_pi",
        });
      }
    }),
  });
}

function explicitNoResponse(): RuntimeWorkDisposition {
  return {
    kind: "settle",
    settlement: {
      terminalStatus: "failed",
      error: safeRuntimeError({
        code: "empty_response",
        message: "Pi settled without producing an assistant response or a visible decision.",
        action: "retry",
      }),
    },
  };
}

async function finishDurableTerminal(
  context: AttemptContext,
  authorizationAtTerminal: RuntimeAuthorization,
): Promise<RuntimeWorkDisposition> {
  const terminal = await context.session.fencedMutation(async () =>
    await context.deps.store.getAttemptTerminalProjection(context.session.fence));
  if (
    terminal.checkpoint !== authorizationAtTerminal.workCheckpoint
    || authorizationAtTerminal.eventCursor === null
    || terminal.eventCursor !== authorizationAtTerminal.eventCursor
  ) {
    throw new RuntimeInvariantError({
      code: "pi_terminal_projection_invalid",
      message: "The durable Pi terminal projection did not match the active attempt cursor.",
      action: "restart_pi",
    });
  }
  // Pi exited rather than settling, so it produced no reply and left nothing worth reading back.
  // The outbox is emptied before the next dispatch either way.
  let hasVisibleOutput = terminal.hasVisibleOutput;
  if (terminal.checkpoint === "agent_settled" && !terminal.outputsHarvested) {
    hasVisibleOutput = await harvestOutputs(context, hasVisibleOutput);
  }
  // The terminal projection contains no credential material. Revalidate immediately before the
  // broker effect, then ACK the cursor even if credentials rotated after Pi produced the result.
  await ackEvents(context, terminal.eventCursor);
  if (terminal.checkpoint === "process_exited") {
    return {
      kind: "settle",
      settlement: {
        terminalStatus: "failed",
        error: safeRuntimeError({
          code: "pi_process_exited",
          message: "Pi exited before completing the turn.",
          action: "restart_pi",
        }),
      },
    };
  }
  return hasVisibleOutput ? runtimeSucceeded : explicitNoResponse();
}

/**
 * Move what Pi left in its outbox into the transcript, before the turn settles.
 *
 * A failure here is a degradation and never a failed turn: by this point Pi has settled and any
 * reply it produced is already durable, so retracting the turn over an unreadable image would be
 * worse than losing the image. Whatever completed inside the budget is recorded, the harvest is
 * marked done so a takeover does not repeat it, and the shortfall is logged under a stable code
 * rather than persisted — a succeeded attempt carries no error by construction.
 */
async function harvestOutputs(
  context: AttemptContext,
  hasVisibleOutput: boolean,
): Promise<boolean> {
  const runtime = requiredRuntime(context);
  const auth = authorization(context);
  // Clamp the harvest to the authority that still exists. Pi has settled and its reply is durable,
  // but the executor must still reauthorize to record and settle, and a deadline that expires mid
  // harvest is denied as `interrupted` -- which would block the ordered queue on a turn that
  // actually finished. Harvesting inside the remaining budget keeps the settle reachable.
  const budgetEnd = context.deps.clock.now().getTime() + OUTBOX_HARVEST_BUDGET_MS;
  const authorityEnd = Math.min(
    auth.inactivityDeadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
    auth.absoluteDeadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
  );
  // Leave room for the record and the settle themselves; a harvest that consumes the last
  // millisecond of authority has bought an image at the cost of the turn.
  const deadlineAt = new Date(Number.isFinite(authorityEnd)
    ? Math.min(budgetEnd, authorityEnd - OUTBOX_HARVEST_SETTLE_RESERVE_MS)
    : budgetEnd);
  if (deadlineAt.getTime() <= context.deps.clock.now().getTime()) {
    // No authority left to spend on images. The reply is already durable; settle it.
    return hasVisibleOutput;
  }
  let harvested: { attachments: RuntimeOutputAttachment[]; incomplete: boolean };
  try {
    harvested = await context.session.external(async (signal) =>
      await context.deps.outboxHarvester.harvestOutbox({
        orgId: context.claim.orgId,
        companionId: context.claim.companionId,
        boxId: runtime.boxId,
        attemptId: context.claim.workId,
        deadlineAt,
        signal,
      }));
  } catch (error) {
    if (mustAbandonRuntimeExecution(error)) throw error;
    harvested = { attachments: [], incomplete: true };
  }
  if (harvested.incomplete) {
    context.deps.log?.warn({
      ts: context.deps.clock.now().toISOString(),
      event: "outbox_harvest_failed",
      companion_id: context.claim.companionId,
      attempt_id: context.claim.workId,
      recovered: harvested.attachments.length,
    });
  }

  // The record and the durable "already harvested" fact are one transaction, so a takeover either
  // sees the whole harvest or none of it.
  const recorded = await context.session.fencedMutation(async () =>
    await context.deps.store.recordAttemptOutputs(context.session.fence, {
      attachments: harvested.attachments,
      activityAt: context.deps.clock.now(),
    }));

  // Emptying the outbox is maintenance, not correctness: the pre-dispatch clear is what guarantees
  // one attempt's leftovers never reach the next turn, so a failure here is deliberately silent.
  if (harvested.attachments.length > 0) {
    try {
      await context.session.external(async (signal) =>
        await context.deps.outboxHarvester.clearOutbox({ boxId: runtime.boxId, signal }));
    } catch (error) {
      if (mustAbandonRuntimeExecution(error)) throw error;
    }
  }
  return recorded.hasVisibleOutput || hasVisibleOutput;
}

async function consumeEvents(
  context: AttemptContext,
  initialVisibleOutput: boolean,
  redact: RuntimeVisibleTextRedactor,
): Promise<RuntimeWorkDisposition> {
  let hasVisibleOutput = initialVisibleOutput;
  for (;;) {
    const auth = await context.session.reauthorize();
    if (auth.attemptStatus === "needs_input") return { kind: "release" };
    if (!auth.piInvocationId || auth.eventCursor === null) {
      throw new RuntimeInvariantError({
        code: "pi_event_binding_missing",
        message: "The accepted Pi invocation or event cursor is unavailable.",
        action: "restart_pi",
      });
    }
    if (auth.workCheckpoint === "agent_settled" || auth.workCheckpoint === "process_exited") {
      return await finishDurableTerminal(context, auth);
    }

    const state = await brokerState(context);
    if (state.invocationId !== auth.piInvocationId) {
      throw new RuntimeInvariantError({
        code: "pi_invocation_changed",
        message: "Pi restarted while the turn was active.",
        action: "restart_pi",
      });
    }
    if (state.activeAttemptId !== null && state.activeAttemptId !== context.claim.workId) {
      throw new RuntimeInvariantError({
        code: "pi_attempt_conflict",
        message: "Pi is bound to a different active attempt.",
        action: "restart_pi",
      });
    }

    const raw = await context.session.external(async (signal) =>
      await context.deps.pi.readBrokerEvents({
        boxId: requiredRuntime(context).boxId,
        after: auth.eventCursor!,
        signal,
      }));
    const page = validatePiJournalRead({
      value: raw,
      after: auth.eventCursor,
      attemptId: context.claim.workId,
      invocationId: auth.piInvocationId,
    });
    if (page.nextCursor === auth.eventCursor) {
      await context.deps.clock.sleep(
        context.deps.eventPollIntervalMs ?? 500,
        context.session.signal,
      );
      continue;
    }
    const classified = classifyPiJournalPage(page, context.deps.clock.now(), redact);
    const counters = cumulativeCounters({
      authorization: auth,
      broker: state.counters,
      pageUnknown: classified.unknownEvents,
    });
    const projected = await context.session.adoptExternalMutation(async (expectedSequence) => {
      const result = await context.deps.eventProjector.projectEventBatch({
        store: context.deps.store,
        fence: context.session.fence,
        expectedSequence,
        piInvocationId: auth.piInvocationId!,
        projections: classified.projections,
        throughCursor: classified.throughCursor,
        ...(classified.activity ? { activityAt: context.deps.clock.now() } : {}),
        unknownEventCount: counters.unknown,
        malformedEventCount: counters.malformed,
        oversizedEventCount: counters.oversized,
      });
      return result
        ? {
          sequence: result.checkpointSequence,
          value: {
            eventCursor: result.eventCursor,
            hasVisibleOutput: result.hasVisibleOutput,
          },
        }
        : null;
    });
    if (projected.eventCursor !== classified.throughCursor) {
      throw new RuntimeInvariantError({
        code: "pi_event_projection_invalid",
        message: "The projected Pi event cursor did not match the broker cursor.",
        action: "restart_pi",
      });
    }

    // This ordering is deliberate: PostgreSQL projection must commit before broker ACK.
    await ackEvents(context, classified.throughCursor);
    hasVisibleOutput = projected.hasVisibleOutput;
    if (classified.processExit) {
      return {
        kind: "settle",
        settlement: {
          terminalStatus: "failed",
          error: safeRuntimeError({
            code: "pi_process_exited",
            message: "Pi exited before completing the turn.",
            action: "restart_pi",
          }),
        },
      };
    }
    if (classified.settled) {
      // Loop instead of settling here. The next reauthorize reads `agent_settled` from the row this
      // projection just wrote and goes through `finishDurableTerminal`, so the live path and a
      // takeover run the identical harvest-then-settle sequence rather than two similar ones.
      continue;
    }
    if (classified.needsInput) return { kind: "release" };
  }
}

async function consumeAcceptedAttempt(
  context: AttemptContext,
  initialVisibleOutput: boolean | null,
  initialRedactor: RuntimeVisibleTextRedactor | null,
): Promise<RuntimeWorkDisposition> {
  try {
    let hasVisibleOutput = initialVisibleOutput;
    let redact = initialRedactor;
    const auth = await context.session.reauthorize();
    if (auth.workCheckpoint === "agent_settled" || auth.workCheckpoint === "process_exited") {
      return await finishDurableTerminal(context, auth);
    }
    if (hasVisibleOutput === null || redact === null) {
      const workMaterial = await material(context);
      hasVisibleOutput = workMaterial.hasVisibleOutput;
      redact = context.deps.projectionRedactorFactory.forMaterial({
        orgId: context.claim.orgId,
        material: workMaterial,
      });
    }
    return await consumeEvents(context, hasVisibleOutput, redact);
  } catch (error) {
    if (mustAbandonRuntimeExecution(error)) throw error;
    // Once Pi accepted a prompt, an observation/validation/ACK failure cannot
    // safely be represented as a terminal failure that releases the ordered
    // queue. Preserve the specific safe code when one exists, and require an
    // explicit retry/cancel path instead.
    return {
      kind: "settle",
      settlement: {
        terminalStatus: "interrupted",
        error: safeErrorFromUnknown(error, {
          code: "pi_event_stream_interrupted",
          message: "The accepted turn could not be safely reconciled with Pi events.",
          action: "restart_pi",
        }),
      },
    };
  }
}

export async function handleAttempt(context: AttemptContext): Promise<RuntimeWorkDisposition> {
  let commandId: string | null = null;
  let hasVisibleOutput: boolean | null = null;
  let redact: RuntimeVisibleTextRedactor | null = null;
  for (;;) {
    const auth = await context.session.reauthorize();
    switch (auth.workCheckpoint) {
      case "starting": {
        const workMaterial = await material(context);
        hasVisibleOutput = workMaterial.hasVisibleOutput;
        redact = context.deps.projectionRedactorFactory.forMaterial({
          orgId: context.claim.orgId,
          material: workMaterial,
        });
        let state = await brokerState(context);
        if (!state.layoutCurrent) {
          await refreshWarmCompanionLayout({
            session: context.session,
            deps: context.deps,
            authorization: authorization(context),
            restartPi: true,
            // `state` is the running broker's startup marker. If disk was updated by an executor
            // that died before recycle, refresh returns `none` but this stale process still must go.
            restartPiWhenUnchanged: true,
          });
          state = await brokerState(context);
          if (!state.layoutCurrent) {
            throw new RuntimeInvariantError({
              code: "pi_layout_stale",
              message: "Pi did not report the current runtime layout after refresh.",
              action: "restart_pi",
            });
          }
        }
        const runtime = requiredRuntime(context);
        requireModelInputCapability(state.modelInput, "text");
        // A turn carrying an image is refused here, against Pi's live report of what the selected
        // model accepts, and before a single byte reaches the Box. The member gets `switch_model`
        // instead of a reply that silently ignored what they sent.
        if (attachmentsIncludeImage(workMaterial.attachments)) {
          requireModelInputCapability(state.modelInput, "image");
        }
        // Overlay refresh recycles Pi in place. Bind to the live idle daemon: the stored instance
        // id can lag a health recycle or a restart that succeeded before this checkpoint.
        if (
          !state.invocationId
          || state.activeAttemptId !== null
          || state.tailCursor !== state.acknowledgedCursor
        ) {
          throw new RuntimeInvariantError({
            code: "pi_not_idle",
            message: "Pi was not idle with an empty broker queue before dispatch.",
            action: "restart_pi",
          });
        }
        const dispatchRuntime = { boxId: runtime.boxId, piInvocationId: state.invocationId };
        const promptText = workMaterial.promptText!
          + attachmentPromptSuffix(await stageAttachments(context, workMaterial));
        commandId = context.deps.idFactory.uuid();
        await context.session.checkpoint({
          nextCheckpoint: "dispatch_write_intent",
          commandId,
        });
        let outcome;
        let providerCallStarted = false;
        try {
          outcome = await context.session.external(async (signal) => {
            providerCallStarted = true;
            return await context.deps.pi.prompt({
              boxId: dispatchRuntime.boxId,
              commandId: commandId!,
              attemptId: context.claim.workId,
              message: promptText,
              signal,
            });
          });
        } catch (error) {
          if (!providerCallStarted || mustAbandonRuntimeExecution(error)) throw error;
          await checkpointDispatchAmbiguous(context, commandId);
          throw new AmbiguousExternalEffectError("prompt_dispatch_ambiguous");
        }
        // The SLO ends when the provider returns Pi's positive acknowledgement. Persisting that
        // acknowledgement is deliberately outside the measured interval: PostgreSQL latency must
        // not be attributed to Box or Pi prompt acceptance.
        const providerReturnedAt = context.deps.clock.now();
        if (outcome.outcome === "ambiguous") {
          await checkpointDispatchAmbiguous(context, commandId);
          throw new AmbiguousExternalEffectError("prompt_dispatch_ambiguous");
        }
        if (outcome.outcome === "rejected") {
          await context.session.checkpoint({
            nextCheckpoint: "dispatch_rejected",
            commandId,
          });
          return {
            kind: "settle",
            settlement: {
              terminalStatus: "failed",
              error: safeRuntimeError({
                code: "pi_prompt_rejected",
                message: "Pi rejected the prompt before accepting it.",
                action: "restart_pi",
              }),
            },
          };
        }
        if (outcome.invocationId !== dispatchRuntime.piInvocationId) {
          await checkpointDispatchAmbiguous(context, commandId);
          throw new AmbiguousExternalEffectError("prompt_dispatch_ambiguous");
        }
        const initialCursor = outcome.initialCursor;
        if (initialCursor < state.tailCursor) {
          await checkpointDispatchAmbiguous(context, commandId);
          throw new AmbiguousExternalEffectError("prompt_dispatch_ambiguous");
        }
        await context.session.checkpoint({
          nextCheckpoint: "dispatch_accepted",
          commandId,
          piInvocationId: outcome.invocationId,
          eventCursor: initialCursor,
          activityAt: providerReturnedAt,
        });
        // cold_start_deadline_at is re-stamped to (claim time + three minutes) when the queued turn
        // is claimed for a start (migration 0110), so it no longer equals turn.created_at + three
        // minutes. Subtracting the constant would recover the claim time, not the durable send time,
        // making a `sendToPromptAckMs` derived from it wrong. Log the raw deadline instead until a
        // real send timestamp is threaded onto the dispatch path.
        context.deps.log?.info({
          ts: providerReturnedAt.toISOString(),
          event: "runtime.prompt.ack",
          companionId: context.claim.companionId,
          attemptId: context.claim.workId,
          boxId: dispatchRuntime.boxId,
          invocationId: outcome.invocationId,
          initialCursor: initialCursor.toString(),
          ...(auth.coldStartDeadlineAt === null || auth.coldStartDeadlineAt === undefined
            ? {}
            : { coldStartDeadlineAt: auth.coldStartDeadlineAt.toISOString() }),
        });
        await refreshWarmTtl(context);
        break;
      }
      case "dispatch_write_intent":
        // No persisted ACK exists and the command id is intentionally not exposed on takeover.
        if (commandId === null) throw new AmbiguousExternalEffectError("prompt_dispatch_ambiguous");
        break;
      case "dispatch_ambiguous":
        throw new AmbiguousExternalEffectError("prompt_dispatch_ambiguous");
      case "dispatch_rejected":
        return {
          kind: "settle",
          settlement: {
            terminalStatus: "failed",
            error: safeRuntimeError({
              code: "pi_prompt_rejected",
              message: "Pi rejected the prompt before accepting it.",
              action: "restart_pi",
            }),
          },
        };
      case "dispatch_accepted":
      case "running":
      case "event_projected":
      case "needs_input":
      case "agent_settled":
      case "process_exited":
        return await consumeAcceptedAttempt(context, hasVisibleOutput, redact);
      default:
        throw new RuntimeInvariantError({
          code: "attempt_checkpoint_invalid",
          message: "The turn attempt reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

/**
 * Land this turn's uploaded files on the Box, before the dispatch write intent exists.
 *
 * Everything about the ordering is deliberate. Staging happens after Pi is confirmed idle and before
 * any dispatch intent is checkpointed, so an exhausted retry here is a proven negative: no prompt was
 * written, the turn settles `failed` with a retryable code rather than `interrupted`, and the queue
 * is released instead of blocked. A retry rewrites the identical paths, so replaying is free of
 * external side effects to reason about.
 */
async function stageAttachments(
  context: AttemptContext,
  material: RuntimeWorkMaterial,
): Promise<StagedRuntimeAttachment[]> {
  if (material.attachments.length === 0) return [];
  const auth = authorization(context);
  try {
    return await retryIdempotentLifecycle({
      call: "stage_attachments",
      clock: context.deps.clock,
      jitter: context.deps.jitter,
      signal: context.session.signal,
      deadlineAt: auth.absoluteDeadlineAt ?? undefined,
      operation: async () => await context.session.external(async (signal) =>
        await context.deps.attachmentStager.stageAttachments({
          orgId: context.claim.orgId,
          companionId: context.claim.companionId,
          boxId: requiredRuntime(context).boxId,
          messageEventId: material.messageEventId!,
          material,
          authorization: authorization(context),
          signal,
        })),
    });
  } catch (error) {
    if (mustAbandonRuntimeExecution(error)) throw error;
    throw new RuntimeInvariantError({
      code: "attachment_staging_failed",
      message: "The files attached to this message could not be staged on the Companion's Box.",
      action: "retry",
    });
  }
}

async function checkpointDispatchAmbiguous(
  context: AttemptContext,
  commandId: string,
): Promise<void> {
  try {
    await context.session.checkpoint({
      nextCheckpoint: "dispatch_ambiguous",
      commandId,
    });
  } catch (error) {
    if (mustAbandonRuntimeExecution(error)) throw error;
    // The prompt may already be on Pi. If even the ambiguity checkpoint cannot be classified,
    // abandon this executor and let takeover inspect durable state; never settle it as replay-safe.
    throw new RuntimeStoreIndeterminateError();
  }
}
