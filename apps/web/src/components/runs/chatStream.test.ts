import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunChatEvent } from "@companion/contracts";
import { chatReducer, createSseParser, decodeChatEvent, initChatState, openRunStream, type ChatState } from "./chatStream";

const resolveToolLabel = (tool: string, skill: string | null) => ({
  label: skill ? `${skill}@1.0.0` : tool,
  action: tool,
});

function apply(state: ChatState, event: RunChatEvent): ChatState {
  return chatReducer(state, { kind: "event", event, resolveToolLabel });
}

describe("createSseParser", () => {
  it("parses complete frames with event/id/data fields", () => {
    const parser = createSseParser();
    const frames = parser.push('event: message\nid: 7\ndata: {"type":"text.done","message_id":"m1"}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      event: "message",
      id: "7",
      data: '{"type":"text.done","message_id":"m1"}',
    });
    expect(parser.lastId()).toBe("7");
  });

  it("buffers partial frames across chunks", () => {
    const parser = createSseParser();
    expect(parser.push("data: {\"type\":\"text.delta\",")).toEqual([]);
    expect(parser.push('"message_id":"m1","delta":"He"}')).toEqual([]);
    const frames = parser.push("\n\ndata: x\n\n");
    expect(frames).toHaveLength(2);
    expect(frames[0]?.data).toBe('{"type":"text.delta","message_id":"m1","delta":"He"}');
  });

  it("joins multi-line data and normalizes CRLF", () => {
    const parser = createSseParser();
    const frames = parser.push("data: line1\r\ndata: line2\r\n\r\n");
    expect(frames[0]?.data).toBe("line1\nline2");
  });

  it("keeps CRLF intact when the carriage return and line feed arrive in separate chunks", () => {
    const parser = createSseParser();
    expect(parser.push('id: 9\r')).toEqual([]);
    expect(parser.push('\ndata: {"type":"session.idle","session_id":"s"}\r')).toEqual([]);
    const frames = parser.push("\n\r\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: "9", data: '{"type":"session.idle","session_id":"s"}' });
  });

  it("ignores comment/heartbeat lines", () => {
    const parser = createSseParser();
    expect(parser.push(": ping\n\n")).toEqual([]);
  });
});

describe("openRunStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function closedStreamResponse(): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  function streamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { status: 200 });
  }

  it("does not reset the reconnect budget for immediately-closing empty 200 responses", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return closedStreamResponse();
      }),
    );

    const events: RunChatEvent[] = [];
    const controller = new AbortController();
    const done = openRunStream("run-1", (event) => events.push(event), controller.signal);

    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(calls).toBe(4);
    expect(events.at(-1)).toEqual({ type: "error", message: "Lost connection to the agent stream." });
  });

  it("reconciles an intentional terminal EOF without reconnecting or showing a transport error", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => closedStreamResponse());
    vi.stubGlobal("fetch", fetchMock);
    const events: RunChatEvent[] = [];
    const onStreamEnd = vi.fn(async () => true);

    await openRunStream("run-terminal", (event) => events.push(event), new AbortController().signal, { onStreamEnd });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onStreamEnd).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("opens after the transcript snapshot cursor on both replay channels", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => closedStreamResponse());
    vi.stubGlobal("fetch", fetchMock);

    await openRunStream("run-snapshot", () => undefined, new AbortController().signal, {
      lastEventId: "12",
      onStreamEnd: async () => true,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("last_event_id=12");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { "Last-Event-ID": "12" } });
  });

  it("reports a healthy connection even when there is no replay event after the snapshot cursor", async () => {
    const fetchMock = vi.fn(async () => closedStreamResponse());
    vi.stubGlobal("fetch", fetchMock);
    const onConnected = vi.fn();

    await openRunStream("run-idle", () => undefined, new AbortController().signal, {
      lastEventId: "12",
      onConnected,
      onStreamEnd: async () => true,
    });

    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("drops a partial frame on disconnect and replays it from the last validated cursor", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse(['id: 7\ndata: {"type":"run.warning","code":"cut']))
      .mockResolvedValueOnce(streamResponse([
        'id: 7\ndata: {"type":"run.warning","code":"replayed","message":"Recovered","phase":null}\n\n',
      ]));
    vi.stubGlobal("fetch", fetchMock);
    const events: RunChatEvent[] = [];
    const done = openRunStream("run-cut", (event) => {
      events.push(event);
      controller.abort();
    }, controller.signal);

    await vi.advanceTimersByTimeAsync(1_000);
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("last_event_id");
    expect(events).toEqual([
      { type: "run.warning", code: "replayed", message: "Recovered", phase: null },
    ]);
  });
});

describe("decodeChatEvent", () => {
  it("decodes typed JSON payloads and rejects garbage", () => {
    expect(decodeChatEvent({ event: null, id: null, data: '{"type":"session.idle","session_id":"s"}' })).toEqual({
      type: "session.idle",
      session_id: "s",
    });
    expect(decodeChatEvent({ event: null, id: null, data: "not json" })).toBeNull();
    expect(decodeChatEvent({ event: null, id: null, data: '{"noType":1}' })).toBeNull();
    expect(decodeChatEvent({ event: null, id: null, data: "" })).toBeNull();
  });

  it("accepts a persisted replay envelope without exposing its sequence to the reducer", () => {
    expect(decodeChatEvent({ event: "run", id: "12", data: '{"sequence":12,"created_at":"now","event":{"type":"run.warning","code":"retry_delayed","message":"The run is retrying","phase":"record"}}' })).toMatchObject({
      type: "run.warning",
      code: "retry_delayed",
    });
  });

  it("schema-validates events: applies defaults and drops malformed frames", () => {
    // Defaults are applied so downstream reads are total (attempt/message → null).
    expect(decodeChatEvent({ event: null, id: null, data: '{"type":"status","state":"busy"}' })).toEqual({
      type: "status",
      state: "busy",
      attempt: null,
      message: null,
    });
    // A 0-based retry attempt is accepted (nonnegative), not dropped.
    expect(decodeChatEvent({ event: null, id: null, data: '{"type":"status","state":"retry","attempt":0}' })).toMatchObject({
      type: "status",
      state: "retry",
      attempt: 0,
    });
    expect(decodeChatEvent({ event: null, id: null, data: '{"type":"reasoning.delta","part_id":"r1","delta":"x"}' })).toEqual({
      type: "reasoning.delta",
      part_id: "r1",
      delta: "x",
    });
    // Malformed frames (unknown type / missing required fields) are dropped, not fed to the reducer.
    expect(decodeChatEvent({ event: null, id: null, data: '{"type":"totally.unknown"}' })).toBeNull();
    expect(decodeChatEvent({ event: null, id: null, data: '{"type":"text.delta","message_id":"m1"}' })).toBeNull();
    expect(decodeChatEvent({ event: null, id: null, data: '{"type":"status","state":"nope"}' })).toBeNull();
  });
});

describe("chatReducer", () => {
  it("marks a durable history snapshot idle and clears stale transport errors on connection", () => {
    let state = apply(initChatState(), { type: "error", message: "network lost" });
    state = chatReducer(state, { kind: "send" });
    state = chatReducer(state, { kind: "history", items: [{ kind: "assistant", text: "done" }], resolveToolLabel });
    expect(state.busy).toBe(false);
    state = chatReducer(state, { kind: "connected" });
    expect(state.error).toBeNull();
  });

  it("appends user/sys items and tracks busy through a full turn", () => {
    let state = initChatState();
    state = chatReducer(state, { kind: "user", text: "hello" });
    state = chatReducer(state, { kind: "send" });
    expect(state.busy).toBe(true);
    state = apply(state, { type: "text.delta", message_id: "m1", delta: "Hi" });
    state = apply(state, { type: "text.delta", message_id: "m1", delta: " there" });
    state = apply(state, { type: "text.done", message_id: "m1" });
    expect(state.busy).toBe(false);
    const asst = state.items.find((item) => item.kind === "asst");
    expect(asst && asst.kind === "asst" ? asst.text : "").toBe("Hi there");
    expect(asst && asst.kind === "asst" ? asst.streaming : true).toBe(false);
  });

  it("merges tool.done into the matching tool.start by call id", () => {
    let state = initChatState();
    state = apply(state, { type: "tool.start", call_id: "c1", skill: "meeting-digest", tool: "digest", title: null, input: "{}" });
    state = apply(state, { type: "tool.start", call_id: "c2", skill: null, tool: "bash", title: null, input: "ls" });
    state = apply(state, { type: "tool.done", call_id: "c1", title: null, output: "ok", duration_ms: 1400 });
    const tools = state.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(2);
    const first = tools[0];
    expect(first && first.kind === "tool" ? first : null).toMatchObject({
      label: "meeting-digest@1.0.0",
      running: false,
      output: "ok",
      durationMs: 1400,
    });
    const second = tools[1];
    expect(second && second.kind === "tool" ? second.running : false).toBe(true);
  });

  it("keeps separate assistant messages per message id", () => {
    let state = initChatState();
    state = apply(state, { type: "text.delta", message_id: "m1", delta: "one" });
    state = apply(state, { type: "text.done", message_id: "m1" });
    state = apply(state, { type: "text.delta", message_id: "m2", delta: "two" });
    const asst = state.items.filter((item) => item.kind === "asst");
    expect(asst).toHaveLength(2);
  });

  it("captures session id and errors", () => {
    let state = initChatState();
    state = apply(state, { type: "ready", session_id: "s-9" });
    expect(state.sessionId).toBe("s-9");
    state = chatReducer(state, { kind: "send" });
    state = apply(state, { type: "error", message: "sandbox unreachable" });
    expect(state.busy).toBe(false);
    expect(state.error).toBe("sandbox unreachable");
  });

  it("keeps warnings non-terminal and records run.error separately", () => {
    let state = initChatState();
    state = apply(state, { type: "status", state: "busy", attempt: null, message: null });
    state = apply(state, { type: "run.warning", code: "retry_delayed", message: "The run is retrying", phase: "record" });
    expect(state.busy).toBe(true);
    expect(state.error).toBeNull();
    expect(state.warnings).toEqual([{ code: "retry_delayed", message: "The run is retrying" }]);
    state = apply(state, { type: "run.error", code: "sandbox_failed", message: "Sandbox stopped", phase: "cleanup" });
    expect(state.busy).toBe(false);
    expect(state.error).toBe("Sandbox stopped");
  });

  // Regression: reconnecting after a dead stream (the server re-sends "ready" at the start of
  // every connection) must clear a stale error banner from the prior dead stream, or a healthy
  // reconnected session looks permanently broken.
  it("clears a stale error once the stream reconnects (ready)", () => {
    let state = initChatState();
    state = apply(state, { type: "error", message: "Lost connection to the agent stream." });
    expect(state.error).toBe("Lost connection to the agent stream.");
    state = apply(state, { type: "ready", session_id: "s-10" });
    expect(state.error).toBeNull();
  });

  it("seeds prior-session history above existing sys lines and maps tool rows as completed", () => {
    let state = initChatState();
    state = chatReducer(state, { kind: "sys", text: "resumed from snapshot" });
    state = chatReducer(state, {
      kind: "history",
      resolveToolLabel,
      attachments: [{
        id: "attachment-1",
        prompt_id: "00000000-0000-4000-8000-000000000001",
        message_id: "msg-user-1",
        prompt_ordinal: 0,
        file_name: "brief.pdf",
        content_type: "application/pdf",
        byte_size: 42,
      }],
      items: [
        { kind: "user", text: "hey", message_id: "msg-user-1" },
        {
          kind: "tool",
          call_id: "c1",
          tool: "digest",
          skill: "meeting-digest",
          title: "Summarize meeting",
          input: "{}",
          output: "done",
          duration_ms: 1200,
        },
        { kind: "assistant", text: "on it" },
      ],
    });

    // Existing sys line stays first, then the reloaded transcript in order.
    expect(state.items.map((item) => item.kind)).toEqual(["sys", "user", "tool", "asst"]);
    const user = state.items.find((item) => item.kind === "user");
    expect(user && user.kind === "user" ? user.attachments : []).toMatchObject([{ file_name: "brief.pdf" }]);
    const tool = state.items.find((item) => item.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool : null).toMatchObject({
      label: "meeting-digest@1.0.0",
      running: false,
      output: "done",
      durationMs: 1200,
    });
    const asst = state.items.find((item) => item.kind === "asst");
    expect(asst && asst.kind === "asst" ? { streaming: asst.streaming, text: asst.text } : null).toEqual({
      streaming: false,
      text: "on it",
    });
  });

  it("maps migrated attachments onto legacy transcript users by prompt ordinal", () => {
    const state = chatReducer(initChatState(), {
      kind: "history",
      resolveToolLabel,
      attachments: [
        {
          id: "attachment-initial",
          prompt_id: "00000000-0000-4000-8000-000000000001",
          message_id: "msg-initial",
          prompt_ordinal: 0,
          file_name: "initial.pdf",
          content_type: "application/pdf",
          byte_size: 12,
        },
        {
          id: "attachment-follow-up",
          prompt_id: "00000000-0000-4000-8000-000000000002",
          message_id: "msg-follow-up",
          prompt_ordinal: 1,
          file_name: "follow-up.txt",
          content_type: "text/plain",
          byte_size: 8,
        },
      ],
      items: [
        { kind: "user", text: "Initial legacy prompt" },
        { kind: "assistant", text: "Initial answer" },
        { kind: "user", text: "Legacy follow-up" },
      ],
    });

    const users = state.items.filter((item) => item.kind === "user");
    expect(users[0]).toMatchObject({ attachments: [expect.objectContaining({ file_name: "initial.pdf" })] });
    expect(users[1]).toMatchObject({ attachments: [expect.objectContaining({ file_name: "follow-up.txt" })] });
  });

  it("drives the working indicator from session.status events", () => {
    let state = initChatState();
    state = apply(state, { type: "status", state: "busy", attempt: null, message: null });
    expect(state.working).toEqual({ active: true, label: "Thinking…" });
    expect(state.busy).toBe(true);

    state = apply(state, { type: "status", state: "retry", attempt: 2, message: "rate limited" });
    expect(state.working).toEqual({ active: true, label: "Retrying (attempt 2)…" });

    state = apply(state, { type: "status", state: "idle", attempt: null, message: null });
    expect(state.working).toEqual({ active: false, label: "" });
    expect(state.busy).toBe(false);
  });

  it("carries tool title/skill/tool onto the item and labels the working line with it", () => {
    let state = initChatState();
    state = apply(state, {
      type: "tool.start",
      call_id: "c1",
      skill: "email-digest",
      tool: "bash",
      title: "Run digest",
      input: '{"command":"python3 run.py"}',
    });
    const tool = state.items.find((item) => item.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool : null).toMatchObject({
      tool: "bash",
      skill: "email-digest",
      action: "Run digest",
      running: true,
    });
    expect(state.working).toEqual({ active: true, label: "Running Run digest…" });

    state = apply(state, { type: "tool.done", call_id: "c1", title: "Run digest", output: "3 files", duration_ms: 900 });
    const done = state.items.find((item) => item.kind === "tool");
    expect(done && done.kind === "tool" ? done.running : true).toBe(false);
  });

  it("streams a reasoning block and auto-collapses it when the answer starts", () => {
    let state = initChatState();
    state = apply(state, { type: "reasoning.delta", part_id: "r1", delta: "Let me " });
    state = apply(state, { type: "reasoning.delta", part_id: "r1", delta: "think." });
    const reasoning = state.items.find((item) => item.kind === "reasoning");
    expect(reasoning && reasoning.kind === "reasoning" ? { text: reasoning.text, streaming: reasoning.streaming } : null).toEqual({
      text: "Let me think.",
      streaming: true,
    });
    expect(state.working.active).toBe(true);

    // The first assistant token tucks the reasoning block away.
    state = apply(state, { type: "text.delta", message_id: "m1", delta: "Answer" });
    const collapsed = state.items.find((item) => item.kind === "reasoning");
    expect(collapsed && collapsed.kind === "reasoning" ? collapsed.streaming : true).toBe(false);
    expect(state.items.some((item) => item.kind === "asst")).toBe(true);
  });

  it("marks a reasoning block done on reasoning.done", () => {
    let state = initChatState();
    state = apply(state, { type: "reasoning.delta", part_id: "r1", delta: "hmm" });
    state = apply(state, { type: "reasoning.done", part_id: "r1" });
    const reasoning = state.items.find((item) => item.kind === "reasoning");
    expect(reasoning && reasoning.kind === "reasoning" ? reasoning.streaming : true).toBe(false);
  });

  it("clears the transcript back to an empty session on reset", () => {
    let state = initChatState();
    state = chatReducer(state, { kind: "user", text: "hello" });
    state = chatReducer(state, { kind: "send" });
    state = chatReducer(state, { kind: "reset" });
    expect(state).toEqual(initChatState());
  });
});
