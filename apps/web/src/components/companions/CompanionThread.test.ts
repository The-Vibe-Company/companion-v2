import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Companion, CompanionThread as Thread } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import { CompanionThread, type CompanionComputerPanel } from "./CompanionThread";

const companionId = "11111111-1111-4111-8111-111111111111";

function companion(overrides: Partial<Companion> = {}): Companion {
  return {
    id: companionId,
    name: "Luna",
    persona: "Content marketing assistant",
    model_id: "claude-opus-4-8",
    selected_skill_ids: [],
    can_write_skills: false,
    selected_mcp_account_ids: [],
    owner_id: "user-1",
    access: "owner",
    last_message: null,
    runtime: {
      state: "running",
      daemon_state: "running",
      box_id: "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 2,
      desktop_available: false,
      last_error: null,
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
        tool: null,
    decision: null,
        created_at: "2026-08-12T12:01:00.000Z",
      },
      {
        event_id: "pi:0",
        ordinal: 1,
        role: "assistant",
        content: "Here is a first pass at the launch note.",
        author_id: null,
        author_name: null,
        tool: null,
    decision: null,
        created_at: "2026-08-12T12:01:20.000Z",
      },
    ],
    pending_count: 0,
    last_message_at: "2026-08-12T12:01:20.000Z",
    ...overrides,
  };
}

/** A closed Computer panel: what a thread opens with, and what most of these cases render. */
function computerPanel(overrides: Partial<CompanionComputerPanel> = {}): CompanionComputerPanel {
  return {
    open: false,
    desktop: null,
    joining: false,
    error: null,
    onToggle: () => {},
    onJoin: () => {},
    ...overrides,
  };
}

function render(props: {
  companion?: Companion;
  thread?: Thread | null;
  error?: string | null;
  busy?: boolean;
  waking?: boolean;
  openingDesktop?: boolean;
  computer?: Partial<CompanionComputerPanel>;
  newSince?: string | null;
}) {
  return renderToStaticMarkup(React.createElement(CompanionThread, {
    companion: props.companion ?? companion(),
    thread: props.thread === undefined ? thread() : props.thread,
    error: props.error ?? null,
    busy: props.busy ?? false,
    waking: props.waking ?? false,
    openingDesktop: props.openingDesktop ?? false,
    computer: computerPanel(props.computer),
    newSince: props.newSince ?? null,
    onBack: () => {},
    orgId: "org-1",
    onSend: async () => true,
    onSettings: () => {},
    onThread: () => {},
    onWake: () => {},
    onDesktop: () => {},
  }));
}

/** What the header reads once the markup is taken out, which is where the chip's state word lives. */
function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

/** What the chip reports about the compute, which is its accessible name rather than its text. */
function chipLabel(markup: string): string {
  return markup.match(/aria-label="(Box · [^"]*)"/)?.[1] ?? "";
}

const asleep = companion({
  runtime: { ...companion().runtime, state: "stopped", daemon_state: "stopped", box_id: null },
});

const viewerThread = thread({
  viewer_id: "user-9",
  access: "viewer",
  read_only: true,
  can_send: false,
});

describe("CompanionThread", () => {
  it("renders one Companion's conversation with a composer for a runner", () => {
    const markup = render({});

    expect(markup).toContain("Chat with Luna");
    expect(markup).toContain("Draft the launch note");
    expect(markup).toContain("Here is a first pass at the launch note.");
    expect(markup).toContain("Message Luna");
    expect(text(markup)).toContain("Online");
    // The word is what is shown; the compute it reports stays in the accessible name.
    expect(chipLabel(markup)).toContain("Box · online");
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
            tool: null,
    decision: null,
            created_at: "2026-08-12T12:02:00.000Z",
          },
        ],
      }),
    });

    expect(markup).toContain("The run stopped before Pi replied.");
    expect(markup).not.toMatch(/tool|skill|mcp/i);
    // Computer use is the Box desktop and nothing else, reached from the one status chip.
    expect(markup.match(/open the Box desktop/g)).toHaveLength(1);
  });

  it("gives a Viewer the read model without a composer or a wake control", () => {
    const markup = render({
      companion: companion({ ...asleep, access: "viewer" }),
      thread: viewerThread,
    });

    expect(markup).toContain("Draft the launch note");
    expect(markup).toContain("Viewer access is read-only");
    expect(markup).not.toContain("Message Luna");
    expect(markup).not.toContain(">Wake<");
  });

  it("shows a Viewer the Box status as a read-only chip that cannot open a desktop", () => {
    const markup = render({
      companion: companion({ access: "viewer", runtime: { ...companion().runtime, box_id: null } }),
      thread: viewerThread,
    });

    expect(text(markup)).toContain("Online");
    expect(chipLabel(markup)).toBe("Box · online");
    expect(markup).not.toContain("open the Box desktop");
    expect(markup).not.toContain(">Wake<");
  });

  it("offers the Box desktop from the chip only while a runner's Box is already running", () => {
    const running = render({});

    expect(text(running)).toContain("Online");
    expect(running).toContain("open the Box desktop");
    // An asleep Box has no desktop, so the chip stays a status read instead of becoming a start.
    expect(text(render({ companion: asleep }))).toContain("Asleep");
    expect(chipLabel(render({ companion: asleep }))).toBe("Box · asleep");
    expect(render({ companion: asleep })).not.toContain("open the Box desktop");
  });

  it("reports an in-flight desktop handoff on the chip that started it", () => {
    const markup = render({ openingDesktop: true });

    expect(text(markup)).toContain("Opening desktop");
    expect(markup).toContain("disabled");
  });

  it("credits a teammate's message to its author instead of the reader", () => {
    const shared = thread({ viewer_id: "user-9" });

    expect(render({ thread: shared })).toContain(">Ada<");
    expect(render({ thread: shared })).not.toContain(">You<");
    // The reader's own message still reads as their own.
    expect(render({ thread: thread() })).toContain(">You<");
  });

  it("offers a wake control only to a runner whose Box is asleep", () => {
    expect(render({ companion: asleep })).toContain(">Wake<");
    expect(render({})).not.toContain(">Wake<");
  });

  it("tells a runner that saved messages wait for a wake", () => {
    const markup = render({ companion: asleep, thread: thread({ pending_count: 2 }) });

    expect(markup).toContain("2 messages saved. Wake Luna to deliver.");
  });

  it("stops offering a wake in the footer once the Companion is awake or coming up", () => {
    // The footer reads the projected runtime the status chip reads, so a Companion a send has just
    // woken says what its messages are waiting for instead of asking to be woken again.
    const waiting = thread({ pending_count: 1 });
    const running = render({ thread: waiting });

    expect(running).toContain("1 message waiting for a reply.");
    expect(running).not.toContain("Wake Luna to deliver.");

    const starting = render({
      companion: companion({
        runtime: { ...companion().runtime, state: "provisioning", daemon_state: "starting" },
      }),
      thread: waiting,
    });

    expect(text(starting)).toContain("Starting");
    expect(starting).toContain("1 message saved. Luna is waking to deliver.");
    expect(starting).not.toContain("Wake Luna to deliver.");
  });

  it("keeps a Viewer's footer read-only even while messages are waiting on a wake", () => {
    const markup = render({
      companion: companion({ ...asleep, access: "viewer" }),
      thread: thread({
        viewer_id: "user-9",
        access: "viewer",
        read_only: true,
        can_send: false,
        pending_count: 2,
      }),
    });

    expect(markup).toContain("Viewer access is read-only");
    expect(markup).not.toContain("Wake Luna to deliver.");
    expect(markup).not.toContain(">Wake<");
  });

  it("explains an Error status to a runner with the reason the API recorded", () => {
    const markup = render({
      companion: companion({
        runtime: {
          ...companion().runtime,
          state: "error",
          daemon_state: "error",
          last_error: "Box runtime is not configured; set COMPANION_BOX_API_KEY",
        },
      }),
    });

    expect(text(markup)).toContain("Error");
    expect(chipLabel(markup)).toBe("Box · error");
    expect(markup).toContain("Box runtime is not configured; set COMPANION_BOX_API_KEY");
  });

  it("gives a Viewer the generic unavailable line the API redacted for them", () => {
    const markup = render({
      companion: companion({
        access: "viewer",
        runtime: {
          ...companion().runtime,
          state: "error",
          daemon_state: "error",
          box_id: null,
          last_error: "This Companion is unavailable right now.",
        },
      }),
      thread: thread({ viewer_id: "user-9", access: "viewer", read_only: true, can_send: false }),
    });

    expect(markup).toContain("This Companion is unavailable right now.");
    expect(markup).not.toContain("COMPANION_BOX_API_KEY");
    expect(markup).not.toContain(">Wake<");
  });

  it("prefers the failure this request saw over the reason already on the row", () => {
    const markup = render({
      companion: companion({
        runtime: { ...companion().runtime, state: "error", last_error: "Box entered error state" },
      }),
      error: "Box did not become ready before the configured timeout",
    });

    expect(markup).toContain("Box did not become ready before the configured timeout");
    expect(markup).not.toContain("Box entered error state");
  });

  it("shows an empty thread as what to do next rather than a dead surface", () => {
    const markup = render({ thread: thread({ entries: [], pending_count: 0, last_message_at: null }) });

    expect(markup).toContain("No messages yet");
    expect(markup).toContain("Messages are saved here. Wake Luna when you want a reply.");
  });

  it("announces the wait while the transcript is still loading", () => {
    const markup = render({ thread: null });

    // The skeleton lines are decorative, so the wait needs its own announcement or a reader is told
    // nothing at all until the conversation arrives.
    expect(markup).toContain("Loading conversation...");
    expect(markup).toContain('aria-busy="true"');
  });

  it("keys every turn to its transcript entry so a re-read updates in place", () => {
    const markup = render({});

    // The primitives render one message per entry under the entry's own id, so the two-second thread
    // re-read reconciles the turns that already exist instead of replacing the conversation.
    expect(markup).toContain('data-message-id="msg:1"');
    expect(markup).toContain('data-message-id="pi:0"');
  });

  it("names a writer once per passage instead of on every line", () => {
    const markup = render({
      thread: thread({
        entries: [
          {
            event_id: "msg:1",
            ordinal: 0,
            role: "user",
            content: "Draft the launch note",
            author_id: "user-1",
            author_name: "Ada",
            tool: null,
    decision: null,
            created_at: "2026-08-12T12:01:00.000Z",
          },
          {
            event_id: "msg:2",
            ordinal: 1,
            role: "user",
            content: "Keep it under 200 words",
            author_id: "user-1",
            author_name: "Ada",
            tool: null,
    decision: null,
            created_at: "2026-08-12T12:01:30.000Z",
          },
        ],
      }),
    });

    expect(markup).toContain("Draft the launch note");
    expect(markup).toContain("Keep it under 200 words");
    expect(markup.match(/>You</g)).toHaveLength(1);
  });

  it("re-announces a writer once the conversation has moved on", () => {
    const markup = render({
      thread: thread({
        entries: [
          ...thread().entries,
          {
            event_id: "msg:9",
            ordinal: 2,
            role: "user",
            content: "One more thing",
            author_id: "user-1",
            author_name: "Ada",
            tool: null,
    decision: null,
            created_at: "2026-08-12T12:40:00.000Z",
          },
        ],
      }),
    });

    // Two passages from the reader: the first message and the one that reopens the thread.
    expect(markup.match(/>You</g)).toHaveLength(2);
  });

  it("shows a turn that only produced reasoning as the reply it is", () => {
    const markup = render({
      thread: thread({
        entries: [
          {
            event_id: "pi:184",
            ordinal: 0,
            role: "assistant",
            content: "Checking the changelog before answering.",
            author_id: null,
            author_name: null,
            tool: null,
    decision: null,
            created_at: "2026-08-12T12:01:20.000Z",
          },
        ],
      }),
    });

    expect(markup).toContain("Checking the changelog before answering.");
  });

  it("says a running Box owes a reply while the transcript ends on a member's message", () => {
    const awaiting = thread({
      entries: [thread().entries[0]!],
      pending_count: 1,
    });

    expect(render({ thread: awaiting })).toContain("is replying...");
    // A sleeping Box owes nothing until it is woken, and the composer hint says so instead.
    expect(render({ companion: asleep, thread: awaiting })).not.toContain("is replying...");
    // A reply that already landed ends the wait.
    expect(render({})).not.toContain("is replying...");
  });

  it("renders a pending shell permission card with Allow / Deny for Owner/Editor", () => {
    const markup = render({
      thread: thread({
        entries: [
          ...thread().entries,
          {
            event_id: "decision:ui-shell",
            ordinal: 2,
            role: "decision",
            content: "Allow shell: bash",
            author_id: null,
            author_name: null,
            tool: null,
            decision: {
              request_id: "ui-shell",
              kind: "shell",
              name: "bash",
              title: "ls -la",
              detail: null,
              status: "pending",
              answer: null,
              decided_by_id: null,
              decided_by_name: null,
              decided_at: null,
              expires_at: "2026-08-12T12:10:00.000Z",
            },
            created_at: "2026-08-12T12:05:00.000Z",
          },
        ],
      }),
    });

    expect(markup).toContain("chat-decision--pending");
    expect(markup).toContain("Allow run a command");
    expect(markup).toContain("ls -la");
    expect(markup).toContain(">Allow<");
    expect(markup).toContain(">Deny<");
  });

  it("shows a resolved permission card without controls, and keeps Viewers from acting on pending ones", () => {
    const resolved = render({
      thread: thread({
        entries: [
          {
            event_id: "decision:ui-file",
            ordinal: 0,
            role: "decision",
            content: "Allow file: write",
            author_id: null,
            author_name: null,
            tool: null,
            decision: {
              request_id: "ui-file",
              kind: "file",
              name: "write",
              title: "notes.md",
              detail: null,
              status: "allowed",
              answer: null,
              decided_by_id: "user-1",
              decided_by_name: "Ada",
              decided_at: "2026-08-12T12:05:30.000Z",
              expires_at: "2026-08-12T12:10:00.000Z",
            },
            created_at: "2026-08-12T12:05:00.000Z",
          },
        ],
      }),
    });
    expect(resolved).toContain("chat-decision--allowed");
    expect(resolved).toContain("allowed by Ada");
    expect(resolved).not.toContain(">Allow<");
    expect(resolved).not.toContain(">Deny<");

    const viewerPending = render({
      companion: companion({ access: "viewer" }),
      thread: thread({
        access: "viewer",
        read_only: true,
        can_send: false,
        entries: [
          {
            event_id: "decision:ui-q",
            ordinal: 0,
            role: "decision",
            content: "Question: ask_user",
            author_id: null,
            author_name: null,
            tool: null,
            decision: {
              request_id: "ui-q",
              kind: "question",
              name: "ask_user",
              title: "Ship tonight?",
              detail: null,
              status: "pending",
              answer: null,
              decided_by_id: null,
              decided_by_name: null,
              decided_at: null,
              expires_at: "2026-08-12T12:10:00.000Z",
            },
            created_at: "2026-08-12T12:05:00.000Z",
          },
        ],
      }),
    });
    expect(viewerPending).toContain("Ship tonight?");
    expect(viewerPending).toContain("Waiting for an Owner or Editor");
    expect(viewerPending).not.toContain(">Allow<");
    expect(viewerPending).not.toContain(">Answer<");
    expect(viewerPending).not.toContain(">Deny<");
  });
});

describe("CompanionThread separators", () => {
  it("parts the transcript by day, once per day the thread was written in", () => {
    const markup = render({
      thread: thread({
        entries: [
          {
            event_id: "msg:1",
            ordinal: 0,
            role: "user",
            content: "Draft the launch note",
            author_id: "user-1",
            author_name: "Ada",
            tool: null,
            decision: null,
            created_at: "2026-08-12T12:00:00.000Z",
          },
          {
            event_id: "pi:1",
            ordinal: 1,
            role: "assistant",
            content: "Here it is.",
            author_id: null,
            author_name: null,
            tool: null,
            decision: null,
            created_at: "2026-08-14T09:00:00.000Z",
          },
        ],
      }),
    });

    // Server markup carries the stable stored day; the reader's clock reformats it on the client.
    expect(markup).toContain('<time dateTime="2026-08-12">2026-08-12</time>');
    expect(markup).toContain('<time dateTime="2026-08-14">2026-08-14</time>');
    expect(markup.match(/chat-sep/g)).toHaveLength(2);
  });

  it("marks where a returning reader left off, and leaves a caught-up thread whole", () => {
    const entries = thread().entries;

    const returning = render({ newSince: "2026-08-12T12:00:30.000Z", thread: thread({ entries }) });
    expect(returning).toContain("chat-sep--new");
    expect(returning).toContain(">New<");

    // Nothing has been said since this reader was last here, so there is nothing to divide.
    expect(render({ newSince: "2026-08-12T23:00:00.000Z", thread: thread({ entries }) }))
      .not.toContain("chat-sep--new");
    // Neither is a first visit, which has no line to return to.
    expect(render({ thread: thread({ entries }) })).not.toContain("chat-sep--new");
  });
});
