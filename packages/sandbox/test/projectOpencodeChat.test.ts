import { describe, expect, it, vi } from "vitest";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  createOpencodeProjectChatRuntime,
  listPendingProjectQuestions,
  rejectProjectQuestion,
  rehydrateProjectSession,
  replyProjectQuestion,
  sendProjectPromptAsync,
  streamProjectChatEvents,
} from "../src/projectOpencodeChat";

describe("Project OpenCode bridge", () => {
  const directory = "/vercel/sandbox/files";

  it("scopes every Project session operation to the managed Files directory", async () => {
    const list = vi.fn(async () => ({ error: undefined, data: [] }));
    const create = vi.fn(async () => ({
      error: undefined,
      data: { id: "session-1", title: "companion:session-1" },
    }));
    const abort = vi.fn(async () => ({ error: undefined, data: true }));
    const get = vi.fn(async () => ({
      error: undefined,
      data: { id: "session-1" },
    }));
    const status = vi.fn(async () => ({
      error: undefined,
      data: { "session-1": { type: "idle" } },
    }));
    const messages = vi.fn(async () => ({ error: undefined, data: [] }));
    const diff = vi.fn(async () => ({ error: undefined, data: [] }));
    const promptAsync = vi.fn(async () => ({
      error: undefined,
      data: undefined,
    }));
    const client = {
      session: {
        list,
        create,
        abort,
        get,
        status,
        messages,
        diff,
        promptAsync,
      },
    } as unknown as OpencodeClient;
    const runtime = createOpencodeProjectChatRuntime(() => client);
    const target = {
      domain: "https://project.invalid",
      password: "password",
    };

    await runtime.findSessionByTitle(target, "companion:session-1");
    await runtime.createSession(target, "companion:session-1");
    await runtime.abortSession(target, "session-1");
    await runtime.getSessionState(target, "session-1");
    await runtime.getMessageState(target, "session-1", "message-1");
    await runtime.loadItems(target, "session-1");
    await runtime.getFileChanges(target, "session-1", "message-1");
    await runtime.sendPrompt(
      target,
      "session-1",
      "Create the file",
      "message-1",
      "openai/gpt-5",
    );

    expect(list).toHaveBeenCalledWith({ directory }, { signal: undefined });
    expect(create).toHaveBeenCalledWith(
      { title: "companion:session-1", directory },
      { signal: undefined },
    );
    expect(abort).toHaveBeenCalledWith(
      { sessionID: "session-1", directory },
      { signal: undefined },
    );
    expect(get).toHaveBeenCalledWith(
      { sessionID: "session-1", directory },
      { signal: undefined },
    );
    expect(status).toHaveBeenCalledWith(
      { directory },
      { signal: undefined },
    );
    expect(messages).toHaveBeenCalledWith(
      { sessionID: "session-1", directory },
      { signal: undefined },
    );
    expect(diff).toHaveBeenCalledWith(
      { sessionID: "session-1", messageID: "message-1", directory },
      { signal: undefined },
    );
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "session-1",
        messageID: "message-1",
        directory,
      }),
      { signal: undefined },
    );
  });

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
        directory,
        model: {
          providerID: "openrouter",
          modelID: "anthropic/claude-sonnet-4.5",
        },
        parts: [{ type: "text", text: "Build the report" }],
      },
      { signal: undefined },
    );
  });

  it("lists both pending question protocols, filters legacy rows, and prefers V2 on duplicate ids", async () => {
    const legacyList = vi.fn(async () => ({
      error: undefined,
      data: [
        {
          id: "shared-request",
          sessionID: "session-a",
          questions: [{
            header: "Legacy",
            question: "Legacy wording?",
            options: [{ label: "Legacy", description: "Compatibility endpoint" }],
          }],
        },
        {
          id: "other-session-request",
          sessionID: "session-b",
          questions: [{
            header: "Other",
            question: "Must not leak",
            options: [],
          }],
        },
        {
          id: "legacy-only",
          sessionID: "session-a",
          questions: [{
            header: "Format",
            question: "Choose a format",
            options: [{ label: "PDF", description: "Portable document" }],
            multiple: false,
            custom: true,
          }],
          tool: { messageID: "message-legacy", callID: "call-legacy" },
        },
      ],
    }));
    const v2List = vi.fn(async () => ({
      error: undefined,
      data: {
        data: [
          {
            id: "shared-request",
            sessionID: "session-a",
            questions: [{
              header: "Current",
              question: "Current wording?",
              options: [{ label: "Current", description: "Session endpoint" }],
            }],
          },
          {
            id: "v2-only",
            sessionID: "session-a",
            questions: [{
              header: "Audience",
              question: "Choose an audience",
              options: [],
            }],
          },
        ],
      },
    }));
    const client = {
      question: { list: legacyList },
      v2: { session: { question: { list: v2List } } },
    } as unknown as OpencodeClient;

    const pending = await listPendingProjectQuestions({
      client,
      sessionId: "session-a",
    });

    expect(pending.map((question) => [
      question.request_id,
      question.protocol,
    ])).toEqual([
      ["shared-request", "question.v2"],
      ["legacy-only", "question"],
      ["v2-only", "question.v2"],
    ]);
    expect(pending[0]?.questions[0]?.header).toBe("Current");
    expect(pending[0]?.questions[0]?.custom).toBe(true);
    expect(pending[1]).toMatchObject({
      request_id: "legacy-only",
      tool: { message_id: "message-legacy", call_id: "call-legacy" },
      questions: [{ multiple: false, custom: true }],
    });
    expect(legacyList).toHaveBeenCalledWith(
      { directory },
      { signal: undefined },
    );
    expect(v2List).toHaveBeenCalledWith(
      { sessionID: "session-a" },
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

    expect(subscribe).toHaveBeenCalledWith(
      { directory },
      {},
    );
    expect(connected).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledWith(
      {
        requestID: "permission-1",
        directory,
        reply: "always",
      },
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
        event: {
          type: "status",
          state: "busy",
          attempt: null,
          message: null,
          activity: "thinking",
        },
      },
      {
        sessionId: "session-a",
        event: {
          type: "status",
          state: "busy",
          attempt: null,
          message: null,
          activity: "responding",
        },
      },
      {
        sessionId: "session-a",
        event: { type: "text.delta", message_id: "assistant-a", delta: "First" },
      },
      {
        sessionId: "session-b",
        event: {
          type: "status",
          state: "busy",
          attempt: null,
          message: null,
          activity: "thinking",
        },
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
        event: {
          type: "status",
          state: "busy",
          attempt: null,
          message: null,
          activity: "thinking",
        },
      },
      {
        sessionId: "session-b",
        event: {
          type: "status",
          state: "busy",
          attempt: null,
          message: null,
          activity: "thinking",
        },
      },
      {
        sessionId: "session-a",
        event: {
          type: "status",
          state: "busy",
          attempt: null,
          message: null,
          activity: "responding",
        },
      },
      {
        sessionId: "session-a",
        event: { type: "text.delta", message_id: "assistant-a", delta: "Alpha" },
      },
      {
        sessionId: "session-b",
        event: {
          type: "status",
          state: "busy",
          attempt: null,
          message: null,
          activity: "responding",
        },
      },
      {
        sessionId: "session-b",
        event: { type: "text.delta", message_id: "assistant-b", delta: "Beta" },
      },
    ]);
  });

  it("normalizes question requests and their resolution without auto-approving them", async () => {
    const events = [
      {
        id: "event-question-asked",
        type: "question.v2.asked",
        properties: {
          id: "question-1",
          sessionID: "session-a",
          questions: [{
            header: "Format",
            question: "Which format should I use?",
            options: [
              { label: "PDF", description: "A fixed-layout document" },
              { label: "Markdown", description: "An editable text document" },
            ],
            multiple: false,
          }],
          tool: { messageID: "assistant-1", callID: "call-1" },
        },
      },
      {
        id: "event-question-replied",
        type: "question.v2.replied",
        properties: {
          sessionID: "session-a",
          requestID: "question-1",
          answers: [["PDF"]],
        },
      },
      // Replayed resolution events are suppressed by the recorder cursor state.
      {
        id: "event-question-replied-replay",
        type: "question.v2.replied",
        properties: {
          sessionID: "session-a",
          requestID: "question-1",
          answers: [["PDF"]],
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
        event: {
          type: "question.asked",
          request_id: "question-1",
          protocol: "question.v2",
          questions: [{
            header: "Format",
            question: "Which format should I use?",
            options: [
              { label: "PDF", description: "A fixed-layout document" },
              { label: "Markdown", description: "An editable text document" },
            ],
            multiple: false,
            custom: true,
          }],
          tool: { message_id: "assistant-1", call_id: "call-1" },
        },
      },
      {
        sessionId: "session-a",
        event: {
          type: "status",
          state: "busy",
          attempt: null,
          message: null,
          activity: "waiting_for_answer",
        },
      },
      {
        sessionId: "session-a",
        event: {
          type: "question.replied",
          request_id: "question-1",
          protocol: "question.v2",
          answers: [["PDF"]],
        },
      },
      {
        sessionId: "session-a",
        event: {
          type: "status",
          state: "busy",
          attempt: null,
          message: null,
          activity: "thinking",
        },
      },
    ]);
  });

  it("relays retry timing and a safe corrective action", async () => {
    const client = {
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            yield {
              id: "event-retry",
              type: "session.status",
              properties: {
                sessionID: "session-a",
                status: {
                  type: "retry",
                  attempt: 2,
                  message: "Provider is temporarily busy",
                  next: 1_784_901_234_000,
                  action: {
                    reason: "rate_limit",
                    provider: "openai",
                    title: "Provider busy",
                    message: "OpenCode will try again automatically.",
                    label: "Provider settings",
                    link: "https://example.com/settings",
                  },
                },
              },
            };
          })(),
        }),
      },
    } as unknown as OpencodeClient;

    const result = [];
    for await (const event of streamProjectChatEvents({ client })) result.push(event);

    expect(result).toEqual([{
      sessionId: "session-a",
      event: {
        type: "status",
        state: "retry",
        attempt: 2,
        message: "Provider is temporarily busy",
        activity: "retrying",
        retry_at: 1_784_901_234_000,
        retry_action: {
          reason: "rate_limit",
          provider: "openai",
          title: "Provider busy",
          message: "OpenCode will try again automatically.",
          label: "Provider settings",
          link: "https://example.com/settings",
        },
      },
    }]);
  });

  it("relays the pending, running, and terminal outcome of one tool call", async () => {
    const events = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-part-1",
            sessionID: "session-a",
            messageID: "assistant-1",
            type: "tool",
            callID: "call-1",
            tool: "write",
            state: { status: "pending", input: { path: "report.md" }, raw: "" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-part-1",
            sessionID: "session-a",
            messageID: "assistant-1",
            type: "tool",
            callID: "call-1",
            tool: "write",
            state: {
              status: "running",
              input: { path: "report.md" },
              title: "Writing report.md",
              time: { start: 100 },
            },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-part-1",
            sessionID: "session-a",
            messageID: "assistant-1",
            type: "tool",
            callID: "call-1",
            tool: "write",
            state: {
              status: "completed",
              input: { path: "report.md" },
              output: "Created report.md",
              title: "Writing report.md",
              metadata: {},
              time: { start: 100, end: 145 },
            },
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

    expect(result.map(({ event }) => event)).toEqual([
      expect.objectContaining({
        type: "tool.start",
        call_id: "call-1",
        phase: "pending",
        message_id: "assistant-1",
      }),
      expect.objectContaining({ type: "status", activity: "using_tool" }),
      expect.objectContaining({
        type: "tool.start",
        call_id: "call-1",
        phase: "running",
        message_id: "assistant-1",
      }),
      expect.objectContaining({
        type: "tool.done",
        call_id: "call-1",
        outcome: "success",
        duration_ms: 45,
        message_id: "assistant-1",
      }),
      expect.objectContaining({ type: "status", activity: "thinking" }),
    ]);
  });

  it("replies to and rejects both supported OpenCode question protocols", async () => {
    const reply = vi.fn(async () => ({ data: true, error: undefined }));
    const reject = vi.fn(async () => ({ data: true, error: undefined }));
    const replyV2 = vi.fn(async () => ({ data: true, error: undefined }));
    const rejectV2 = vi.fn(async () => ({ data: true, error: undefined }));
    const client = {
      question: { reply, reject },
      v2: {
        session: {
          question: { reply: replyV2, reject: rejectV2 },
        },
      },
    } as unknown as OpencodeClient;

    await replyProjectQuestion({
      client,
      sessionId: "session-a",
      requestId: "question-1",
      protocol: "question",
      answers: [["PDF"]],
    });
    await rejectProjectQuestion({
      client,
      sessionId: "session-a",
      requestId: "question-2",
      protocol: "question",
    });
    await replyProjectQuestion({
      client,
      sessionId: "session-a",
      requestId: "question-3",
      protocol: "question.v2",
      answers: [["Markdown"]],
    });
    await rejectProjectQuestion({
      client,
      sessionId: "session-a",
      requestId: "question-4",
      protocol: "question.v2",
    });

    expect(reply).toHaveBeenCalledWith({
      requestID: "question-1",
      directory,
      answers: [["PDF"]],
    }, { signal: undefined });
    expect(reject).toHaveBeenCalledWith({
      requestID: "question-2",
      directory,
    }, { signal: undefined });
    expect(replyV2).toHaveBeenCalledWith({
      sessionID: "session-a",
      requestID: "question-3",
      questionV2Reply: { answers: [["Markdown"]] },
    }, { signal: undefined });
    expect(rejectV2).toHaveBeenCalledWith({
      sessionID: "session-a",
      requestID: "question-4",
    }, { signal: undefined });
  });
});
