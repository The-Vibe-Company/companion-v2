import type { SkillRunDetail } from "@companion/contracts";

export function canReactivateRun(run: SkillRunDetail | null, now = Date.now()): boolean {
  if (!run?.can_reactivate || !run.reactivatable_until) return false;
  if (run.status !== "frozen" && run.status !== "interrupted" && run.status !== "canceled") return false;
  return Date.parse(run.reactivatable_until) > now;
}

/** Terminal retained sessions share the same text-and-file composer as a live session. */
export function canUseRunComposer(
  status: SkillRunDetail["status"] | null,
  liveSendReady: boolean,
  terminalCanReactivate: boolean,
): boolean {
  return liveSendReady
    || ((status === "frozen" || status === "interrupted" || status === "canceled") && terminalCanReactivate);
}

/** A terminal prompt can commit even when its HTTP acknowledgement is lost, so polling must resume. */
export function shouldRestartPollingAfterPromptFailure(status: SkillRunDetail["status"] | null): boolean {
  return status === "frozen" || status === "interrupted" || status === "canceled";
}

/** Reject stale detail fetches without blocking a legitimate terminal -> queued generation. */
export function isStaleRunDetail(current: SkillRunDetail, next: SkillRunDetail): boolean {
  if (next.activation_revision < current.activation_revision) return true;
  if (next.activation_revision > current.activation_revision) return false;
  if (next.transcript_event_sequence < current.transcript_event_sequence) return true;
  const currentTerminal = ["frozen", "interrupted", "error", "canceled"].includes(current.status);
  const nextTerminal = ["frozen", "interrupted", "error", "canceled"].includes(next.status);
  return currentTerminal && !nextTerminal && next.transcript_event_sequence <= current.transcript_event_sequence;
}
