import { describe, expect, it } from "vitest";
import type { SkillRunDetail } from "@companion/contracts";
import {
  canReactivateRun,
  canUseRunComposer,
  isStaleRunDetail,
  shouldRestartPollingAfterPromptFailure,
} from "./reactivation";

function detail(overrides: Partial<SkillRunDetail> = {}): SkillRunDetail {
  return {
    id: "run-1",
    skill_slug: "demo",
    skill_version: "1.0.0",
    model: "openai/gpt-5",
    prompt_excerpt: "Hello",
    prompt: "Hello",
    status: "frozen",
    status_detail: null,
    created_at: "2026-07-15T00:00:00.000Z",
    last_active_at: null,
    transcript: [],
    warnings: [],
    transcript_event_sequence: 12,
    activation_revision: 0,
    reactivatable_until: "2026-07-22T00:00:00.000Z",
    can_reactivate: true,
    attachments: [],
    pending_prompts: [],
    artifacts: [],
    ...overrides,
  };
}

describe("run reactivation UI state", () => {
  it("enables only retained canceled or frozen sessions before expiry", () => {
    const now = Date.parse("2026-07-16T00:00:00.000Z");
    expect(canReactivateRun(detail(), now)).toBe(true);
    expect(canReactivateRun(detail({ status: "canceled" }), now)).toBe(true);
    expect(canReactivateRun(detail({ status: "error" }), now)).toBe(false);
    expect(canReactivateRun(detail(), Date.parse("2026-07-23T00:00:00.000Z"))).toBe(false);
  });

  it("accepts a newer activation with the same transcript cursor but rejects stale fetches", () => {
    const terminal = detail();
    expect(isStaleRunDetail(terminal, detail({ status: "queued", phase: "queued" }))).toBe(true);
    expect(isStaleRunDetail(terminal, detail({
      status: "queued",
      phase: "queued",
      activation_revision: 1,
    }))).toBe(false);
    expect(isStaleRunDetail(detail({ activation_revision: 1 }), terminal)).toBe(true);
  });

  it("restarts polling when a terminal reactivation acknowledgement is lost", () => {
    expect(shouldRestartPollingAfterPromptFailure("canceled")).toBe(true);
    expect(shouldRestartPollingAfterPromptFailure("frozen")).toBe(true);
    expect(shouldRestartPollingAfterPromptFailure("running")).toBe(false);
  });

  it("keeps the text and attachment composer available for retained terminal sessions", () => {
    expect(canUseRunComposer("running", true, false)).toBe(true);
    expect(canUseRunComposer("frozen", false, true)).toBe(true);
    expect(canUseRunComposer("canceled", false, true)).toBe(true);
    expect(canUseRunComposer("frozen", false, false)).toBe(false);
    expect(canUseRunComposer("error", false, true)).toBe(false);
  });
});
