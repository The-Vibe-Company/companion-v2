import { describe, expect, it } from "vitest";
import {
  PiJournalCorrelationError,
  PiProjectionSecurityError,
  PiJournalValidationError,
  classifyPiJournalPage,
  validateBrokerCounters,
  validatePiJournalRead,
} from "./piEvents";
import { createRuntimeVisibleTextRedactor } from "./projectionRedaction";
import { ATTEMPT_ID, PI_INVOCATION_ID } from "./test/fixtures";

describe("Pi journal validation and projection", () => {
  it("counts unknown events, projects process exit, and never treats it as settlement", () => {
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: { type: "future_event", secret: "must not be projected" },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_process_exit",
            exit: { code: 137, signal: "SIGKILL" },
          },
        ],
        nextCursor: 2,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(page);

    expect(classified.unknownEvents).toBe(1);
    expect(classified.settled).toBe(false);
    expect(classified.processExit).toEqual({ code: 137, signal: "SIGKILL" });
    expect(classified.projections).toEqual([
      { sequence: 2n, type: "process_exit", code: 137, signal: "SIGKILL" },
    ]);
    expect(JSON.stringify(classified.projections, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value)).not.toContain("must not be projected");
  });

  it("requires exact attempt and invocation correlation", () => {
    expect(() => validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "pi_event",
          event: { type: "agent_settled" },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    })).toThrow(PiJournalCorrelationError);
  });

  it("ignores an unsupported settlement shape", () => {
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "agent_settled", extra: true },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(page);
    expect(classified.settled).toBe(false);
    expect(classified.unknownEvents).toBe(1);
    expect(classified.projections).toEqual([]);
  });

  it("validates all broker rejection counters without retaining rejected lines", () => {
    expect(validateBrokerCounters({
      malformedLines: 2,
      oversizedLines: 3,
      unterminatedLines: 4,
      unknownEvents: 5,
      unboundEvents: 6,
      orphanResponses: 7,
      rawLine: "not part of the returned value",
    })).toEqual({
      malformedLines: 2,
      oversizedLines: 3,
      unterminatedLines: 4,
      unknownEvents: 5,
      unboundEvents: 6,
      orphanResponses: 7,
    });
  });

  it.each([
    {
      name: "more than 256 records",
      value: {
        events: Array.from({ length: 257 }, (_value, index) => ({
          sequence: index + 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "turn_start" },
        })),
        nextCursor: 257,
        acknowledgedCursor: 0,
        hasMore: true,
      },
      after: 0n,
    },
    {
      name: "an ACK ahead of the durable cursor",
      value: {
        events: [],
        nextCursor: 4,
        acknowledgedCursor: 4,
        hasMore: false,
      },
      after: 3n,
    },
    {
      name: "an empty page that skips the requested cursor",
      value: {
        events: [],
        nextCursor: 2,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 1n,
    },
    {
      name: "a partial page whose next cursor is not its final record",
      value: {
        events: [{
          sequence: 2,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "turn_start" },
        }],
        nextCursor: 3,
        acknowledgedCursor: 1,
        hasMore: true,
      },
      after: 1n,
    },
  ])("rejects $name", ({ value, after }) => {
    expect(() => validatePiJournalRead({
      value,
      after,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    })).toThrow(PiJournalValidationError);
  });

  it("keeps opaque tool and decision ids out of DB entry keys", () => {
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "tool_execution_start",
              toolCallId: "provider call/id with spaces?",
              toolName: "shell",
              args: { command: "true" },
            },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "provider request/id with spaces?",
              method: "confirm",
              title: "companion:shell:approve",
              message: "Approve?",
            },
          },
        ],
        nextCursor: 2,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(page);

    expect(classified.projections).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool", entry_key: "tool:1" }),
      expect.objectContaining({
        type: "decision",
        entry_key: "decision:2",
        request_key: "provider request/id with spaces?",
      }),
    ]));
  });

  it("redacts exact credentials and projects tool events as safe metadata only", () => {
    const opaqueSecret = "mF9xOpaqueCredentialValue";
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: `Result ${opaqueSecret} Bearer abc.def https://s3.example/a?X-Amz-Signature=secret` },
                  { type: "thinking", thinking: `credential=${opaqueSecret}` },
                ],
              },
            },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "tool_execution_start",
              toolCallId: "raw-provider-call-id",
              toolName: "shell",
              args: { command: `cat auth.json && echo ${opaqueSecret}` },
            },
          },
          {
            sequence: 3,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "tool_execution_end",
              toolCallId: "raw-provider-call-id",
              toolName: "shell",
              result: { stdout: `TOKEN=${opaqueSecret}` },
            },
          },
          {
            sequence: 4,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "request-1",
              method: "confirm",
              title: "companion:shell:approve",
              message: `Approve use of ${opaqueSecret}?`,
            },
          },
        ],
        nextCursor: 4,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(
      page,
      new Date("2026-08-16T12:00:00.000Z"),
      createRuntimeVisibleTextRedactor([opaqueSecret]),
    );
    const serialized = JSON.stringify(classified.projections, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    const tools = classified.projections.filter((projection) => projection.type === "tool");

    expect(serialized).not.toContain(opaqueSecret);
    expect(serialized).not.toContain("raw-provider-call-id");
    expect(serialized).not.toContain("auth.json");
    expect(serialized).not.toContain("X-Amz-Signature");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      tool: {
        call_id: expect.stringMatching(/^sha256:[0-9a-f]{32}$/),
        kind: "shell",
        name: "shell",
        title: "Shell command",
        detail: null,
      },
    });
    expect(tools[1]?.tool.call_id).toBe(tools[0]?.tool.call_id);
  });

  it.each([
    ["webfetch", "browse"],
    ["execute", "shell"],
    ["str_replace_editor", "file"],
  ] as const)("uses the canonical tool catalog for %s", (toolName, kind) => {
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "tool_execution_start", toolName, toolCallId: "call-1" },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    expect(classifyPiJournalPage(page).projections[0]).toMatchObject({
      type: "tool",
      tool: { kind },
    });
  });

  it("does not reintroduce exact secrets through synthetic redaction markers", () => {
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              content: "credential Bearer abc [credential removed]",
            },
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(
      page,
      new Date(),
      createRuntimeVisibleTextRedactor(["credential", "redacted"]),
    );
    const serialized = JSON.stringify(classified.projections, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("redacted");
  });

  it("redacts quoted OAuth JSON fields even when their values have no known token shape", () => {
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              content: '{"access_token":"plain-opaque-access","clientSecret":"plain-opaque-client"}',
            },
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const serialized = JSON.stringify(
      classifyPiJournalPage(page).projections,
      (_key, value) => typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain("plain-opaque");
    expect(serialized).toContain("[redacted]");
  });

  it("refuses to persist a decision request id that contains credential material", () => {
    const secret = "opaque-decision-secret";
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "extension_ui_request",
            id: secret,
            method: "confirm",
            title: "companion:shell:approve",
            message: "Approve?",
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    expect(() => classifyPiJournalPage(
      page,
      new Date(),
      createRuntimeVisibleTextRedactor([secret]),
    )).toThrow(PiProjectionSecurityError);
  });

  it("refuses an oversized decision id before credential redaction can see only a prefix", () => {
    const secret = "s".repeat(240);
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "extension_ui_request",
            id: secret,
            method: "confirm",
            title: "companion:shell:approve",
            message: "Approve?",
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    expect(() => classifyPiJournalPage(
      page,
      new Date(),
      createRuntimeVisibleTextRedactor([secret]),
    )).toThrow(PiProjectionSecurityError);
  });

  it("refuses a decision id equal to the exact-redaction marker", () => {
    const secret = "[credential removed]";
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "extension_ui_request",
            id: secret,
            method: "confirm",
            title: "companion:shell:approve",
            message: "Approve?",
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    expect(() => classifyPiJournalPage(
      page,
      new Date(),
      createRuntimeVisibleTextRedactor([secret]),
    )).toThrow(PiProjectionSecurityError);
  });
});
