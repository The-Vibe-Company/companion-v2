import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BoxLabSourceUnavailableError } from "../src/driver";
import { BoxLabService } from "../src/lab";
import { ProcessExecutionError } from "../src/process";
import {
  BoxLabStateStore,
  type BoxLabDeletionRecord,
  type BoxLabPersistedState,
} from "../src/state";
import { FakeDriver } from "./fakeDriver";

const WORKSPACE_SCOPE = "lifecycle-test-0123456789ab";
const RESOURCE_PREFIX = `companion-box-lab-${WORKSPACE_SCOPE}`;

class OperationGate {
  readonly started: Promise<void>;
  readonly #released: Promise<void>;
  #start!: () => void;
  #release!: () => void;

  constructor() {
    this.started = new Promise((resolvePromise) => {
      this.#start = resolvePromise;
    });
    this.#released = new Promise((resolvePromise) => {
      this.#release = resolvePromise;
    });
  }

  async enter(): Promise<void> {
    this.#start();
    await this.#released;
  }

  release(): void {
    this.#release();
  }
}

class BlockingLifecycleDriver extends FakeDriver {
  createGate: OperationGate | undefined;
  stopGate: OperationGate | undefined;
  snapshotGate: OperationGate | undefined;
  deleteCalls = 0;
  snapshotDeleteCalls = 0;
  writeCalls = 0;
  shellCalls = 0;

  override async create(resourceName: string, fromSnapshotResourceName?: string): Promise<void> {
    await this.createGate?.enter();
    await super.create(resourceName, fromSnapshotResourceName);
  }

  override async stop(resourceName: string): Promise<void> {
    await this.stopGate?.enter();
    await super.stop(resourceName);
  }

  override async writeFile(resourceName: string, relativePath: string, content: Uint8Array): Promise<void> {
    this.writeCalls += 1;
    await super.writeFile(resourceName, relativePath, content);
  }

  override async delete(resourceName: string): Promise<void> {
    this.deleteCalls += 1;
    await super.delete(resourceName);
  }

  override async saveSnapshot(resourceName: string, snapshotResourceName: string): Promise<void> {
    await this.snapshotGate?.enter();
    await super.saveSnapshot(resourceName, snapshotResourceName);
  }

  override async deleteSnapshot(snapshotResourceName: string): Promise<void> {
    this.snapshotDeleteCalls += 1;
    await super.deleteSnapshot(snapshotResourceName);
  }

  override async interactiveShell(): Promise<number> {
    this.shellCalls += 1;
    return 0;
  }
}

class FailingSnapshotDriver extends BlockingLifecycleDriver {
  readonly #failure: Error;

  constructor(failure: Error) {
    super();
    this.#failure = failure;
  }

  override async saveSnapshot(): Promise<void> {
    throw this.#failure;
  }
}

class TransientDeleteDriver extends BlockingLifecycleDriver {
  remainingFailures: number;
  onFailure: (() => void) | undefined;

  constructor(failures: number) {
    super();
    this.remainingFailures = failures;
  }

  override async delete(resourceName: string): Promise<void> {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      this.deleteCalls += 1;
      this.onFailure?.();
      throw new ProcessExecutionError("process_failed", "Contained deletion failed transiently");
    }
    await super.delete(resourceName);
  }
}

class BlockingStateStore extends BoxLabStateStore {
  saveGate: OperationGate | undefined;

  override async save(state: BoxLabPersistedState): Promise<void> {
    const gate = this.saveGate;
    this.saveGate = undefined;
    const write = super.save(state);
    await gate?.enter();
    await write;
  }
}

class OneShotFailingStateStore extends BoxLabStateStore {
  nextFailure: Error | undefined;

  override async save(state: BoxLabPersistedState): Promise<void> {
    const failure = this.nextFailure;
    this.nextFailure = undefined;
    if (failure) throw failure;
    await super.save(state);
  }
}

interface TestContext {
  directory: string;
  driver: BlockingLifecycleDriver;
  service: BoxLabService;
  store: BoxLabStateStore;
}

async function context(driver = new BlockingLifecycleDriver()): Promise<TestContext> {
  const directory = await mkdtemp(resolve(tmpdir(), "companion-box-lab-lifecycle-"));
  const store = new BoxLabStateStore(directory, WORKSPACE_SCOPE);
  const service = new BoxLabService({
    driver,
    store,
    resourcePrefix: RESOURCE_PREFIX,
    diagnosticsDirectory: resolve(directory, "diagnostics"),
  });
  await service.initialize();
  return { directory, driver, service, store };
}

async function waitUntil(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runningBox(service: BoxLabService): Promise<string> {
  const created = await service.createBox({});
  await waitUntil(
    async () => (await service.getBox(created.id)).state === "running",
    "the Box to run",
  );
  return created.id;
}

async function readySnapshot(service: BoxLabService, boxId: string, name: string): Promise<void> {
  await service.saveSnapshot(boxId, name);
  await waitUntil(
    async () => (await service.getSnapshot(name)).status === "ready",
    `snapshot ${name} to become ready`,
  );
}

async function completedDeletion(
  service: BoxLabService,
  operation: BoxLabDeletionRecord,
): Promise<BoxLabDeletionRecord> {
  await waitUntil(
    async () => (await service.getDeletion(operation.id)).status === "completed",
    "the deletion to complete",
  );
  return await service.getDeletion(operation.id);
}

describe("Box Lab lifecycle serialization", () => {
  it("reserves the Box lifecycle queue before transitional state persistence settles", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "companion-box-lab-lifecycle-"));
    const driver = new BlockingLifecycleDriver();
    const store = new BlockingStateStore(directory, WORKSPACE_SCOPE);
    const service = new BoxLabService({
      driver,
      store,
      resourcePrefix: RESOURCE_PREFIX,
      diagnosticsDirectory: resolve(directory, "diagnostics"),
    });
    const gate = new OperationGate();
    try {
      await service.initialize();
      const boxId = await runningBox(service);
      store.saveGate = gate;
      const stopping = service.stopBox(boxId);
      await gate.started;

      const deletion = await service.requestDeletion(boxId);
      expect(driver.deleteCalls).toBe(0);

      gate.release();
      await stopping;
      await completedDeletion(service, deletion);
      expect(driver.deleteCalls).toBe(1);
      expect(driver.resources.size).toBe(0);
    } finally {
      gate.release();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("queues permanent deletion behind an in-flight Box create", async () => {
    const driver = new BlockingLifecycleDriver();
    const gate = new OperationGate();
    driver.createGate = gate;
    const test = await context(driver);
    try {
      const created = await test.service.createBox({});
      await gate.started;

      const deletion = await test.service.requestDeletion(created.id);
      expect(driver.deleteCalls).toBe(0);

      gate.release();
      await completedDeletion(test.service, deletion);
      expect(driver.deleteCalls).toBe(1);
      expect(driver.resources.size).toBe(0);
      await expect(test.service.getBox(created.id)).rejects.toMatchObject({ code: "box_not_found" });
    } finally {
      gate.release();
      await test.service.close();
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it("queues permanent deletion behind an in-flight Box archive", async () => {
    const test = await context();
    const gate = new OperationGate();
    try {
      const boxId = await runningBox(test.service);
      test.driver.stopGate = gate;
      await test.service.stopBox(boxId);
      await gate.started;

      const deletion = await test.service.requestDeletion(boxId);
      expect(test.driver.deleteCalls).toBe(0);

      gate.release();
      await completedDeletion(test.service, deletion);
      expect(test.driver.deleteCalls).toBe(1);
      expect(test.driver.resources.size).toBe(0);
    } finally {
      gate.release();
      await test.service.close();
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it("protects a saving snapshot and queues source deletion behind it", async () => {
    const test = await context();
    const gate = new OperationGate();
    try {
      const boxId = await runningBox(test.service);
      test.driver.snapshotGate = gate;
      await test.service.saveSnapshot(boxId, "saving-snapshot");
      await gate.started;

      await expect(test.service.deleteSnapshot("saving-snapshot")).rejects.toMatchObject({
        status: 409,
        code: "save_in_progress",
      });
      const deletion = await test.service.requestDeletion(boxId);
      expect(test.driver.deleteCalls).toBe(0);

      gate.release();
      await completedDeletion(test.service, deletion);
      expect((await test.service.getSnapshot("saving-snapshot")).status).toBe("ready");
      expect(test.driver.deleteCalls).toBe(1);
      await test.service.deleteSnapshot("saving-snapshot");
      expect(test.driver.snapshots.size).toBe(0);
    } finally {
      gate.release();
      await test.service.close();
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it("queues file writes, commands, and the interactive shell behind an in-flight snapshot", async () => {
    const test = await context();
    const gate = new OperationGate();
    try {
      const boxId = await runningBox(test.service);
      test.driver.snapshotGate = gate;
      await test.service.saveSnapshot(boxId, "operation-barrier");
      await gate.started;

      const write = test.service.writeBoxFile({
        boxId,
        path: "queued.txt",
        content: "after snapshot",
      });
      const command = test.service.executeCommand({ boxId, command: "printf queued" });
      const shell = test.service.shell(boxId);
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

      expect(test.driver.writeCalls).toBe(0);
      expect(test.driver.commands).toHaveLength(0);
      expect(test.driver.shellCalls).toBe(0);

      gate.release();
      await Promise.all([write, command, shell]);
      expect(test.driver.writeCalls).toBe(1);
      expect(test.driver.commands).toHaveLength(1);
      expect(test.driver.shellCalls).toBe(1);
      expect((await test.service.getSnapshot("operation-barrier")).status).toBe("ready");
    } finally {
      gate.release();
      await test.service.close();
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it("marks the source Box unavailable when snapshot recovery cannot restart it", async () => {
    const test = await context(new FailingSnapshotDriver(new BoxLabSourceUnavailableError()));
    try {
      const boxId = await runningBox(test.service);
      await test.service.saveSnapshot(boxId, "restart-failed");
      await waitUntil(
        async () => (await test.service.getSnapshot("restart-failed")).status === "failed",
        "the failed snapshot to settle",
      );

      expect(await test.service.getBox(boxId)).toMatchObject({ state: "error" });
      await expect(test.service.executeCommand({ boxId, command: "true" })).rejects.toMatchObject({
        status: 409,
        code: "box_not_running",
      });
    } finally {
      await test.service.close();
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it("keeps the source Box running when snapshot cloning fails but recovery succeeds", async () => {
    const test = await context(new FailingSnapshotDriver(
      new ProcessExecutionError("process_failed", "Box Lab Lima snapshot clone exited unsuccessfully"),
    ));
    try {
      const boxId = await runningBox(test.service);
      await test.service.saveSnapshot(boxId, "clone-failed");
      await waitUntil(
        async () => (await test.service.getSnapshot("clone-failed")).status === "failed",
        "the failed snapshot to settle",
      );

      expect(await test.service.getBox(boxId)).toMatchObject({ state: "running" });
      await expect(test.service.executeCommand({ boxId, command: "true" })).resolves.toMatchObject({
        success: true,
      });
    } finally {
      await test.service.close();
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it("keeps a snapshot until an accepted clone has consumed it", async () => {
    const test = await context();
    const gate = new OperationGate();
    try {
      const sourceBoxId = await runningBox(test.service);
      await readySnapshot(test.service, sourceBoxId, "clone-source");
      test.driver.createGate = gate;

      const clone = await test.service.createBox({ from: "clone-source" });
      await gate.started;
      const deleting = test.service.deleteSnapshot("clone-source");
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

      expect(test.driver.snapshotDeleteCalls).toBe(0);
      expect(test.driver.snapshots.size).toBe(1);
      await expect(test.service.createBox({ from: "clone-source" })).rejects.toMatchObject({
        status: 409,
        code: "snapshot_delete_in_progress",
      });

      gate.release();
      await deleting;
      await waitUntil(
        async () => (await test.service.getBox(clone.id)).state === "running",
        "the accepted clone to run",
      );
      expect(test.driver.snapshotDeleteCalls).toBe(1);
      expect(test.driver.snapshots.size).toBe(0);
      await expect(test.service.getSnapshot("clone-source")).rejects.toMatchObject({
        code: "unknown_snapshot",
      });
    } finally {
      gate.release();
      await test.service.close();
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it("does not serialize clone consumption against an independent snapshot", async () => {
    const test = await context();
    const gate = new OperationGate();
    try {
      const sourceBoxId = await runningBox(test.service);
      await readySnapshot(test.service, sourceBoxId, "blocked-clone-source");
      await readySnapshot(test.service, sourceBoxId, "independent-snapshot");
      test.driver.createGate = gate;

      const clone = await test.service.createBox({ from: "blocked-clone-source" });
      await gate.started;
      await test.service.deleteSnapshot("independent-snapshot");

      expect(test.driver.snapshotDeleteCalls).toBe(1);
      expect(test.driver.snapshots.has(`${RESOURCE_PREFIX}-snapshot-blocked-clone-source`)).toBe(true);
      expect(test.driver.snapshots.has(`${RESOURCE_PREFIX}-snapshot-independent-snapshot`)).toBe(false);

      gate.release();
      await waitUntil(
        async () => (await test.service.getBox(clone.id)).state === "running",
        "the independent clone to run",
      );
    } finally {
      gate.release();
      await test.service.close();
      await rm(test.directory, { recursive: true, force: true });
    }
  });
});

describe("Box Lab deletion recovery", () => {
  it("keeps a retry scheduled when persisting a driver failure initially fails", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "companion-box-lab-lifecycle-"));
    const driver = new TransientDeleteDriver(1);
    const store = new OneShotFailingStateStore(directory, WORKSPACE_SCOPE);
    const service = new BoxLabService({
      driver,
      store,
      resourcePrefix: RESOURCE_PREFIX,
      diagnosticsDirectory: resolve(directory, "diagnostics"),
    });
    const persistenceFailure = new Error("Final deletion persistence failed");
    try {
      await service.initialize();
      const boxId = await runningBox(service);
      driver.onFailure = () => {
        store.nextFailure = persistenceFailure;
      };

      const requested = await service.requestDeletion(boxId);
      const completed = await completedDeletion(service, requested);
      await service.close();

      expect(completed).toMatchObject({ status: "completed", attemptCount: 2 });
      expect(driver.deleteCalls).toBe(2);
      expect(driver.resources.size).toBe(0);
      const diagnostic: unknown = JSON.parse(await readFile(
        resolve(directory, "diagnostics", "latest.json"),
        "utf8",
      ));
      expect(diagnostic).toMatchObject({
        operation: "delete_box",
        cause: {
          code: "process_failed",
          message: "Contained deletion failed transiently",
        },
      });
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases a failed initial persistence so the same deletion can be requested again", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "companion-box-lab-lifecycle-"));
    const driver = new BlockingLifecycleDriver();
    const store = new OneShotFailingStateStore(directory, WORKSPACE_SCOPE);
    const service = new BoxLabService({
      driver,
      store,
      resourcePrefix: RESOURCE_PREFIX,
      diagnosticsDirectory: resolve(directory, "diagnostics"),
    });
    const persistenceFailure = new Error("Initial deletion persistence failed");
    try {
      await service.initialize();
      const boxId = await runningBox(service);
      store.nextFailure = persistenceFailure;

      await expect(service.requestDeletion(boxId)).rejects.toBe(persistenceFailure);
      const [blocked] = (await store.load()).deletions;
      expect(blocked).toMatchObject({ targetId: boxId, status: "blocked", attemptCount: 0 });
      expect(driver.deleteCalls).toBe(0);

      const retried = await service.requestDeletion(boxId);
      const completed = await completedDeletion(service, retried);

      expect(retried.id).toBe(blocked?.id);
      expect(completed).toMatchObject({ status: "completed", attemptCount: 1 });
      expect(driver.deleteCalls).toBe(1);
      expect(driver.resources.size).toBe(0);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries a transient blocked deletion without another DELETE request", async () => {
    const test = await context(new TransientDeleteDriver(1));
    try {
      const boxId = await runningBox(test.service);
      const requested = await test.service.requestDeletion(boxId);
      const completed = await completedDeletion(test.service, requested);

      expect(completed).toMatchObject({ status: "completed", attemptCount: 2 });
      expect(test.driver.deleteCalls).toBe(2);
      expect(test.driver.resources.size).toBe(0);
    } finally {
      await test.service.close();
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it("opens a new bounded retry window when DELETE is repeated for a blocked operation", async () => {
    const driver = new TransientDeleteDriver(3);
    const test = await context(driver);
    try {
      const boxId = await runningBox(test.service);
      const requested = await test.service.requestDeletion(boxId);
      await test.service.close();

      expect(await test.service.getDeletion(requested.id)).toMatchObject({
        status: "blocked",
        attemptCount: 3,
      });
      expect(test.driver.deleteCalls).toBe(3);
      expect(test.driver.resources.size).toBe(1);

      driver.remainingFailures = 0;
      const retried = await test.service.requestDeletion(boxId);
      const completed = await completedDeletion(test.service, retried);

      expect(retried.id).toBe(requested.id);
      expect(completed).toMatchObject({ status: "completed", attemptCount: 4 });
      expect(test.driver.deleteCalls).toBe(4);
      expect(test.driver.resources.size).toBe(0);
    } finally {
      await test.service.close();
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  for (const [status, attemptCount] of [["pending", 0], ["processing", 2], ["blocked", 1]] as const) {
    it(`replays an idempotent ${status} deletion after service restart`, async () => {
      const test = await context();
      const boxId = status === "pending" ? "bx_23456789" : "bx_3456789a";
      const resourceName = `${RESOURCE_PREFIX}-${boxId}`;
      const operationId = status === "pending"
        ? `bdop_${"1".repeat(32)}`
        : `bdop_${"2".repeat(32)}`;
      const now = new Date().toISOString();
      const state: BoxLabPersistedState = {
        version: 1,
        workspaceScope: WORKSPACE_SCOPE,
        boxes: [{
          id: boxId,
          resourceName,
          state: "running",
          desktopAvailable: false,
          setupStatus: "done",
          setupError: null,
          ttlSeconds: 3_600,
          createdAt: now,
          updatedAt: now,
        }],
        snapshots: [],
        deletions: [{
          id: operationId,
          targetId: boxId,
          status,
          attemptCount,
          requestedAt: now,
          completedAt: null,
        }],
      };
      await test.service.close();
      await test.driver.create(resourceName);
      await test.store.save(state);
      const restarted = new BoxLabService({
        driver: test.driver,
        store: test.store,
        resourcePrefix: RESOURCE_PREFIX,
        diagnosticsDirectory: resolve(test.directory, "diagnostics"),
      });
      try {
        await restarted.initialize();
        const completed = await completedDeletion(restarted, state.deletions[0]!);
        expect(completed).toMatchObject({
          status: "completed",
          attemptCount: attemptCount + 1,
        });
        expect(test.driver.resources.size).toBe(0);
        await expect(restarted.getBox(boxId)).rejects.toMatchObject({ code: "box_not_found" });
      } finally {
        await restarted.close();
        await rm(test.directory, { recursive: true, force: true });
      }
    });
  }
});
