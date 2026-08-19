import { describe, expect, it } from "vitest";
import { ROUTINE_FIRE_NAMESPACE, routineFireMessageId } from "../src/companionRoutineFireId";
import { computeNextFireAt, validateRoutineSchedule } from "../src/companionRoutines";

describe("Companion routine schedules", () => {
  it("rejects unknown timezones and malformed cron", () => {
    expect(validateRoutineSchedule({ cron: "0 9 * * *", timezone: "Not/AZone" })).toEqual({
      ok: false,
      code: "invalid_timezone",
    });
    expect(validateRoutineSchedule({ cron: "not a cron", timezone: "UTC" }).ok).toBe(false);
  });

  it("rejects expressions that fire more often than every five minutes", () => {
    expect(validateRoutineSchedule({ cron: "* * * * *", timezone: "UTC" })).toEqual({
      ok: false,
      code: "interval_too_short",
    });
  });

  it("accepts a weekday morning schedule and returns a strictly future next fire", () => {
    const after = new Date("2026-08-19T12:00:00.000Z");
    const result = validateRoutineSchedule({
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      after,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextFireAt.getTime()).toBeGreaterThan(after.getTime());
    expect(computeNextFireAt("0 9 * * 1-5", "UTC", after).getTime()).toBe(
      result.nextFireAt.getTime(),
    );
  });

  it("stamps a stable uuidv5 for the same routine and scheduled instant", () => {
    const scheduledFor = new Date("2026-08-19T09:00:00.000Z");
    const routineId = "11111111-1111-4111-8111-111111111111";
    const first = routineFireMessageId({ routineId, scheduledFor });
    const second = routineFireMessageId({ routineId, scheduledFor });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(routineFireMessageId({
      routineId,
      scheduledFor: new Date("2026-08-19T10:00:00.000Z"),
    })).not.toBe(first);
    expect(ROUTINE_FIRE_NAMESPACE).toMatch(/^[0-9a-f-]{36}$/);
  });
});
