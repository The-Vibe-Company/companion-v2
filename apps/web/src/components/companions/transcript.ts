import type {
  CompanionRuntimeState,
  CompanionThread,
  CompanionTranscriptEntry,
} from "@companion/contracts";

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
