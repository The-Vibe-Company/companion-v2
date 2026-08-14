import { describe, expect, it } from "vitest";
import type { CompanionToolRun } from "@companion/contracts";
import {
  matchCompanionToolCompletions,
  projectCompanionPiEvents,
} from "../src/companionPiEvents";

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

const now = new Date("2026-08-12T12:00:00.000Z");

describe("Pi RPC log projection", () => {
  it("projects assistant text, drops thinking, and gives each tool call its own entry", () => {
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

    expect(projection.entries.map((entry) => [entry.role, entry.content])).toEqual([
      ["assistant", "Two services timed out."],
      ["tool", "ls"],
    ]);
    // The reply stays the reply: the thinking is gone and the call is beside it, not inside it.
    expect(projection.entries[0]?.tool).toBeUndefined();
    expect(projection.entries[1]?.tool).toMatchObject({
      call_id: "call_1",
      kind: "shell",
      name: "bash",
      title: "ls",
      status: "running",
      screenshot: null,
    });
    expect(projection.settled).toBe(true);
    expect(projection.consumedBytes).toBe(Buffer.byteLength(chunk, "utf8"));
  });

  it("reads a tool result as the completion of the call it names", () => {
    const chunk = [
      line({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_7", name: "bash", arguments: { command: "ls" } }],
          stopReason: "toolUse",
        },
      }),
      line({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "call_7",
          content: [{ type: "text", text: "README.md\npackage.json" }],
        },
      }),
    ].join("");

    const projection = projectCompanionPiEvents({ chunk, offset: 0, now });

    expect(projection.toolCompletions).toEqual([{
      callId: "call_7",
      status: "ok",
      result: "README.md\npackage.json",
      completedAt: now,
    }]);
  });

  it("reports a failed tool result as a failed run", () => {
    const chunk = line({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call_8",
        isError: true,
        content: [{ type: "text", text: "bash: nope: command not found" }],
      },
    });

    const projection = projectCompanionPiEvents({ chunk, offset: 0, now });

    expect(projection.toolCompletions[0]).toMatchObject({
      callId: "call_8",
      status: "error",
      result: "bash: nope: command not found",
    });
  });

  it("names a run by what it touched rather than by the tool that touched it", () => {
    const chunk = [
      line({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "str_replace_editor", input: { path: "src/app.ts" } },
            { type: "tool_use", id: "b", name: "web_search", input: { query: "oklch support" } },
            { type: "tool_use", id: "c", name: "computer", input: { action: "screenshot" } },
            { type: "tool_use", id: "d", name: "summon_kraken", input: {} },
          ],
          stopReason: "toolUse",
        },
      }),
    ].join("");

    const projection = projectCompanionPiEvents({ chunk, offset: 0, now });

    expect(projection.entries.map((entry) => [entry.tool?.kind, entry.tool?.title])).toEqual([
      ["file", "src/app.ts"],
      ["browse", "oklch support"],
      ["computer", "screenshot"],
      // An unrecognized tool reports itself rather than being filed under a guess.
      ["tool", "summon_kraken"],
    ]);
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

  it("shows the reasoning when a settled turn answered without a text part", () => {
    const chunk = [
      line({ type: "message_end", message: { role: "user", content: "What year is it? One word." } }),
      line({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "\n2025" }],
          stopReason: "stop",
          timestamp: Date.parse("2026-08-12T11:59:30.000Z"),
        },
      }),
      line({ type: "agent_settled" }),
    ].join("");

    const projection = projectCompanionPiEvents({ chunk, offset: 0, now });

    expect(projection.entries).toEqual([{
      eventId: expect.stringMatching(/^pi:\d+$/),
      role: "assistant",
      content: "2025",
      createdAt: new Date("2026-08-12T11:59:30.000Z"),
    }]);
    expect(projection.settled).toBe(true);
  });

  it("keeps a settled turn with no content at all visible as a system line", () => {
    const chunk = [
      line({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } }),
      line({ type: "agent_settled" }),
    ].join("");

    const projection = projectCompanionPiEvents({ chunk, offset: 0, now });

    expect(projection.entries.map((entry) => entry.role)).toEqual(["system"]);
    expect(projection.entries[0]?.content).toBe("Pi ended the turn without a visible reply.");
    expect(projection.settled).toBe(true);
  });

  it("leaves a mid-turn tool step as its chip and not as a reply", () => {
    const chunk = line({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
        stopReason: "toolUse",
      },
    });

    const projection = projectCompanionPiEvents({ chunk, offset: 0, now });

    // A tool step is not a turn, so it must never close one with "Pi ended the turn without a
    // visible reply" — the chip is the whole of what happened here.
    expect(projection.entries.map((entry) => entry.role)).toEqual(["tool"]);
  });

  it("gives a call and the reply beside it ids that survive a repeated read", () => {
    const chunk = line({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Listing the repository." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
          { type: "toolCall", id: "call_2", name: "bash", arguments: { command: "pwd" } },
        ],
        stopReason: "toolUse",
      },
    });

    const projection = projectCompanionPiEvents({ chunk, offset: 4_096, now });
    const replayed = projectCompanionPiEvents({ chunk, offset: 4_096, now });

    expect(projection.entries.map((entry) => entry.eventId)).toEqual([
      "pi:4096",
      "pi:4096:tool:0",
      "pi:4096:tool:1",
    ]);
    expect(replayed.entries).toEqual(projection.entries);
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

/**
 * Product promise:
 * A chip that starts spinning stops on the run it belongs to. A tool call and its result routinely
 * arrive in different syncs, so the match is what keeps a finished run from spinning forever and a
 * stray result from closing somebody else's run.
 *
 * Regression caught:
 * Closing whichever chip is convenient — the newest, or any open one — which shows a shell run's
 * output under a file run, and re-closing an already-settled run when a shrunken log is reread.
 *
 * Why this level:
 * The rule is pure. It reads the open runs and the results and says which chips settle; the database
 * around it only supplies the one list and writes the other.
 *
 * Failure proof:
 * Dropping the call-id branch, or letting a result with no id close the newest run, fails a case.
 */
describe("Pi tool result matching", () => {
  const run = (
    eventId: string,
    overrides: Partial<CompanionToolRun> = {},
  ): { eventId: string; tool: CompanionToolRun } => ({
    eventId,
    tool: {
      call_id: null,
      kind: "shell",
      name: "bash",
      title: "ls",
      status: "running",
      detail: '{ "command": "ls" }',
      screenshot: null,
      ...overrides,
    },
  });

  const result = (
    callId: string | null,
    overrides: Partial<{ status: "ok" | "error"; result: string | null }> = {},
  ) => ({ callId, status: "ok" as const, result: "done", completedAt: now, ...overrides });

  it("closes the run its result names, whatever order the results arrive in", () => {
    const settled = matchCompanionToolCompletions(
      [run("a", { call_id: "call_1" }), run("b", { call_id: "call_2" })],
      [result("call_2"), result("call_1", { status: "error", result: "exit 1" })],
    );

    expect(settled.map((entry) => [entry.eventId, entry.tool.status])).toEqual([
      ["b", "ok"],
      ["a", "error"],
    ]);
  });

  it("closes the oldest open run when the harness reports no call id", () => {
    const settled = matchCompanionToolCompletions(
      [run("a"), run("b")],
      [result(null), result(null)],
    );

    expect(settled.map((entry) => entry.eventId)).toEqual(["a", "b"]);
  });

  it("drops a result that matches no open run instead of closing one at random", () => {
    expect(matchCompanionToolCompletions([run("a", { call_id: "call_1" })], [result("call_9")]))
      .toEqual([]);
    expect(matchCompanionToolCompletions([], [result(null)])).toEqual([]);
  });

  it("keeps the arguments and adds what the tool answered", () => {
    const [settled] = matchCompanionToolCompletions([run("a")], [result(null, { result: "logs" })]);

    expect(settled?.tool.detail).toBe('{ "command": "ls" }\n\nlogs');
    // Everything the call itself said about the run is untouched by its result.
    expect(settled?.tool).toMatchObject({ kind: "shell", name: "bash", title: "ls" });
  });
});

describe("permission broker projection", () => {
  it("projects shell and file confirm requests as pending decision cards", () => {
    const chunk = [
      line({
        type: "extension_ui_request",
        id: "ui-shell-1",
        method: "confirm",
        title: "companion:shell:bash",
        message: "rm -rf /tmp/scratch",
        timeout: 300_000,
      }),
      line({
        type: "extension_ui_request",
        id: "ui-file-1",
        method: "confirm",
        title: "companion:file:write",
        message: "src/index.ts",
        timeout: 300_000,
      }),
    ].join("");

    const projection = projectCompanionPiEvents({ chunk, offset: 0, now });

    expect(projection.entries).toHaveLength(2);
    expect(projection.entries[0]).toMatchObject({
      eventId: "decision:ui-shell-1",
      role: "decision",
      content: "rm -rf /tmp/scratch",
      decision: {
        request_id: "ui-shell-1",
        kind: "shell",
        name: "bash",
        title: "rm -rf /tmp/scratch",
        status: "pending",
        answer: null,
        expires_at: "2026-08-12T12:05:00.000Z",
      },
    });
    expect(projection.entries[1]?.decision).toMatchObject({
      request_id: "ui-file-1",
      kind: "file",
      name: "write",
      title: "src/index.ts",
      status: "pending",
    });
  });

  it("projects ask_user input requests as question cards", () => {
    const chunk = line({
      type: "extension_ui_request",
      id: "ui-q-1",
      method: "input",
      title: "companion:question:ask_user",
      placeholder: "Ship the release notes now?",
      timeout: 300_000,
    });

    const projection = projectCompanionPiEvents({ chunk, offset: 10, now });

    expect(projection.entries).toEqual([expect.objectContaining({
      eventId: "decision:ui-q-1",
      role: "decision",
      decision: expect.objectContaining({
        kind: "question",
        name: "ask_user",
        title: "Ship the release notes now?",
        status: "pending",
      }),
    })]);
  });

  it("ignores fire-and-forget extension UI and titles the Companion broker did not mint", () => {
    const chunk = [
      line({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "mcp" }),
      line({
        type: "extension_ui_request",
        id: "2",
        method: "confirm",
        title: "Clear session?",
        message: "All messages will be lost.",
      }),
      line({
        type: "extension_ui_request",
        id: "3",
        method: "notify",
        message: "Blocked",
      }),
    ].join("");

    expect(projectCompanionPiEvents({ chunk, offset: 0, now }).entries).toEqual([]);
  });
});
