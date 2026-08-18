import { describe, expect, it } from "vitest";
import {
  LeaseFenceLostError,
  LeaseSession,
  RUNTIME_RENEW_INTERVAL_MS,
} from "./leaseSession";
import {
  MemoryRuntimeStore,
  TestClock,
  attemptAuthorization,
  attemptClaim,
} from "./test/fixtures";

describe("LeaseSession", () => {
  it("renews every ten seconds and immediately before an external effect", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const clock = new TestClock();
    const session = new LeaseSession({
      store,
      claim,
      executorId: "lease-test",
      clock,
    });

    await session.start();
    expect(store.renewals).toBe(1);
    expect([...clock.timers.values()][0]?.milliseconds).toBe(RUNTIME_RENEW_INTERVAL_MS);

    clock.runNextTimer();
    await Promise.resolve();
    await session.drain();
    expect(store.renewals).toBe(2);

    let effects = 0;
    await session.external(async () => { effects += 1; });
    expect(store.renewals).toBe(3);
    expect(effects).toBe(1);
    session.stop();
  });

  it("aborts mutations immediately after a stale checkpoint fence", async () => {
    const claim = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(claim) });
    const session = new LeaseSession({
      store,
      claim,
      executorId: "lease-test",
      clock: new TestClock(),
    });
    await session.start();
    store.authorization.workCheckpointSequence = 9n;

    await expect(session.checkpoint({ nextCheckpoint: "dispatch_write_intent" }))
      .rejects.toBeInstanceOf(LeaseFenceLostError);
    expect(session.lost).toBe(true);

    let effects = 0;
    await expect(session.external(async () => { effects += 1; }))
      .rejects.toBeInstanceOf(LeaseFenceLostError);
    expect(effects).toBe(0);
  });
});
