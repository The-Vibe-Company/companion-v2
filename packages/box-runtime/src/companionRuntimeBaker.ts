import { BoxRuntimeAdapterError, type BoxRuntimeLifecycleClient } from "./boxMaintenanceClient";
import type { CompanionBoxRuntimeV2 } from "./boxCompanionRuntime";
import {
  isCompanionRuntimeImageName,
  type CompanionPiLayoutIdentity,
} from "./companionRuntimeImage";

// Create stays at the unnamed-orphan bound. The bake itself is longer: ready wait, layout, snapshot.
const BAKER_CREATE_TTL_SECONDS = 300;
const BAKER_WORK_TTL_SECONDS = 1_800;
const READY_POLL_INTERVAL_MS = 1_000;
const SNAPSHOT_POLL_INTERVAL_MS = 2_000;
const BAKE_RETRY_INTERVAL_MS = 30_000;
const BOX_READY_TIMEOUT_MS = 180_000;
const SNAPSHOT_READY_TIMEOUT_MS = 600_000;
const READY_STATES = new Set(["ready", "idle", "running"]);

export interface CompanionRuntimeImageBaker {
  readonly identity: CompanionPiLayoutIdentity;
  readyName(): string | null;
  /** Current image if baked, otherwise the previous companion snapshot a new Box can clone. */
  cloneName(): string | null;
  ensure(signal: AbortSignal): Promise<{ name: string; ready: boolean; baked: boolean }>;
}

export function createCompanionRuntimeImageBaker(input: {
  identity: CompanionPiLayoutIdentity;
  lifecycle: BoxRuntimeLifecycleClient;
  runtime: Pick<CompanionBoxRuntimeV2, "existingBoxStatus" | "refreshPiLayout" | "refreshTtl">;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onAttemptError?: (error: unknown) => void;
}): CompanionRuntimeImageBaker {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  let readyName: string | null = null;
  let parentName: string | null = null;
  let inflight: Promise<{ name: string; ready: boolean; baked: boolean }> | null = null;

  const baker: CompanionRuntimeImageBaker = {
    identity: input.identity,
    readyName: () => readyName,
    cloneName: () => readyName ?? parentName,
    async ensure(signal) {
      const pending = inflight ??= (async () => {
        try {
          while (true) {
            signal.throwIfAborted();
            try {
              const result = await ensureImage({
                identity: input.identity,
                lifecycle: input.lifecycle,
                runtime: input.runtime,
                now,
                sleep,
                signal,
                onParent: (name) => {
                  parentName = name;
                },
              });
              if (result.ready) {
                readyName = result.name;
                return result;
              }
              input.onAttemptError?.(new Error("The companion runtime image was not ready after a bake attempt."));
            } catch (error) {
              if (signal.aborted) throw error;
              input.onAttemptError?.(error);
            }
            await sleep(BAKE_RETRY_INTERVAL_MS, signal);
          }
        } finally {
          inflight = null;
        }
      })();
      return await pending;
    },
  };
  return baker;
}

async function ensureImage(input: {
  identity: CompanionPiLayoutIdentity;
  lifecycle: BoxRuntimeLifecycleClient;
  runtime: Pick<CompanionBoxRuntimeV2, "existingBoxStatus" | "refreshPiLayout" | "refreshTtl">;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  onParent?: (name: string) => void;
}): Promise<{ name: string; ready: boolean; baked: boolean }> {
  const current = await input.lifecycle.getNamedSnapshot({
    name: input.identity.imageName,
    signal: input.signal,
    deadlineAt: input.now() + 30_000,
  });
  if (current?.status === "ready") {
    return { name: input.identity.imageName, ready: true, baked: false };
  }
  if (current?.status === "saving") {
    const parent = await selectParentSnapshot(input);
    if (parent) input.onParent?.(parent);
    const settled = await waitNamedSnapshot(input, input.identity.imageName);
    if (settled?.status === "ready") {
      return { name: input.identity.imageName, ready: true, baked: false };
    }
  }

  const parent = await selectParentSnapshot(input);
  if (parent) input.onParent?.(parent);
  await pruneStaleImages({ ...input, keep: parent ? [parent] : [] });
  let boxId: string | null = null;
  try {
    const created = await createBakerBox(input, parent);
    boxId = created.boxId;
    await input.runtime.refreshTtl({
      boxId,
      ttlSeconds: BAKER_WORK_TTL_SECONDS,
      signal: input.signal,
    });
    await waitBoxReady(input, boxId);
    await input.runtime.refreshPiLayout({ boxId, signal: input.signal });
    try {
      await input.lifecycle.saveNamedSnapshot({
        boxId,
        name: input.identity.imageName,
        deadlineAt: input.now() + 30_000,
        signal: input.signal,
      });
    } catch (error) {
      if (!isSnapshotSaveInFlight(error)) throw error;
    }
    const saved = await waitNamedSnapshot(input, input.identity.imageName);
    if (saved?.status !== "ready") {
      return { name: input.identity.imageName, ready: false, baked: false };
    }
    await pruneStaleImages({ ...input, keep: parent ? [parent] : [] });
    return { name: input.identity.imageName, ready: true, baked: true };
  } finally {
    if (boxId) {
      await input.lifecycle.deletePermanentlyAndWait({
        boxId,
        deadlineAt: input.now() + 120_000,
        signal: input.signal,
      }).catch(() => undefined);
    }
  }
}

async function selectParentSnapshot(input: {
  identity: CompanionPiLayoutIdentity;
  lifecycle: BoxRuntimeLifecycleClient;
  signal: AbortSignal;
  now: () => number;
}): Promise<string | undefined> {
  const snapshots = await input.lifecycle.listNamedSnapshots({
    signal: input.signal,
    deadlineAt: input.now() + 30_000,
  });
  const parents = snapshots
    .filter((snapshot) => snapshot.status === "ready"
      && snapshot.name !== input.identity.imageName
      && isCompanionRuntimeImageName(snapshot.name))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return parents[0]?.name;
}

async function waitBoxReady(input: {
  runtime: Pick<CompanionBoxRuntimeV2, "existingBoxStatus">;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
}, boxId: string): Promise<void> {
  const deadline = input.now() + BOX_READY_TIMEOUT_MS;
  while (input.now() < deadline) {
    input.signal.throwIfAborted();
    const observed = await input.runtime.existingBoxStatus({ boxId, signal: input.signal });
    if (READY_STATES.has(observed.state)) return;
    if (observed.state === "error" || observed.state === "archived") {
      throw new Error("The runtime image baker Box did not become ready.");
    }
    await input.sleep(READY_POLL_INTERVAL_MS, input.signal);
  }
  throw new Error("The runtime image baker Box did not become ready before its deadline.");
}

async function waitNamedSnapshot(input: {
  identity: CompanionPiLayoutIdentity;
  lifecycle: BoxRuntimeLifecycleClient;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
}, name: string) {
  const deadline = input.now() + SNAPSHOT_READY_TIMEOUT_MS;
  while (input.now() < deadline) {
    input.signal.throwIfAborted();
    const snapshot = await input.lifecycle.getNamedSnapshot({
      name,
      signal: input.signal,
      deadlineAt: input.now() + 30_000,
    });
    if (snapshot?.status === "ready" || snapshot?.status === "failed") return snapshot;
    await input.sleep(SNAPSHOT_POLL_INTERVAL_MS, input.signal);
  }
  return input.lifecycle.getNamedSnapshot({
    name,
    signal: input.signal,
    deadlineAt: input.now() + 30_000,
  });
}

async function createBakerBox(
  input: {
    lifecycle: BoxRuntimeLifecycleClient;
    signal: AbortSignal;
    now: () => number;
  },
  parent: string | undefined,
): Promise<{ boxId: string }> {
  try {
    return await input.lifecycle.createEphemeralBox({
      ttlSeconds: BAKER_CREATE_TTL_SECONDS,
      noEnv: true,
      deadlineAt: input.now() + 30_000,
      signal: input.signal,
      ...(parent ? { from: parent } : {}),
    });
  } catch (error) {
    if (!parent || !isUnknownSnapshot(error)) throw error;
    return await input.lifecycle.createEphemeralBox({
      ttlSeconds: BAKER_CREATE_TTL_SECONDS,
      noEnv: true,
      deadlineAt: input.now() + 30_000,
      signal: input.signal,
    });
  }
}

async function pruneStaleImages(input: {
  identity: CompanionPiLayoutIdentity;
  lifecycle: BoxRuntimeLifecycleClient;
  signal: AbortSignal;
  now: () => number;
  keep?: readonly string[];
}): Promise<void> {
  const keep = new Set([input.identity.imageName, ...(input.keep ?? [])]);
  const snapshots = await input.lifecycle.listNamedSnapshots({
    signal: input.signal,
    deadlineAt: input.now() + 30_000,
  });
  const stale = snapshots.filter((snapshot) =>
    isCompanionRuntimeImageName(snapshot.name) && !keep.has(snapshot.name));
  for (const snapshot of stale) {
    await input.lifecycle.deleteNamedSnapshot({
      name: snapshot.name,
      signal: input.signal,
      deadlineAt: input.now() + 30_000,
    }).catch(() => undefined);
  }
}

function isUnknownSnapshot(error: unknown): boolean {
  if (!(error instanceof BoxRuntimeAdapterError)) return false;
  return error.providerCode === "unknown_snapshot" || error.stableCode === "box_not_found";
}

function isSnapshotSaveInFlight(error: unknown): boolean {
  return error instanceof BoxRuntimeAdapterError && error.providerCode === "save_in_progress";
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
