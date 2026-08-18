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

  it("propagates a startup failure and removes the early signal listeners", async () => {
    const failure = new Error("startup failed");
    const stop = vi.fn(async () => undefined);
    const signals = new EventEmitter();
    await expect(runRuntimeUntilSignal({
      signals,
      build: async () => ({
        application: { start: async () => { throw failure; }, stop },
        server: {} as never,
      }),
    })).rejects.toBe(failure);
    expect(stop).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("latches SIGTERM while composition is still pending", async () => {
    const signals = new EventEmitter();
    let resolveBuild!: (service: {
      application: { start(): Promise<void>; stop(): Promise<void> };
      server: never;
    }) => void;
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const running = runRuntimeUntilSignal({
      signals,
      build: async () => await new Promise((resolve) => { resolveBuild = resolve; }),
    });

    signals.emit("SIGTERM");
    resolveBuild({ application: { start, stop }, server: {} as never });
    await running;

    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops safely when SIGINT arrives during application startup", async () => {
    const signals = new EventEmitter();
    let resolveStart!: () => void;
    const start = vi.fn(async () => await new Promise<void>((resolve) => { resolveStart = resolve; }));
    const stop = vi.fn(async () => { resolveStart(); });
    const running = runRuntimeUntilSignal({
      signals,
      build: async () => ({ application: { start, stop }, server: {} as never }),
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

    signals.emit("SIGINT");
    await running;

    expect(stop).toHaveBeenCalledOnce();
  });
});
