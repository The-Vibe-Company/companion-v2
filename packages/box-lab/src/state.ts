import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

export type BoxLabBoxState = "provisioning" | "running" | "archiving" | "archived" | "error";
export type BoxLabSetupStatus = "pending" | "running" | "done" | "failed" | null;

export interface BoxLabBoxRecord {
  id: string;
  resourceName: string;
  name?: string;
  state: BoxLabBoxState;
  desktopAvailable: false;
  setupStatus: BoxLabSetupStatus;
  setupError: string | null;
  ttlSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoxLabSnapshotRecord {
  name: string;
  resourceName: string;
  status: "saving" | "ready" | "failed";
  sourceBoxId: string;
  createdAt: string;
  error?: string;
}

export interface BoxLabDeletionRecord {
  id: string;
  targetId: string;
  status: "pending" | "processing" | "blocked" | "completed";
  attemptCount: number;
  requestedAt: string;
  completedAt: string | null;
}

export interface BoxLabPersistedState {
  version: 1;
  workspaceScope: string;
  boxes: BoxLabBoxRecord[];
  snapshots: BoxLabSnapshotRecord[];
  deletions: BoxLabDeletionRecord[];
}

const boxRecordSchema: z.ZodType<BoxLabBoxRecord> = z.object({
  id: z.string(),
  resourceName: z.string(),
  name: z.string().optional(),
  state: z.enum(["provisioning", "running", "archiving", "archived", "error"]),
  desktopAvailable: z.literal(false),
  setupStatus: z.enum(["pending", "running", "done", "failed"]).nullable(),
  setupError: z.string().nullable(),
  ttlSeconds: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const snapshotRecordSchema: z.ZodType<BoxLabSnapshotRecord> = z.object({
  name: z.string(),
  resourceName: z.string(),
  status: z.enum(["saving", "ready", "failed"]),
  sourceBoxId: z.string(),
  createdAt: z.string(),
  error: z.string().optional(),
});

const deletionRecordSchema: z.ZodType<BoxLabDeletionRecord> = z.object({
  id: z.string(),
  targetId: z.string(),
  status: z.enum(["pending", "processing", "blocked", "completed"]),
  attemptCount: z.number(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
});

const persistedStateSchema: z.ZodType<BoxLabPersistedState> = z.object({
  version: z.literal(1),
  workspaceScope: z.string(),
  boxes: z.array(boxRecordSchema),
  snapshots: z.array(snapshotRecordSchema),
  deletions: z.array(deletionRecordSchema),
});

function freshState(workspaceScope: string): BoxLabPersistedState {
  return { version: 1, workspaceScope, boxes: [], snapshots: [], deletions: [] };
}

export class BoxLabStateStore {
  readonly path: string;
  readonly #workspaceScope: string;
  #writeChain = Promise.resolve();

  constructor(stateDirectory: string, workspaceScope: string) {
    this.path = resolve(stateDirectory, "state.json");
    this.#workspaceScope = workspaceScope;
  }

  async load(): Promise<BoxLabPersistedState> {
    let body: string;
    try {
      body = await readFile(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return freshState(this.#workspaceScope);
      }
      throw error;
    }
    let parsed: ReturnType<typeof persistedStateSchema.safeParse>;
    try {
      parsed = persistedStateSchema.safeParse(JSON.parse(body));
    } catch {
      throw new Error("Box Lab state is not valid JSON; run reset after inspecting the file");
    }
    if (!parsed.success || parsed.data.workspaceScope !== this.#workspaceScope) {
      throw new Error("Box Lab state does not match this workspace or schema version");
    }
    return structuredClone(parsed.data);
  }

  async save(state: BoxLabPersistedState): Promise<void> {
    const snapshot = structuredClone(state);
    const write = this.#writeChain.catch(() => undefined).then(async () => {
      await mkdir(resolve(this.path, ".."), { recursive: true });
      const temporary = `${this.path}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    });
    // One failed filesystem write must fail its caller without poisoning every later persistence
    // attempt. Keep an always-settled tail for ordering and await the original write for fidelity.
    this.#writeChain = write.catch(() => undefined);
    await write;
  }
}
