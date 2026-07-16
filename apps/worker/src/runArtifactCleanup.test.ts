import { describe, expect, it, vi } from "vitest";
import { sweepRunArtifacts } from "./runArtifactCleanup";

describe("run artifact maintenance", () => {
  it("deletes only candidates that remain expired under the final row lock", async () => {
    const deleteObject = vi.fn(async () => undefined);
    const deleteExpired = vi.fn(async ({ artifact, deleteObject: remove }) => {
      if (artifact.id === "raced") return false;
      await remove();
      return true;
    });
    const result = await sweepRunArtifacts({
      now: new Date("2026-07-16T12:00:00Z"),
      list: async () => [
        { id: "expired", storageKey: "org/run-artifacts/run/expired" },
        { id: "raced", storageKey: "org/run-artifacts/run/raced" },
      ],
      deleteExpired: deleteExpired as never,
      headObject: async () => ({ etag: '"old-etag"' }),
      deleteObject,
    });
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith(
      "org/run-artifacts/run/expired",
      '"old-etag"',
      expect.any(AbortSignal),
    );
    expect(result).toEqual({ deleted: 1, retained: 1, failed: 0 });
  });

  it("keeps metadata for retry when object deletion fails", async () => {
    const result = await sweepRunArtifacts({
      list: async () => [{ id: "expired", storageKey: "key" }],
      headObject: async () => null,
      deleteExpired: async () => { throw new Error("S3 unavailable"); },
    });
    expect(result).toEqual({ deleted: 0, retained: 0, failed: 1 });
  });

  it("aborts and releases a stalled object deletion deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = sweepRunArtifacts({
      deleteTimeoutMs: 25,
      list: async () => [{ id: "expired", storageKey: "key" }],
      headObject: async () => ({ etag: '"old-etag"' }),
      deleteExpired: async ({ deleteObject }) => {
        await deleteObject();
        return true;
      },
      deleteObject: (_key, ifMatch, nextSignal) => new Promise((_resolve, reject) => {
        expect(ifMatch).toBe('"old-etag"');
        signal = nextSignal;
        nextSignal.addEventListener("abort", () => reject(nextSignal.reason), { once: true });
      }),
    });

    await vi.advanceTimersByTimeAsync(26);
    await expect(result).resolves.toEqual({ deleted: 0, retained: 0, failed: 1 });
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("uses the observed ETag so a late delete cannot remove replacement bytes", async () => {
    const deleteObject = vi.fn(async () => undefined);
    await expect(sweepRunArtifacts({
      list: async () => [{ id: "expired", storageKey: "key" }],
      headObject: async () => ({ etag: '"version-before-lock"' }),
      deleteExpired: async ({ deleteObject: remove }) => {
        await remove();
        return true;
      },
      deleteObject,
    })).resolves.toEqual({ deleted: 1, retained: 0, failed: 0 });

    expect(deleteObject).toHaveBeenCalledWith(
      "key",
      '"version-before-lock"',
      expect.any(AbortSignal),
    );
  });
});
