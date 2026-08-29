import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BoxLabSourceUnavailableError,
  normalizeGuestFilePath,
  type BoxLabDriver,
  type DriverCommandResult,
} from "./driver";
import { ProcessExecutionError } from "./process";
import {
  BoxLabStateStore,
  type BoxLabBoxRecord,
  type BoxLabDeletionRecord,
  type BoxLabPersistedState,
  type BoxLabSnapshotRecord,
} from "./state";

const BOX_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const SNAPSHOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DELETION_ID_PATTERN = /^bdop_[a-f0-9]{32}$/;
const MAX_COMMAND_SECONDS = 900;
const DELETION_RETRY_DELAYS_MS = [100, 500] as const;

export class BoxLabError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BoxLabError";
    this.status = status;
    this.code = code;
  }
}

export interface BoxLabServiceOptions {
  driver: BoxLabDriver;
  store: BoxLabStateStore;
  resourcePrefix: string;
  diagnosticsDirectory: string;
}

export interface CreateBoxInput {
  ttlSeconds?: number;
  setupScript?: string;
  from?: string;
}

export interface ListBoxesInput {
  cursor: string | null;
  limit: number;
  sort: "asc" | "desc";
}

function newBoxId(existing: ReadonlySet<string>): string {
  for (;;) {
    const entropy = randomBytes(8);
    let suffix = "";
    for (let index = 0; index < 8; index += 1) {
      suffix += BOX_ID_ALPHABET[entropy[index]! % BOX_ID_ALPHABET.length];
    }
    const id = `bx_${suffix}`;
    if (!existing.has(id)) return id;
  }
}

function publicBox(box: BoxLabBoxRecord): Omit<BoxLabBoxRecord, "resourceName" | "createdAt" | "updatedAt"> {
  const result: Omit<BoxLabBoxRecord, "resourceName" | "createdAt" | "updatedAt"> = {
    id: box.id,
    state: box.state,
    desktopAvailable: false,
    setupStatus: box.setupStatus,
    setupError: box.setupError,
    ttlSeconds: box.ttlSeconds,
  };
  if (box.name !== undefined) result.name = box.name;
  return result;
}

function publicSnapshot(snapshot: BoxLabSnapshotRecord): Omit<BoxLabSnapshotRecord, "resourceName"> {
  const result: Omit<BoxLabSnapshotRecord, "resourceName"> = {
    name: snapshot.name,
    status: snapshot.status,
    sourceBoxId: snapshot.sourceBoxId,
    createdAt: snapshot.createdAt,
  };
  if (snapshot.error !== undefined) result.error = snapshot.error;
  return result;
}

interface BoxLabDiagnosticCause {
  code: string;
  message: string;
}

function ttlSeconds(value: number | undefined, fallback = 21_600): number {
  const ttl = value ?? fallback;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 2_592_000) {
    throw new BoxLabError(400, "invalid_request", "ttlSeconds must be between 1 and 2592000");
  }
  return ttl;
}

function safeBoxId(value: string): string {
  if (!BOX_ID_PATTERN.test(value)) throw new BoxLabError(404, "box_not_found", "Box was not found");
  return value;
}

function safeSnapshotName(value: string): string {
  if (!SNAPSHOT_NAME_PATTERN.test(value)) {
    throw new BoxLabError(400, "invalid_request", "Named snapshot name is invalid");
  }
  return value;
}

function deletionRetryDelay(attemptCount: number): number | undefined {
  return DELETION_RETRY_DELAYS_MS[attemptCount - 1];
}

function deletionWindowStartAttemptCount(attemptCount: number): number {
  return attemptCount - (attemptCount % (DELETION_RETRY_DELAYS_MS.length + 1));
}

export class BoxLabService {
  readonly #driver: BoxLabDriver;
  readonly #store: BoxLabStateStore;
  readonly #resourcePrefix: string;
  readonly #diagnosticsDirectory: string;
  #state: BoxLabPersistedState | null = null;
  readonly #background = new Set<Promise<void>>();
  readonly #activeDeletionOperations = new Set<string>();
  readonly #resourceTasks = new Map<string, Promise<void>>();
  readonly #snapshotDeletionTasks = new Map<string, Promise<void>>();

  constructor(options: BoxLabServiceOptions) {
    this.#driver = options.driver;
    this.#store = options.store;
    this.#resourcePrefix = options.resourcePrefix;
    this.#diagnosticsDirectory = options.diagnosticsDirectory;
  }

  get driverKind(): BoxLabDriver["kind"] {
    return this.#driver.kind;
  }

  async initialize(): Promise<void> {
    if (this.#state) return;
    this.#state = await this.#store.load();
    let recovered = false;
    const deletionsToResume: Array<{
      operation: BoxLabDeletionRecord;
      resourceName: string;
      windowStartAttemptCount: number;
    }> = [];
    for (const box of this.#state.boxes) {
      if (box.state === "provisioning" || box.state === "archiving") {
        box.state = "error";
        box.setupStatus = box.setupStatus === "done" ? "done" : "failed";
        box.setupError = "Box Lab lifecycle was interrupted; inspect or delete this Box";
        box.updatedAt = new Date().toISOString();
        recovered = true;
      }
    }
    for (const snapshot of this.#state.snapshots) {
      if (snapshot.status === "saving") {
        snapshot.status = "failed";
        snapshot.error = "Snapshot save was interrupted";
        recovered = true;
      }
    }
    for (const operation of this.#state.deletions) {
      const windowStartAttemptCount = deletionWindowStartAttemptCount(operation.attemptCount);
      const resumable = operation.status === "pending"
        || operation.status === "processing"
        || (
          operation.status === "blocked"
          && operation.attemptCount > windowStartAttemptCount
        );
      if (!resumable) continue;
      const box = this.#state.boxes.find((candidate) => candidate.id === operation.targetId);
      operation.status = "pending";
      operation.completedAt = null;
      deletionsToResume.push({
        operation,
        resourceName: box?.resourceName ?? `${this.#resourcePrefix}-${operation.targetId}`,
        windowStartAttemptCount,
      });
      recovered = true;
    }
    if (recovered) await this.#persist();
    for (const deletion of deletionsToResume) {
      this.#startDeletionWindow(
        this.#state,
        deletion.operation,
        deletion.resourceName,
        deletion.windowStartAttemptCount,
      );
    }
  }

  async #readyState(): Promise<BoxLabPersistedState> {
    await this.initialize();
    return this.#state!;
  }

  async #persist(): Promise<void> {
    if (!this.#state) throw new Error("Box Lab service is not initialized");
    await this.#store.save(this.#state);
  }

  #box(state: BoxLabPersistedState, id: string): BoxLabBoxRecord {
    safeBoxId(id);
    const box = state.boxes.find((candidate) => candidate.id === id);
    if (!box) throw new BoxLabError(404, "box_not_found", "Box was not found");
    return box;
  }

  #queueResources<Result>(resourceNames: readonly string[], action: () => Promise<Result>): Promise<Result> {
    const names = [...new Set(resourceNames)];
    const predecessors = names.map((resourceName) => (
      this.#resourceTasks.get(resourceName)?.catch(() => undefined) ?? Promise.resolve()
    ));
    const operation = Promise.all(predecessors).then(action);
    let task: Promise<void>;
    task = operation
      .then(() => undefined, () => undefined)
      .finally(() => {
        for (const resourceName of names) {
          if (this.#resourceTasks.get(resourceName) === task) {
            this.#resourceTasks.delete(resourceName);
          }
        }
      });
    for (const resourceName of names) this.#resourceTasks.set(resourceName, task);
    return operation;
  }

  #track(task: Promise<void>): void {
    this.#background.add(task);
    void task.then(
      () => this.#background.delete(task),
      () => this.#background.delete(task),
    );
  }

  #schedule(
    operation: string,
    identifiers: Record<string, string>,
    resourceNames: readonly string[],
    action: () => Promise<void>,
  ): void {
    const guardedAction = async (): Promise<void> => {
      try {
        await action();
      } catch (error) {
        const cause: BoxLabDiagnosticCause = error instanceof ProcessExecutionError
          ? { code: error.code, message: error.message.slice(0, 300) }
          : error instanceof BoxLabSourceUnavailableError
            ? { code: error.code, message: error.message }
            : { code: "driver_failure", message: "Contained Box driver operation failed" };
        await this.#writeDiagnostic(operation, identifiers, cause).catch(() => undefined);
      }
    };
    this.#track(this.#queueResources(resourceNames, guardedAction));
  }

  #startDeletionWindow(
    state: BoxLabPersistedState,
    operation: BoxLabDeletionRecord,
    resourceName: string,
    windowStartAttemptCount: number,
    pendingPersist: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    if (this.#activeDeletionOperations.has(operation.id)) return pendingPersist;
    this.#activeDeletionOperations.add(operation.id);
    const retryablePersist = this.#recoverInitialDeletionPersistence(operation, pendingPersist);
    this.#scheduleDeletion(state, operation, resourceName, windowStartAttemptCount, retryablePersist);
    return retryablePersist;
  }

  async #recoverInitialDeletionPersistence(
    operation: BoxLabDeletionRecord,
    pendingPersist: Promise<void>,
  ): Promise<void> {
    try {
      await pendingPersist;
    } catch (error) {
      operation.status = "blocked";
      operation.completedAt = null;
      try {
        await this.#persist();
      } catch {
        // The original persistence failure is the actionable error for this request. A later DELETE
        // can retry from the in-memory blocked operation even if recording that recovery also fails.
      } finally {
        this.#activeDeletionOperations.delete(operation.id);
      }
      throw error;
    }
  }

  #scheduleDeletion(
    state: BoxLabPersistedState,
    operation: BoxLabDeletionRecord,
    resourceName: string,
    windowStartAttemptCount: number,
    pendingPersist: Promise<void> = Promise.resolve(),
  ): void {
    const boxId = operation.targetId;
    this.#schedule("delete_box", { boxId, operationId: operation.id }, [resourceName], async () => {
      await pendingPersist;
      operation.status = "processing";
      operation.attemptCount += 1;
      await this.#persist();
      let retryDelayMs: number | undefined;
      let operationFailed = false;
      let operationFailure: unknown;
      try {
        await this.#driver.delete(resourceName);
        state.boxes = state.boxes.filter((candidate) => candidate.id !== boxId);
        operation.status = "completed";
        operation.completedAt = new Date().toISOString();
      } catch (error) {
        operationFailed = true;
        operationFailure = error;
        operation.status = "blocked";
        retryDelayMs = deletionRetryDelay(operation.attemptCount - windowStartAttemptCount);
      }
      let persistenceFailed = false;
      let persistenceFailure: unknown;
      try {
        await this.#persist();
      } catch (error) {
        persistenceFailed = true;
        persistenceFailure = error;
      } finally {
        if (retryDelayMs === undefined) {
          this.#activeDeletionOperations.delete(operation.id);
        } else {
          this.#scheduleDeletionRetry(
            state,
            operation,
            resourceName,
            windowStartAttemptCount,
            retryDelayMs,
          );
        }
      }
      if (operationFailed) throw operationFailure;
      if (persistenceFailed) throw persistenceFailure;
    });
  }

  #scheduleDeletionRetry(
    state: BoxLabPersistedState,
    operation: BoxLabDeletionRecord,
    resourceName: string,
    windowStartAttemptCount: number,
    delayMs: number,
  ): void {
    const retry = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs)).then(() => {
      if (operation.status === "blocked") {
        this.#scheduleDeletion(state, operation, resourceName, windowStartAttemptCount);
      } else {
        this.#activeDeletionOperations.delete(operation.id);
      }
    });
    this.#track(retry);
  }

  async #writeDiagnostic(
    operation: string,
    identifiers: Record<string, string>,
    cause: BoxLabDiagnosticCause,
  ): Promise<void> {
    await mkdir(this.#diagnosticsDirectory, { recursive: true });
    const diagnostic = {
      ok: false,
      code: "box_lab_driver_failure",
      operation,
      driver: this.#driver.kind,
      at: new Date().toISOString(),
      ...identifiers,
      cause,
    };
    await writeFile(
      resolve(this.#diagnosticsDirectory, "latest.json"),
      `${JSON.stringify(diagnostic, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async close(): Promise<void> {
    while (this.#background.size > 0) {
      await Promise.allSettled(this.#background);
    }
  }

  async listBoxes(input: ListBoxesInput): Promise<{
    boxes: ReturnType<typeof publicBox>[];
    pageInfo: { nextCursor: string | null; hasMore: boolean };
  }> {
    const state = await this.#readyState();
    const ordered = [...state.boxes].sort((left, right) => left.id.localeCompare(right.id));
    if (input.sort === "desc") ordered.reverse();
    const start = input.cursor === null ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(start) || start < 0 || start > ordered.length) {
      throw new BoxLabError(400, "invalid_request", "Box list cursor is invalid");
    }
    const boxes = ordered.slice(start, start + input.limit).map(publicBox);
    const next = start + boxes.length;
    const hasMore = next < ordered.length;
    return { boxes, pageInfo: { nextCursor: hasMore ? String(next) : null, hasMore } };
  }

  async createBox(input: CreateBoxInput): Promise<ReturnType<typeof publicBox>> {
    const state = await this.#readyState();
    const fromName = input.from === undefined ? undefined : safeSnapshotName(input.from);
    const snapshot = fromName === undefined
      ? undefined
      : state.snapshots.find((candidate) => candidate.name === fromName);
    if (input.from !== undefined && (!snapshot || snapshot.status !== "ready")) {
      throw new BoxLabError(404, "unknown_snapshot", "Named snapshot is not ready");
    }
    if (snapshot && this.#snapshotDeletionTasks.has(snapshot.resourceName)) {
      throw new BoxLabError(409, "snapshot_delete_in_progress", "Named snapshot is being deleted");
    }
    const id = newBoxId(new Set(state.boxes.map((box) => box.id)));
    const now = new Date().toISOString();
    const box: BoxLabBoxRecord = {
      id,
      resourceName: `${this.#resourcePrefix}-${id}`,
      state: "provisioning",
      desktopAvailable: false,
      setupStatus: input.setupScript ? "pending" : "done",
      setupError: null,
      ttlSeconds: ttlSeconds(input.ttlSeconds),
      createdAt: now,
      updatedAt: now,
    };
    state.boxes.push(box);
    const pendingPersist = this.#persist();
    const guardedResources = snapshot
      ? [box.resourceName, snapshot.resourceName]
      : [box.resourceName];
    this.#schedule("create_box", { boxId: id }, guardedResources, async () => {
      await pendingPersist;
      try {
        await this.#driver.create(box.resourceName, snapshot?.resourceName);
        if (input.setupScript) {
          box.setupStatus = "running";
          box.updatedAt = new Date().toISOString();
          await this.#persist();
          await this.#driver.writeFile(
            box.resourceName,
            ".box-lab/setup.sh",
            Buffer.from(input.setupScript, "utf8"),
          );
          const setup = await this.#driver.execute({
            resourceName: box.resourceName,
            command: "set -e; chmod 700 \"$HOME/.box-lab/setup.sh\"; exec \"$HOME/.box-lab/setup.sh\"",
            timeoutSeconds: 300,
          });
          if (!setup.success) throw new Error("setup failed");
        }
        box.state = "running";
        box.setupStatus = "done";
        box.setupError = null;
      } catch (error) {
        box.state = "error";
        box.setupStatus = "failed";
        box.setupError = "Contained Box setup failed; inspect Box Lab diagnostics";
        throw error;
      } finally {
        box.updatedAt = new Date().toISOString();
        await this.#persist();
      }
    });
    await pendingPersist;
    return publicBox(box);
  }

  async getBox(boxId: string): Promise<ReturnType<typeof publicBox>> {
    const state = await this.#readyState();
    return publicBox(this.#box(state, boxId));
  }

  async patchBox(boxId: string, input: { name?: string; ttlSeconds?: number }): Promise<ReturnType<typeof publicBox>> {
    const state = await this.#readyState();
    const box = this.#box(state, boxId);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name || name.length > 120) throw new BoxLabError(400, "invalid_request", "Box name is invalid");
      if (state.boxes.some((candidate) => candidate.id !== boxId && candidate.name === name)) {
        throw new BoxLabError(409, "box_name_conflict", "Box name is already in use");
      }
      box.name = name;
    }
    if (input.ttlSeconds !== undefined) box.ttlSeconds = ttlSeconds(input.ttlSeconds);
    box.updatedAt = new Date().toISOString();
    await this.#persist();
    return publicBox(box);
  }

  async writeBoxFile(input: {
    boxId: string;
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
  }): Promise<{ path: string; bytes: number }> {
    const state = await this.#readyState();
    const box = this.#box(state, input.boxId);
    if (box.state !== "running") throw new BoxLabError(409, "box_not_running", "Box is not running");
    let path: string;
    try {
      path = normalizeGuestFilePath(input.path);
    } catch {
      throw new BoxLabError(400, "invalid_request", "Box file path is invalid");
    }
    let content: Buffer;
    if (input.encoding === "base64") {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) {
        throw new BoxLabError(400, "invalid_request", "Box file base64 content is invalid");
      }
      content = Buffer.from(input.content, "base64");
    } else {
      content = Buffer.from(input.content, "utf8");
    }
    await this.#queueResources([box.resourceName], async () => {
      if (box.state !== "running") throw new BoxLabError(409, "box_not_running", "Box is not running");
      await this.#driver.writeFile(box.resourceName, path, content);
    });
    return { path: input.path, bytes: content.byteLength };
  }

  async executeCommand(input: {
    boxId: string;
    command: string;
    timeoutSeconds?: number;
  }): Promise<DriverCommandResult> {
    const state = await this.#readyState();
    const box = this.#box(state, input.boxId);
    if (box.state !== "running") throw new BoxLabError(409, "box_not_running", "Box is not running");
    if (!input.command || input.command.includes("\0") || Buffer.byteLength(input.command, "utf8") > 256 * 1024) {
      throw new BoxLabError(400, "invalid_request", "Box command is invalid");
    }
    const timeout = input.timeoutSeconds ?? 60;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_COMMAND_SECONDS) {
      throw new BoxLabError(400, "invalid_request", `timeoutSeconds must be between 1 and ${MAX_COMMAND_SECONDS}`);
    }
    return await this.#queueResources([box.resourceName], async () => {
      if (box.state !== "running") throw new BoxLabError(409, "box_not_running", "Box is not running");
      return await this.#driver.execute({
        resourceName: box.resourceName,
        command: input.command,
        timeoutSeconds: timeout,
      });
    });
  }

  async stopBox(boxId: string): Promise<ReturnType<typeof publicBox>> {
    const state = await this.#readyState();
    const box = this.#box(state, boxId);
    if (box.state === "archived") return publicBox(box);
    if (box.state !== "running") throw new BoxLabError(409, "box_already_stopping", "Box cannot be stopped now");
    box.state = "archiving";
    box.updatedAt = new Date().toISOString();
    const pendingPersist = this.#persist();
    this.#schedule("stop_box", { boxId }, [box.resourceName], async () => {
      await pendingPersist;
      try {
        await this.#driver.stop(box.resourceName);
        box.state = "archived";
      } catch (error) {
        box.state = "error";
        throw error;
      } finally {
        box.updatedAt = new Date().toISOString();
        await this.#persist();
      }
    });
    await pendingPersist;
    return publicBox(box);
  }

  async resumeBox(boxId: string, input: { ttlSeconds?: number }): Promise<ReturnType<typeof publicBox>> {
    const state = await this.#readyState();
    const box = this.#box(state, boxId);
    if (box.state !== "archived") throw new BoxLabError(409, "box_not_resumable", "Box is not archived");
    box.ttlSeconds = ttlSeconds(input.ttlSeconds, box.ttlSeconds);
    box.state = "provisioning";
    box.updatedAt = new Date().toISOString();
    const pendingPersist = this.#persist();
    this.#schedule("resume_box", { boxId }, [box.resourceName], async () => {
      await pendingPersist;
      try {
        await this.#driver.start(box.resourceName);
        box.state = "running";
      } catch (error) {
        box.state = "error";
        throw error;
      } finally {
        box.updatedAt = new Date().toISOString();
        await this.#persist();
      }
    });
    await pendingPersist;
    return publicBox(box);
  }

  async requestDeletion(boxId: string): Promise<BoxLabDeletionRecord> {
    const state = await this.#readyState();
    const box = this.#box(state, boxId);
    const existing = state.deletions.find((operation) => operation.targetId === boxId && operation.status !== "completed");
    if (existing) {
      if (existing.status === "blocked" && !this.#activeDeletionOperations.has(existing.id)) {
        const windowStartAttemptCount = existing.attemptCount;
        existing.status = "pending";
        existing.completedAt = null;
        const pendingPersist = this.#persist();
        const retryablePersist = this.#startDeletionWindow(
          state,
          existing,
          box.resourceName,
          windowStartAttemptCount,
          pendingPersist,
        );
        await retryablePersist;
      }
      return structuredClone(existing);
    }
    const operation: BoxLabDeletionRecord = {
      id: `bdop_${randomBytes(16).toString("hex")}`,
      targetId: boxId,
      status: "pending",
      attemptCount: 0,
      requestedAt: new Date().toISOString(),
      completedAt: null,
    };
    state.deletions.push(operation);
    const pendingPersist = this.#persist();
    const retryablePersist = this.#startDeletionWindow(
      state,
      operation,
      box.resourceName,
      operation.attemptCount,
      pendingPersist,
    );
    await retryablePersist;
    return structuredClone(operation);
  }

  async getDeletion(operationId: string): Promise<BoxLabDeletionRecord> {
    const state = await this.#readyState();
    if (!DELETION_ID_PATTERN.test(operationId)) {
      throw new BoxLabError(404, "deletion_operation_not_found", "Deletion operation was not found");
    }
    const operation = state.deletions.find((candidate) => candidate.id === operationId);
    if (!operation) throw new BoxLabError(404, "deletion_operation_not_found", "Deletion operation was not found");
    return structuredClone(operation);
  }

  async listSnapshots(): Promise<Array<ReturnType<typeof publicSnapshot>>> {
    const state = await this.#readyState();
    return state.snapshots.map(publicSnapshot).sort((left, right) => left.name.localeCompare(right.name));
  }

  async getSnapshot(nameValue: string): Promise<ReturnType<typeof publicSnapshot>> {
    const state = await this.#readyState();
    const name = safeSnapshotName(nameValue);
    const snapshot = state.snapshots.find((candidate) => candidate.name === name);
    if (!snapshot) throw new BoxLabError(404, "unknown_snapshot", "Named snapshot was not found");
    return publicSnapshot(snapshot);
  }

  async saveSnapshot(boxId: string, nameValue: string): Promise<ReturnType<typeof publicSnapshot>> {
    const state = await this.#readyState();
    const box = this.#box(state, boxId);
    const name = safeSnapshotName(nameValue);
    if (box.state !== "running") throw new BoxLabError(409, "box_not_running", "Box is not running");
    if (state.snapshots.some((candidate) => candidate.name === name)) {
      throw new BoxLabError(409, "save_in_progress", "Named snapshot already exists");
    }
    const snapshot: BoxLabSnapshotRecord = {
      name,
      resourceName: `${this.#resourcePrefix}-snapshot-${name}`,
      status: "saving",
      sourceBoxId: boxId,
      createdAt: new Date().toISOString(),
    };
    state.snapshots.push(snapshot);
    const pendingPersist = this.#persist();
    this.#schedule("save_snapshot", { boxId, snapshot: name }, [box.resourceName], async () => {
      await pendingPersist;
      try {
        await this.#driver.saveSnapshot(box.resourceName, snapshot.resourceName);
        snapshot.status = "ready";
        delete snapshot.error;
      } catch (error) {
        snapshot.status = "failed";
        snapshot.error = "Contained snapshot save failed";
        if (error instanceof BoxLabSourceUnavailableError) {
          box.state = "error";
          box.updatedAt = new Date().toISOString();
        }
        throw error;
      } finally {
        await this.#persist();
      }
    });
    await pendingPersist;
    return publicSnapshot(snapshot);
  }

  async deleteSnapshot(nameValue: string): Promise<void> {
    const state = await this.#readyState();
    const name = safeSnapshotName(nameValue);
    const snapshot = state.snapshots.find((candidate) => candidate.name === name);
    if (!snapshot) return;
    if (snapshot.status === "saving") {
      throw new BoxLabError(409, "save_in_progress", "Named snapshot is still saving");
    }
    const existingDeletion = this.#snapshotDeletionTasks.get(snapshot.resourceName);
    if (existingDeletion) {
      await existingDeletion;
      return;
    }
    const deletion = this.#queueResources([snapshot.resourceName], async () => {
      await this.#driver.deleteSnapshot(snapshot.resourceName);
      state.snapshots = state.snapshots.filter((candidate) => candidate.name !== name);
      await this.#persist();
    });
    this.#snapshotDeletionTasks.set(snapshot.resourceName, deletion);
    this.#track(deletion);
    try {
      await deletion;
    } finally {
      if (this.#snapshotDeletionTasks.get(snapshot.resourceName) === deletion) {
        this.#snapshotDeletionTasks.delete(snapshot.resourceName);
      }
    }
  }

  async shell(boxId: string): Promise<number> {
    const state = await this.#readyState();
    const box = this.#box(state, boxId);
    if (box.state !== "running") throw new BoxLabError(409, "box_not_running", "Box is not running");
    return await this.#queueResources([box.resourceName], async () => {
      if (box.state !== "running") throw new BoxLabError(409, "box_not_running", "Box is not running");
      return await this.#driver.interactiveShell(box.resourceName);
    });
  }

  async reset(): Promise<void> {
    await this.close();
    await this.#driver.reset();
    this.#state = {
      version: 1,
      workspaceScope: (await this.#readyState()).workspaceScope,
      boxes: [],
      snapshots: [],
      deletions: [],
    };
    await this.#persist();
  }
}
