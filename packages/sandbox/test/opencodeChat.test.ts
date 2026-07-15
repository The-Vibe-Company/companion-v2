import { describe, expect, it } from "vitest";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { RunRuntimeError } from "@companion/core";
import {
  createOpencodeRunChatRuntime,
  createOpencodeStreamState,
  getSessionMessageState,
  getSessionState,
  loadSessionItems,
  sendPromptAsync,
  streamChatEvents,
} from "../src/opencodeChat";

function clientWithMessages(messages: unknown[]): OpencodeClient {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  } as unknown as OpencodeClient;
}

describe("sendPromptAsync", () => {
  it("classifies an OpenCode payload rejection without exposing the SDK error body", async () => {
    const client = {
      session: {
        promptAsync: async () => ({ error: { data: "sensitive upstream payload" } }),
      },
    } as unknown as OpencodeClient;

    const error = await sendPromptAsync(client, "session-1", "hello", {
      messageId: "msg_00000000000100000000000000",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RunRuntimeError);
    expect(error).toMatchObject({ message: "OpenCode rejected the prompt" });
    expect(String(error)).not.toContain("sensitive upstream payload");
  });
});

describe("loadSessionItems", () => {
  it("includes a completed tool call as a history item", async () => {
    const client = clientWithMessages([
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "file.txt",
              title: "List files",
              time: { start: 0, end: 100 },
            },
          },
        ],
      },
    ]);

    const items = await loadSessionItems(client, "session-1");

    expect(items).toEqual([
      expect.objectContaining({ kind: "tool", call_id: "call-1", tool: "bash", output: "file.txt", duration_ms: 100 }),
    ]);
  });

  // Regression: a tool call that ends in the SDK's "error" state was previously dropped entirely
  // from the persisted transcript snapshot — the only surviving record once a frozen run's sandbox
  // is destroyed. The live streamChatEvents path already handled this status; loadSessionItems did
  // not.
  it("includes a failed tool call as a history item, not silently dropped", async () => {
    const client = clientWithMessages([
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            callID: "call-2",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "rm -rf /nope" },
              error: "permission denied",
              time: { start: 0, end: 50 },
            },
          },
        ],
      },
    ]);

    const items = await loadSessionItems(client, "session-1");

    expect(items).toEqual([
      expect.objectContaining({ kind: "tool", call_id: "call-2", tool: "bash", output: "permission denied", duration_ms: null }),
    ]);
  });

  it("drops tool calls still pending or running (no terminal state yet)", async () => {
    const client = clientWithMessages([
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", callID: "call-3", tool: "bash", state: { status: "pending", input: {} } },
          { type: "tool", callID: "call-4", tool: "bash", state: { status: "running", input: {}, time: { start: 0 } } },
        ],
      },
    ]);

    const items = await loadSessionItems(client, "session-1");

    expect(items).toEqual([]);
  });

  it("includes user/assistant text alongside tool items", async () => {
    const client = clientWithMessages([
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
    ]);

    const items = await loadSessionItems(client, "session-1");

    expect(items).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello" },
    ]);
  });

  it("preserves whitespace around transcript text until secret redaction", async () => {
    const client = clientWithMessages([
      { info: { role: "assistant" }, parts: [{ type: "text", text: " secret-with-spaces " }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "   " }] },
    ]);

    await expect(loadSessionItems(client, "session-1")).resolves.toEqual([
      { kind: "assistant", text: " secret-with-spaces " },
    ]);
  });

  it("does not truncate tool payloads before the worker can redact them", async () => {
    const output = `${"x".repeat(4_100)}secret-after-the-old-cutoff`;
    const client = clientWithMessages([
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            callID: "call-long",
            tool: "bash",
            state: { status: "completed", input: { token: output }, output },
          },
        ],
      },
    ]);

    const items = await loadSessionItems(client, "session-1");

    expect(items[0]).toEqual(expect.objectContaining({ input: expect.stringContaining(output), output }));
  });
});

describe("session reconciliation", () => {
  it("distinguishes missing, idle and active sessions", async () => {
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => path.id === "missing"
          ? { data: undefined, error: { name: "NotFoundError", data: { message: "missing" } } }
          : { data: { id: path.id }, error: undefined },
        status: async () => ({ data: { busy: { type: "busy" }, retry: { type: "retry", attempt: 1, message: "again", next: 0 } } }),
      },
    } as unknown as OpencodeClient;

    await expect(getSessionState(client, "missing")).resolves.toBe("missing");
    await expect(getSessionState(client, "idle")).resolves.toBe("idle");
    await expect(getSessionState(client, "busy")).resolves.toBe("busy");
    await expect(getSessionState(client, "retry")).resolves.toBe("retry");
  });

  it("treats non-not-found lookup errors as transient instead of duplicating a session", async () => {
    const client = {
      session: {
        get: async () => ({ data: undefined, error: { name: "BadRequest", data: { message: "upstream unavailable" } } }),
      },
    } as unknown as OpencodeClient;

    await expect(getSessionState(client, "session-1")).rejects.toThrow(/validate the persisted session/);
  });

  it("reconciles deterministic messages through their exact assistant child", async () => {
    const client = clientWithMessages([
      { info: { id: "message-existing", role: "user" }, parts: [] },
      { info: { id: "message-pending", role: "user" }, parts: [] },
      { info: { id: "reply-pending", role: "assistant", parentID: "message-pending", time: { created: 1 } }, parts: [] },
      { info: { id: "message-complete", role: "user" }, parts: [] },
      { info: { id: "reply-complete", role: "assistant", parentID: "message-complete", time: { created: 1, completed: 2 } }, parts: [] },
      { info: { id: "message-error", role: "user" }, parts: [] },
      { info: { id: "reply-error", role: "assistant", parentID: "message-error", time: { created: 1 }, error: { name: "UnknownError" } }, parts: [] },
    ]);

    await expect(getSessionMessageState(client, "session-1", "message-new")).resolves.toBe("missing");
    await expect(getSessionMessageState(client, "session-1", "message-existing")).resolves.toBe("pending");
    await expect(getSessionMessageState(client, "session-1", "message-pending")).resolves.toBe("pending");
    await expect(getSessionMessageState(client, "session-1", "message-complete")).resolves.toBe("completed");
    await expect(getSessionMessageState(client, "session-1", "message-error")).resolves.toBe("error");
  });
});

describe("streamChatEvents", () => {
  it("signals readiness only after the upstream event subscription is established", async () => {
    const order: string[] = [];
    const client = {
      event: {
        subscribe: async () => {
          order.push("subscribed");
          return {
            stream: (async function* () {
              order.push("streamed");
              yield { type: "session.idle", properties: { sessionID: "session-1" } };
            })(),
          };
        },
      },
    } as unknown as OpencodeClient;

    const iterator = streamChatEvents({
      client,
      sessionId: "session-1",
      onConnected: () => order.push("connected"),
    });
    await iterator.next();

    expect(order).toEqual(["subscribed", "connected", "streamed"]);
  });

  it("does not replay a delta-first update when cumulative text follows", async () => {
    const events = [
      {
        type: "message.updated",
        properties: { info: { sessionID: "session-1", role: "assistant", id: "message-1" } },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "text",
            text: "",
          },
          delta: "Hel",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "text",
            text: "Hello",
          },
        },
      },
    ];
    const client = {
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            for (const event of events) yield event;
          })(),
        }),
      },
    } as unknown as OpencodeClient;

    const deltas: string[] = [];
    for await (const event of streamChatEvents({ client, sessionId: "session-1" })) {
      if (event.type === "text.delta") deltas.push(event.delta);
    }

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(deltas.join("")).toBe("Hello");
  });

  it("continues cumulative offsets across recorder reconnects", async () => {
    const state = createOpencodeStreamState();
    const clientForText = (text: string) =>
      ({
        event: {
          subscribe: async () => ({
            stream: (async function* () {
              yield {
                type: "message.updated",
                properties: { info: { sessionID: "session-1", role: "assistant", id: "message-1" } },
              };
              yield {
                type: "message.part.updated",
                properties: {
                  part: {
                    id: "part-1",
                    sessionID: "session-1",
                    messageID: "message-1",
                    type: "text",
                    text,
                  },
                },
              };
            })(),
          }),
        },
      }) as unknown as OpencodeClient;

    const deltas: string[] = [];
    for await (const event of streamChatEvents({
      client: clientForText("Hello"),
      sessionId: "session-1",
      state,
    })) {
      if (event.type === "text.delta") deltas.push(event.delta);
    }
    for await (const event of streamChatEvents({
      client: clientForText("Hello world"),
      sessionId: "session-1",
      state,
    })) {
      if (event.type === "text.delta") deltas.push(event.delta);
    }

    expect(deltas).toEqual(["Hello", " world"]);
    expect(deltas.join("")).toBe("Hello world");
  });

  it("keeps cumulative offsets when reconnects use new connection signals", async () => {
    let subscription = 0;
    const runtime = createOpencodeRunChatRuntime(() => ({
      event: {
        subscribe: async () => {
          const text = subscription++ === 0 ? "Hello" : "Hello world";
          return {
            stream: (async function* () {
              yield {
                type: "message.updated",
                properties: { info: { sessionID: "session-1", role: "assistant", id: "message-1" } },
              };
              yield {
                type: "message.part.updated",
                properties: {
                  part: {
                    id: "part-1",
                    sessionID: "session-1",
                    messageID: "message-1",
                    type: "text",
                    text,
                  },
                },
              };
            })(),
          };
        },
      },
    }) as unknown as OpencodeClient);
    const target = { domain: "https://sandbox.invalid", password: "unused" };
    const recorderKey = {};
    const deltas: string[] = [];
    for await (const event of runtime.streamEvents(
      target,
      "session-1",
      new AbortController().signal,
      undefined,
      recorderKey,
    )) {
      if (event.type === "text.delta") deltas.push(event.delta);
    }
    for await (const event of runtime.streamEvents(
      target,
      "session-1",
      new AbortController().signal,
      undefined,
      recorderKey,
    )) {
      if (event.type === "text.delta") deltas.push(event.delta);
    }

    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("keeps distinct identical idle events across reconnects", async () => {
    const state = createOpencodeStreamState();
    const client = {
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            yield { type: "session.idle", properties: { sessionID: "session-1" } };
          })(),
        }),
      },
    } as unknown as OpencodeClient;

    const idle: string[] = [];
    for await (const event of streamChatEvents({ client, sessionId: "session-1", state })) {
      if (event.type === "session.idle") idle.push(event.session_id);
    }
    for await (const event of streamChatEvents({ client, sessionId: "session-1", state })) {
      if (event.type === "session.idle") idle.push(event.session_id);
    }

    expect(idle).toEqual(["session-1", "session-1"]);
  });
});
