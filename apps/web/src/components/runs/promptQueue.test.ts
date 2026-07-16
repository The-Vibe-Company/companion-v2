import { describe, expect, it } from "vitest";
import type { RunPromptAccepted, SkillRunDetail } from "@companion/contracts";
import {
  foldPromptStatusDetail,
  mergeAcceptedPromptDetail,
  mergeStalePendingPrompts,
  newerPromptStatus,
  orderedPromptStatus,
} from "./promptQueue";

function detail(): SkillRunDetail {
  return {
    id: "run-1",
    skill_slug: "demo",
    skill_version: "1.0.0",
    model: "openai/gpt-5",
    prompt_excerpt: "Start",
    prompt: "Start",
    status: "running",
    status_detail: null,
    created_at: "2026-07-16T00:00:00.000Z",
    last_active_at: null,
    transcript: [],
    warnings: [],
    transcript_event_sequence: 1,
    activation_revision: 0,
    reactivatable_until: null,
    can_reactivate: false,
    attachments: [],
    artifacts: [],
    pending_prompts: [{
      id: "11111111-1111-4111-8111-111111111111",
      message_id: "message-1",
      ordinal: 1,
      kind: "follow_up",
      text: "Next",
      status: "processing",
      created_at: "2026-07-16T00:00:01.000Z",
      attachments: [],
    }],
  };
}

describe("mergeAcceptedPromptDetail", () => {
  it("does not let a late queued HTTP acknowledgement downgrade SSE processing state", () => {
    const acknowledgement: RunPromptAccepted = {
      accepted: true,
      prompt_id: "11111111-1111-4111-8111-111111111111",
      message_id: "message-1",
      ordinal: 1,
      status: "queued",
      attachments: [],
      reactivated: false,
    };
    const merged = mergeAcceptedPromptDetail(detail(), acknowledgement, "Next");
    expect(merged.pending_prompts).toMatchObject([{ status: "processing", message_id: "message-1" }]);
  });

  it("accepts an ordered processing-to-queued retry and removes a terminal prompt immediately", () => {
    const queued = foldPromptStatusDetail(detail(), {
      type: "prompt.status",
      prompt_id: "11111111-1111-4111-8111-111111111111",
      message_id: "message-1",
      ordinal: 1,
      status: "queued",
    });
    expect(queued.pending_prompts[0]?.status).toBe("queued");

    const processing = foldPromptStatusDetail(queued, {
      type: "prompt.status",
      prompt_id: "11111111-1111-4111-8111-111111111111",
      message_id: "message-1",
      ordinal: 1,
      status: "processing",
    });
    expect(processing.pending_prompts[0]?.status).toBe("processing");

    const terminal = foldPromptStatusDetail(processing, {
      type: "prompt.status",
      prompt_id: "11111111-1111-4111-8111-111111111111",
      message_id: "message-1",
      ordinal: 1,
      status: "canceled",
    });
    expect(terminal.pending_prompts).toEqual([]);
    expect(newerPromptStatus("canceled", "processing")).toBe("canceled");
    expect(orderedPromptStatus("processing", "queued")).toBe("queued");
  });

  it("protects local processing and terminal state from a detail request started earlier", () => {
    const staleQueued = {
      ...detail().pending_prompts[0]!,
      status: "queued" as const,
    };
    expect(mergeStalePendingPrompts(
      detail().pending_prompts,
      [staleQueued],
      new Map([[staleQueued.id, "processing" as const]]),
    )).toMatchObject([{ status: "processing" }]);
    expect(mergeStalePendingPrompts(
      [],
      [staleQueued],
      new Map([[staleQueued.id, "canceled" as const]]),
    )).toEqual([]);
  });
});
