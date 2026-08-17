import {
  AmbiguousExternalEffectError,
  RuntimeHandoffError,
  RuntimeInvariantError,
  RuntimeShutdownError,
  safeErrorFromUnknown,
  safeRuntimeError,
} from "./errors";
import { runtimeSucceeded, type RuntimeWorkDisposition } from "./handler";
import {
  LeaseAuthorizationDeniedError,
  LeaseFenceLostError,
  LeaseRenewalError,
  type LeaseSession,
} from "./leaseSession";
import { BOX_WARM_TTL_SECONDS } from "./operations";
import {
  classifyPiJournalPage,
  validateBrokerCounters,
  validatePiJournalRead,
  type PiBrokerCounters,
} from "./piEvents";
import type { RuntimeEngineDependencies } from "./ports";
import type { RuntimeVisibleTextRedactor } from "./projectionRedaction";
import { retryIdempotentLifecycle } from "./retry";
import {
  RuntimeStoreIndeterminateError,
  RuntimeStoreSerializationError,
} from "./store";
import type {
  AttemptRuntimeClaim,
  ModelInputCapability,
  RuntimeAuthorization,
  RuntimeWorkMaterial,
} from "./types";

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
  return terminal.hasVisibleOutput ? runtimeSucceeded : explicitNoResponse();
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
    if (classified.needsInput) return { kind: "release" };
    if (classified.settled) {
      return hasVisibleOutput ? runtimeSucceeded : explicitNoResponse();
    }
  }
}

function mustAbandonFence(error: unknown): boolean {
  return error instanceof LeaseFenceLostError
    || error instanceof LeaseRenewalError
    || error instanceof LeaseAuthorizationDeniedError
    || error instanceof RuntimeStoreSerializationError
    || error instanceof RuntimeStoreIndeterminateError
    || error instanceof RuntimeHandoffError
    || error instanceof RuntimeShutdownError;
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
    if (mustAbandonFence(error)) throw error;
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
        const state = await brokerState(context);
        const runtime = requiredRuntime(context);
        requireModelInputCapability(state.modelInput, "text");
        if (
          state.invocationId !== runtime.piInvocationId
          || state.activeAttemptId !== null
          || state.tailCursor !== state.acknowledgedCursor
        ) {
          throw new RuntimeInvariantError({
            code: "pi_not_idle",
            message: "Pi was not idle with an empty broker queue before dispatch.",
            action: "restart_pi",
          });
        }
        commandId = context.deps.idFactory.uuid();
        await context.session.checkpoint({
          nextCheckpoint: "dispatch_write_intent",
          commandId,
        });
        let outcome;
        try {
          outcome = await context.session.external(async (signal) =>
            await context.deps.pi.prompt({
              boxId: requiredRuntime(context).boxId,
              commandId: commandId!,
              attemptId: context.claim.workId,
              message: workMaterial.promptText!,
              signal,
            }));
        } catch {
          await context.session.checkpoint({
            nextCheckpoint: "dispatch_ambiguous",
            commandId,
          });
          throw new AmbiguousExternalEffectError("prompt_dispatch_ambiguous");
        }
        if (outcome.outcome === "ambiguous") {
          await context.session.checkpoint({
            nextCheckpoint: "dispatch_ambiguous",
            commandId,
          });
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
        if (outcome.invocationId !== runtime.piInvocationId) {
          await context.session.checkpoint({
            nextCheckpoint: "dispatch_ambiguous",
            commandId,
          });
          throw new AmbiguousExternalEffectError("prompt_dispatch_ambiguous");
        }
        await context.session.checkpoint({
          nextCheckpoint: "dispatch_accepted",
          commandId,
          piInvocationId: outcome.invocationId,
          eventCursor: state.tailCursor,
          activityAt: context.deps.clock.now(),
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
