import { afterEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  fire: vi.fn(),
  fail: vi.fn(),
  nextFire: vi.fn(),
  messageId: vi.fn(),
  enabled: vi.fn(),
  sanitize: vi.fn((message: string) => message),
}));
const dbMocks = vi.hoisted(() => ({ db: { kind: "db" } }));

vi.mock("@companion/core", () => ({
  claimDueCompanionRoutines: coreMocks.claim,
  fireCompanionRoutine: coreMocks.fire,
  failCompanionRoutineFire: coreMocks.fail,
  nextRoutineFireAt: coreMocks.nextFire,
  routineFireMessageId: coreMocks.messageId,
  companionsEnabled: coreMocks.enabled,
  sanitizeCompanionRuntimeError: coreMocks.sanitize,
}));
vi.mock("@companion/db", () => ({ db: dbMocks.db }));

import { startRoutineSupervisor } from "./routineSupervisor";

const claim = {
  orgId: "org-1",
  companionId: "companion-1",
  routineId: "routine-1",
  name: "Standup",
  prompt: "Write the standup",
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  scheduledFor: new Date("2026-08-19T09:00:00.000Z"),
};

describe("Companion routine supervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not start when Companions are flagged off", async () => {
    coreMocks.enabled.mockReturnValue(false);
    expect(await startRoutineSupervisor()).toBeNull();
    expect(coreMocks.claim).not.toHaveBeenCalled();
  });

  it("fires a claimed routine with a deterministic message id", async () => {
    coreMocks.enabled.mockReturnValue(true);
    coreMocks.claim.mockResolvedValue([claim]);
    coreMocks.nextFire.mockReturnValue(new Date("2026-08-20T09:00:00.000Z"));
    coreMocks.messageId.mockReturnValue("11111111-1111-5111-8111-111111111111");
    coreMocks.fire.mockResolvedValue({ outcome: "fired", replayed: false });
    const supervisor = await startRoutineSupervisor({ intervalMs: 60_000 });
    try {
      await vi.waitFor(() => expect(coreMocks.fire).toHaveBeenCalled());
      expect(coreMocks.messageId).toHaveBeenCalledWith({
        routineId: claim.routineId,
        scheduledFor: claim.scheduledFor,
      });
      expect(coreMocks.fire).toHaveBeenCalledWith(expect.objectContaining({
        orgId: claim.orgId,
        routineId: claim.routineId,
        clientMessageId: "11111111-1111-5111-8111-111111111111",
        database: dbMocks.db,
      }));
    } finally {
      await supervisor?.stop();
    }
  });

  it("records a classified error and continues the rest of the batch", async () => {
    coreMocks.enabled.mockReturnValue(true);
    const other = { ...claim, routineId: "routine-2", name: "Wrap-up" };
    coreMocks.claim.mockResolvedValue([claim, other]);
    coreMocks.nextFire.mockReturnValue(new Date("2026-08-20T09:00:00.000Z"));
    coreMocks.messageId.mockReturnValue("22222222-2222-5222-8222-222222222222");
    coreMocks.fire.mockImplementation(async (input: { routineId: string }) => {
      if (input.routineId === "routine-1") {
        throw Object.assign(new Error("retired Companion cannot accept messages"), { code: "55000" });
      }
      return { outcome: "fired", replayed: false };
    });
    coreMocks.fail.mockResolvedValue(undefined);
    const supervisor = await startRoutineSupervisor({ intervalMs: 60_000 });
    try {
      await vi.waitFor(() => expect(coreMocks.fire).toHaveBeenCalledTimes(2));
      expect(coreMocks.fail).toHaveBeenCalledWith(expect.objectContaining({
        routineId: "routine-1",
        errorCode: "companion_retired",
      }));
    } finally {
      await supervisor?.stop();
    }
  });
});
