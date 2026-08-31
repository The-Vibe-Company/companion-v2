import {
  AmbiguousExternalEffectError,
  RuntimeInvariantError,
  safeRuntimeError,
} from "./errors";
import { mustAbandonRuntimeExecution } from "./executionControl";
import { runtimeSucceeded, type RuntimeWorkDisposition } from "./handler";
import type { LeaseSession } from "./leaseSession";
import type { RuntimeEngineDependencies } from "./ports";
import { retryIdempotentObservation } from "./retry";
import { RuntimeStoreIndeterminateError } from "./store";
import type { DecisionRuntimeClaim, RuntimeAuthorization } from "./types";

interface DecisionContext {
  claim: DecisionRuntimeClaim;
  session: LeaseSession;
  deps: RuntimeEngineDependencies;
}

interface DecisionRuntimeBinding {
  boxId: string;
  invocationId: string;
}

function authorization(context: DecisionContext): RuntimeAuthorization {
  const value = context.session.authorization;
  if (!value?.authorized) {
    throw new RuntimeInvariantError({
      code: "runtime_authorization_missing",
      message: "Runtime authorization was unavailable for decision delivery.",
      action: "none",
    });
  }
  return value;
}

function runtimeBinding(context: DecisionContext): DecisionRuntimeBinding {
  const value = authorization(context);
  if (!value.boxId || !value.piInvocationId || value.diskLayoutVersion !== 14) {
    throw new RuntimeInvariantError({
      code: "decision_runtime_unavailable",
      message: "The active Pi invocation is unavailable for decision delivery.",
      action: "restart_pi",
    });
  }
  return { boxId: value.boxId, invocationId: value.piInvocationId };
}

export async function handleDecision(
  context: DecisionContext,
): Promise<RuntimeWorkDisposition> {
  let commandId: string | null = null;
  for (;;) {
    const auth = await context.session.reauthorize();
    switch (auth.workCheckpoint) {
      case "pending": {
        const workMaterial = await context.session.fencedLookup(async () =>
          await context.deps.materialProvider.getMaterial({
            store: context.deps.store,
            fence: context.session.fence,
            signal: context.session.signal,
          }));
        if (
          workMaterial.turnId !== context.claim.turnId
          || !workMaterial.attemptId
          || !workMaterial.decisionRequestKind
          || !workMaterial.decisionResponsePayload
        ) {
          throw new RuntimeInvariantError({
            code: "decision_response_unavailable",
            message: "The durable decision response is unavailable.",
            action: "none",
          });
        }
        const binding = runtimeBinding(context);
        const broker = await retryIdempotentObservation({
          call: "get_broker_state",
          clock: context.deps.clock,
          jitter: context.deps.jitter,
          signal: context.session.signal,
          deadlineAt: auth.absoluteDeadlineAt ?? undefined,
          operation: async () => await context.session.external(async (signal) => {
            const currentBinding = runtimeBinding(context);
            if (
              currentBinding.boxId !== binding.boxId
              || currentBinding.invocationId !== binding.invocationId
            ) {
              throw new RuntimeStoreIndeterminateError();
            }
            return await context.deps.pi.brokerState({ boxId: binding.boxId, signal });
          }),
        });
        if (
          broker.invocationId !== binding.invocationId
          || broker.activeAttemptId !== workMaterial.attemptId
        ) {
          throw new RuntimeInvariantError({
            code: "decision_attempt_mismatch",
            message: "Pi is not waiting on the decision's active attempt.",
            action: "restart_pi",
          });
        }
        commandId = context.deps.idFactory.uuid();
        await context.session.checkpoint({ nextCheckpoint: "write_intent", commandId });
        let outcome;
        let providerCallStarted = false;
        try {
          outcome = await context.session.external(async (signal) => {
            const currentBinding = runtimeBinding(context);
            if (
              currentBinding.boxId !== binding.boxId
              || currentBinding.invocationId !== binding.invocationId
            ) {
              throw new RuntimeStoreIndeterminateError();
            }
            providerCallStarted = true;
            return await context.deps.pi.respondExtensionUi({
              boxId: binding.boxId,
              commandId: commandId!,
              attemptId: workMaterial.attemptId!,
              response: workMaterial.decisionResponsePayload!,
              signal,
            });
          });
        } catch (error) {
          if (!providerCallStarted || mustAbandonRuntimeExecution(error)) throw error;
          await checkpointDecisionAmbiguous(context, commandId);
          throw new AmbiguousExternalEffectError("decision_delivery_ambiguous");
        }
        if (outcome.outcome === "ambiguous" || (
          outcome.outcome === "accepted" && outcome.invocationId !== binding.invocationId
        )) {
          await checkpointDecisionAmbiguous(context, commandId);
          throw new AmbiguousExternalEffectError("decision_delivery_ambiguous");
        }
        if (outcome.outcome === "rejected") {
          return {
            kind: "settle",
            settlement: {
              terminalStatus: "interrupted",
              error: safeRuntimeError({
                code: "pi_decision_rejected",
                message: "Pi rejected the durable decision response.",
                action: "retry",
              }),
            },
          };
        }
        return runtimeSucceeded;
      }
      case "write_intent":
      case "ambiguous":
        // A response may already have reached Pi. Neither the command nor the response is replayed.
        throw new AmbiguousExternalEffectError("decision_delivery_ambiguous");
      default:
        throw new RuntimeInvariantError({
          code: "decision_checkpoint_invalid",
          message: "Decision delivery reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function checkpointDecisionAmbiguous(
  context: DecisionContext,
  commandId: string,
): Promise<void> {
  try {
    await context.session.checkpoint({ nextCheckpoint: "ambiguous", commandId });
  } catch (error) {
    if (mustAbandonRuntimeExecution(error)) throw error;
    throw new RuntimeStoreIndeterminateError();
  }
}
