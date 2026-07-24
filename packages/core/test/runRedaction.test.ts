import { describe, expect, it } from "vitest";
import {
  createRunRedactor,
  createRunStreamingRedactor,
  redactAndBoundProjectEvents,
  redactAndBoundProjectTranscript,
  RUN_REDACTION_MIN_LITERAL_LENGTH,
  RUN_REDACTION_PLACEHOLDER,
} from "../src/runRedaction";
import {
  PROJECT_QUESTION_ANSWERS_MAX_BYTES,
  PROJECT_QUESTION_PAYLOAD_MAX_BYTES,
  PROJECT_TRANSCRIPT_MAX_BYTES,
  RUN_CHAT_DELTA_MAX,
  RUN_CHAT_ID_MAX,
  RUN_CHAT_TOOL_OUTPUT_MAX,
  runChatEventSchema,
  runChatHistoryItemSchema,
} from "@companion/contracts";

describe("RunRedactor", () => {
  it("uses every non-empty injected literal, including unusually short credentials", () => {
    const redactor = createRunRedactor([undefined, null, "", "x", "abc", "safe", "second-secret"]);

    expect(RUN_REDACTION_MIN_LITERAL_LENGTH).toBe(1);
    expect(redactor.redactText("x abc safe second-secret")).toBe(
      `${RUN_REDACTION_PLACEHOLDER} ${RUN_REDACTION_PLACEHOLDER} ${RUN_REDACTION_PLACEHOLDER} ${RUN_REDACTION_PLACEHOLDER}`,
    );
  });

  it("prefers the longest overlapping literal and handles regex metacharacters literally", () => {
    const redactor = createRunRedactor(["token", "token-long", "a+b*c?.[x]"]);

    expect(redactor.redactText("token-long token a+b*c?.[x]")).toBe(
      `${RUN_REDACTION_PLACEHOLDER} ${RUN_REDACTION_PLACEHOLDER} ${RUN_REDACTION_PLACEHOLDER}`,
    );
  });

  it("redacts nested event, tool, and Error strings without mutating the input", () => {
    const secret = "sk-live-super-secret";
    const error = Object.assign(new Error(`provider rejected ${secret}`), {
      details: { response: `tool output: ${secret}` },
    });
    const input = {
      type: "tool.done",
      output: `top-level ${secret}`,
      nested: [{ input: `curl -H 'Authorization: ${secret}'` }],
      error,
    };
    const redactor = createRunRedactor([secret]);

    const result = redactor.redactPayload(input);

    expect(result).not.toBe(input);
    expect(result.nested).not.toBe(input.nested);
    expect(result.nested[0]).not.toBe(input.nested[0]);
    expect(result.output).toBe(`top-level ${RUN_REDACTION_PLACEHOLDER}`);
    expect(result.nested[0]?.input).toBe(`curl -H 'Authorization: ${RUN_REDACTION_PLACEHOLDER}'`);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBe(error);
    expect(result.error.message).toBe(`provider rejected ${RUN_REDACTION_PLACEHOLDER}`);
    expect(result.error.stack).not.toContain(secret);
    expect(result.error.details.response).toBe(`tool output: ${RUN_REDACTION_PLACEHOLDER}`);

    expect(input.output).toContain(secret);
    expect(input.nested[0]?.input).toContain(secret);
    expect(error.message).toContain(secret);
    expect(error.details.response).toContain(secret);
  });

  it("preserves cycles while returning a distinct redacted payload", () => {
    const secret = "cycle-secret";
    const input: { message: string; self?: unknown } = { message: secret };
    input.self = input;

    const result = createRunRedactor([secret]).redactPayload(input);

    expect(result).not.toBe(input);
    expect(result.message).toBe(RUN_REDACTION_PLACEHOLDER);
    expect(result.self).toBe(result);
  });

  it("clear drops the literals and turns future redaction into a pass-through", () => {
    const secret = "clear-this-secret";
    const redactor = createRunRedactor([secret]);
    expect(redactor.redactText(secret)).toBe(RUN_REDACTION_PLACEHOLDER);

    redactor.clear();

    expect(redactor.redactText(secret)).toBe(secret);
  });

  it("redacts exact secret bytes without decoding surrounding binary data", () => {
    const secret = "binary-secret";
    const prefix = Buffer.from([0x00, 0xff, 0x89, 0x50]);
    const suffix = Buffer.from([0xfe, 0x01]);
    const input = Buffer.concat([prefix, Buffer.from(secret), suffix]);

    const output = createRunRedactor([secret]).redactBytes(input);

    expect(output.subarray(0, prefix.length)).toEqual(prefix);
    expect(output.subarray(-suffix.length)).toEqual(suffix);
    expect(output.includes(Buffer.from(secret))).toBe(false);
    expect(output.includes(Buffer.from(RUN_REDACTION_PLACEHOLDER))).toBe(true);
  });
});

describe("RunStreamingRedactor", () => {
  it("does not emit a literal split across adjacent chunks", () => {
    const secret = "split-across-chunks";
    const stream = createRunStreamingRedactor([secret]);
    const output = [
      stream.push("before "),
      stream.push(secret.slice(0, 5)),
      stream.push(secret.slice(5, 12)),
      stream.push(`${secret.slice(12)} after`),
      stream.flush(),
    ];

    expect(output.join("")).toBe(`before ${RUN_REDACTION_PLACEHOLDER} after`);
    expect(output.every((chunk) => !chunk.includes(secret))).toBe(true);
  });

  it("retains only a bounded tail and flushes ordinary text", () => {
    const stream = createRunStreamingRedactor(["secret"]);

    expect(stream.push("0123456789")).toBe("01234");
    expect(stream.flush()).toBe("56789");
    expect(stream.push("next")).toBe("");
    expect(stream.flush()).toBe("next");
  });

  it("redacts the longest complete literal while draining a safe prefix", () => {
    const stream = createRunStreamingRedactor(["token", "token-long"]);
    const output = stream.push("token-long and token") + stream.flush();

    expect(output).toBe(`${RUN_REDACTION_PLACEHOLDER} and ${RUN_REDACTION_PLACEHOLDER}`);
  });

  it("clear drops both literal references and the pending raw tail", () => {
    const secret = "pending-stream-secret";
    const stream = createRunStreamingRedactor([secret]);
    expect(stream.push(secret.slice(0, 8))).toBe("");

    stream.clear();

    expect(stream.flush()).toBe("");
    expect(stream.push(secret)).toBe(secret);
  });

  it("a stream created from a RunRedactor owns an independent literal set", () => {
    const secret = "independent-secret";
    const redactor = createRunRedactor([secret]);
    const stream = redactor.createStream();
    redactor.clear();

    expect(stream.push(secret) + stream.flush()).toBe(RUN_REDACTION_PLACEHOLDER);
    expect(redactor.redactText(secret)).toBe(secret);
  });
});

describe("Project chat persistence boundaries", () => {
  it("redacts, bounds, and parses every sandbox-origin event", () => {
    const secret = "project-provider-secret";
    const events = redactAndBoundProjectEvents([
      {
        type: "tool.done",
        call_id: "c".repeat(RUN_CHAT_ID_MAX + 100),
        title: null,
        output: `${"x".repeat(RUN_CHAT_TOOL_OUTPUT_MAX + 100)}${secret}`,
        duration_ms: 1,
      },
      {
        type: "text.delta",
        message_id: "message",
        delta: `${"🤖".repeat(RUN_CHAT_DELTA_MAX)}${secret}`,
      },
      {
        type: "status",
        state: "retry",
        attempt: 2,
        message: `Waiting for ${secret}`,
        activity: "retrying",
        retry_at: Date.now() + 1_000,
        retry_action: {
          reason: secret,
          provider: "provider",
          title: "Try again",
          message: secret,
          label: "Open settings",
          link: `https://example.com/${secret}`,
        },
      },
      {
        type: "question.asked",
        request_id: "question-request",
        protocol: "question",
        questions: [
          {
            header: "Format",
            question: `Which ${secret} format should I use?`,
            options: [
              {
                label: "Brief",
                description: `Use the ${secret} brief`,
              },
            ],
            multiple: false,
            custom: true,
          },
        ],
        tool: {
          message_id: "assistant-message",
          call_id: "question-tool",
        },
      },
    ], createRunRedactor([secret]));

    expect(events.length).toBeGreaterThan(2);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.map((event) => runChatEventSchema.parse(event))).toEqual(events);
    const tool = events[0];
    expect(tool?.type).toBe("tool.done");
    if (tool?.type === "tool.done") {
      expect(Buffer.byteLength(tool.call_id, "utf8")).toBeLessThanOrEqual(RUN_CHAT_ID_MAX);
      expect(Buffer.byteLength(tool.output, "utf8")).toBeLessThanOrEqual(
        RUN_CHAT_TOOL_OUTPUT_MAX,
      );
    }
    for (const event of events) {
      if (event.type === "text.delta") {
        expect(Buffer.byteLength(event.delta, "utf8")).toBeLessThanOrEqual(
          RUN_CHAT_DELTA_MAX,
        );
      }
    }
  });

  it("redacts and caps a cumulative Project transcript while retaining the newest response", () => {
    const secret = "transcript-secret-sentinel";
    const transcript = redactAndBoundProjectTranscript([
      {
        kind: "tool",
        call_id: "old-tool",
        tool: "bash",
        skill: null,
        title: null,
        input: secret,
        output: "x".repeat(700_000),
        duration_ms: 1,
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        kind: "assistant" as const,
        text: `${index}:${"🤖".repeat(100_000)}`,
      })),
      { kind: "assistant", text: `final ${secret}` },
    ], createRunRedactor([secret]));

    expect(Buffer.byteLength(JSON.stringify(transcript), "utf8")).toBeLessThanOrEqual(
      PROJECT_TRANSCRIPT_MAX_BYTES,
    );
    expect(JSON.stringify(transcript)).not.toContain(secret);
    expect(transcript.at(-1)).toEqual({
      kind: "assistant",
      text: `final ${RUN_REDACTION_PLACEHOLDER}`,
    });
    expect(transcript.map((item) => runChatHistoryItemSchema.parse(item))).toEqual(transcript);
  });

  it("compacts aggregate question payloads without dropping their answer shape", () => {
    const questions = Array.from({ length: 8 }, (_, questionIndex) => ({
      header: `"${questionIndex}"`.repeat(180),
      question: `"question-${questionIndex}"`.repeat(320),
      options: Array.from({ length: 12 }, (_, optionIndex) => ({
        label: `"option-${questionIndex}-${optionIndex}"`.repeat(40),
        description: `"description-${questionIndex}-${optionIndex}"`.repeat(260),
      })),
      multiple: true,
      custom: true,
    }));
    const [asked, replied] = redactAndBoundProjectEvents([
      {
        type: "question.asked",
        request_id: "question-aggregate",
        protocol: "question.v2",
        questions,
        tool: { message_id: "message-1", call_id: "call-1" },
      },
      {
        type: "question.replied",
        request_id: "question-aggregate",
        protocol: "question.v2",
        answers: Array.from({ length: 8 }, () =>
          Array.from({ length: 12 }, () => `"answer"`.repeat(700)),
        ),
      },
    ]);

    expect(asked?.type).toBe("question.asked");
    expect(replied?.type).toBe("question.replied");
    if (asked?.type === "question.asked") {
      expect(asked.questions).toHaveLength(8);
      expect(asked.questions.every((question) => question.options.length === 12)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(asked.questions), "utf8")).toBeLessThanOrEqual(
        PROJECT_QUESTION_PAYLOAD_MAX_BYTES,
      );
    }
    if (replied?.type === "question.replied") {
      expect(replied.answers).toHaveLength(8);
      expect(replied.answers.every((answers) => answers.length === 12)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(replied.answers), "utf8")).toBeLessThanOrEqual(
        PROJECT_QUESTION_ANSWERS_MAX_BYTES,
      );
    }
  });

  it("rejects invalid aggregate transcript limits", () => {
    expect(() => redactAndBoundProjectTranscript([], undefined, 1)).toThrow(RangeError);
  });
});
