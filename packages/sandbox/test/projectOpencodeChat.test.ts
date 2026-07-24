import { describe, expect, it, vi } from "vitest";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  createOpencodeProjectChatRuntime,
  rehydrateProjectSession,
  sendProjectPromptAsync,
  streamProjectChatEvents,
} from "../src/projectOpencodeChat";

describe("Project OpenCode bridge", () => {
  it("accepts an assistant reply when the provider finishes through session idle only", async () => {
    const client = {
      session: {
        messages: vi.fn(async () => ({
          error: undefined,
          data: [
            {
              info: { id: "message-1", role: "user" },
              parts: [{ type: "text", text: "Hello" }],
            },
            {
              info: {
                id: "assistant-1",
                parentID: "message-1",
                role: "assistant",
                time: { created: 1 },
              },
              parts: [{
                id: "part-1",
                messageID: "assistant-1",
                sessionID: "session-1",
                type: "text",
                text: "Hello! How can I help?",
                time: { start: 1, end: 2 },
              }],
            },
          ],
        })),
        get: vi.fn(async () => ({
          error: undefined,
          data: { id: "session-1" },
        })),
        status: vi.fn(async () => ({
          error: undefined,
          data: { "session-1": { type: "idle" } },
        })),
      },
    } as unknown as OpencodeClient;
    const runtime = createOpencodeProjectChatRuntime(() => client);

    await expect(
      runtime.getMessageState(
        { domain: "https://project.invalid", password: "password" },
        "session-1",
        "message-1",
      ),
    ).resolves.toBe("completed");
  });

  it("keeps an unfinished or unanswered idle message pending", async () => {
    const messages = vi
      .fn()
      .mockResolvedValueOnce({
        error: undefined,
        data: [
          {
            info: { id: "message-1", role: "user" },
            parts: [{ type: "text", text: "Hello" }],
          },
          {
            info: {
              id: "assistant-1",
              parentID: "message-1",
              role: "assistant",
              time: { created: 1 },
            },
            parts: [{ type: "text", text: "Still working" }],
          },
        ],
      })
      .mockResolvedValueOnce({
        error: undefined,
        data: [
          {
            info: { id: "message-2", role: "user" },
            parts: [{ type: "text", text: "Hello again" }],
          },
        ],
      });
    const status = vi.fn(async () => ({
      error: undefined,
      data: { "session-1": { type: "busy" } },
    }));
    const client = {
      session: {
        messages,
        get: vi.fn(async () => ({
          error: undefined,
          data: { id: "session-1" },
        })),
        status,
      },
    } as unknown as OpencodeClient;
    const runtime = createOpencodeProjectChatRuntime(() => client);
    const target = {
      domain: "https://project.invalid",
      password: "password",
    };

    await expect(
      runtime.getMessageState(target, "session-1", "message-1"),
    ).resolves.toBe("pending");
    await expect(
      runtime.getMessageState(target, "session-1", "message-2"),
    ).resolves.toBe("pending");
    expect(status).toHaveBeenCalledOnce();
  });

  it("pins the session model on every prompt", async () => {
    const promptAsync = vi.fn(async () => ({ data: undefined, error: undefined }));
    const client = { session: { promptAsync } } as unknown as OpencodeClient;

    await sendProjectPromptAsync({
      client,
      sessionId: "session-1",
      text: "Build the report",
      messageId: "message-1",
      modelRef: "openrouter/anthropic/claude-sonnet-4.5",
    });

    expect(promptAsync).toHaveBeenCalledWith(
      {
        sessionID: "session-1",
        messageID: "message-1",
        model: {
          providerID: "openrouter",
          modelID: "anthropic/claude-sonnet-4.5",
        },
        parts: [{ type: "text", text: "Build the report" }],
      },
      { signal: undefined },
    );
  });

  it("rehydrates a recreated session as no-reply context before the follow-up", async () => {
    const messages = vi.fn(async () => ({ data: [], error: undefined }));
    const promptAsync = vi.fn(async () => ({ data: undefined, error: undefined }));
    const client = { session: { messages, promptAsync } } as unknown as OpencodeClient;

    await rehydrateProjectSession({
      client,
      sessionId: "session-restored",
      transcript: [
        { kind: "user", text: "Original question", message_id: "msg-1" },
        { kind: "assistant", text: "Durable answer", message_id: "msg-2" },
      ],
    });

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "session-restored",
        messageID: expect.stringMatching(/^msg_000000000000[0-9a-f]{14}$/),
        noReply: true,
        parts: [expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Durable answer"),
        })],
      }),
      { signal: undefined },
    );
  });

  it("filters synthetic recovery context from the next durable transcript", async () => {
    const client = {
      session: {
        messages: vi.fn(async () => ({
          error: undefined,
          data: [
            {
              info: {
                id: "msg_000000000000aaaaaaaaaaaaaa",
                role: "user",
              },
              parts: [{
                type: "text",
                text: "Companion restored this private Project from a durable checkpoint.\n\n[]",
              }],
            },
            {
              info: { id: "msg-follow-up", role: "user" },
              parts: [{ type: "text", text: "Continue" }],
            },
          ],
        })),
      },
    } as unknown as OpencodeClient;
    const runtime = createOpencodeProjectChatRuntime(() => client);

    await expect(runtime.loadItems(
      { domain: "https://project.invalid", password: "password" },
      "session-restored",
    )).resolves.toEqual([
      { kind: "user", text: "Continue", message_id: "msg-follow-up" },
    ]);
  });

  it("uses one stream, auto-approves permissions, and demultiplexes native sessions", async () => {
    const approve = vi.fn(async () => ({ data: true, error: undefined }));
    const approveV2 = vi.fn(async () => ({ data: true, error: undefined }));
    const events = [
      {
        id: "event-permission-1",
        type: "permission.asked",
        properties: {
          id: "permission-1",
          sessionID: "session-a",
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: [],
          tool: { messageID: "message-a", callID: "call-a" },
        },
      },
      {
        id: "event-permission-v2-1",
        type: "permission.v2.asked",
        properties: {
          id: "permission-v2-1",
          sessionID: "session-b",
          action: "bash",
          resources: ["*"],
          save: ["*"],
          metadata: {},
        },
      },
      {
        type: "message.updated",
        properties: {
          info: { id: "assistant-a", sessionID: "session-a", role: "assistant" },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-a",
            sessionID: "session-a",
            messageID: "assistant-a",
            type: "text",
            text: "First",
          },
        },
      },
      {
        type: "session.status",
        properties: { sessionID: "session-b", status: { type: "busy" } },
      },
    ];
    const subscribe = vi.fn(async () => ({
      stream: (async function* () {
        for (const event of events) yield event;
      })(),
    }));
    const client = {
      event: { subscribe },
      permission: { reply: approve },
      v2: { session: { permission: { reply: approveV2 } } },
    } as unknown as OpencodeClient;
    const connected = vi.fn();

    const result = [];
    for await (const event of streamProjectChatEvents({ client, onConnected: connected })) {
      result.push(event);
    }

    expect(subscribe).toHaveBeenCalledOnce();
    expect(connected).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledWith(
      { requestID: "permission-1", reply: "always" },
      { signal: undefined },
    );
    expect(approveV2).toHaveBeenCalledWith(
      {
        sessionID: "session-b",
        requestID: "permission-v2-1",
        reply: "always",
      },
      { signal: undefined },
    );
    expect(result).toEqual([
      {
        sessionId: "session-a",
        event: { type: "text.delta", message_id: "assistant-a", delta: "First" },
      },
      {
        sessionId: "session-b",
        event: { type: "status", state: "busy", attempt: null, message: null },
      },
    ]);
  });

  it("keeps cumulative cursors isolated between concurrent sessions", async () => {
    const events = [
      {
        type: "message.updated",
        properties: { info: { id: "assistant-a", sessionID: "session-a", role: "assistant" } },
      },
      {
        type: "message.updated",
        properties: { info: { id: "assistant-b", sessionID: "session-b", role: "assistant" } },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "shared-part-id",
            sessionID: "session-a",
            messageID: "assistant-a",
            type: "text",
            text: "Alpha",
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "shared-part-id",
            sessionID: "session-b",
            messageID: "assistant-b",
            type: "text",
            text: "Beta",
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

    const result = [];
    for await (const event of streamProjectChatEvents({ client })) result.push(event);

    expect(result).toEqual([
      {
        sessionId: "session-a",
        event: { type: "text.delta", message_id: "assistant-a", delta: "Alpha" },
      },
      {
        sessionId: "session-b",
        event: { type: "text.delta", message_id: "assistant-b", delta: "Beta" },
      },
    ]);
  });
});
