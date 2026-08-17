import { handleAttempt } from "./attempt";
import { handleDecision } from "./decision";
import {
  AmbiguousExternalEffectError,
  RuntimeShutdownError,
  denialRuntimeError,
  safeErrorFromUnknown,
} from "./errors";
import type { RuntimeWorkDisposition } from "./handler";
import { handleHealth } from "./health";
import {
  LeaseAuthorizationDeniedError,
  LeaseFenceLostError,
  LeaseRenewalError,
  LeaseSession,
} from "./leaseSession";
import { handleOperation } from "./operations";
import type { RuntimeEngineDependencies } from "./ports";
import { handleSettings } from "./settings";
import {
  RuntimeStoreIndeterminateError,
  RuntimeStoreSerializationError,
} from "./store";
import type { RuntimeClaim, RuntimeSettlementInput } from "./types";

export type RuntimeExecutionOutcome =
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "released"
  | "fence_lost";

export interface RuntimeExecutionResult {
  workKind: RuntimeClaim["workKind"];
  workId: string;
  companionId: string;
  outcome: RuntimeExecutionOutcome;
}

const RELEASE_DENIALS = new Set([
  "higher_priority_work_pending",
  "settings_changed_since_claim",
  "settings_changed",
]);

export class RuntimeEngine {
  readonly #deps: RuntimeEngineDependencies;
  readonly #sessions = new Map<string, LeaseSession>();
  readonly #executions = new Set<Promise<RuntimeExecutionResult>>();
  #shuttingDown = false;

  constructor(dependencies: RuntimeEngineDependencies) {
    this.#deps = dependencies;
  }

  get activeCount(): number {
    return this.#executions.size;
  }

  execute(claim: RuntimeClaim): Promise<RuntimeExecutionResult> {
    const execution = this.#execute(claim);
    this.#executions.add(execution);
    const cleanup = (): void => {
      this.#executions.delete(execution);
    };
    // Do not use an ignored `finally()` promise here: it mirrors a rejection and
    // would become an unhandled rejection even when the caller handles `execution`.
    void execution.then(cleanup, cleanup);
    return execution;
  }

  requestShutdown(): void {
    this.#shuttingDown = true;
    this.interruptActive();
  }

  interruptActive(): void {
    for (const session of this.#sessions.values()) session.requestShutdown();
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#executions]);
  }

  async #execute(claim: RuntimeClaim): Promise<RuntimeExecutionResult> {
    const session = new LeaseSession({
      store: this.#deps.store,
      claim,
      executorId: this.#deps.executorId,
      clock: this.#deps.clock,
    });
    this.#sessions.set(claim.workId, session);
    try {
      const authorization = await session.start();
      if (!authorization.authorized) {
        return await this.#finishDenial(claim, session, authorization.denialCode);
      }
      if (this.#shuttingDown) {
        session.requestShutdown();
        return await this.#finishSettlement(claim, session, {
          terminalStatus: "interrupted",
          error: safeErrorFromUnknown(new RuntimeShutdownError(), {
            code: "runtime_shutting_down",
            message: "Runtime execution was interrupted during shutdown.",
            action: "retry",
          }),
        });
      }
      const disposition = await this.#dispatch(claim, session);
      if (disposition.kind === "release") {
        const released = await session.release();
        return this.#result(claim, released ? "released" : "fence_lost");
      }
      return await this.#finishSettlement(claim, session, disposition.settlement);
    } catch (error) {
      if (error instanceof LeaseFenceLostError || error instanceof LeaseRenewalError) {
        return this.#result(claim, "fence_lost");
      }
      if (
        error instanceof RuntimeStoreSerializationError
        || error instanceof RuntimeStoreIndeterminateError
      ) {
        // The database may have committed a response-lost CAS. Do not guess or replay a side effect.
        session.stop();
        return this.#result(claim, "fence_lost");
      }
      if (error instanceof LeaseAuthorizationDeniedError) {
        return await this.#finishDenial(claim, session, error.denialCode);
      }
      if (error instanceof AmbiguousExternalEffectError) {
        return await this.#finishSettlement(claim, session, {
          terminalStatus: "interrupted",
          error: safeErrorFromUnknown(error, {
            code: "external_effect_ambiguous",
            message: "An external effect may have succeeded and was not replayed.",
            action: "retry",
          }),
        });
      }
      if (error instanceof RuntimeShutdownError) {
        return await this.#finishSettlement(claim, session, {
          terminalStatus: "interrupted",
          error: safeErrorFromUnknown(error, {
            code: "runtime_shutting_down",
            message: "Runtime execution was interrupted during shutdown.",
            action: "retry",
          }),
        });
      }
      return await this.#finishSettlement(claim, session, {
        terminalStatus: "failed",
        error: safeErrorFromUnknown(error, {
          code: "runtime_execution_failed",
          message: "Runtime execution failed.",
          action: "retry",
        }),
      });
    } finally {
      session.stop();
      await session.drain();
      this.#sessions.delete(claim.workId);
    }
  }

  async #dispatch(
    claim: RuntimeClaim,
    session: LeaseSession,
  ): Promise<RuntimeWorkDisposition> {
    switch (claim.workKind) {
      case "operation":
        return await handleOperation({ claim, session, deps: this.#deps });
      case "decision":
        return await handleDecision({ claim, session, deps: this.#deps });
      case "attempt":
        return await handleAttempt({ claim, session, deps: this.#deps });
      case "settings":
        return await handleSettings({ claim, session, deps: this.#deps });
      case "health":
        return await handleHealth({ claim, session, deps: this.#deps });
    }
  }

  async #finishDenial(
    claim: RuntimeClaim,
    session: LeaseSession,
    denialCode: string | null,
  ): Promise<RuntimeExecutionResult> {
    const code = denialCode ?? "runtime_authorization_denied";
    if (RELEASE_DENIALS.has(code)) {
      const released = await session.release();
      return this.#result(claim, released ? "released" : "fence_lost");
    }
    const settlement = denialRuntimeError(code);
    return await this.#finishSettlement(claim, session, settlement);
  }

  async #finishSettlement(
    claim: RuntimeClaim,
    session: LeaseSession,
    settlement: RuntimeSettlementInput,
  ): Promise<RuntimeExecutionResult> {
    const settled = await session.settle(settlement);
    return this.#result(claim, settled ? settlement.terminalStatus : "fence_lost");
  }

  #result(claim: RuntimeClaim, outcome: RuntimeExecutionOutcome): RuntimeExecutionResult {
    return {
      workKind: claim.workKind,
      workId: claim.workId,
      companionId: claim.companionId,
      outcome,
    };
  }
}
