import { afterAll, describe, expect, it } from "vitest";
import type { SkillDatabaseTable } from "@companion/contracts";
import { SkillDatabaseError } from "@companion/core";
import { SqliteWasmSkillDatabaseRuntime } from "../src";

const runtime = new SqliteWasmSkillDatabaseRuntime(1);
afterAll(() => runtime.close());

const limits = {
  maxBytes: 1024 * 1024,
  // Match the production default so parallel monorepo tests do not mistake WASM cold-start CPU
  // contention for a query timeout. The dedicated non-yielding test uses a 50 ms deadline.
  statementTimeoutMs: 2_000,
  maxResultRows: 100,
  maxResultBytes: 64 * 1024,
};

const stateTable: SkillDatabaseTable = {
  audience: "organization",
  columns: {
    id: { type: "text", nullable: false },
    value: { type: "text", nullable: true },
  },
  primary_key: ["id"],
  unique: [],
};

describe("SQLite WASM skill database runtime", () => {
  it("round-trips a serialized image and returns parameterized rows", async () => {
    const inserted = await runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "INSERT INTO state(id, value) VALUES (?, ?)",
      params: ["ticket-1", "done"],
      mode: "write",
      limits,
    });
    expect(inserted.image).toBeInstanceOf(Buffer);
    expect(inserted.changes).toBe(1);

    const selected = await runtime.execute({
      image: inserted.image,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 1,
      sql: "SELECT id, value FROM state WHERE id = ?",
      params: ["ticket-1"],
      mode: "read",
      limits,
    });
    expect(selected).toMatchObject({
      columns: ["id", "value"],
      rows: [["ticket-1", "done"]],
      readOnly: true,
      image: null,
    });

    await expect(runtime.execute({
      image: inserted.image,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 1,
      sql: "SELECT COUNT(*) FROM state",
      params: [],
      mode: "read",
      limits,
    })).resolves.toMatchObject({ rows: [[1]] });
  });

  it("accepts the 64 variables required by a widest-table optimistic update", async () => {
    const params = Array.from({ length: 64 }, (_, index) => index);
    await expect(runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: `SELECT ${params.map((_, index) => `? AS value_${index}`).join(", ")}`,
      params,
      mode: "read",
      limits,
    })).resolves.toMatchObject({ rows: [params] });
  });

  it("migrates an existing realm additively on open", async () => {
    const first = await runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "INSERT INTO state(id) VALUES (?)",
      params: ["ticket-2"],
      mode: "write",
      limits,
    });
    const migratedTable: SkillDatabaseTable = {
      ...stateTable,
      columns: {
        ...stateTable.columns,
        attempts: { type: "integer", nullable: false, default: 0 },
      },
    };
    const migrated = await runtime.execute({
      image: first.image,
      tables: { state: migratedTable },
      schemaGeneration: 2,
      fileSchemaGeneration: 1,
      sql: "SELECT attempts FROM state WHERE id = ?",
      params: ["ticket-2"],
      mode: "read",
      limits,
    });
    expect(migrated.rows).toEqual([[0]]);
    expect(migrated.image).toBeInstanceOf(Buffer);
  });

  it("rejects authorizer escapes and write statements in read mode", async () => {
    await expect(runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "PRAGMA user_version",
      params: [],
      mode: "write",
      limits,
    })).rejects.toMatchObject({ code: "forbidden_statement" });
    await expect(runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "INSERT INTO state(id) VALUES ('no')",
      params: [],
      mode: "read",
      limits,
    })).rejects.toMatchObject({ code: "forbidden_statement" });
    await expect(runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "SELECT 1",
      params: [],
      mode: "write",
      limits,
    })).rejects.toMatchObject({ code: "forbidden_statement" });
  });

  it("forbids inserts into retired columns and implicit physical-column order", async () => {
    const first = await runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "INSERT INTO state(id, value) VALUES (?, ?)",
      params: ["retired-column", "hidden"],
      mode: "write",
      limits,
    });
    const withoutRetiredValue: SkillDatabaseTable = {
      ...stateTable,
      columns: { id: stateTable.columns.id! },
    };
    const retiredInput = {
      image: first.image,
      tables: { state: withoutRetiredValue },
      schemaGeneration: 2,
      fileSchemaGeneration: 1,
      params: ["new-id", "should-not-write"],
      mode: "write" as const,
      limits,
    };
    await expect(runtime.execute({
      ...retiredInput,
      sql: "INSERT INTO state(id, value) VALUES (?, ?)",
    })).rejects.toMatchObject({ code: "forbidden_statement" });
    await expect(runtime.execute({
      ...retiredInput,
      sql: "INSERT INTO state VALUES (?, ?)",
    })).rejects.toMatchObject({ code: "forbidden_statement" });
  });

  it("terminates non-yielding recursive work and respawns the worker", async () => {
    await expect(runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "WITH RECURSIVE loop(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM loop) SELECT max(x) FROM loop",
      params: [],
      mode: "read",
      limits: { ...limits, statementTimeoutMs: 50 },
    })).rejects.toEqual(expect.objectContaining<Partial<SkillDatabaseError>>({ code: "timeout" }));

    await expect(runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "SELECT 1",
      params: [],
      mode: "read",
      limits,
    })).resolves.toMatchObject({ rows: [[1]] });
  });

  it("bounds queued tasks while a worker is occupied", async () => {
    const constrained = new SqliteWasmSkillDatabaseRuntime(1, {
      maxQueuedTasks: 1,
      maxQueuedBytes: limits.maxBytes,
    });
    try {
      await constrained.execute({
        image: null,
        tables: { state: stateTable },
        schemaGeneration: 1,
        fileSchemaGeneration: 0,
        sql: "SELECT 0",
        params: [],
        mode: "read",
        limits,
      });
      const occupied = constrained.execute({
        image: null,
        tables: { state: stateTable },
        schemaGeneration: 1,
        fileSchemaGeneration: 0,
        sql: "WITH RECURSIVE loop(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM loop) SELECT max(x) FROM loop",
        params: [],
        mode: "read",
        limits: { ...limits, statementTimeoutMs: 100 },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = constrained.execute({
        image: null,
        tables: { state: stateTable },
        schemaGeneration: 1,
        fileSchemaGeneration: 0,
        sql: "SELECT 1",
        params: [],
        mode: "read",
        limits,
      });
      await expect(constrained.execute({
        image: null,
        tables: { state: stateTable },
        schemaGeneration: 1,
        fileSchemaGeneration: 0,
        sql: "SELECT 2",
        params: [],
        mode: "read",
        limits,
      })).rejects.toMatchObject({ code: "overloaded" });
      await expect(occupied).rejects.toMatchObject({ code: "timeout" });
      await expect(queued).resolves.toMatchObject({ rows: [[1]] });
    } finally {
      await constrained.close();
    }
  });

  it("rejects immediately instead of queueing while the caller holds an external lock", async () => {
    const constrained = new SqliteWasmSkillDatabaseRuntime(1);
    try {
      await constrained.execute({
        image: null,
        tables: { state: stateTable },
        schemaGeneration: 1,
        fileSchemaGeneration: 0,
        sql: "SELECT 0",
        params: [],
        mode: "read",
        limits,
      });
      const occupied = constrained.execute({
        image: null,
        tables: { state: stateTable },
        schemaGeneration: 1,
        fileSchemaGeneration: 0,
        sql: "WITH RECURSIVE loop(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM loop) SELECT max(x) FROM loop",
        params: [],
        mode: "read",
        limits: { ...limits, statementTimeoutMs: 100 },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(constrained.execute({
        image: null,
        tables: { state: stateTable },
        schemaGeneration: 1,
        fileSchemaGeneration: 0,
        sql: "SELECT 1",
        params: [],
        mode: "read",
        limits,
        queueIfBusy: false,
      })).rejects.toMatchObject({ code: "overloaded" });
      await expect(occupied).rejects.toMatchObject({ code: "timeout" });
    } finally {
      await constrained.close();
    }
  });

  it("stops respawning after bounded worker startup failures", async () => {
    const unavailable = new SqliteWasmSkillDatabaseRuntime(1, {
      maxStartupFailures: 2,
      restartBaseDelayMs: 1,
      startupTimeoutMs: 1_000,
      workerUrl: new URL("./missing-worker.mjs", import.meta.url),
    });
    try {
      await expect(unavailable.execute({
        image: null,
        tables: { state: stateTable },
        schemaGeneration: 1,
        fileSchemaGeneration: 0,
        sql: "SELECT 1",
        params: [],
        mode: "read",
        limits,
      })).rejects.toMatchObject({ code: "overloaded" });
    } finally {
      await unavailable.close();
    }
  });

  it("fails explicitly instead of truncating oversized results or databases", async () => {
    await expect(runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "SELECT randomblob(131072)",
      params: [],
      mode: "read",
      limits,
    })).rejects.toMatchObject({ code: "result_too_large" });

    await expect(runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "SELECT 1",
      params: [],
      mode: "read",
      limits,
    })).resolves.toMatchObject({ rows: [[1]] });

    await expect(runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "WITH RECURSIVE rows(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM rows WHERE x < 5) SELECT x FROM rows",
      params: [],
      mode: "read",
      limits: { ...limits, maxResultRows: 2 },
    })).rejects.toMatchObject({ code: "result_too_large" });

    await expect(runtime.execute({
      image: null,
      tables: { state: stateTable },
      schemaGeneration: 1,
      fileSchemaGeneration: 0,
      sql: "WITH RECURSIVE rows(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM rows WHERE x < 4) INSERT INTO state(id, value) SELECT printf('large-%d', x), zeroblob(20000) FROM rows",
      params: [],
      mode: "write",
      limits: { ...limits, maxBytes: 32 * 1024 },
    })).rejects.toMatchObject({ code: "database_full" });
  });
});
