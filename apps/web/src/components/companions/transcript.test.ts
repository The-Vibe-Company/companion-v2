import type { CompanionThread, CompanionTranscriptEntry } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import {
  composerHint,
  localDay,
  replyExpected,
  transcriptAuthor,
  transcriptDisplayContent,
  utcDay,
} from "./transcript";

function entry(overrides: Partial<CompanionTranscriptEntry> = {}): CompanionTranscriptEntry {
  return {
    event_id: "msg:1",
    ordinal: 0,
    role: "user",
    content: "Draft the launch note",
    author_id: "user-1",
    author_name: "Ada",
    tool: null,
    decision: null,
    reasoning: null,
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
    last_read_ordinal: null,
    ...overrides,
  };
}

describe("transcriptDisplayContent", () => {
  it.each([
    ["Pi ended the turn without a visible reply.", "Luna ended the turn without a visible reply."],
    ["Pi ended the turn without a reply (error).", "Luna ended the turn without a reply (error)."],
    ["Pi ended the turn without a reply (aborted).", "Luna ended the turn without a reply (aborted)."],
    ["Pi did not accept the message: unavailable", "Luna did not accept the message: unavailable"],
  ])("names the Companion in a system note: %s", (content, expected) => {
    expect(transcriptDisplayContent(entry({ role: "system", content }), "Luna")).toBe(expected);
  });

  it("only replaces Pi as a standalone name", () => {
    expect(transcriptDisplayContent(
      entry({
        role: "system",
        content: "Pi stopped; pi.dev, Pipedream, Piñata, and αPi stayed available.",
      }),
      "Luna",
    )).toBe("Luna stopped; pi.dev, Pipedream, Piñata, and αPi stayed available.");
  });

  it.each(["user", "assistant", "tool", "decision"] as const)(
    "keeps %s content literal",
    (role) => {
      expect(transcriptDisplayContent(entry({ role, content: "Pi stayed literal." }), "Luna"))
        .toBe("Pi stayed literal.");
    },
  );

  it("inserts a Companion name literally", () => {
    expect(transcriptDisplayContent(entry({ role: "system", content: "Pi stopped." }), "$& Atlas"))
      .toBe("$& Atlas stopped.");
  });
});

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
    expect(transcriptAuthor(entry({ role: "decision" }), "user-1", "Luna")).toBeNull();
  });
});

describe("transcript day keys", () => {
  it("names a day the same way whatever clock produced the key", () => {
    // Both keys are `YYYY-MM-DD`, so the separator's own label formats identically either way.
    expect(utcDay("2026-08-14T23:30:00.000Z")).toBe("2026-08-14");
    expect(localDay("2026-08-14T23:30:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

  it("keeps waiting while a permission card is still open mid-turn", () => {
    expect(replyExpected({
      entries: [entry(), entry({ event_id: "decision:ui-1", role: "decision" })],
      awake: true,
    })).toBe(true);
  });

  it("never waits on a Box that is not running, because nothing has been delivered", () => {
    expect(replyExpected({ entries: [entry()], awake: false })).toBe(false);
    expect(replyExpected({ entries: [], awake: true })).toBe(false);
  });
});

describe("composerHint", () => {
  it("explains the keys while nothing is waiting", () => {
    expect(composerHint({ thread: thread(), companionName: "Luna", state: "running" }))
      .toBe("Enter sends. Shift + Enter starts a new line.");
  });

  it("counts messages waiting on a reply and messages waiting on a wake", () => {
    expect(composerHint({
      thread: thread({ pending_count: 1 }),
      companionName: "Luna",
      state: "running",
    })).toBe("1 message waiting for a reply.");
    expect(composerHint({
      thread: thread({ pending_count: 2 }),
      companionName: "Luna",
      state: "stopped",
    })).toBe("2 messages saved. Wake Luna to deliver.");
  });

  it("never asks for a wake that is already under way or already done", () => {
    // The footer reads the same projected state as the status chip, so a Companion a send has woken
    // cannot keep asking to be woken.
    expect(composerHint({
      thread: thread({ pending_count: 1 }),
      companionName: "Luna",
      state: "provisioning",
    })).toBe("1 message saved. Luna is waking to deliver.");
    expect(composerHint({
      thread: thread({ pending_count: 1 }),
      companionName: "Luna",
      state: "running",
    })).not.toContain("Wake Luna");
  });
});
