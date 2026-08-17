import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { runRuntimeUntilSignal } from "./process";

describe("runtime process signal handling", () => {
  it("starts once and drains once on the first SIGTERM/SIGINT", async () => {
    const signals = new EventEmitter();
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const running = runRuntimeUntilSignal({
      signals,
      build: async () => ({
        application: { start, stop },
        server: {} as never,
      }),
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await running;
    expect(stop).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("propagates a startup failure without installing signal listeners", async () => {
    const failure = new Error("startup failed");
    const stop = vi.fn(async () => undefined);
    await expect(runRuntimeUntilSignal({
      signals: new EventEmitter(),
      build: async () => ({
        application: { start: async () => { throw failure; }, stop },
        server: {} as never,
      }),
    })).rejects.toBe(failure);
    expect(stop).not.toHaveBeenCalled();
  });
});
