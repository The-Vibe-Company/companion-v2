import type { CompanionThread, CompanionTranscriptEntry } from "@companion/contracts";

/**
 * How long a writer keeps the floor. Consecutive turns from the same writer inside this window read
 * as one passage, so the transcript names the writer and the clock once per passage instead of
 * repeating both on every line.
 */
const PASSAGE_WINDOW_MS = 15 * 60 * 1000;

/** The event id the composer's own message carries until the control plane returns the saved one. */
export const SENDING_EVENT_ID = "sending";

/** One transcript entry with everything the render needs that the entry itself does not carry. */
export interface TranscriptTurn {
  entry: CompanionTranscriptEntry;
  /** Who wrote it, as it is shown: the reader is "You", Pi is the Companion, a note is neither. */
  author: string | null;
  /** True when this turn opens a passage, so it carries the writer and the time. */
  lead: boolean;
  /** True while the control plane has not confirmed this message yet. */
  sending: boolean;
}

/**
 * Who wrote this entry. A thread shared with Editors has several writers, so only the reader's own
 * messages say "You"; a teammate's message keeps their name. A system note has no writer: it reports
 * what happened to the run rather than something anyone said.
 */
export function transcriptAuthor(
  entry: CompanionTranscriptEntry,
  viewerId: string,
  companionName: string,
): string | null {
  if (entry.role === "assistant") return companionName;
  if (entry.role === "system") return null;
  if (entry.author_id === viewerId) return "You";
  return entry.author_name ?? "Member";
}

function millis(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Group a transcript into passages. A passage is a run of turns from one writer in one role inside
 * `PASSAGE_WINDOW_MS`; only its first turn is announced. System notes never join a passage, and they
 * never continue one either, so the writer is re-announced after an interruption.
 */
export function transcriptTurns(
  entries: readonly CompanionTranscriptEntry[],
  context: { viewerId: string; companionName: string },
): TranscriptTurn[] {
  let previous: { author: string | null; role: string; at: number } | null = null;
  return entries.map((entry) => {
    const author = transcriptAuthor(entry, context.viewerId, context.companionName);
    const at = millis(entry.created_at);
    const lead = author === null
      || previous === null
      || previous.author !== author
      || previous.role !== entry.role
      || at - previous.at > PASSAGE_WINDOW_MS;
    previous = { author, role: entry.role, at };
    return { entry, author, lead, sending: entry.event_id === SENDING_EVENT_ID };
  });
}

/**
 * Whether Pi owes this thread a reply. A running Box whose transcript ends on a member's message is
 * working on one, and saying so is the difference between a live thread and one that looks stuck. It
 * is read from the transcript the reader already has, so it never asks Box anything: a sleeping Box
 * owes nothing until it is woken, and the composer hint explains that instead.
 */
export function replyExpected(input: {
  entries: readonly CompanionTranscriptEntry[];
  awake: boolean;
}): boolean {
  if (!input.awake) return false;
  return input.entries[input.entries.length - 1]?.role === "user";
}

/** What the composer says under itself: delivery when messages are waiting, keys otherwise. */
export function composerHint(input: {
  thread: CompanionThread | null;
  companionName: string;
  awake: boolean;
}): string {
  const pending = input.thread?.pending_count ?? 0;
  if (pending < 1) return "Enter sends. Shift + Enter starts a new line.";
  const count = `${pending} message${pending === 1 ? "" : "s"}`;
  return input.awake
    ? `${count} waiting for a reply.`
    : `${count} saved. Wake ${input.companionName} to deliver.`;
}
