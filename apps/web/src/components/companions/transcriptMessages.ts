import { useMemo, useRef } from "react";
import type {
  CompanionDecision,
  CompanionToolRun,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { transcriptAuthor } from "./transcript";

/**
 * The transcript is a flat log of entries — a message, a reply, a tool run, a permission card — and
 * a chat is a column of messages. This module is the translation between them, and it is pure: it
 * takes the control-plane read model and returns what the thread renders, with no React state, no
 * fetching, and no knowledge of how any of it looks.
 *
 * The shape it produces is the one assistant-ui already understands. A turn Pi took is one assistant
 * message whose parts are its reasoning, its reply, and every run and card it produced along the way,
 * in the order they happened — so a turn reads as one thing that happened rather than as five
 * messages from the same speaker, and the hover action bar, the copy, and the message spacing all
 * belong to the turn instead of to its pieces.
 */

/** The tool names the thread registers UIs for. Neither is a tool anyone can call — see below. */
export const COMPANION_TOOL_NAME = "companion_tool";
export const COMPANION_DECISION_TOOL_NAME = "companion_decision";

/**
 * How long a writer keeps the floor. Consecutive messages from the same writer inside this window
 * read as one passage, so the transcript names the writer and the clock once per passage instead of
 * repeating both on every line.
 */
const PASSAGE_WINDOW_MS = 15 * 60 * 1000;

/** One rendered message: a member's message, a Pi turn, or a note about the run. */
export interface TranscriptMessage {
  /**
   * The first source entry's event id. A turn's group keeps this id as the turn grows, so the
   * runtime sees one message being extended rather than a new message per projected entry — and an
   * optimistic send keeps the id the control plane will store it under, so the saved entry replaces
   * it instead of joining it.
   */
  id: string;
  role: "user" | "assistant" | "system";
  /** Who wrote it, as it is shown: the reader is "You", Pi is the Companion, a note is neither. */
  author: string | null;
  /** True when this message opens a passage, so it carries the writer and the time. */
  lead: boolean;
  /** True while the control plane has not confirmed this message yet. */
  sending: boolean;
  /** The first source entry's timestamp: when the passage this message may open began. */
  createdAt: string;
  /** The entries this message was built from, in transcript order. */
  entries: readonly CompanionTranscriptEntry[];
}

export interface TranscriptGroupingContext {
  viewerId: string;
  companionName: string;
  /** The message this composer is still sending, named by the event id it will be stored under. */
  sendingEventId?: string | null;
}

/** A tool run and a permission card ride into the thread as tool calls; this is what they carry. */
export interface CompanionToolArgs {
  run: CompanionToolRun;
}

export interface CompanionDecisionArgs {
  decision: CompanionDecision;
}

/** True for the entries a Pi turn is made of, which are the ones that group together. */
function partOfTurn(entry: CompanionTranscriptEntry): boolean {
  return entry.role === "assistant" || entry.role === "tool" || entry.role === "decision";
}

function millis(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Group a transcript into messages.
 *
 * A member's message is its own message, and so is a note about the run — a refused send, a turn that
 * ended with nothing to show — because neither belongs to a turn. Everything Pi produced between two
 * such interruptions is one turn: a maximal run of replies, tool runs, and permission cards, however
 * they interleave.
 */
export function groupTranscriptEntries(
  entries: readonly CompanionTranscriptEntry[],
  context: TranscriptGroupingContext,
): TranscriptMessage[] {
  const groups: TranscriptMessage[] = [];
  let open: CompanionTranscriptEntry[] | null = null;

  const push = (
    role: TranscriptMessage["role"],
    grouped: readonly CompanionTranscriptEntry[],
  ) => {
    const first = grouped[0]!;
    groups.push({
      id: first.event_id,
      role,
      // The writer is the message's, not its first entry's: a turn that ran a tool before it said
      // anything is still the Companion speaking, and a note about the run is nobody speaking.
      author: role === "assistant"
        ? context.companionName
        : role === "system"
          ? null
          : transcriptAuthor(first, context.viewerId, context.companionName),
      // Filled in below, once every message's writer and clock are known.
      lead: true,
      sending: context.sendingEventId != null
        && grouped.some((entry) => entry.event_id === context.sendingEventId),
      createdAt: first.created_at,
      entries: grouped,
    });
  };

  for (const entry of entries) {
    if (partOfTurn(entry)) {
      if (open) open.push(entry);
      else open = [entry];
      continue;
    }
    if (open) {
      push("assistant", open);
      open = null;
    }
    push(entry.role === "user" ? "user" : "system", [entry]);
  }
  if (open) push("assistant", open);

  let previous: { author: string | null; role: string; at: number } | null = null;
  for (const group of groups) {
    const at = millis(group.createdAt);
    // A note has no writer, so it neither opens nor continues a passage: the writer before it is
    // re-announced after the interruption.
    group.lead = group.author === null
      || previous === null
      || previous.author !== group.author
      || previous.role !== group.role
      || at - previous.at > PASSAGE_WINDOW_MS;
    previous = { author: group.author, role: group.role, at };
  }
  return groups;
}

type MessagePart = NonNullable<Exclude<ThreadMessageLike["content"], string>>[number];

function partsOf(entry: CompanionTranscriptEntry): MessagePart[] {
  if (entry.tool) {
    return [{
      type: "tool-call",
      // The transcript's own name for the run, not Pi's: an event id is unique inside a thread, so
      // two runs Pi happened to give the same call id still render as two cards.
      toolCallId: entry.event_id,
      toolName: COMPANION_TOOL_NAME,
      args: { run: entry.tool },
      // A running chip has no result yet. Everything the card shows is read from the run in `args`,
      // because this thread polls rather than streams: a part is never mid-flight, it is simply the
      // run as the last poll saw it.
      result: entry.tool.status === "running" ? undefined : { status: entry.tool.status },
    }];
  }
  if (entry.decision) {
    return [{
      type: "tool-call",
      toolCallId: entry.event_id,
      toolName: COMPANION_DECISION_TOOL_NAME,
      args: { decision: entry.decision },
      result: entry.decision.status === "pending" ? undefined : { status: entry.decision.status },
    }];
  }
  const parts: MessagePart[] = [];
  // Reasoning comes before the reply it produced, which is the order it happened in and the order a
  // reader who opens the disclosure expects to read it.
  if (entry.reasoning) parts.push({ type: "reasoning", text: entry.reasoning });
  if (entry.content) parts.push({ type: "text", text: entry.content });
  return parts;
}

/**
 * One grouped message as assistant-ui reads it. An assistant message with no parts at all would
 * render as an empty turn, so it keeps one empty text part — the same thing the runtime does for a
 * reply that has not produced anything yet.
 */
export function toThreadMessageLike(group: TranscriptMessage): ThreadMessageLike {
  const content = group.entries.flatMap(partsOf);
  return {
    id: group.id,
    role: group.role,
    content: content.length ? content : [{ type: "text", text: "" }],
    createdAt: new Date(group.createdAt),
  };
}

/**
 * Keep one object per entry across polls. The thread is re-read every couple of seconds and arrives
 * as fresh JSON each time, so without this every message would look new to the runtime and the whole
 * transcript would re-render mid-conversation.
 */
export function useStableEntries(
  entries: CompanionTranscriptEntry[],
): CompanionTranscriptEntry[] {
  const seen = useRef(new Map<string, CompanionTranscriptEntry>());
  const previous = useRef<CompanionTranscriptEntry[]>([]);
  return useMemo(() => {
    const next = new Map<string, CompanionTranscriptEntry>();
    const stable = entries.map((entry) => {
      const kept = seen.current.get(entry.event_id);
      const unchanged = kept
        && kept.role === entry.role
        && kept.content === entry.content
        && kept.reasoning === entry.reasoning
        && kept.author_id === entry.author_id
        && kept.author_name === entry.author_name
        // A chip is the one entry that changes after it is stored: it settles, and a visual run then
        // gains its frame. Only those three fields ever move, so comparing them is what keeps a
        // finished run from re-rendering on every poll for the rest of the conversation.
        && kept.tool?.status === entry.tool?.status
        && kept.tool?.detail === entry.tool?.detail
        && kept.tool?.screenshot === entry.tool?.screenshot
        && kept.decision?.status === entry.decision?.status
        && kept.decision?.answer === entry.decision?.answer
        && kept.decision?.decided_by_id === entry.decision?.decided_by_id
        && kept.created_at === entry.created_at;
      const value = unchanged ? kept : entry;
      next.set(entry.event_id, value);
      return value;
    });
    seen.current = next;
    const same = stable.length === previous.current.length
      && stable.every((entry, index) => entry === previous.current[index]);
    if (same) return previous.current;
    previous.current = stable;
    return stable;
  }, [entries]);
}

/** True when a message is built from exactly the same entry objects, in the same order and state. */
function sameGroup(kept: TranscriptMessage, next: TranscriptMessage): boolean {
  return kept.role === next.role
    && kept.author === next.author
    && kept.lead === next.lead
    && kept.sending === next.sending
    && kept.createdAt === next.createdAt
    && kept.entries.length === next.entries.length
    && kept.entries.every((entry, index) => entry === next.entries[index]);
}

/**
 * The same trick as `useStableEntries`, one level up. A turn's group is rebuilt on every poll because
 * grouping allocates, so without this the conversion to assistant-ui messages would run again for
 * every turn in the thread whenever any one of them changed.
 */
export function useStableGroups(groups: TranscriptMessage[]): TranscriptMessage[] {
  const seen = useRef(new Map<string, TranscriptMessage>());
  const previous = useRef<TranscriptMessage[]>([]);
  return useMemo(() => {
    const next = new Map<string, TranscriptMessage>();
    const stable = groups.map((group) => {
      const kept = seen.current.get(group.id);
      const value = kept && sameGroup(kept, group) ? kept : group;
      next.set(group.id, value);
      return value;
    });
    seen.current = next;
    const same = stable.length === previous.current.length
      && stable.every((group, index) => group === previous.current[index]);
    if (same) return previous.current;
    previous.current = stable;
    return stable;
  }, [groups]);
}
