import type {
  CompanionRuntimeState,
  CompanionThread,
  CompanionTranscriptEntry,
} from "@companion/contracts";

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

/**
 * Whether Pi owes this thread a reply. A running Box whose transcript ends on a member's message is
 * working on one, and saying so is the difference between a live thread and one that looks stuck. A
 * transcript ending on a tool or decision is the same promise mid-turn. A timed-out tool is
 * the exception: the control plane aborted that turn, so keeping it in-flight would leave the
 * composer disabled after the tool had already failed closed. It is read from the transcript the
 * reader already has, so it never asks Box anything.
 */
export function replyExpected(input: {
  entries: readonly CompanionTranscriptEntry[];
  awake: boolean;
  /** Messages waiting for Pi rather than a reply. Omit only when judging transcript history alone. */
  pendingCount?: number;
}): boolean {
  if (!input.awake) return false;
  const tail = input.entries[input.entries.length - 1];
  if (tail?.role === "user") {
    if (input.pendingCount !== undefined) return input.pendingCount === 0;
    for (let index = input.entries.length - 2; index >= 0; index -= 1) {
      const entry = input.entries[index];
      if (entry?.role === "assistant") return true;
      if (entry?.role === "tool" && entry.tool?.status === "timeout") return false;
    }
    return true;
  }
  if (tail?.role === "tool") return tail.tool?.status !== "timeout";
  if (tail?.role === "decision") return true;
  return false;
}

/**
 * What the composer says under itself: delivery when messages are waiting, keys otherwise. Delivery
 * is read from the same projected runtime state as the Box status chip, so the footer of a Companion
 * a send has just started never suggests a second lifecycle action, and a Companion still
 * coming up is reported as coming up rather than as one nobody has woken yet.
 */
export function composerHint(input: {
  thread: CompanionThread | null;
  companionName: string;
  state: CompanionRuntimeState;
}): string {
  const pending = input.thread?.pending_count ?? 0;
  if (pending < 1) {
    // A wake with nothing queued yet is the prewarm a keystroke started: say what the wait is and
    // roughly how long, so the reader keeps typing instead of wondering whether anything happened.
    return input.state === "provisioning"
      ? `${input.companionName} is waking, usually under a minute. Send when ready.`
      : "Enter sends. Shift + Enter starts a new line.";
  }
  const count = `${pending} message${pending === 1 ? "" : "s"}`;
  if (input.state === "running") return `${count} waiting for delivery.`;
  if (input.state === "provisioning") {
    return `${count} saved. ${input.companionName} is starting to deliver.`;
  }
  return `${count} saved. Send another message to retry delivery.`;
}
