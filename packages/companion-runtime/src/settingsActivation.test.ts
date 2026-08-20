import { describe, expect, it } from "vitest";

import { activateRuntimeSettings } from "./settingsActivation";
import { TestClock } from "./test/fixtures";

describe("activateRuntimeSettings", () => {
  it("rejects a fresh idle Pi first observed after the durable deadline", async () => {
    const clock = new TestClock();
    let observations = 0;

    await expect(activateRuntimeSettings({
      expectedSettingsRevision: 2n,
      expectedSkillsRevision: 3,
      previousPiInvocationId: "pi-old",
      deadlineAt: new Date(clock.now().getTime() + 500),
      clock,
      signal: new AbortController().signal,
      stage: async () => ({
        diskLayoutVersion: 14,
        appliedSettingsRevision: 2n,
        appliedSkillsRevision: 3,
        materialExpiresAt: new Date("2026-08-16T18:00:00.000Z"),
      }),
      restartPi: async () => ({ state: "starting", invocationId: null }),
      observePi: async () => {
        observations += 1;
        return { state: "idle", invocationId: "pi-new" };
      },
    })).rejects.toMatchObject({ stableCode: "pi_restart_deadline_exceeded" });

    expect(clock.sleeps).toEqual([1_000]);
    expect(observations).toBe(1);
  });
});
