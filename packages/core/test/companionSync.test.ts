/* oxlint-disable anti-slop/no-shape-in-symbol-names -- The fixture mirrors the shared icon catalog field. */

import { describe, expect, it } from "vitest";
import type {
  Companion,
  CompanionSection,
  CompanionThread,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import {
  buildCompanionRosterSync,
  buildCompanionThreadDelta,
  CompanionSyncCursorError,
} from "../src/companionSync";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "user-1";
const COMPANION_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_COMPANION_ID = "33333333-3333-4333-8333-333333333333";
const SECTION_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_ONE = "msg:55555555-5555-4555-8555-555555555555";
const EVENT_TWO = "msg:66666666-6666-4666-8666-666666666666";
const EVENT_THREE = "msg:77777777-7777-4777-8777-777777777777";
const NOW = "2026-08-29T00:00:00.000Z";

const companion: Companion = {
  id: COMPANION_ID,
  name: "Research",
  persona: "Check sources.",
  icon: { shape: 0, mouth: 0, accessory: 0, color: 0 },
  model_id: "claude-opus-4-8",
  selected_skill_ids: [],
  can_write_skills: true,
  selected_mcp_account_ids: [],
  owner_id: OWNER_ID,
  section_id: SECTION_ID,
  access: "owner",
  pinned: false,
  hidden: false,
  muted: false,
  unread: false,
  last_message: null,
  runtime: {
    generation: 1,
    state: "running",
    daemon_state: "running",
    replying: false,
    box_id: "box-1",
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 14,
    desktop_available: true,
    last_error: null,
    skills_revision: 1,
    skills_applied_revision: 1,
    skills_applied_at: NOW,
    skills_last_error: null,
    last_observed_at: NOW,
    last_started_at: NOW,
    last_stopped_at: null,
    latest_operation: null,
  },
  created_at: NOW,
  updated_at: NOW,
};

const section: CompanionSection = {
  id: SECTION_ID,
  org_id: ORG_ID,
  owner_id: OWNER_ID,
  name: "Work",
  position: 0,
  created_at: NOW,
  updated_at: NOW,
};

function entry(
  eventId: string,
  ordinal: number,
  content: string,
): CompanionTranscriptEntry {
  return {
    event_id: eventId,
    ordinal,
    role: "user",
    content,
    reasoning: null,
    author_id: OWNER_ID,
    author_name: "Owner",
    tool: null,
    decision: null,
    routine: null,
    trigger: null,
    turn_id: null,
    queued: false,
    attachments: [],
    created_at: NOW,
  };
}

function thread(entries: CompanionTranscriptEntry[]): CompanionThread {
  return {
    companion_id: COMPANION_ID,
    viewer_id: OWNER_ID,
    access: "owner",
    read_only: false,
    can_send: true,
    transcription_available: true,
    entries,
    active_turn: null,
    queued_count: 0,
    interrupted_turn: null,
    last_message_at: NOW,
    last_read_ordinal: null,
  };
}

describe("Companion stateless sync projections", () => {
  it("returns a complete initial roster and an empty unchanged delta", () => {
    const initial = buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companions: [companion],
      sections: [section],
    });

    expect(initial.changed_companions).toEqual([companion]);
    expect(initial.changed_sections).toEqual([section]);
    expect(initial.deleted_companion_ids).toEqual([]);
    expect(initial.deleted_section_ids).toEqual([]);
    expect(initial.companion_ids).toEqual([COMPANION_ID]);
    expect(initial.section_ids).toEqual([SECTION_ID]);

    const unchanged = buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companions: [companion],
      sections: [section],
      cursor: initial.cursor,
    });
    expect(unchanged.changed_companions).toEqual([]);
    expect(unchanged.changed_sections).toEqual([]);
    expect(unchanged.deleted_companion_ids).toEqual([]);
    expect(unchanged.deleted_section_ids).toEqual([]);
    expect(unchanged.companion_ids).toEqual([COMPANION_ID]);
    expect(unchanged.section_ids).toEqual([SECTION_ID]);
    expect(unchanged.cursor).toBe(initial.cursor);
  });

  it("returns changed/new projections and deletion tombstones", () => {
    const initial = buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companions: [companion],
      sections: [section],
    });
    const changed = {
      ...companion,
      name: "Research updated",
      updated_at: "2026-08-29T00:01:00.000Z",
    };
    const added = { ...companion, id: SECOND_COMPANION_ID, name: "New" };
    const next = buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companions: [changed, added],
      sections: [],
      cursor: initial.cursor,
    });

    expect(next.changed_companions).toEqual([changed, added]);
    expect(next.deleted_companion_ids).toEqual([]);
    expect(next.changed_sections).toEqual([]);
    expect(next.deleted_section_ids).toEqual([SECTION_ID]);
    expect(next.companion_ids).toEqual([COMPANION_ID, SECOND_COMPANION_ID]);
    expect(next.section_ids).toEqual([]);
    // Replaying the same prior snapshot is deterministic and does not invent duplicates.
    expect(buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companions: [changed, added],
      sections: [],
      cursor: initial.cursor,
    })).toEqual(next);
  });

  it("carries current roster order even when no row changed", () => {
    const second = { ...companion, id: SECOND_COMPANION_ID, name: "Second" };
    const initial = buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companions: [companion, second],
      sections: [section],
    });
    const reordered = buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companions: [second, companion],
      sections: [section],
      cursor: initial.cursor,
    });
    expect(reordered.changed_companions).toEqual([]);
    expect(reordered.companion_ids).toEqual([SECOND_COMPANION_ID, COMPANION_ID]);
  });

  it("rejects malformed, oversized, cross-scope, and internally inconsistent cursors", () => {
    expect(() => buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companions: [],
      sections: [],
      cursor: "not-a-cursor",
    })).toThrow(CompanionSyncCursorError);
    expect(() => buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companions: [],
      sections: [],
      cursor: "a".repeat(256 * 1024 + 1),
    })).toThrow(CompanionSyncCursorError);

    const initial = buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companions: [companion],
      sections: [section],
    });
    expect(() => buildCompanionRosterSync({
      orgId: ORG_ID,
      actorId: "another-user",
      companions: [companion],
      sections: [section],
      cursor: initial.cursor,
    })).toThrow(CompanionSyncCursorError);
  });

  it("returns updated, added, and deleted thread entries in ordinal order", () => {
    const original = thread([
      entry(EVENT_ONE, 2, "one"),
      entry(EVENT_TWO, 4, "two"),
    ]);
    const initial = buildCompanionThreadDelta({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companionId: COMPANION_ID,
      thread: original,
    });
    expect(initial.reset_entries).toBe(true);
    const updated = thread([
      entry(EVENT_ONE, 2, "one updated"),
      entry(EVENT_THREE, 1, "three"),
    ]);
    const next = buildCompanionThreadDelta({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companionId: COMPANION_ID,
      thread: updated,
      cursor: initial.cursor,
    });

    expect(next.changed_entries.map((item) => item.event_id)).toEqual([EVENT_THREE, EVENT_ONE]);
    expect(next.deleted_event_ids).toEqual([EVENT_TWO]);
    expect(next.reset_entries).toBe(false);
    expect(next.thread).not.toHaveProperty("entries");
    expect(buildCompanionThreadDelta({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companionId: COMPANION_ID,
      thread: updated,
      cursor: initial.cursor,
    })).toEqual(next);
  });

  it("keeps long-thread cursors bounded and sends only appended tail entries", () => {
    const entries = Array.from({ length: 5_000 }, (_, index) =>
      entry(`event:${index}`, index, `message ${index}`));
    const initial = buildCompanionThreadDelta({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companionId: COMPANION_ID,
      thread: thread(entries),
    });
    expect(initial.cursor.length).toBeLessThan(256 * 1024);

    const appended = entry("event:5000", 5_000, "message 5000");
    const next = buildCompanionThreadDelta({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companionId: COMPANION_ID,
      thread: thread([...entries, appended]),
      cursor: initial.cursor,
    });
    expect(next.reset_entries).toBe(false);
    expect(next.changed_entries).toEqual([appended]);
    expect(next.deleted_event_ids).toEqual([]);
  });

  it("resets from a bounded cursor when an exceptional historical prefix changes", () => {
    const entries = Array.from({ length: 300 }, (_, index) =>
      entry(`event:${index}`, index, `message ${index}`));
    const initial = buildCompanionThreadDelta({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companionId: COMPANION_ID,
      thread: thread(entries),
    });
    const corrected = entries.map((item, index) =>
      index === 0 ? { ...item, content: "corrected history" } : item);
    const next = buildCompanionThreadDelta({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      companionId: COMPANION_ID,
      thread: thread(corrected),
      cursor: initial.cursor,
    });
    expect(next.reset_entries).toBe(true);
    expect(next.changed_entries).toEqual(corrected);
    expect(next.deleted_event_ids).toEqual([]);
  });
});
