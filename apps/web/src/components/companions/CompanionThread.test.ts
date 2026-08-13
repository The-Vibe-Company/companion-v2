import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Companion, CompanionThread as Thread } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import { CompanionThread } from "./CompanionThread";

const companionId = "11111111-1111-4111-8111-111111111111";

function companion(overrides: Partial<Companion> = {}): Companion {
  return {
    id: companionId,
    name: "Luna",
    persona: "Content marketing assistant",
    owner_id: "user-1",
    access: "owner",
    runtime: {
      state: "running",
      daemon_state: "running",
      box_id: "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 2,
      desktop_available: false,
      last_observed_at: null,
      last_started_at: null,
      last_stopped_at: null,
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    companion_id: companionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries: [
      {
        event_id: "msg:1",
        ordinal: 0,
        role: "user",
        content: "Draft the launch note",
        author_id: "user-1",
        author_name: "Ada",
        created_at: "2026-08-12T12:01:00.000Z",
      },
      {
        event_id: "pi:0",
        ordinal: 1,
        role: "assistant",
        content: "Here is a first pass at the launch note.",
        author_id: null,
        author_name: null,
        created_at: "2026-08-12T12:01:20.000Z",
      },
    ],
    pending_count: 0,
    last_message_at: "2026-08-12T12:01:20.000Z",
    ...overrides,
  };
}

function render(props: {
  companion?: Companion;
  thread?: Thread | null;
  error?: string | null;
  busy?: boolean;
  waking?: boolean;
}) {
  return renderToStaticMarkup(React.createElement(CompanionThread, {
    companion: props.companion ?? companion(),
    thread: props.thread === undefined ? thread() : props.thread,
    error: props.error ?? null,
    busy: props.busy ?? false,
    waking: props.waking ?? false,
    onBack: () => {},
    onSend: async () => true,
    onWake: () => {},
  }));
}

describe("CompanionThread", () => {
  it("renders one Companion's conversation with a composer for a runner", () => {
    const markup = render({});

    expect(markup).toContain("Chat with Luna");
    expect(markup).toContain("Draft the launch note");
    expect(markup).toContain("Here is a first pass at the launch note.");
    expect(markup).toContain("Message Luna");
    expect(markup).toContain("Online");
  });

  it("keeps Pi tools and Skills out of the thread surface", () => {
    const markup = render({
      thread: thread({
        entries: [
          ...thread().entries,
          {
            event_id: "pi:512",
            ordinal: 2,
            role: "system",
            content: "The run stopped before Pi replied.",
            author_id: null,
            author_name: null,
            created_at: "2026-08-12T12:02:00.000Z",
          },
        ],
      }),
    });

    expect(markup).toContain("The run stopped before Pi replied.");
    expect(markup).not.toMatch(/tool|skill|desktop|mcp/i);
  });

  it("gives a Viewer the read model without a composer or a wake control", () => {
    const markup = render({
      companion: companion({
        access: "viewer",
        runtime: { ...companion().runtime, state: "stopped", daemon_state: "stopped", box_id: null },
      }),
      thread: thread({ viewer_id: "user-9", access: "viewer", read_only: true, can_send: false }),
    });

    expect(markup).toContain("Draft the launch note");
    expect(markup).toContain("Viewer access is read-only");
    expect(markup).not.toContain("Message Luna");
    expect(markup).not.toContain(">Wake<");
  });

  it("credits a teammate's message to its author instead of the reader", () => {
    const shared = thread({ viewer_id: "user-9" });

    expect(render({ thread: shared })).toContain(">Ada<");
    expect(render({ thread: shared })).not.toContain(">You<");
    // The reader's own message still reads as their own.
    expect(render({ thread: thread() })).toContain(">You<");
  });

  it("offers a wake control only to a runner whose Box is asleep", () => {
    const asleep = companion({
      runtime: { ...companion().runtime, state: "stopped", daemon_state: "stopped", box_id: null },
    });

    expect(render({ companion: asleep })).toContain(">Wake<");
    expect(render({})).not.toContain(">Wake<");
  });

  it("tells a runner that saved messages wait for a wake", () => {
    const markup = render({
      companion: companion({
        runtime: { ...companion().runtime, state: "stopped", daemon_state: "stopped", box_id: null },
      }),
      thread: thread({ pending_count: 2 }),
    });

    expect(markup).toContain("2 messages saved. Wake Luna to deliver.");
  });

  it("shows an empty thread as an invitation rather than a dead surface", () => {
    const markup = render({ thread: thread({ entries: [], pending_count: 0, last_message_at: null }) });

    expect(markup).toContain("Say hello to Luna");
  });
});
