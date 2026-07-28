import type { ProjectEventEnvelope } from "@companion/contracts";

export function parseProjectLastEventId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** The durable envelope is the reducer input; Last-Event-ID is the same sequence. */
export function projectEventFrame(envelope: ProjectEventEnvelope): string {
  const eventType = /^[A-Za-z0-9_.-]{1,80}$/.test(envelope.event.type)
    ? envelope.event.type
    : "message";
  return `id: ${envelope.sequence}\nevent: ${eventType}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

export function projectReadyFrame(sessionId: string): string {
  return `event: ready\ndata: ${JSON.stringify({ type: "ready", session_id: sessionId })}\n\n`;
}

export function parseProjectEventNotification(
  value: string,
): { sessionId: string; sequence: number } | null {
  try {
    const parsed = JSON.parse(value) as {
      session_id?: unknown;
      sequence?: unknown;
    };
    if (
      typeof parsed.session_id !== "string" ||
      !Number.isSafeInteger(parsed.sequence) ||
      Number(parsed.sequence) <= 0
    ) {
      return null;
    }
    return {
      sessionId: parsed.session_id,
      sequence: Number(parsed.sequence),
    };
  } catch {
    return null;
  }
}
