import { describe, expect, it } from "vitest";
import {
  PostgresRuntimeStore,
  RuntimeCredentialSnapshotChangedError,
  RuntimeStoreIndeterminateError,
  type RuntimeSqlClient,
} from "./store";
import type { LeaseFence } from "./types";
import {
  ATTEMPT_ID,
  CLAIM_TOKEN,
  COMPANION_ID,
  MESSAGE_EVENT_ID,
  ORG_ID,
  TURN_ID,
} from "./test/fixtures";

class RecordingSql implements RuntimeSqlClient {
  readonly calls: Array<{ query: string; parameters: unknown[] }> = [];
  rows: Record<string, unknown>[] = [];

  async unsafe<T extends Record<string, unknown>[]>(
    query: string,
    parameters: unknown[] = [],
  ): Promise<T> {
    this.calls.push({ query, parameters });
    return this.rows as T;
  }
}

const fence: LeaseFence = {
  orgId: ORG_ID,
  companionId: COMPANION_ID,
  claimToken: CLAIM_TOKEN,
  claimEpoch: 3n,
  gateEpoch: 4n,
  executorId: "executor-1",
  workKind: "operation",
  workId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

describe("PostgresRuntimeStore", () => {
  it("uses the exact fenced parameter order for duplicate cleanup checkpoints", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      box_id: "bx_2345678a",
      status: "delete_requested",
      provider_operation_id: "delete-op",
      checkpoint_sequence: "8",
    }];
    const store = new PostgresRuntimeStore(sql);

    await store.checkpointDuplicateCleanup(fence, {
      boxId: "bx_2345678a",
      expectedSequence: 7n,
      nextStatus: "delete_requested",
      providerOperationId: "delete-op",
    });

    expect(sql.calls[0]?.query).toContain("public.companion_runtime_checkpoint_duplicate_cleanup(");
    expect(sql.calls[0]?.parameters).toEqual([
      ORG_ID,
      COMPANION_ID,
      CLAIM_TOKEN,
      "3",
      "4",
      "executor-1",
      "operation",
      fence.workId,
      "bx_2345678a",
      "7",
      "delete_requested",
      "delete-op",
    ]);
  });

  it("decodes the durable attempt/output proof from the material definer", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      message_event_id: MESSAGE_EVENT_ID,
      prompt_text: "hello",
      decision_request_kind: null,
      decision_response_payload: null,
      provider_material: [],
      skill_material: [],
      mcp_material: [],
      model_input: null,
      has_visible_output: true,
      attachments: [{
        id: "3f1d8a52-0c47-4e3b-9a19-7bd0c5e4a611",
        storage_key: "companion-attachments/org/companion/message/0-" + "a".repeat(64),
        content_type: "image/png",
        byte_size: 2048,
        sha256: "a".repeat(64),
        filename: "chart.png",
        position: 0,
      }],
      credential_snapshot_matches: true,
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.getMaterial({ ...fence, workKind: "attempt", workId: ATTEMPT_ID }, 30);

    expect(result).toMatchObject({
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      hasVisibleOutput: true,
      attachments: [{ filename: "chart.png", contentType: "image/png", position: 0 }],
    });
    expect(sql.calls[0]?.query).toContain("public.companion_runtime_get_material(");
    expect(sql.calls[0]?.query).toContain("attempt_id");
    expect(sql.calls[0]?.query).toContain("has_visible_output");
    expect(sql.calls[0]?.query).toContain("attachments");
  });

  it("refuses staging material whose names, digests, or ordering drifted from the contract", async () => {
    const base = {
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      message_event_id: MESSAGE_EVENT_ID,
      prompt_text: "hello",
      decision_request_kind: null,
      decision_response_payload: null,
      provider_material: [],
      skill_material: [],
      mcp_material: [],
      model_input: null,
      has_visible_output: true,
      credential_snapshot_matches: true,
    };
    const attachment = {
      id: "3f1d8a52-0c47-4e3b-9a19-7bd0c5e4a611",
      storage_key: "companion-attachments/org/companion/message/0-" + "a".repeat(64),
      content_type: "image/png",
      byte_size: 2048,
      sha256: "a".repeat(64),
      filename: "chart.png",
      position: 0,
    };
    for (const drifted of [
      { ...attachment, filename: "../escape.png" },
      { ...attachment, sha256: "not-a-digest" },
      { ...attachment, content_type: "application/zip" },
      { ...attachment, byte_size: 20 * 1024 * 1024 },
      { ...attachment, position: 3 },
    ]) {
      const sql = new RecordingSql();
      sql.rows = [{ ...base, attachments: [drifted] }];
      const store = new PostgresRuntimeStore(sql);
      await expect(
        store.getMaterial({ ...fence, workKind: "attempt", workId: ATTEMPT_ID }, 30),
      ).rejects.toThrow();
    }
  });

  it("hands the harvested outputs to the definer as a jsonb array, not a JSON string", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ recorded: 1, has_visible_output: true }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.recordAttemptOutputs(
      { ...fence, workKind: "attempt", workId: ATTEMPT_ID },
      {
        attachments: [{
          storageKey: `companion-attachments/org/companion/outputs/attempt/0-${"d".repeat(64)}`,
          contentType: "image/png",
          byteSize: 512,
          sha256: "d".repeat(64),
          filename: "plot.png",
        }],
        activityAt: new Date("2026-08-18T12:00:00.000Z"),
      },
    );

    expect(result).toEqual({ recorded: 1, hasVisibleOutput: true });
    expect(sql.calls[0]?.query).toContain("public.companion_runtime_record_attempt_outputs(");
    // Pre-stringifying arrives as a JSON *string*, whose jsonb_typeof is not `array`, and the
    // definer refuses it. The driver serializes the array itself.
    const attachments = sql.calls[0]?.parameters?.[8];
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments).toEqual([expect.objectContaining({
      filename: "plot.png",
      content_type: "image/png",
      byte_size: 512,
      position: 0,
    })]);
  });

  it("returns null when the harvest fence is stale rather than inventing a result", async () => {
    const sql = new RecordingSql();
    sql.rows = [];
    const store = new PostgresRuntimeStore(sql);

    await expect(store.recordAttemptOutputs(
      { ...fence, workKind: "attempt", workId: ATTEMPT_ID },
      { attachments: [], activityAt: new Date("2026-08-18T12:00:00.000Z") },
    )).resolves.toBeNull();
  });

  it("accepts a config_proposal decision kind from the material definer", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      message_event_id: null,
      prompt_text: null,
      decision_request_kind: "config_proposal",
      decision_response_payload: { type: "extension_ui_response", id: "config-1", confirmed: true },
      provider_material: [],
      skill_material: [],
      mcp_material: [],
      model_input: null,
      has_visible_output: true,
      credential_snapshot_matches: true,
      attachments: [],
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.getMaterial({ ...fence, workKind: "decision", workId: ATTEMPT_ID }, 30);

    expect(result).toMatchObject({
      decisionRequestKind: "config_proposal",
      decisionResponsePayload: {
        type: "extension_ui_response",
        id: "config-1",
        confirmed: true,
      },
    });
  });

  it("rejects material whose dispatch-time credential snapshot changed", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ credential_snapshot_matches: false }];
    const store = new PostgresRuntimeStore(sql);

    await expect(store.getMaterial({ ...fence, workKind: "attempt", workId: ATTEMPT_ID }, 30))
      .rejects.toBeInstanceOf(RuntimeCredentialSnapshotChangedError);
  });

  it("reads terminal output proof without fetching credential material", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      checkpoint: "agent_settled",
      event_cursor: "42",
      has_visible_output: true,
      outputs_harvested: false,
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.getAttemptTerminalProjection({
      ...fence,
      workKind: "attempt",
      workId: ATTEMPT_ID,
    });

    expect(result).toEqual({
      checkpoint: "agent_settled",
      eventCursor: 42n,
      hasVisibleOutput: true,
      outputsHarvested: false,
    });
    expect(sql.calls[0]?.query).toContain(
      "public.companion_runtime_get_attempt_terminal_projection(",
    );
    expect(sql.calls[0]?.query).not.toContain("provider_material");
  });

  it("passes structured event batches to postgres.js for one jsonb serialization", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      checkpoint_sequence: "3",
      event_cursor: "10",
      has_visible_output: true,
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.projectEventBatch(
      { ...fence, workKind: "attempt", workId: ATTEMPT_ID },
      {
        expectedSequence: 2n,
        piInvocationId: "pi-invocation-1",
        events: [{
          sequence: 10n,
          type: "assistant",
          entry_key: "assistant:10",
          content: "hello",
        }],
        throughCursor: 10n,
        unknownEventCount: 0,
        malformedEventCount: 0,
        oversizedEventCount: 0,
      },
    );

    expect(result).toEqual({
      checkpointSequence: 3n,
      eventCursor: 10n,
      hasVisibleOutput: true,
    });
    expect(sql.calls[0]?.parameters[10]).toEqual([{
      sequence: "10",
      type: "assistant",
      entry_key: "assistant:10",
      content: "hello",
    }]);
    expect(Array.isArray(sql.calls[0]?.parameters[10])).toBe(true);
  });

  it("maps a lost response from a mutating definer to an indeterminate outcome", async () => {
    const sql: RuntimeSqlClient = {
      unsafe: async () => {
        throw Object.assign(new Error("connection closed after command"), {
          code: "CONNECTION_CLOSED",
        });
      },
    };
    const store = new PostgresRuntimeStore(sql);

    await expect(store.settle(fence, { terminalStatus: "succeeded" }))
      .rejects.toMatchObject({
        name: "RuntimeStoreIndeterminateError",
        cause: expect.objectContaining({ message: "connection closed after command" }),
      });
  });
});
