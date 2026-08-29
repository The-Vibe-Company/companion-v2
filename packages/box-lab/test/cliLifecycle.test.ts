import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runBoxLabLeasedActivity } from "../src/cliLifecycle";
import { BoxLabService } from "../src/lab";
import { BoxLabStateStore, type BoxLabPersistedState } from "../src/state";
import { FakeDriver } from "./fakeDriver";

class DeletionGate {
  readonly started: Promise<void>;
  readonly #released: Promise<void>;
  #markStarted!: () => void;
  #release!: () => void;

  constructor() {
    this.started = new Promise((resolvePromise) => {
      this.#markStarted = resolvePromise;
    });
    this.#released = new Promise((resolvePromise) => {
      this.#release = resolvePromise;
    });
  }

  async enter(): Promise<void> {
    this.#markStarted();
    await this.#released;
  }

  release(): void {
    this.#release();
  }
}

class BlockingDeletionDriver extends FakeDriver {
  readonly events: string[] = [];
  readonly deletionGate = new DeletionGate();

  override async delete(resourceName: string): Promise<void> {
    this.events.push("delete-started");
    await this.deletionGate.enter();
    await super.delete(resourceName);
    this.events.push("delete-completed");
  }
}

describe("Box Lab CLI lifecycle drain", () => {
  it("drains a resumed deletion before releasing the activity lease", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "companion-box-lab-cli-lifecycle-"));
    const workspaceScope = "cli-lifecycle-test-0123456789ab";
    const resourcePrefix = `companion-box-lab-${workspaceScope}`;
    const deletingBoxId = "bx_23456789";
    const shellBoxId = "bx_3456789a";
    const deletingResource = `${resourcePrefix}-${deletingBoxId}`;
    const shellResource = `${resourcePrefix}-${shellBoxId}`;
    const now = new Date().toISOString();
    const state: BoxLabPersistedState = {
      version: 1,
      workspaceScope,
      boxes: [deletingBoxId, shellBoxId].map((id) => ({
        id,
        resourceName: id === deletingBoxId ? deletingResource : shellResource,
        state: "running",
        desktopAvailable: false,
        setupStatus: "done",
        setupError: null,
        ttlSeconds: 3_600,
        createdAt: now,
        updatedAt: now,
      })),
      snapshots: [],
      deletions: [{
        id: `bdop_${"a".repeat(32)}`,
        targetId: deletingBoxId,
        status: "pending",
        attemptCount: 0,
        requestedAt: now,
        completedAt: null,
      }],
    };
    const store = new BoxLabStateStore(directory, workspaceScope);
    const driver = new BlockingDeletionDriver();
    const service = new BoxLabService({
      driver,
      store,
      resourcePrefix,
      diagnosticsDirectory: resolve(directory, "diagnostics"),
    });
    let releaseCalls = 0;
    try {
      await driver.create(deletingResource);
      await driver.create(shellResource);
      await store.save(state);

      const shell = runBoxLabLeasedActivity({
        lease: { release: async () => { releaseCalls += 1; driver.events.push("lease-released"); } },
        run: async () => await service.shell(shellBoxId),
        drain: async () => await service.close(),
      });
      await driver.deletionGate.started;

      expect(releaseCalls).toBe(0);
      expect(driver.events).toEqual(["delete-started"]);

      driver.deletionGate.release();
      await expect(shell).resolves.toBe(0);
      expect(driver.events).toEqual(["delete-started", "delete-completed", "lease-released"]);
      expect(releaseCalls).toBe(1);
    } finally {
      driver.deletionGate.release();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the lease fail-closed when draining fails", async () => {
    const drainFailure = new Error("drain failed");
    let releaseCalls = 0;

    await expect(runBoxLabLeasedActivity({
      lease: { release: async () => { releaseCalls += 1; } },
      run: async () => 0,
      drain: async () => { throw drainFailure; },
    })).rejects.toBe(drainFailure);
    expect(releaseCalls).toBe(0);
  });

  it("drains exactly once before release when startup fails", async () => {
    const startupFailure = new Error("listen failed");
    const events: string[] = [];

    await expect(runBoxLabLeasedActivity({
      lease: { release: async () => { events.push("lease-released"); } },
      run: async () => {
        events.push("listen");
        throw startupFailure;
      },
      drain: async () => { events.push("handle-closed"); },
    })).rejects.toBe(startupFailure);
    expect(events).toEqual(["listen", "handle-closed", "lease-released"]);
  });
});
