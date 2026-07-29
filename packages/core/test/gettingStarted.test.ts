/**
 * Product promise:
 * Guided onboarding always resumes at the first unconfirmed step and completes only after all three.
 *
 * Regression caught:
 * Reordering or weakening the completion predicate could skip a review or falsely hide the checklist.
 *
 * Why this test is unit-level:
 * Step ordering and completion are pure rules; transaction and RLS behavior belong to integration.
 *
 * Failure proof:
 * Returning a later missing step or allowing any null timestamp to count as complete fails the matrix.
 */
import { describe, expect, it } from "vitest";
import {
  firstIncompleteGettingStartedStep,
  isGettingStartedComplete,
} from "../src/gettingStarted";

describe("getting-started progress helpers", () => {
  const done = new Date("2026-07-28T12:00:00.000Z");

  it.each([
    [{ companionInstalledAt: null, localReviewedAt: null, orgReviewedAt: null }, "companion_install"],
    [{ companionInstalledAt: done, localReviewedAt: null, orgReviewedAt: null }, "local_review"],
    [{ companionInstalledAt: done, localReviewedAt: done, orgReviewedAt: null }, "org_review"],
    [{ companionInstalledAt: done, localReviewedAt: done, orgReviewedAt: done }, null],
  ] as const)("resumes from the first incomplete step", (state, expected) => {
    expect(firstIncompleteGettingStartedStep(state)).toBe(expected);
  });

  it("requires every step before completion", () => {
    expect(isGettingStartedComplete({
      companionInstalledAt: done,
      localReviewedAt: done,
      orgReviewedAt: done,
    })).toBe(true);
    expect(isGettingStartedComplete({
      companionInstalledAt: done,
      localReviewedAt: null,
      orgReviewedAt: done,
    })).toBe(false);
  });
});
