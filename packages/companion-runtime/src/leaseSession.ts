import type { RuntimeClock } from "./clock";
import { RuntimeShutdownError } from "./errors";
import {
  RUNTIME_LEASE_SECONDS,
  type RuntimeStore,
} from "./store";
import type {
  LeaseFence,
  RuntimeAuthorization,
  RuntimeCheckpointInput,
  RuntimeClaim,
  RuntimeObservationInput,
  RuntimeSettlementInput,
} from "./types";

export const RUNTIME_RENEW_INTERVAL_MS = 10_000;

export class LeaseFenceLostError extends Error {
  constructor() {
    super("Runtime lease fence was lost");
    this.name = "LeaseFenceLostError";
  }
}

export class LeaseAuthorizationDeniedError extends Error {
  constructor(readonly denialCode: string) {
    super("Runtime authorization was denied");
    this.name = "LeaseAuthorizationDeniedError";
  }
}

export class LeaseRenewalError extends Error {
  constructor() {
    super("Runtime lease could not be renewed");
    this.name = "LeaseRenewalError";
  }
}

export function claimFence(claim: RuntimeClaim, executorId: string): LeaseFence {
  return {
    orgId: claim.orgId,
    companionId: claim.companionId,
    claimToken: claim.claimToken,
    claimEpoch: claim.claimEpoch,
    gateEpoch: claim.gateEpoch,
    executorId,
    workKind: claim.workKind,
    workId: claim.workId,
  };
}

/** Serializes renewal and every fenced mutation for one claimed Companion. */
export class LeaseSession {
  readonly fence: LeaseFence;
  readonly #abortController = new AbortController();
  readonly #store: RuntimeStore;
  readonly #clock: RuntimeClock;
  readonly #renewIntervalMs: number;
  #sequence: bigint;
  #authorization: RuntimeAuthorization | null = null;
  #tail: Promise<void> = Promise.resolve();
  #timer: unknown;
  #running = false;
  #lost = false;
  #denialCode: string | null = null;
  #renewalFailed = false;

  constructor(input: {
    store: RuntimeStore;
    claim: RuntimeClaim;
    executorId: string;
    clock: RuntimeClock;
    renewIntervalMs?: number;
  }) {
    this.#store = input.store;
    this.#clock = input.clock;
    this.#renewIntervalMs = input.renewIntervalMs ?? RUNTIME_RENEW_INTERVAL_MS;
    this.#sequence = input.claim.checkpointSequence;
    this.fence = claimFence(input.claim, input.executorId);
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get sequence(): bigint {
    return this.#sequence;
  }

  get authorization(): RuntimeAuthorization | null {
    return this.#authorization;
  }

  get lost(): boolean {
    return this.#lost;
  }

  get denialCode(): string | null {
    return this.#denialCode;
  }

  get renewalFailed(): boolean {
    return this.#renewalFailed;
  }

  async start(): Promise<RuntimeAuthorization> {
    if (this.#running) {
      if (!this.#authorization) throw new LeaseFenceLostError();
      return this.#authorization;
    }
    this.#running = true;
    const authorization = await this.#renewAuthorization(true);
    if (authorization.authorized) this.#scheduleRenewal();
    return authorization;
  }

  async reauthorize(): Promise<RuntimeAuthorization> {
    return await this.#renewAuthorization(false);
  }

  async #renewAuthorization(allowDenied: boolean): Promise<RuntimeAuthorization> {
    return await this.#enqueue(async () => {
      if (this.#lost) throw new LeaseFenceLostError();
      let authorization: RuntimeAuthorization | null;
      try {
        authorization = await this.#store.renewAndAuthorize(this.fence, RUNTIME_LEASE_SECONDS);
      } catch {
        this.#renewalFailed = true;
        this.#abort(new LeaseRenewalError());
        throw new LeaseRenewalError();
      }
      if (!authorization) {
        this.#lost = true;
        this.#abort(new LeaseFenceLostError());
        throw new LeaseFenceLostError();
      }
      if (authorization.workCheckpointSequence < this.#sequence) {
        this.#renewalFailed = true;
        this.#abort(new LeaseRenewalError());
        throw new LeaseRenewalError();
      }
      this.#sequence = authorization.workCheckpointSequence;
      this.#authorization = authorization;
      if (!authorization.authorized) {
        this.#denialCode = authorization.denialCode ?? "runtime_authorization_denied";
        this.#abort(new LeaseAuthorizationDeniedError(this.#denialCode));
        if (!allowDenied) throw new LeaseAuthorizationDeniedError(this.#denialCode);
      }
      return authorization;
    });
  }

  /** Immediate renewal/authorization is mandatory immediately before every external effect. */
  async external<T>(effect: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const authorization = await this.reauthorize();
    if (!authorization.authorized) {
      throw new LeaseAuthorizationDeniedError(
        authorization.denialCode ?? "runtime_authorization_denied",
      );
    }
    if (this.signal.aborted) throw this.signal.reason ?? new LeaseFenceLostError();
    return await effect(this.signal);
  }

  async checkpoint(
    input: Omit<RuntimeCheckpointInput, "expectedSequence">,
  ): Promise<bigint> {
    return await this.#enqueue(async () => {
      this.#assertMutable();
      const sequence = await this.#store.checkpoint(this.fence, {
        ...input,
        expectedSequence: this.#sequence,
      });
      if (sequence === null) return this.#loseFence();
      this.#sequence = sequence;
      return sequence;
    });
  }

  async observe(
    input: Omit<RuntimeObservationInput, "expectedSequence">,
  ): Promise<bigint> {
    return await this.#enqueue(async () => {
      this.#assertMutable();
      const sequence = await this.#store.observeInstance(this.fence, {
        ...input,
        expectedSequence: this.#sequence,
      });
      if (sequence === null) return this.#loseFence();
      this.#sequence = sequence;
      return sequence;
    });
  }

  /** Adopt the sequence returned by another narrow fenced definer, such as event projection. */
  async adoptExternalMutation<T>(
    mutation: (expectedSequence: bigint) => Promise<{ sequence: bigint; value: T } | null>,
  ): Promise<T> {
    return await this.#enqueue(async () => {
      this.#assertMutable();
      const result = await mutation(this.#sequence);
      if (!result) return this.#loseFence();
      if (result.sequence <= this.#sequence) {
        this.#renewalFailed = true;
        this.#abort(new LeaseRenewalError());
        throw new LeaseRenewalError();
      }
      this.#sequence = result.sequence;
      return result.value;
    });
  }

  /** Serialize a child-ledger/material definer that does not advance the main work sequence. */
  async fencedMutation<T>(mutation: () => Promise<T | null>): Promise<T> {
    return await this.#enqueue(async () => {
      this.#assertMutable();
      const result = await mutation();
      if (result === null) return this.#loseFence();
      return result;
    });
  }

  async settle(input: RuntimeSettlementInput): Promise<boolean> {
    return await this.#enqueue(async () => {
      if (this.#lost) return false;
      const settled = await this.#store.settle(this.fence, input);
      if (!settled) {
        this.#lost = true;
        this.#abort(new LeaseFenceLostError());
      }
      this.stop();
      return settled;
    });
  }

  async release(): Promise<boolean> {
    return await this.#enqueue(async () => {
      if (this.#lost) return false;
      const released = await this.#store.release(this.fence);
      if (!released) this.#lost = true;
      this.stop();
      return released;
    });
  }

  /** Stop local I/O. The engine may still use the live DB fence to record interruption. */
  requestShutdown(): void {
    this.#abort(new RuntimeShutdownError());
    this.#clearRenewal();
  }

  stop(): void {
    this.#running = false;
    this.#clearRenewal();
  }

  async drain(): Promise<void> {
    await this.#tail;
  }

  #assertMutable(): void {
    if (this.#lost) throw new LeaseFenceLostError();
    if (this.#denialCode) throw new LeaseAuthorizationDeniedError(this.#denialCode);
    if (this.#renewalFailed) throw new LeaseRenewalError();
  }

  #loseFence(): never {
    this.#lost = true;
    this.#abort(new LeaseFenceLostError());
    throw new LeaseFenceLostError();
  }

  #abort(reason: unknown): void {
    if (!this.#abortController.signal.aborted) this.#abortController.abort(reason);
  }

  #scheduleRenewal(): void {
    if (!this.#running || this.#lost || this.#denialCode || this.#renewalFailed) return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      void this.reauthorize()
        .then(() => this.#scheduleRenewal())
        .catch(() => undefined);
    }, this.#renewIntervalMs);
  }

  #clearRenewal(): void {
    if (this.#timer === undefined) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
