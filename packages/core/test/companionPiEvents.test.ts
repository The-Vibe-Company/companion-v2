import { describe, expect, it } from "vitest";
import { projectCompanionPiEvents } from "../src/companionPiEvents";

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

const now = new Date("2026-08-12T12:00:00.000Z");

describe("Pi RPC log projection", () => {
  it("projects assistant text and drops thinking, tool calls, and tool results", () => {
    const chunk = [
      line({ type: "agent_start" }),
      line({ type: "message_end", message: { role: "user", content: "Summarize the incident" } }),
      line({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "text", text: "Two services timed out." },
            { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
          ],
          stopReason: "stop",
          timestamp: Date.parse("2026-08-12T11:59:00.000Z"),
        },
      }),
      line({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "logs" }] } }),
      line({ type: "agent_settled" }),
    ].join("");

    const projection = projectCompanionPiEvents({ chunk, offset: 0, now });

    expect(projection.entries).toEqual([{
      eventId: expect.stringMatching(/^pi:\d+$/),
      role: "assistant",
      content: "Two services timed out.",
      createdAt: new Date("2026-08-12T11:59:00.000Z"),
    }]);
    expect(projection.settled).toBe(true);
    expect(projection.consumedBytes).toBe(Buffer.byteLength(chunk, "utf8"));
  });

  it("derives event ids from byte offsets so a repeated read stays idempotent", () => {
    const first = line({ type: "agent_start" });
    const reply = line({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });

    const projection = projectCompanionPiEvents({ chunk: first + reply, offset: 4_096, now });
    const replayed = projectCompanionPiEvents({ chunk: first + reply, offset: 4_096, now });

    expect(projection.entries[0]?.eventId).toBe(`pi:${4_096 + Buffer.byteLength(first, "utf8")}`);
    expect(replayed.entries).toEqual(projection.entries);
  });

  it("leaves a truncated trailing record for the next read", () => {
    const complete = line({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    });
    const partial = '{"type":"message_end","message":{"role":"assist';

    const projection = projectCompanionPiEvents({ chunk: complete + partial, offset: 0, now });

    expect(projection.entries).toHaveLength(1);
    expect(projection.consumedBytes).toBe(Buffer.byteLength(complete, "utf8"));
  });

  it("keeps a failed turn visible without inventing an assistant reply", () => {
    const chunk = [
      line({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } }),
      line({ type: "response", command: "prompt", success: false, error: "agent is streaming" }),
    ].join("");

    const projection = projectCompanionPiEvents({ chunk, offset: 0, now });

    expect(projection.entries.map((entry) => entry.role)).toEqual(["system", "system"]);
    expect(projection.entries[0]?.content).toContain("without a reply (error)");
    expect(projection.entries[1]?.content).toContain("agent is streaming");
  });

  it("skips malformed records instead of failing the whole sync", () => {
    const chunk = `not json\n${line({
      type: "message_end",
      message: { role: "assistant", content: "Recovered" },
    })}`;

    const projection = projectCompanionPiEvents({ chunk, offset: 0, now });

    expect(projection.entries).toHaveLength(1);
    expect(projection.entries[0]?.content).toBe("Recovered");
    expect(projection.consumedBytes).toBe(Buffer.byteLength(chunk, "utf8"));
  });
});
