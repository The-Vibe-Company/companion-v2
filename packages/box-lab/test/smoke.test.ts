import { describe, expect, it, vi } from "vitest";

import {
  BoxLabFailureCaseError,
  boxLabFailureIdentitySalt,
  retryBoxLabPrewarm,
  runRetainedFailureCase,
} from "../src/smoke";

describe("Box Lab failure-case retention", () => {
  it("cleans an isolated Box only after its expected failure assertion passes", async () => {
    const action = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);

    await runRetainedFailureCase({ caseName: "expected", boxId: "bx_23456789", action, cleanup });

    expect(action).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("retains the exact failing Box for inspection", async () => {
    const cause = new Error("assertion failed");
    const cleanup = vi.fn(async () => undefined);

    await expect(runRetainedFailureCase({
      caseName: "command_timeout",
      boxId: "bx_23456789",
      action: async () => { throw cause; },
      cleanup,
    })).rejects.toMatchObject({
      name: "BoxLabFailureCaseError",
      caseName: "command_timeout",
      boxId: "bx_23456789",
      cause,
    } satisfies Partial<BoxLabFailureCaseError>);
    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe("Box Lab timeout prewarm", () => {
  it("retries a transient first-shell failure", async () => {
    const action = vi.fn()
      .mockRejectedValueOnce(new Error("user shell not ready"))
      .mockResolvedValueOnce(undefined);

    await retryBoxLabPrewarm({ action, attempts: 3, delayMs: 0 });

    expect(action).toHaveBeenCalledTimes(2);
  });

  it("surfaces the final failure after the bounded attempts", async () => {
    const finalFailure = new Error("prewarm still unavailable");
    const action = vi.fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(finalFailure);

    await expect(retryBoxLabPrewarm({ action, attempts: 2, delayMs: 0 }))
      .rejects.toBe(finalFailure);
    expect(action).toHaveBeenCalledTimes(2);
  });
});

describe("Box Lab failure identity", () => {
  it("uses the runtime image salt contract for every deterministic case", () => {
    expect(boxLabFailureIdentitySalt("command_timeout")).toMatch(/^[a-f0-9]{64}$/);
    expect(boxLabFailureIdentitySalt("command_timeout"))
      .not.toBe(boxLabFailureIdentitySalt("npm_nonzero"));
  });
});
