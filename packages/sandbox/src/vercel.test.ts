import { beforeEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: { get },
  APIError: class APIError extends Error {
    constructor(readonly response: Response) {
      super(`provider returned ${response.status}`);
    }
  },
}));

import { createVercelRuntime } from "./vercel";

const ref = {
  sandboxName: "run-test",
  sandboxId: "sandbox-test",
  region: "iad1",
  timeoutMs: 300_000,
};

describe("Vercel runtime lifecycle conformance", () => {
  beforeEach(() => get.mockReset());

  it("observes running and stopped sessions without resuming", async () => {
    get
      .mockResolvedValueOnce({
        status: "running",
        expiresAt: new Date("2026-07-23T12:05:00.000Z"),
      })
      .mockResolvedValueOnce({ status: "stopped", expiresAt: undefined });
    const runtime = createVercelRuntime({ token: "token", teamId: "team", projectId: "project", vcpus: 2 });

    await expect(runtime.observe(ref)).resolves.toEqual({
      state: "running",
      expiresAt: new Date("2026-07-23T12:05:00.000Z"),
    });
    await expect(runtime.observe(ref)).resolves.toEqual({ state: "stopped", expiresAt: null });
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ name: "run-test", resume: false }));
  });

  it("maps not found to missing but propagates transient failures", async () => {
    const { APIError } = await import("@vercel/sandbox");
    get
      .mockRejectedValueOnce(new APIError(new Response(null, { status: 404 })))
      .mockRejectedValueOnce(new APIError(new Response(null, { status: 503 })));
    const runtime = createVercelRuntime({ token: "token", teamId: "team", projectId: "project", vcpus: 2 });

    await expect(runtime.observe(ref)).resolves.toEqual({ state: "missing", expiresAt: null });
    await expect(runtime.observe(ref)).rejects.toThrow("503");
  });

  it("returns a fresh observation after extending", async () => {
    const extendTimeout = vi.fn(async () => undefined);
    get
      .mockResolvedValueOnce({
        status: "running",
        expiresAt: new Date("2026-07-23T12:05:00.000Z"),
        extendTimeout,
      })
      .mockResolvedValueOnce({
        status: "running",
        expiresAt: new Date("2026-07-23T13:00:00.000Z"),
      });
    const runtime = createVercelRuntime({ token: "token", teamId: "team", projectId: "project", vcpus: 2 });

    await expect(runtime.extendTimeout!(ref, 3_300_000)).resolves.toEqual({
      state: "running",
      expiresAt: new Date("2026-07-23T13:00:00.000Z"),
    });
    expect(extendTimeout).toHaveBeenCalledWith(3_300_000, { signal: undefined });
  });
});
