import { describe, expect, it } from "vitest";
import { retryIdempotentLifecycle } from "./retry";
import { TestClock } from "./test/fixtures";

describe("retryIdempotentLifecycle", () => {
  it("uses the complete 1/2/5/10/30 second schedule for a retryable lifecycle call", async () => {
    const clock = new TestClock();
    let calls = 0;

    const result = await retryIdempotentLifecycle({
      call: "get_status",
      clock,
      jitter: () => 0.5,
      operation: async () => {
        calls += 1;
        if (calls <= 5) throw Object.assign(new Error("temporary"), { status: 503 });
        return "ready";
      },
    });

    expect(result).toBe("ready");
    expect(calls).toBe(6);
    expect(clock.sleeps).toEqual([1_000, 2_000, 5_000, 10_000, 30_000]);
  });

  it("stops before a backoff would cross the durable deadline", async () => {
    const clock = new TestClock();
    let calls = 0;

    await expect(retryIdempotentLifecycle({
      call: "poll_delete",
      clock,
      jitter: () => 0.5,
      deadlineAt: new Date(clock.now().getTime() + 6_000),
      operation: async () => {
        calls += 1;
        throw Object.assign(new Error("temporary"), { status: 429 });
      },
    })).rejects.toThrow("temporary");

    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([1_000, 2_000]);
  });

  it("does not retry a non-retryable provider rejection", async () => {
    const clock = new TestClock();
    let calls = 0;

    await expect(retryIdempotentLifecycle({
      call: "resume_box",
      clock,
      jitter: () => 0.5,
      operation: async () => {
        calls += 1;
        throw Object.assign(new Error("invalid"), { status: 400 });
      },
    })).rejects.toThrow("invalid");

    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("does not call the provider when backoff reaches the durable deadline", async () => {
    const clock = new TestClock();
    const sleep = clock.sleep.bind(clock);
    clock.sleep = async (milliseconds, signal) => {
      await sleep(milliseconds, signal);
      clock.advance(1);
    };
    let calls = 0;

    await expect(retryIdempotentLifecycle({
      call: "get_status",
      clock,
      jitter: () => 0.5,
      deadlineAt: new Date(clock.now().getTime() + 1_001),
      operation: async () => {
        calls += 1;
        throw Object.assign(new Error("temporary"), { status: 503 });
      },
    })).rejects.toThrow("temporary");

    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("rechecks abort and deadline after the pre-attempt hook", async () => {
    const clock = new TestClock();
    const controller = new AbortController();
    let calls = 0;
    const stopped = new Error("lease stopped");

    await expect(retryIdempotentLifecycle({
      call: "get_status",
      clock,
      jitter: () => 0.5,
      signal: controller.signal,
      beforeAttempt: async () => { controller.abort(stopped); },
      operation: async () => { calls += 1; },
    })).rejects.toBe(stopped);
    expect(calls).toBe(0);

    await expect(retryIdempotentLifecycle({
      call: "get_status",
      clock,
      jitter: () => 0.5,
      deadlineAt: new Date(clock.now().getTime() + 1),
      beforeAttempt: async () => { clock.advance(1); },
      operation: async () => { calls += 1; },
    })).rejects.toThrow("deadline elapsed");
    expect(calls).toBe(0);
  });
});
