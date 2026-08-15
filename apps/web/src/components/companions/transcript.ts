import type {
  CompanionRuntimeState,
  CompanionThread,
  CompanionTranscriptEntry,
} from "@companion/contracts";

/**
 * How long a writer keeps the floor. Consecutive turns from the same writer inside this window read
 * as one passage, so the transcript names the writer and the clock once per passage instead of
 * repeating both on every line.
 */
const PASSAGE_WINDOW_MS = 15 * 60 * 1000;

/** One transcript entry with everything the render needs that the entry itself does not carry. */
export interface TranscriptTurn {
  entry: CompanionTranscriptEntry;
  /** Who wrote it, as it is shown: the reader is "You", Pi is the Companion, a note is neither. */
  author: string | null;
  /** True when this turn opens a passage, so it carries the writer and the time. */
  lead: boolean;
  /** True while the control plane has not confirmed this message yet. */
  sending: boolean;
  /**
   * The day this turn opens, as `YYYY-MM-DD`, or null when it continues the day above it. Server
   * markup keys it on the stored UTC day so both renders agree; once the client owns the clock the
   * key is the reader's own day, so the separator and the times beneath it name the same date.
   */
  startsDay: string | null;
  /** True on the first message this reader has not caught up on, which is where "New" is drawn. */
  startsNew: boolean;
}

/**
 * Present a control-plane note in the Companion's product vocabulary. Historical notes store Pi's
 * runtime name, but the transcript speaks about the Companion the reader opened and follows its
 * current name after a rename. Only system notes cross this boundary: replies and tool output stay
 * literal, even when they mention Pi themselves.
 */
export function transcriptDisplayContent(
  entry: CompanionTranscriptEntry,
  companionName: string,
): string {
  if (entry.role !== "system") return entry.content;
  return entry.content.replace(
    /(^|[^\p{L}\p{M}\p{N}\p{Pc}])Pi(?=$|[^\p{L}\p{M}\p{N}\p{Pc}])/gu,
    (_match, prefix: string) => `${prefix}${companionName}`,
  );
}

/**
 * Who wrote this entry. A thread shared with Editors has several writers, so only the reader's own
 * messages say "You"; a teammate's message keeps their name. A system note and a tool run have no
 * writer: they report what happened to the run rather than something anyone said.
 */
export function transcriptAuthor(
  entry: CompanionTranscriptEntry,
  viewerId: string,
  companionName: string,
): string | null {
  if (entry.role === "assistant") return companionName;
  if (entry.role === "system" || entry.role === "tool" || entry.role === "decision") return null;
  if (entry.author_id === viewerId) return "You";
  return entry.author_name ?? "Member";
}

/** The stored day, which is the one both renders can agree on before the client has its clock. */
export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/** The reader's own day, as the same `YYYY-MM-DD` key so the separator label formats identically. */
export function localDay(iso: string): string {
  const at = new Date(iso);
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const dayOfMonth = `${at.getDate()}`.padStart(2, "0");
  return `${at.getFullYear()}-${month}-${dayOfMonth}`;
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
  context: {
    viewerId: string;
    companionName: string;
    /** The message this composer is still sending, named by the event id it will be stored under. */
    sendingEventId?: string | null;
    /**
     * This reader's own unread watermark as it stood when they opened the thread, from the
     * control plane rather than this device. The first message past it that somebody else wrote is
     * where "New" is drawn. Null leaves the thread undivided, which is what a first visit and a
     * thread the reader has caught up on both look like.
     */
    lastReadOrdinal?: number | null;
    /**
     * How a stored timestamp becomes the day it belongs to. Server markup uses the stored UTC day so
     * both renders agree; the client swaps in the reader's own calendar, because a separator that
     * says one date above a clock that says another is worse than no separator at all.
     */
    dayOf?: (iso: string) => string;
  },
): TranscriptTurn[] {
  let previous: { author: string | null; role: string; at: number } | null = null;
  // Day boundaries and the new-message divider are drawn on what was said, not on what ran: a tool
  // chip is chrome between two turns, so a separator that landed on one would separate a reply from
  // the machinery of its own turn.
  let previousDay: string | null = null;
  let newDrawn = false;
  return entries.map((entry) => {
    const author = transcriptAuthor(entry, context.viewerId, context.companionName);
    const at = millis(entry.created_at);
    const lead = author === null
      || previous === null
      || previous.author !== author
      || previous.role !== entry.role
      || at - previous.at > PASSAGE_WINDOW_MS;
    previous = { author, role: entry.role, at };

    const said = entry.role === "user" || entry.role === "assistant";
    const day = (context.dayOf ?? utcDay)(entry.created_at);
    const startsDay = said && day !== previousDay ? day : null;
    if (said) previousDay = day;

    const mine = entry.role === "user" && entry.author_id === context.viewerId;
    const startsNew = said
      && !mine
      && !newDrawn
      && context.lastReadOrdinal != null
      && entry.ordinal > context.lastReadOrdinal;
    if (startsNew) newDrawn = true;

    return {
      entry,
      author,
      lead,
      sending: context.sendingEventId !== undefined
        && context.sendingEventId !== null
        && entry.event_id === context.sendingEventId,
      startsDay,
      startsNew,
    };
  });
}

/**
 * Whether Pi owes this thread a reply. A running Box whose transcript ends on a member's message is
 * working on one, and saying so is the difference between a live thread and one that looks stuck. A
 * transcript ending on a tool run is the same promise mid-turn: Pi is doing the work the chip names
 * and has not spoken yet. It is read from the transcript the reader already has, so it never asks
 * Box anything: a sleeping Box owes nothing until it is woken, and the composer hint says so.
 */
export function replyExpected(input: {
  entries: readonly CompanionTranscriptEntry[];
  awake: boolean;
}): boolean {
  if (!input.awake) return false;
  const role = input.entries[input.entries.length - 1]?.role;
  return role === "user" || role === "tool" || role === "decision";
}

/**
 * What the composer says under itself: delivery when messages are waiting, keys otherwise. Delivery
 * is read from the same projected runtime state as the Box status chip, so the footer of a Companion
 * a send has just woken never keeps offering the wake that already happened, and a Companion still
 * coming up is reported as coming up rather than as one nobody has woken yet.
 */
export function composerHint(input: {
  thread: CompanionThread | null;
  companionName: string;
  state: CompanionRuntimeState;
}): string {
  const pending = input.thread?.pending_count ?? 0;
  if (pending < 1) return "Enter sends. Shift + Enter starts a new line.";
  const count = `${pending} message${pending === 1 ? "" : "s"}`;
  if (input.state === "running") return `${count} waiting for a reply.`;
  if (input.state === "provisioning") {
    return `${count} saved. ${input.companionName} is waking to deliver.`;
  }
  return `${count} saved. Wake ${input.companionName} to deliver.`;
}
