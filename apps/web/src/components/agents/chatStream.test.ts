import { describe, expect, it } from "vitest";
import type { AgentChatEvent } from "@companion/contracts";
import { chatReducer, createSseParser, decodeChatEvent, initChatState, type ChatState } from "./chatStream";

const resolveToolLabel = (tool: string, skill: string | null) => ({
  label: skill ? `${skill}@1.0.0` : tool,
  action: tool,
});

function apply(state: ChatState, event: AgentChatEvent): ChatState {
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

  it("ignores comment/heartbeat lines", () => {
    const parser = createSseParser();
    expect(parser.push(": ping\n\n")).toEqual([]);
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
});

describe("chatReducer", () => {
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
    state = apply(state, { type: "tool.start", call_id: "c1", skill: "meeting-digest", tool: "digest", input: "{}" });
    state = apply(state, { type: "tool.start", call_id: "c2", skill: null, tool: "bash", input: "ls" });
    state = apply(state, { type: "tool.done", call_id: "c1", output: "ok", duration_ms: 1400 });
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

  it("seeds prior-session history above existing sys lines and maps tool rows as completed", () => {
    let state = initChatState();
    state = chatReducer(state, { kind: "sys", text: "resumed from snapshot" });
    state = chatReducer(state, {
      kind: "history",
      resolveToolLabel,
      items: [
        { kind: "user", text: "hey" },
        {
          kind: "tool",
          call_id: "c1",
          tool: "digest",
          skill: "meeting-digest",
          input: "{}",
          output: "done",
          duration_ms: 1200,
        },
        { kind: "assistant", text: "on it" },
      ],
    });

    // Existing sys line stays first, then the reloaded transcript in order.
    expect(state.items.map((item) => item.kind)).toEqual(["sys", "user", "tool", "asst"]);
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

  it("clears the transcript back to an empty session on reset", () => {
    let state = initChatState();
    state = chatReducer(state, { kind: "user", text: "hello" });
    state = chatReducer(state, { kind: "send" });
    state = chatReducer(state, { kind: "reset" });
    expect(state).toEqual(initChatState());
  });
});
