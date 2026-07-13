import type { RunEventEnvelope } from "@companion/contracts";

const MAX_LAST_EVENT_ID = Number.MAX_SAFE_INTEGER;

/** Parse the SSE replay cursor without accepting floats, negatives, or oversized values. */
export function parseLastEventId(value: string | undefined): number {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_LAST_EVENT_ID ? parsed : 0;
}

/** Each durable event is one proper replayable SSE frame. */
export function runEventFrame(envelope: RunEventEnvelope): string {
  return `id: ${envelope.sequence}\nevent: message\ndata: ${JSON.stringify(envelope.event)}\n\n`;
}

/** Connection-local barrier emitted only after durable replay has caught up. */
export function runReadyFrame(sessionId = ""): string {
  return `event: message\ndata: ${JSON.stringify({ type: "ready", session_id: sessionId })}\n\n`;
}

export function runDrainAction(input: {
  eventCount: number;
  pageSize: number;
  notified: boolean;
  terminal: boolean;
  readySent: boolean;
}): "continue" | "close" | "ready" | "wait" {
  if (input.eventCount >= input.pageSize || input.notified) return "continue";
  if (input.terminal) return "close";
  return input.readySent ? "wait" : "ready";
}

/** LISTEN/NOTIFY carries cursors only; event contents are always re-read through creator-scoped RLS. */
export function parseRunEventNotification(value: string): { runId: string; sequence: number } | null {
  try {
    const parsed = JSON.parse(value) as { run_id?: unknown; sequence?: unknown };
    if (typeof parsed.run_id !== "string" || !Number.isSafeInteger(parsed.sequence) || Number(parsed.sequence) <= 0) {
      return null;
    }
    return { runId: parsed.run_id, sequence: Number(parsed.sequence) };
  } catch {
    return null;
  }
}
