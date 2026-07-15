import type { SkillRunDetail } from "@companion/contracts";

export function canReactivateRun(run: SkillRunDetail | null, now = Date.now()): boolean {
  if (!run?.can_reactivate || !run.reactivatable_until) return false;
  if (run.status !== "frozen" && run.status !== "canceled") return false;
  return Date.parse(run.reactivatable_until) > now;
}

/** A terminal prompt can commit even when its HTTP acknowledgement is lost, so polling must resume. */
export function shouldRestartPollingAfterPromptFailure(status: SkillRunDetail["status"] | null): boolean {
  return status === "frozen" || status === "canceled";
}

/** Reject stale detail fetches without blocking a legitimate terminal -> queued generation. */
export function isStaleRunDetail(current: SkillRunDetail, next: SkillRunDetail): boolean {
  if (next.activation_revision < current.activation_revision) return true;
  if (next.activation_revision > current.activation_revision) return false;
  if (next.transcript_event_sequence < current.transcript_event_sequence) return true;
  const currentTerminal = ["frozen", "error", "canceled"].includes(current.status);
  const nextTerminal = ["frozen", "error", "canceled"].includes(next.status);
  return currentTerminal && !nextTerminal && next.transcript_event_sequence <= current.transcript_event_sequence;
}
