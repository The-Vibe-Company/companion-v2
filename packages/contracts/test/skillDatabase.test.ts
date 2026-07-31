import { describe, expect, it } from "vitest";
import {
  gateSkillDatabaseSql,
  generateSkillDatabaseCreateTableSql,
  skillDatabaseDeclarationSchema,
  skillDatabaseStatementInputSchema,
} from "../src/skillDatabase";
import type { SkillDatabaseStatementResult } from "../src/skillDatabase";

describe("skill database contracts", () => {
  it("normalizes declarations and generates only server-owned DDL", () => {
    const declaration = skillDatabaseDeclarationSchema.parse({
      tables: {
        processed_tickets: {
          audience: "organization",
          columns: {
            ticket_id: { type: "text", nullable: false },
            processed_at: { type: "timestamp" },
            attempts: { type: "integer", nullable: false, default: 0 },
          },
          primary_key: ["ticket_id"],
          unique: [["processed_at", "ticket_id"]],
        },
      },
    });

    expect(generateSkillDatabaseCreateTableSql("processed_tickets", declaration.tables.processed_tickets!)).toBe(
      'CREATE TABLE IF NOT EXISTS "processed_tickets" ("ticket_id" TEXT NOT NULL, "processed_at" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("ticket_id"), UNIQUE ("processed_at", "ticket_id"))',
    );
  });

  it("rejects unsafe names and constraints that reference undeclared columns", () => {
    expect(() => skillDatabaseDeclarationSchema.parse({
      tables: {
        sqlite_shadow: { columns: { id: { type: "text" } } },
      },
    })).toThrow(/invalid SQLite table name/);
    expect(() => skillDatabaseDeclarationSchema.parse({
      tables: {
        state: {
          columns: { rowid: { type: "text" } },
          primary_key: ["missing"],
        },
      },
    })).toThrow(/invalid SQLite column name|undeclared column/);
  });

  it("rejects defaults that cannot be applied by the bounded lazy migration", () => {
    const table = (defaultValue: string | null, nullable = true) => ({
      tables: {
        state: {
          columns: {
            value: { type: "text", nullable, default: defaultValue },
          },
        },
      },
    });

    expect(() => skillDatabaseDeclarationSchema.parse(table(null, false))).toThrow(/cannot have a null default/);
    expect(() => skillDatabaseDeclarationSchema.parse(table("😀".repeat(1_025)))).toThrow(/4096 bytes/);
    expect(() => skillDatabaseDeclarationSchema.parse(table("'".repeat(4_096)))).toThrow(
      /generated SQLite table definition must not exceed 8192 bytes/,
    );
  });

  it("allows one parameterized DML statement and rejects comments hiding forbidden or multiple statements", () => {
    expect(gateSkillDatabaseSql("/* intent */ INSERT INTO state(id) VALUES (?)", "write").keyword).toBe("insert");
    expect(gateSkillDatabaseSql("-- read\nWITH rows AS (SELECT 1) SELECT * FROM rows;", "read").keyword).toBe("with");
    expect(() => gateSkillDatabaseSql("/**/PRAGMA user_version", "write")).toThrow(/not allowed/);
    expect(() => gateSkillDatabaseSql("SELECT 1; DELETE FROM state", "write")).toThrow(/one SQL statement/);
    expect(() => gateSkillDatabaseSql("INSERT INTO state VALUES (1)", "read")).toThrow(/not allowed/);
    expect(() => gateSkillDatabaseSql("WITH row AS (SELECT 1) INSERT INTO state SELECT * FROM row", "write"))
      .toThrow(/not allowed/);
  });

  it("caps SQL and parameter payloads at the wire boundary", () => {
    expect(() => skillDatabaseStatementInputSchema.parse({ sql: "x".repeat(8193) })).toThrow();
    expect(() => skillDatabaseStatementInputSchema.parse({
      sql: "SELECT ?",
      params: ["x".repeat(65 * 1024)],
    })).toThrow(/parameters/);
  });

  it("keeps the exported statement result aligned with the REST wire shape", () => {
    const result = {
      columns: ["id"],
      rows: [[1]],
      row_count: 1,
      changes: 0,
      last_insert_rowid: null,
      read_only: true,
      db_size_bytes: 8_192,
      schema_generation: 2,
    } satisfies SkillDatabaseStatementResult;

    expect(Object.keys(result)).toEqual([
      "columns",
      "rows",
      "row_count",
      "changes",
      "last_insert_rowid",
      "read_only",
      "db_size_bytes",
      "schema_generation",
    ]);
  });
});
