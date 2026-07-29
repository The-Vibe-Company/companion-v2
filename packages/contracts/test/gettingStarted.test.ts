/**
 * Product promise:
 * Getting-started progress has one closed step vocabulary and never accepts malformed state.
 *
 * Regression caught:
 * A route or client could drift to a different step name or treat an incomplete timestamp as done.
 *
 * Why this test is unit-level:
 * The risk is deterministic contract validation with no persistence or transport behavior.
 *
 * Failure proof:
 * Removing a required state field or widening the step enum makes these rejection assertions fail.
 */
import { describe, expect, it } from "vitest";
import {
  gettingStartedStateSchema,
  gettingStartedStepSchema,
  localSkillPromptsSchema,
  recordGettingStartedStepInputSchema,
} from "../src";

describe("getting-started contracts", () => {
  it("accepts only the three supported monotonic steps", () => {
    expect(gettingStartedStepSchema.options).toEqual([
      "companion_install",
      "local_review",
      "org_review",
    ]);
    expect(recordGettingStartedStepInputSchema.parse({
      step: "local_review",
      agent: " Codex ",
    })).toEqual({ step: "local_review", agent: "Codex" });
    expect(() => recordGettingStartedStepInputSchema.parse({ step: "dismissed" })).toThrow();
  });

  it("validates the snake-case state response", () => {
    const state = gettingStartedStateSchema.parse({
      companion_installed_at: "2026-07-28T12:00:00.000Z",
      local_reviewed_at: null,
      org_reviewed_at: null,
      completed_at: null,
      dismissed_at: null,
      completed: false,
      first_incomplete_step: "local_review",
    });
    expect(state.first_incomplete_step).toBe("local_review");
    expect(() => gettingStartedStateSchema.parse({
      ...state,
      companion_installed_at: "not-a-date",
    })).toThrow();
  });

  it("keeps onboarding prompts additive to the existing prompt set", () => {
    expect(localSkillPromptsSchema.parse({
      install: "install",
      update: "update",
      use: "use",
      onboarding: "onboard",
      resume: "resume",
      ignored_by_older_consumers: true,
    })).toMatchObject({ onboarding: "onboard", resume: "resume" });
  });
});
