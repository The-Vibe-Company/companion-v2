import { describe, expect, it, vi } from "vitest";

import { refreshWarmCompanionLayout } from "./layoutRefresh";
import type { LeaseSession } from "./leaseSession";
import type { RuntimeEngineDependencies } from "./ports";
import { attemptAuthorization, attemptClaim, PI_INVOCATION_ID, TestClock } from "./test/fixtures";

function session(): LeaseSession {
  const signal = new AbortController().signal;
  return {
    signal,
    external: async (effect) => await effect(signal),
  } as LeaseSession;
}

function deps(overrides: {
  refreshLayout?: () => Promise<{ applied: "none" | "overlay" | "base" }>;
  invalidateLayout?: () => Promise<void>;
  restartPiDaemon?: () => Promise<{ state: string; invocationId?: string | null }>;
}): RuntimeEngineDependencies {
  return {
    clock: new TestClock(),
    jitter: () => 0.5,
    resourceStager: {
      refreshLayout: overrides.refreshLayout ?? (async () => ({ applied: "none" as const })),
      invalidateLayout: overrides.invalidateLayout ?? (async () => undefined),
    },
    pi: {
      restartPiDaemon: overrides.restartPiDaemon ?? (async () => ({
        state: "idle",
        invocationId: "new-pi",
      })),
    },
  } as unknown as RuntimeEngineDependencies;
}

describe("warm Companion layout refresh", () => {
  it("leaves Pi running when the disk already matches", async () => {
    const restartPiDaemon = vi.fn();
    const result = await refreshWarmCompanionLayout({
      session: session(),
      deps: deps({ restartPiDaemon }),
      authorization: attemptAuthorization(attemptClaim()),
      restartPi: true,
    });

    expect(result).toEqual({
      applied: "none",
      restartedPi: false,
      piInvocationId: PI_INVOCATION_ID,
    });
    expect(restartPiDaemon).not.toHaveBeenCalled();
  });

  it("recycles only Pi after an overlay or package refresh", async () => {
    const result = await refreshWarmCompanionLayout({
      session: session(),
      deps: deps({
        refreshLayout: async () => ({ applied: "overlay" }),
      }),
      authorization: attemptAuthorization(attemptClaim()),
      restartPi: true,
    });

    expect(result).toEqual({
      applied: "overlay",
      restartedPi: true,
      piInvocationId: "new-pi",
    });
  });

  it("invalidates the layout marker when Pi cannot be recycled", async () => {
    const invalidateLayout = vi.fn(async () => undefined);
    const result = await refreshWarmCompanionLayout({
      session: session(),
      deps: deps({
        refreshLayout: async () => ({ applied: "overlay" }),
        invalidateLayout,
        restartPiDaemon: async () => ({ state: "starting", invocationId: null }),
      }),
      authorization: attemptAuthorization(attemptClaim()),
      restartPi: true,
    });

    expect(result).toEqual({
      applied: "overlay",
      restartedPi: false,
      piInvocationId: PI_INVOCATION_ID,
    });
    expect(invalidateLayout).toHaveBeenCalledOnce();
  });

  it("invalidates the layout marker before rethrowing a recycle failure", async () => {
    const invalidateLayout = vi.fn(async () => undefined);
    await expect(refreshWarmCompanionLayout({
      session: session(),
      deps: deps({
        refreshLayout: async () => ({ applied: "base" }),
        invalidateLayout,
        restartPiDaemon: async () => {
          throw new Error("Pi recycle failed");
        },
      }),
      authorization: attemptAuthorization(attemptClaim()),
      restartPi: true,
    })).rejects.toThrow("Pi recycle failed");
    expect(invalidateLayout).toHaveBeenCalledOnce();
  });

  it("does nothing without a Box id", async () => {
    const refreshLayout = vi.fn();
    const result = await refreshWarmCompanionLayout({
      session: session(),
      deps: deps({ refreshLayout }),
      authorization: attemptAuthorization(attemptClaim(), { boxId: null }),
      restartPi: true,
    });

    expect(result.applied).toBe("none");
    expect(refreshLayout).not.toHaveBeenCalled();
  });
});
