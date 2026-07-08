import { describe, expect, it } from "vitest";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { loadSessionItems } from "../src/opencodeChat";

function clientWithMessages(messages: unknown[]): OpencodeClient {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  } as unknown as OpencodeClient;
}

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
});
