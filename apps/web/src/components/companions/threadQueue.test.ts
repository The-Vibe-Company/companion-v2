import { describe, expect, it } from "vitest";
import { createThreadQueue } from "./threadQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createThreadQueue", () => {
  it("skips a poll while a request that can reach Pi is in flight", async () => {
    const queue = createThreadQueue();
    const first = deferred<string>();
    let polls = 0;

    const running = queue.run(() => {
      polls += 1;
      return first.promise;
    }, { skipWhenBusy: true });
    const skipped = await queue.run(() => {
      polls += 1;
      return Promise.resolve("second");
    }, { skipWhenBusy: true });

    expect(skipped).toBeUndefined();
    expect(polls).toBe(1);
    first.resolve("first");
    await expect(running).resolves.toBe("first");
  });

  it("runs a person's send after the request in flight rather than beside it", async () => {
    const queue = createThreadQueue();
    const sync = deferred<string>();
    const order: string[] = [];

    const syncing = queue.run(() => {
      order.push("sync:start");
      return sync.promise.then((value) => {
        order.push("sync:end");
        return value;
      });
    }, { skipWhenBusy: true });
    const sending = queue.run(() => {
      order.push("send:start");
      return Promise.resolve("sent");
    }, { skipWhenBusy: false });

    await new Promise((resolve) => setTimeout(resolve, 0));
    // The send is queued, so it has not started while the sync is still waiting on Pi.
    expect(order).toEqual(["sync:start"]);
    sync.resolve("synced");
    await expect(syncing).resolves.toBe("synced");
    await expect(sending).resolves.toBe("sent");
    expect(order).toEqual(["sync:start", "sync:end", "send:start"]);
  });

  it("keeps accepting work after a failed request and reports the failure to its caller", async () => {
    const queue = createThreadQueue();

    await expect(queue.run(() => Promise.reject(new Error("pi refused")), {
      skipWhenBusy: false,
    })).rejects.toThrow("pi refused");
    await expect(queue.run(() => Promise.resolve("after"), { skipWhenBusy: true }))
      .resolves.toBe("after");
  });
});
