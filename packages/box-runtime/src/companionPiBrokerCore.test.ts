import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CompanionPiBroker,
  SegmentedCompanionPiJournal,
  StrictLfJsonlDecoder,
  createCompanionPiOutputDecoder,
  normalizePiModelCatalog,
  listenOwnerOnlyCompanionPiSocket,
  sendCompanionPiBrokerCommand,
  startCompanionPiBrokerSocket,
  type CompanionPiRpcTransport,
  type PiJsonObject,
} from "./companionPiBrokerCore";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("StrictLfJsonlDecoder", () => {
  it("uses literal LF, rejects CRLF and invalid UTF-8, and continues with later records", () => {
    const records: PiJsonObject[] = [];
    const faults: string[] = [];
    const decoder = new StrictLfJsonlDecoder({
      maxLineBytes: 128,
      onRecord: (record) => records.push(record),
      onFault: (fault) => faults.push(fault),
    });

    decoder.push(Buffer.from('{"type":"one"}\n{"type":"crlf"}\r\n{"type":'));
    decoder.push(Buffer.from('"two"}\n'));
    decoder.push(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]));
    decoder.finish();

    expect(records).toEqual([{ type: "one" }, { type: "two" }]);
    expect(faults).toEqual(["malformed", "malformed"]);
  });

  it("drops an oversized line without retaining raw content and resumes at its LF", () => {
    const records: PiJsonObject[] = [];
    const faults: string[] = [];
    const decoder = new StrictLfJsonlDecoder({
      maxLineBytes: 32,
      onRecord: (record) => records.push(record),
      onFault: (fault) => faults.push(fault),
    });
    const secret = "do-not-persist-this-provider-token";

    decoder.push(Buffer.from(`{"type":"message_update","value":"${secret}`));
    decoder.push(Buffer.from(`${"x".repeat(256)}"}\n{"type":"agent_settled"}\n`));
    decoder.finish();

    expect(faults).toEqual(["oversized"]);
    expect(records).toEqual([{ type: "agent_settled" }]);
    expect(JSON.stringify({ faults, records })).not.toContain(secret);
  });

  it("counts an unterminated final fragment without parsing it", () => {
    const records: PiJsonObject[] = [];
    const faults: string[] = [];
    const decoder = new StrictLfJsonlDecoder({
      onRecord: (record) => records.push(record),
      onFault: (fault) => faults.push(fault),
    });
    decoder.push(Buffer.from('{"type":"agent_start"}'));
    decoder.finish();
    expect(records).toEqual([]);
    expect(faults).toEqual(["unterminated"]);
  });

  it("counts an empty LF record as malformed and continues", () => {
    const records: PiJsonObject[] = [];
    const faults: string[] = [];
    const decoder = new StrictLfJsonlDecoder({
      onRecord: (record) => records.push(record),
      onFault: (fault) => faults.push(fault),
    });
    decoder.push(Buffer.from('\n{"type":"agent_start"}\n'));
    decoder.finish();
    expect(faults).toEqual(["malformed"]);
    expect(records).toEqual([{ type: "agent_start" }]);
  });

  it("does not misclassify or swallow an operational onRecord failure", () => {
    const faults: string[] = [];
    const decoder = new StrictLfJsonlDecoder({
      onRecord() {
        throw new Error("synthetic journal fsync failure");
      },
      onFault: (fault) => faults.push(fault),
    });
    expect(() => decoder.push(Buffer.from('{"type":"agent_start"}\n')))
      .toThrow("synthetic journal fsync failure");
    expect(faults).toEqual([]);
  });
});

describe("SegmentedCompanionPiJournal", () => {
  it("persists monotonic segments, explicit acknowledgements, retention, and restart recovery", () => {
    const directory = temporaryDirectory("pi-journal-");
    let journal = new SegmentedCompanionPiJournal({ directory, segmentBytes: 180 });
    for (const type of ["agent_start", "turn_start", "agent_settled"]) {
      journal.append({
        invocationId: "invocation-1",
        attemptId: "attempt-1",
        kind: "pi_event",
        event: { type },
      });
    }

    expect(journal.read(0, 2)).toMatchObject({
      events: [{ sequence: 1 }, { sequence: 2 }],
      nextCursor: 2,
      acknowledgedCursor: 0,
      hasMore: true,
    });
    expect(journal.acknowledge(2)).toBe(2);
    expect(readdirSync(directory).filter((name) => name.endsWith(".ndjson"))).toHaveLength(1);

    journal = new SegmentedCompanionPiJournal({ directory, segmentBytes: 180 });
    expect(journal.tailCursor).toBe(3);
    expect(journal.acknowledgedCursor).toBe(2);
    expect(journal.read(0)).toMatchObject({
      events: [{ sequence: 3 }],
      nextCursor: 3,
      acknowledgedCursor: 2,
      hasMore: false,
    });
    expect(journal.append({
      invocationId: "invocation-1",
      attemptId: "attempt-exit",
      kind: "pi_process_exit",
      exit: { code: 86, signal: null },
    }).sequence).toBe(4);
    expect(() => journal.acknowledge(5)).toThrow("beyond the journal tail");
  });

  it("recovers by discarding only an incomplete journal tail", () => {
    const directory = temporaryDirectory("pi-journal-tail-");
    let journal = new SegmentedCompanionPiJournal({ directory });
    journal.append({
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      kind: "pi_event",
      event: { type: "agent_start" },
    });
    const segment = readdirSync(directory).find((name) => name.endsWith(".ndjson"));
    expect(segment).toBeDefined();
    const path = join(directory, segment!);
    const complete = readFileSync(path, "utf8");
    appendFileSync(path, '{"sequence":2,"secret":"partial-tail"');

    journal = new SegmentedCompanionPiJournal({ directory });
    expect(journal.tailCursor).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(complete);
  });

  it("retires unacknowledged records when a new systemd invocation takes ownership", () => {
    const directory = temporaryDirectory("pi-journal-invocation-");
    const journal = new SegmentedCompanionPiJournal({ directory });
    journal.append({
      invocationId: "invocation-old",
      attemptId: "attempt-old",
      kind: "pi_event",
      event: { type: "agent_start" },
    });

    new CompanionPiBroker({
      invocationId: "invocation-new",
      journal,
      transport: new FakePiTransport({}),
    });

    expect(journal.acknowledgedCursor).toBe(journal.tailCursor);
    expect(journal.read(0).events).toEqual([]);
  });

  it("bounds pages by encoded bytes without skipping a monotonic record", () => {
    const directory = temporaryDirectory("pi-journal-page-");
    const journal = new SegmentedCompanionPiJournal({ directory, segmentBytes: 512 * 1024 });
    for (let index = 0; index < 3; index += 1) {
      journal.append({
        invocationId: "invocation-1",
        attemptId: "attempt-1",
        kind: "pi_event",
        event: { type: "message_update", delta: "x".repeat(120 * 1024), index },
      });
    }
    const first = journal.read(0);
    expect(first.events.map((event) => event.sequence)).toEqual([1]);
    expect(first).toMatchObject({ nextCursor: 1, hasMore: true });
    const second = journal.read(first.nextCursor);
    expect(second.events.map((event) => event.sequence)).toEqual([2]);
    expect(() => journal.read(4)).toThrow("beyond the journal tail");
  });

  it("does not publish an acknowledgement in memory when its atomic write fails", () => {
    const directory = temporaryDirectory("pi-journal-ack-failure-");
    const journal = new SegmentedCompanionPiJournal({ directory });
    journal.append({
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      kind: "pi_event",
      event: { type: "agent_start" },
    });
    const ackPath = join(directory, "ack.cursor");
    rmSync(ackPath);
    mkdirSync(ackPath);

    expect(() => journal.acknowledge(1)).toThrow();
    expect(journal.acknowledgedCursor).toBe(0);
    expect(journal.read(0).events.map((event) => event.sequence)).toEqual([1]);

    rmSync(ackPath, { recursive: true });
    expect(journal.acknowledge(1)).toBe(1);
  });
});

describe("CompanionPiBroker", () => {
  it("correlates broker identity with Pi model input capabilities", async () => {
    const harness = brokerHarness();

    await expect(harness.broker.command({
      id: "control-runtime-state",
      type: "runtime_state",
    })).resolves.toMatchObject({
      id: "control-runtime-state",
      success: true,
      data: {
        invocationId: "invocation-1",
        activeAttemptId: null,
        tailCursor: 0,
        acknowledgedCursor: 0,
        modelInput: ["text", "image"],
      },
    });
    expect(harness.transport.requests).toEqual([
      expect.objectContaining({ type: "get_state" }),
    ]);
  });

  it("preflights idle state, omits streamingBehavior, and binds events through settlement", async () => {
    const harness = brokerHarness();

    const response = await harness.broker.command({
      id: "control-prompt-1",
      type: "prompt",
      attemptId: "attempt-1",
      message: "Do the work",
    });
    expect(response).toMatchObject({
      id: "control-prompt-1",
      success: true,
      data: { attemptId: "attempt-1", piAcknowledged: true },
    });
    expect(harness.transport.requests.map((request) => request.type)).toEqual(["get_state", "prompt"]);
    expect(harness.transport.requests[1]).toEqual(expect.objectContaining({
      type: "prompt",
      message: "Do the work",
    }));
    expect(harness.transport.requests[1]).not.toHaveProperty("streamingBehavior");
    expect(harness.broker.activeAttemptId).toBe("attempt-1");

    harness.broker.acceptPiRecord({ type: "agent_start" });
    harness.broker.acceptPiRecord({ type: "future_event", secret: "ignored" });
    harness.broker.acceptPiRecord({ type: "agent_settled", futureShape: true });
    expect(harness.broker.activeAttemptId).toBe("attempt-1");
    harness.broker.acceptPiRecord({ type: "agent_settled" });
    expect(harness.broker.activeAttemptId).toBeNull();
    expect(harness.journal.read(0).events).toEqual([
      expect.objectContaining({ sequence: 1, attemptId: "attempt-1", event: { type: "agent_start" } }),
      expect.objectContaining({ sequence: 2, attemptId: "attempt-1", event: { type: "agent_settled" } }),
    ]);
    expect(harness.journal.counters.unknownEvents).toBe(2);
  });

  it("aborts the active attempt and clears the binding on a positive ACK", async () => {
    const harness = brokerHarness();
    await harness.broker.command({
      id: "control-prompt-1",
      type: "prompt",
      attemptId: "attempt-1",
      message: "Do the work",
    });
    expect(harness.broker.activeAttemptId).toBe("attempt-1");

    const aborted = await harness.broker.command({
      id: "control-abort-1",
      type: "abort",
      attemptId: "attempt-1",
    });
    expect(aborted).toMatchObject({
      id: "control-abort-1",
      success: true,
      data: { aborted: true, attemptId: "attempt-1" },
    });
    expect(harness.transport.requests.map((request) => request.type)).toEqual([
      "get_state",
      "prompt",
      "abort",
    ]);
    expect(harness.broker.activeAttemptId).toBeNull();
  });

  it("binds the attempt before writing prompt so events racing its ACK stay correlated", async () => {
    const directory = temporaryDirectory("pi-broker-racing-ack-");
    const journal = new SegmentedCompanionPiJournal({ directory });
    let broker!: CompanionPiBroker;
    const transport: CompanionPiRpcTransport = {
      async request(command) {
        if (command.type === "get_state") {
          return {
            id: command.id,
            type: "response",
            command: "get_state",
            success: true,
            data: {
              isStreaming: false,
              isCompacting: false,
              pendingMessageCount: 0,
              model: { input: ["text"] },
            },
          };
        }
        broker.acceptPiRecord({ type: "agent_start" });
        return { id: command.id, type: "response", command: "prompt", success: true };
      },
      async send() {},
    };
    broker = new CompanionPiBroker({ invocationId: "invocation-race", journal, transport });
    const response = await broker.command({
      id: "control-racing-ack",
      type: "prompt",
      attemptId: "attempt-racing-ack",
      message: "Race",
    });
    expect(response).toMatchObject({
      success: true,
      data: { initialCursor: 0 },
    });
    expect(journal.read(0).events).toEqual([
      expect.objectContaining({ attemptId: "attempt-racing-ack", event: { type: "agent_start" } }),
    ]);
  });

  it("refuses a busy or queued Pi before writing a prompt", async () => {
    const harness = brokerHarness({ isStreaming: true, pendingMessageCount: 1 });
    const response = await harness.broker.command({
      id: "control-prompt-busy",
      type: "prompt",
      attemptId: "attempt-busy",
      message: "Must not queue",
    });
    expect(response).toMatchObject({
      success: false,
      error: { code: "pi_not_idle", ambiguous: false },
    });
    expect(harness.transport.requests.map((request) => request.type)).toEqual(["get_state"]);
    expect(harness.broker.activeAttemptId).toBeNull();
  });

  it("keeps an attempt bound when prompt acknowledgement is ambiguous and never auto-replays it", async () => {
    const harness = brokerHarness();
    harness.transport.promptFailure = true;
    const first = await harness.broker.command({
      id: "control-prompt-ambiguous",
      type: "prompt",
      attemptId: "attempt-ambiguous",
      message: "May have run",
    });
    expect(first).toMatchObject({
      success: false,
      error: { code: "pi_ack_ambiguous", ambiguous: true },
    });
    expect(harness.broker.activeAttemptId).toBe("attempt-ambiguous");

    const second = await harness.broker.command({
      id: "control-prompt-second",
      type: "prompt",
      attemptId: "attempt-second",
      message: "Must remain blocked",
    });
    expect(second).toMatchObject({ success: false, error: { code: "attempt_active" } });
    expect(harness.transport.requests.filter((request) => request.type === "prompt")).toHaveLength(1);
  });

  it("treats a correlated but malformed prompt ACK as ambiguous rather than proven negative", async () => {
    const harness = brokerHarness();
    harness.transport.promptResponseSuccess = "invalid";
    const response = await harness.broker.command({
      id: "control-prompt-malformed-ack",
      type: "prompt",
      attemptId: "attempt-malformed-ack",
      message: "May have executed",
    });
    expect(response).toMatchObject({
      success: false,
      error: { code: "pi_ack_ambiguous", ambiguous: true },
    });
    expect(harness.broker.activeAttemptId).toBe("attempt-malformed-ack");
  });

  it("clears the binding only for a correlated explicit negative prompt ACK", async () => {
    const harness = brokerHarness();
    harness.transport.promptResponseSuccess = false;
    const refused = await harness.broker.command({
      id: "control-prompt-refused",
      type: "prompt",
      attemptId: "attempt-refused",
      message: "Refuse",
    });
    expect(refused).toMatchObject({
      success: false,
      error: { code: "pi_prompt_refused", ambiguous: false },
    });
    expect(harness.broker.activeAttemptId).toBeNull();

    harness.transport.promptResponseSuccess = true;
    const retry = await harness.broker.command({
      id: "control-prompt-after-refusal",
      type: "prompt",
      attemptId: "attempt-after-refusal",
      message: "Retry safely",
    });
    expect(retry).toMatchObject({ success: true });
  });

  it("atomically delivers a decision through the sole active binding without requiring attemptId", async () => {
    const harness = brokerHarness();
    await harness.broker.command({
      id: "control-prompt",
      type: "prompt",
      attemptId: "attempt-question",
      message: "Ask",
    });
    const response = await harness.broker.command({
      id: "control-answer",
      type: "extension_ui_response",
      response: { type: "extension_ui_response", id: "ui-1", value: "Continue" },
    });
    expect(response).toMatchObject({
      success: true,
      data: { attemptId: "attempt-question", delivered: true },
    });
    expect(harness.transport.sent).toEqual([
      { type: "extension_ui_response", id: "ui-1", value: "Continue" },
    ]);
  });

  it.each([
    ["negative read cursor", { type: "read_events", after: -1 }],
    ["fractional read cursor", { type: "read_events", after: 0.5 }],
    ["string read cursor", { type: "read_events", after: "0" }],
    ["read cursor beyond tail", { type: "read_events", after: 1 }],
    ["zero read limit", { type: "read_events", after: 0, limit: 0 }],
    ["fractional read limit", { type: "read_events", after: 0, limit: 1.5 }],
    ["read limit above maximum", { type: "read_events", after: 0, limit: 257 }],
    ["negative acknowledgement", { type: "ack_events", through: -1 }],
    ["string acknowledgement", { type: "ack_events", through: "0" }],
    ["acknowledgement beyond tail", { type: "ack_events", through: 1 }],
  ] as const)("classifies %s as an unambiguous invalid command", async (_name, fields) => {
    const harness = brokerHarness();
    const response = await harness.broker.command({ id: "invalid-control", ...fields });

    expect(response).toMatchObject({
      id: "invalid-control",
      success: false,
      error: { code: "invalid_command", ambiguous: false },
    });
  });

  it("keeps journal persistence failures classified as broker unavailable", async () => {
    const harness = brokerHarness();
    harness.journal.append({
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      kind: "pi_event",
      event: { type: "agent_start" },
    });
    const acknowledgementPath = join(harness.directory, "ack.cursor");
    rmSync(acknowledgementPath);
    mkdirSync(acknowledgementPath);

    const response = await harness.broker.command({
      id: "ack-io-failure",
      type: "ack_events",
      through: 1,
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: "broker_unavailable", ambiguous: false },
    });
  });

  it("marks a failed one-way decision send ambiguous and keeps the active binding", async () => {
    const harness = brokerHarness();
    await harness.broker.command({
      id: "control-prompt",
      type: "prompt",
      attemptId: "attempt-question",
      message: "Ask",
    });
    harness.transport.sendFailure = true;

    const response = await harness.broker.command({
      id: "control-answer-lost",
      type: "extension_ui_response",
      response: { type: "extension_ui_response", id: "ui-1", value: "Continue" },
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: "decision_delivery_ambiguous", ambiguous: true },
    });
    expect(harness.broker.activeAttemptId).toBe("attempt-question");
    expect(harness.transport.sent).toHaveLength(1);
  });

  it("records process exit separately with the active attempt and clears the binding", async () => {
    const harness = brokerHarness();
    await harness.broker.command({
      id: "control-prompt",
      type: "prompt",
      attemptId: "attempt-crash",
      message: "Crash",
    });
    harness.broker.acceptPiProcessExit({ code: 86, signal: null });
    expect(harness.broker.activeAttemptId).toBeNull();
    expect(harness.journal.read(0).events).toEqual([
      expect.objectContaining({
        kind: "pi_process_exit",
        attemptId: "attempt-crash",
        exit: { code: 86, signal: null },
      }),
    ]);
  });

  it("counts a process exit after settlement without writing an unbound journal record", async () => {
    const harness = brokerHarness();
    await harness.broker.command({
      id: "control-prompt",
      type: "prompt",
      attemptId: "attempt-settled",
      message: "Finish",
    });
    harness.broker.acceptPiRecord({ type: "agent_settled" });
    harness.broker.acceptPiProcessExit({ code: 0, signal: null });

    expect(harness.journal.read(0).events).toHaveLength(1);
    expect(harness.journal.counters.unboundEvents).toBe(1);
  });

  it("counts malformed and oversized Pi lines without writing their raw content", async () => {
    const harness = brokerHarness();
    await harness.broker.command({
      id: "control-prompt",
      type: "prompt",
      attemptId: "attempt-parser",
      message: "Parse",
    });
    const decoder = createCompanionPiOutputDecoder({
      broker: harness.broker,
      journal: harness.journal,
      maxLineBytes: 64,
    });
    const secret = "provider-token-must-not-survive";
    decoder.push(Buffer.from(`{"broken":"${secret}"\n`));
    decoder.push(Buffer.from(`{"type":"message_update","value":"${secret}${"x".repeat(200)}"}\n`));
    decoder.push(Buffer.from('{"type":"agent_settled"}\n'));
    decoder.finish();

    expect(harness.journal.counters).toMatchObject({ malformedLines: 1, oversizedLines: 1 });
    expect(harness.journal.read(0).events).toEqual([
      expect.objectContaining({ event: { type: "agent_settled" } }),
    ]);
    const persisted = readdirSync(harness.directory)
      .map((name) => readFileSync(join(harness.directory, name), "utf8"))
      .join("\n");
    expect(persisted).not.toContain(secret);
  });
});

describe("layout-14 broker socket", () => {
  it("closes and unlinks a listening server when owner-only chmod fails", async () => {
    const socketPath = join(temporaryDirectory("pi-socket-chmod-failure-"), "broker.sock");
    const server = createServer();
    await expect(listenOwnerOnlyCompanionPiSocket(server, socketPath, () => {
      throw new Error("synthetic chmod failure");
    })).rejects.toThrow("synthetic chmod failure");
    expect(server.listening).toBe(false);
    expect(() => statSync(socketPath)).toThrow();
  });

  it("uses mode 0600 and returns exactly one correlated LF response before EOF", async () => {
    const harness = brokerHarness();
    const socketPath = join(temporaryDirectory("pi-socket-"), "broker.sock");
    const server = await startCompanionPiBrokerSocket({ broker: harness.broker, socketPath });
    try {
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const response = await sendCompanionPiBrokerCommand({
        socketPath,
        command: { id: "socket-state-1", type: "broker_state" },
      });
      expect(response).toMatchObject({ id: "socket-state-1", success: true });
      const raw = await rawSocketRequest(socketPath, '{"id":"socket-state-2","type":"broker_state"}\n');
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(raw)).toMatchObject({ id: "socket-state-2", success: true });
    } finally {
      await closeServer(server);
    }
  });

  it("accepts only the first framed command and never executes trailing or post-fault input", async () => {
    const harness = brokerHarness();
    const socketPath = join(temporaryDirectory("pi-socket-one-shot-"), "broker.sock");
    const server = await startCompanionPiBrokerSocket({ broker: harness.broker, socketPath });
    try {
      const twoCommands = await rawSocketRequest(socketPath, [
        '{"id":"first","type":"broker_state"}',
        '{"id":"second","type":"prompt","attemptId":"attempt-smuggled","message":"ignore"}',
        "",
      ].join("\n"));
      expect(JSON.parse(twoCommands)).toMatchObject({ id: "first", success: true });
      expect(harness.transport.requests).toEqual([]);

      const postFault = await rawSocketRequest(socketPath, [
        '{"id":"broken",',
        '{"id":"third","type":"prompt","attemptId":"attempt-after-fault","message":"ignore"}',
        "",
      ].join("\n"));
      expect(JSON.parse(postFault)).toMatchObject({
        id: null,
        success: false,
        error: { code: "invalid_command" },
      });
      expect(harness.transport.requests).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });
});

describe("normalizePiModelCatalog", () => {
  it("preserves Pi input capabilities while dropping invalid catalog entries", () => {
    expect(normalizePiModelCatalog([
      {
        id: " vision-model ",
        provider: "example",
        input: ["text", "image", "image", 42],
        contextWindow: 32_000,
      },
      { provider: "missing-id", input: ["text"] },
    ])).toEqual([
      {
        id: "vision-model",
        provider: "example",
        input: ["text", "image"],
        contextWindow: 32_000,
      },
    ]);
  });
});

class FakePiTransport implements CompanionPiRpcTransport {
  readonly requests: PiJsonObject[] = [];
  readonly sent: PiJsonObject[] = [];
  state: PiJsonObject;
  promptFailure = false;
  sendFailure = false;
  promptResponseSuccess: unknown = true;

  constructor(state: PiJsonObject) {
    this.state = state;
  }

  async request(command: PiJsonObject): Promise<PiJsonObject> {
    this.requests.push(command);
    if (command.type === "get_state") {
      return {
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: this.state,
      };
    }
    if (command.type === "prompt") {
      if (this.promptFailure) throw new Error("synthetic lost acknowledgement");
      return {
        id: command.id,
        type: "response",
        command: "prompt",
        success: this.promptResponseSuccess,
      };
    }
    if (command.type === "abort") {
      return {
        id: command.id,
        type: "response",
        command: "abort",
        success: true,
      };
    }
    throw new Error("unexpected Pi request");
  }

  async send(command: PiJsonObject): Promise<void> {
    this.sent.push(command);
    if (this.sendFailure) throw new Error("synthetic lost decision delivery");
  }
}

function brokerHarness(state: Partial<PiJsonObject> = {}): {
  directory: string;
  journal: SegmentedCompanionPiJournal;
  transport: FakePiTransport;
  broker: CompanionPiBroker;
} {
  const directory = temporaryDirectory("pi-broker-");
  const journal = new SegmentedCompanionPiJournal({ directory, segmentBytes: 512 });
  const transport = new FakePiTransport({
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    model: { id: "model-1", input: ["text", "image"] },
    ...state,
  });
  const broker = new CompanionPiBroker({
    invocationId: "invocation-1",
    journal,
    transport,
  });
  return { directory, journal, transport, broker };
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function rawSocketRequest(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.on("connect", () => socket.end(line));
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(output));
    socket.on("error", reject);
  });
}

function closeServer(server: import("node:net").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
