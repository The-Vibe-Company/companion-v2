import { describe, expect, it } from "vitest";
import {
  type LeaseRenewalErrorInfo,
  LeaseFenceLostError,
  LeaseSession,
  RUNTIME_RENEW_INTERVAL_MS,
  RUNTIME_RENEW_RETRY_MS,
} from "./leaseSession";
import {
  MemoryRuntimeStore,
  TestClock,
  attemptAuthorization,
  attemptClaim,
} from "./test/fixtures";
import type { RuntimeAuthorization } from "./types";

type RenewBehavior = "ok" | "throw" | "deny" | "null";

/** MemoryRuntimeStore with a scripted renewAndAuthorize outcome per call, for renewal tests. */
class ScriptedRenewStore extends MemoryRuntimeStore {
  behaviors: RenewBehavior[] = [];
  denialCode = "provider_revoked";

  override async renewAndAuthorize(): Promise<RuntimeAuthorization | null> {
    this.renewals += 1;
    const behavior = this.behaviors.shift() ?? "ok";
    if (behavior === "throw") throw new Error("database temporarily unavailable");
    if (behavior === "null") return null;
    if (behavior === "deny") {
      return { ...this.authorization, authorized: false, denialCode: this.denialCode };
    }
    return { ...this.authorization };
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function hasRetryTimer(clock: TestClock): boolean {
  return [...clock.timers.values()].some((timer) => timer.milliseconds === RUNTIME_RENEW_RETRY_MS);
}

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

  it("retries a transient background renewal failure and keeps the session usable", async () => {
    const claim = attemptClaim();
    const store = new ScriptedRenewStore({ authorization: attemptAuthorization(claim) });
    // start succeeds; the scheduled background renewal throws once; the short retry then succeeds.
    store.behaviors = ["ok", "throw"];
    const clock = new TestClock();
    const errors: LeaseRenewalErrorInfo[] = [];
    const session = new LeaseSession({
      store,
      claim,
      executorId: "lease-test",
      clock,
      onRenewalError: (info) => errors.push(info),
    });

    await session.start();
    expect(store.renewals).toBe(1);

    // Fire the scheduled renewal: it throws, so the session logs once and schedules a short retry
    // instead of aborting the heartbeat.
    clock.runNextTimer();
    await flushMicrotasks();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.attempt).toBe(1);
    expect(errors[0]?.fence.workId).toBe(claim.workId);
    expect(session.signal.aborted).toBe(false);
    expect(session.renewalFailed).toBe(false);
    expect(hasRetryTimer(clock)).toBe(true);

    // The session is still fully usable: an external effect reauthorizes successfully.
    let effects = 0;
    await session.external(async () => { effects += 1; });
    expect(effects).toBe(1);

    // The pending retry timer then renews cleanly and only the single transient error was reported.
    clock.runNextTimer();
    await flushMicrotasks();
    expect(errors).toHaveLength(1);
    expect(session.signal.aborted).toBe(false);
    session.stop();
  });

  it("aborts on an authoritative denial without retrying or logging a transient error", async () => {
    const claim = attemptClaim();
    const store = new ScriptedRenewStore({ authorization: attemptAuthorization(claim) });
    // start succeeds; the first background renewal is an authoritative denial, and a second would be
    // too — an authoritative outcome must abort immediately rather than enter the transient retry loop.
    store.behaviors = ["ok", "deny", "deny"];
    const clock = new TestClock();
    const errors: LeaseRenewalErrorInfo[] = [];
    const session = new LeaseSession({
      store,
      claim,
      executorId: "lease-test",
      clock,
      onRenewalError: (info) => errors.push(info),
    });

    await session.start();
    clock.runNextTimer();
    await flushMicrotasks();

    expect(session.denialCode).toBe("provider_revoked");
    expect(session.signal.aborted).toBe(true);
    // A denial is not a transient failure: nothing is logged and no retry is scheduled.
    expect(errors).toHaveLength(0);
    expect(hasRetryTimer(clock)).toBe(false);
  });
});
