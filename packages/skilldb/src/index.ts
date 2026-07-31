import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { SkillDatabaseError, type SkillDatabaseRuntime, type SkillDatabaseRuntimeResult } from "@companion/core";

interface QueuedTask {
  id: string;
  input: Parameters<SkillDatabaseRuntime["execute"]>[0];
  resolve(value: SkillDatabaseRuntimeResult): void;
  reject(error: unknown): void;
}

interface WorkerSlot {
  worker: Worker;
  ready: boolean;
  startupFailures: number;
  startupTimer: NodeJS.Timeout | null;
  task: QueuedTask | null;
  timer: NodeJS.Timeout | null;
}

function poolSizeFromEnv(): number {
  const parsed = Number.parseInt(process.env.COMPANION_SKILL_DB_WORKER_POOL ?? "2", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 32 ? parsed : 2;
}

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function deserializeResult(result: SkillDatabaseRuntimeResult & { image: Uint8Array | null }): SkillDatabaseRuntimeResult {
  return {
    ...result,
    image: result.image ? Buffer.from(result.image) : null,
  };
}

export class SqliteWasmSkillDatabaseRuntime implements SkillDatabaseRuntime {
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: QueuedTask[] = [];
  private readonly maxQueuedTasks: number;
  private readonly maxQueuedBytes: number;
  private readonly maxStartupFailures: number;
  private readonly startupTimeoutMs: number;
  private readonly restartBaseDelayMs: number;
  private readonly workerUrl: URL;
  private readonly pendingRestarts = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(
    size = poolSizeFromEnv(),
    options: {
      maxQueuedTasks?: number;
      maxQueuedBytes?: number;
      maxStartupFailures?: number;
      startupTimeoutMs?: number;
      restartBaseDelayMs?: number;
      workerUrl?: URL;
    } = {},
  ) {
    if (!Number.isSafeInteger(size) || size < 1) throw new Error("skill database worker pool size must be positive");
    this.maxQueuedTasks = options.maxQueuedTasks
      ?? positiveEnv("COMPANION_SKILL_DB_MAX_QUEUED_TASKS", Math.max(4, size * 4));
    this.maxQueuedBytes = options.maxQueuedBytes
      ?? positiveEnv("COMPANION_SKILL_DB_MAX_QUEUED_BYTES", 64 * 1024 * 1024);
    this.maxStartupFailures = options.maxStartupFailures
      ?? positiveEnv("COMPANION_SKILL_DB_MAX_STARTUP_FAILURES", 3);
    this.startupTimeoutMs = options.startupTimeoutMs
      ?? positiveEnv("COMPANION_SKILL_DB_STARTUP_TIMEOUT_MS", 10_000);
    this.restartBaseDelayMs = options.restartBaseDelayMs ?? 100;
    this.workerUrl = options.workerUrl ?? new URL("./worker.mjs", import.meta.url);
    if (!Number.isSafeInteger(this.maxQueuedTasks) || this.maxQueuedTasks < 1) {
      throw new Error("skill database worker queue limit must be positive");
    }
    if (!Number.isSafeInteger(this.maxQueuedBytes) || this.maxQueuedBytes < 1) {
      throw new Error("skill database worker queued-byte limit must be positive");
    }
    if (!Number.isSafeInteger(this.maxStartupFailures) || this.maxStartupFailures < 1) {
      throw new Error("skill database worker startup failure limit must be positive");
    }
    if (!Number.isSafeInteger(this.startupTimeoutMs) || this.startupTimeoutMs < 1) {
      throw new Error("skill database worker startup timeout must be positive");
    }
    if (!Number.isSafeInteger(this.restartBaseDelayMs) || this.restartBaseDelayMs < 1) {
      throw new Error("skill database worker restart delay must be positive");
    }
    for (let index = 0; index < size; index++) this.slots.push(this.createSlot());
  }

  private createSlot(startupFailures = 0): WorkerSlot {
    const slot: WorkerSlot = {
      worker: new Worker(this.workerUrl, {
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      }),
      ready: false,
      startupFailures,
      startupTimer: null,
      task: null,
      timer: null,
    };
    slot.startupTimer = setTimeout(() => {
      this.replaceFailedSlot(slot, new Error("skill database worker startup timed out"));
    }, this.startupTimeoutMs);
    slot.worker.on("message", (message:
      | { ready: true }
      | {
        id: string;
        ok: boolean;
        result?: SkillDatabaseRuntimeResult & { image: Uint8Array | null };
        error?: { code: ConstructorParameters<typeof SkillDatabaseError>[0]; message: string };
      }
    ) => {
      if ("ready" in message) {
        if (slot.startupTimer) clearTimeout(slot.startupTimer);
        slot.startupTimer = null;
        slot.ready = true;
        slot.startupFailures = 0;
        this.dispatch();
        return;
      }
      if (!slot.task || message.id !== slot.task.id) return;
      const task = slot.task;
      this.clearSlot(slot);
      if (message.ok && message.result) task.resolve(deserializeResult(message.result));
      else task.reject(new SkillDatabaseError(message.error?.code ?? "sql_error", message.error?.message ?? "SQLite worker failed"));
      this.dispatch();
    });
    slot.worker.on("error", (error) => this.replaceFailedSlot(slot, error));
    slot.worker.on("exit", (code) => {
      if (!this.closed && code !== 0 && this.slots.includes(slot)) {
        this.replaceFailedSlot(slot, new Error(`SQLite worker exited with code ${code}`));
      }
    });
    return slot;
  }

  private clearSlot(slot: WorkerSlot): void {
    if (slot.startupTimer) clearTimeout(slot.startupTimer);
    if (slot.timer) clearTimeout(slot.timer);
    slot.startupTimer = null;
    slot.timer = null;
    slot.task = null;
  }

  private rejectQueuedIfUnavailable(error: unknown): void {
    if (this.slots.length || this.pendingRestarts.size) return;
    const unavailable = error instanceof SkillDatabaseError
      ? error
      : new SkillDatabaseError("overloaded", "skill database workers are unavailable", { cause: error });
    for (const queued of this.queue.splice(0)) queued.reject(unavailable);
  }

  private replaceFailedSlot(slot: WorkerSlot, error: unknown): void {
    const index = this.slots.indexOf(slot);
    if (index === -1) return;
    const task = slot.task;
    const failedBeforeReady = !slot.ready;
    const startupFailures = slot.startupFailures + 1;
    this.clearSlot(slot);
    this.slots.splice(index, 1);
    void slot.worker.terminate();
    if (task) task.reject(error);
    if (!this.closed && failedBeforeReady && startupFailures <= this.maxStartupFailures) {
      const delayMs = Math.min(2_000, this.restartBaseDelayMs * (2 ** (startupFailures - 1)));
      const timer = setTimeout(() => {
        this.pendingRestarts.delete(timer);
        if (this.closed) return;
        this.slots.splice(Math.min(index, this.slots.length), 0, this.createSlot(startupFailures));
        this.dispatch();
      }, delayMs);
      this.pendingRestarts.add(timer);
    } else if (!this.closed && !failedBeforeReady) {
      this.slots.splice(index, 0, this.createSlot());
    }
    this.rejectQueuedIfUnavailable(error);
    this.dispatch();
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (!slot.ready || slot.task) continue;
      const task = this.queue.shift();
      if (!task) return;
      slot.task = task;
      slot.timer = setTimeout(() => {
        if (slot.task !== task) return;
        const index = this.slots.indexOf(slot);
        this.clearSlot(slot);
        this.slots.splice(index, 1);
        void slot.worker.terminate();
        task.reject(new SkillDatabaseError("timeout", "skill database statement timed out"));
        if (!this.closed) this.slots.splice(index, 0, this.createSlot());
        this.dispatch();
      }, task.input.limits.statementTimeoutMs + 250);
      slot.worker.postMessage({ id: task.id, input: task.input });
    }
  }

  execute(input: Parameters<SkillDatabaseRuntime["execute"]>[0]): Promise<SkillDatabaseRuntimeResult> {
    if (this.closed) return Promise.reject(new Error("skill database runtime is closed"));
    if (input.queueIfBusy === false && !this.slots.some((slot) => slot.ready && !slot.task)) {
      return Promise.reject(
        new SkillDatabaseError("overloaded", "skill database workers are busy; retry later"),
      );
    }
    const queuedBytes = this.queue.reduce(
      (total, task) => total + (task.input.image?.byteLength ?? 0),
      0,
    );
    if (
      this.queue.length >= this.maxQueuedTasks
      || queuedBytes + (input.image?.byteLength ?? 0) > this.maxQueuedBytes
    ) {
      return Promise.reject(
        new SkillDatabaseError("overloaded", "skill database worker queue is full; retry later"),
      );
    }
    return new Promise((resolve, reject) => {
      const task: QueuedTask = { id: randomUUID(), input, resolve, reject };
      const abort = () => {
        const queuedIndex = this.queue.indexOf(task);
        if (queuedIndex >= 0) {
          this.queue.splice(queuedIndex, 1);
          reject(input.signal?.reason ?? new Error("skill database statement aborted"));
          return;
        }
        const slot = this.slots.find((candidate) => candidate.task === task);
        if (slot) this.replaceFailedSlot(slot, input.signal?.reason ?? new Error("skill database statement aborted"));
      };
      if (input.signal?.aborted) {
        abort();
        return;
      }
      input.signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(task);
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.queue.splice(0)) task.reject(new Error("skill database runtime is closed"));
    for (const timer of this.pendingRestarts) clearTimeout(timer);
    this.pendingRestarts.clear();
    await Promise.all(this.slots.splice(0).map(async (slot) => {
      if (slot.startupTimer) clearTimeout(slot.startupTimer);
      if (slot.timer) clearTimeout(slot.timer);
      slot.task?.reject(new Error("skill database runtime is closed"));
      await slot.worker.terminate();
    }));
  }
}
