import { RuntimeInvariantError } from "./errors";
import type { RuntimeClock } from "./clock";
import type { PiObservedState } from "./types";

export interface StagedRuntimeSettings {
  diskLayoutVersion: 14;
  appliedSettingsRevision: bigint;
  appliedSkillsRevision: number | null;
  materialExpiresAt: Date | null;
}

interface PiActivationObservation {
  state: PiObservedState;
  invocationId: string | null;
}

export interface ActivatedRuntimeSettings {
  piState: "idle";
  piInvocationId: string;
  appliedSettingsRevision: bigint;
  appliedSkillsRevision: number | null;
  materialExpiresAt: Date | null;
}

/**
 * Stage one frozen resource snapshot and activate it in a fresh Pi daemon.
 *
 * The caller persists the returned fields together in one fenced observation. A
 * takeover before that observation deliberately repeats both idempotent steps,
 * so it can never publish revisions against an unproven daemon invocation.
 */
export async function activateRuntimeSettings(input: {
  expectedSettingsRevision: bigint;
  expectedSkillsRevision: number | null;
  previousPiInvocationId: string | null;
  deadlineAt: Date;
  clock: Pick<RuntimeClock, "now" | "sleep">;
  signal: AbortSignal;
  stage(): Promise<StagedRuntimeSettings>;
  restartPi(): Promise<PiActivationObservation>;
  observePi(): Promise<PiActivationObservation>;
}): Promise<ActivatedRuntimeSettings> {
  const staged = await input.stage();
  if (
    staged.diskLayoutVersion !== 14
    || staged.appliedSettingsRevision !== input.expectedSettingsRevision
    || staged.appliedSkillsRevision !== input.expectedSkillsRevision
  ) {
    throw new RuntimeInvariantError({
      code: "settings_apply_mismatch",
      message: "The Box did not apply the exact claimed settings snapshot.",
      action: "retry",
    });
  }

  let pi = await input.restartPi();
  for (;;) {
    if (input.clock.now().getTime() >= input.deadlineAt.getTime()) {
      throw new RuntimeInvariantError({
        code: "pi_restart_deadline_exceeded",
        message: "Pi did not expose a new idle invocation for updated settings before the deadline.",
        action: "restart_pi",
      });
    }
    if (pi.state === "error" || pi.state === "absent") {
      throw new RuntimeInvariantError({
        code: "pi_start_failed",
        message: "Pi failed while activating updated settings.",
        action: "restart_pi",
      });
    }
    if (
      pi.state === "idle"
      && pi.invocationId
      && pi.invocationId !== input.previousPiInvocationId
    ) {
      return {
        piState: "idle",
        piInvocationId: pi.invocationId,
        appliedSettingsRevision: staged.appliedSettingsRevision,
        appliedSkillsRevision: staged.appliedSkillsRevision,
        materialExpiresAt: staged.materialExpiresAt,
      };
    }
    await input.clock.sleep(1_000, input.signal);
    pi = await input.observePi();
  }
}
