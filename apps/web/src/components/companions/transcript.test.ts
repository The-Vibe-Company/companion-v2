import type { CompanionThread, CompanionTranscriptEntry } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import { composerHint, replyExpected, transcriptAuthor, transcriptTurns } from "./transcript";

function entry(overrides: Partial<CompanionTranscriptEntry> = {}): CompanionTranscriptEntry {
  return {
    event_id: "msg:1",
    ordinal: 0,
    role: "user",
    content: "Draft the launch note",
    author_id: "user-1",
    author_name: "Ada",
    created_at: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function thread(overrides: Partial<CompanionThread> = {}): CompanionThread {
  return {
    companion_id: "11111111-1111-4111-8111-111111111111",
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries: [],
    pending_count: 0,
    last_message_at: null,
    ...overrides,
  };
}

describe("transcriptAuthor", () => {
  it("credits the reader's own message to them and a teammate's to its author", () => {
    expect(transcriptAuthor(entry(), "user-1", "Luna")).toBe("You");
    expect(transcriptAuthor(entry(), "user-9", "Luna")).toBe("Ada");
  });

  it("falls back to Member when a shared thread lost the author's name", () => {
    expect(transcriptAuthor(entry({ author_name: null }), "user-9", "Luna")).toBe("Member");
  });

  it("credits a reply to the Companion and leaves a run note unattributed", () => {
    expect(transcriptAuthor(entry({ role: "assistant" }), "user-1", "Luna")).toBe("Luna");
    expect(transcriptAuthor(entry({ role: "system" }), "user-1", "Luna")).toBeNull();
  });
});

describe("transcriptTurns", () => {
  const context = { viewerId: "user-1", companionName: "Luna" };

  it("announces a writer once for a run of consecutive turns", () => {
    const turns = transcriptTurns([
      entry({ event_id: "msg:1", created_at: "2026-08-12T12:00:00.000Z" }),
      entry({ event_id: "msg:2", created_at: "2026-08-12T12:00:40.000Z" }),
    ], context);

    expect(turns.map((turn) => turn.lead)).toEqual([true, false]);
  });

  it("announces the writer again when the floor changes hands", () => {
    const turns = transcriptTurns([
      entry({ event_id: "msg:1" }),
      entry({ event_id: "pi:0", role: "assistant", created_at: "2026-08-12T12:00:20.000Z" }),
      entry({ event_id: "msg:2", created_at: "2026-08-12T12:00:50.000Z" }),
    ], context);

    expect(turns.map((turn) => turn.lead)).toEqual([true, true, true]);
  });

  it("announces the writer again after a long pause", () => {
    const turns = transcriptTurns([
      entry({ event_id: "msg:1", created_at: "2026-08-12T12:00:00.000Z" }),
      entry({ event_id: "msg:2", created_at: "2026-08-12T12:20:00.000Z" }),
    ], context);

    expect(turns.map((turn) => turn.lead)).toEqual([true, true]);
  });

  it("keeps a run note out of the passage it interrupts", () => {
    const turns = transcriptTurns([
      entry({ event_id: "msg:1" }),
      entry({
        event_id: "pi:12",
        role: "system",
        content: "Pi did not accept the message.",
        author_id: null,
        author_name: null,
        created_at: "2026-08-12T12:00:10.000Z",
      }),
      entry({ event_id: "msg:2", created_at: "2026-08-12T12:00:20.000Z" }),
    ], context);

    expect(turns.map((turn) => turn.author)).toEqual(["You", null, "You"]);
    // The note ends the passage, so the message after it names its writer again.
    expect(turns[2]?.lead).toBe(true);
  });

  it("marks only the message the composer has not had confirmed yet", () => {
    const turns = transcriptTurns(
      [entry({ event_id: "msg:1" }), entry({ event_id: "msg:2" })],
      { ...context, sendingEventId: "msg:2" },
    );

    expect(turns.map((turn) => turn.sending)).toEqual([false, true]);
  });

  it("marks nothing while no send is in flight", () => {
    // A saved entry is never in flight, and the id is the same one the control plane stored, so
    // nothing may go on claiming a message is still on its way once its send has settled.
    const turns = transcriptTurns([entry({ event_id: "msg:1" })], context);

    expect(turns[0]?.sending).toBe(false);
  });
});

describe("replyExpected", () => {
  it("waits on a running Box whose transcript ends on a member's message", () => {
    expect(replyExpected({ entries: [entry()], awake: true })).toBe(true);
  });

  it("stops waiting once the reply or the run note lands", () => {
    expect(replyExpected({
      entries: [entry(), entry({ event_id: "pi:0", role: "assistant" })],
      awake: true,
    })).toBe(false);
    expect(replyExpected({
      entries: [entry(), entry({ event_id: "pi:1", role: "system" })],
      awake: true,
    })).toBe(false);
  });

  it("never waits on a Box that is not running, because nothing has been delivered", () => {
    expect(replyExpected({ entries: [entry()], awake: false })).toBe(false);
    expect(replyExpected({ entries: [], awake: true })).toBe(false);
  });
});

describe("composerHint", () => {
  it("explains the keys while nothing is waiting", () => {
    expect(composerHint({ thread: thread(), companionName: "Luna", awake: true }))
      .toBe("Enter sends. Shift + Enter starts a new line.");
  });

  it("counts messages waiting on a reply and messages waiting on a wake", () => {
    expect(composerHint({ thread: thread({ pending_count: 1 }), companionName: "Luna", awake: true }))
      .toBe("1 message waiting for a reply.");
    expect(composerHint({ thread: thread({ pending_count: 2 }), companionName: "Luna", awake: false }))
      .toBe("2 messages saved. Wake Luna to deliver.");
  });
});
