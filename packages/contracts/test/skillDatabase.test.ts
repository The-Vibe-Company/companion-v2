import { describe, expect, it } from "vitest";
import {
  gateSkillDatabaseSql,
  generateSkillDatabaseCreateTableSql,
  skillDatabaseDeclarationSchema,
  skillDatabaseDescribeResponseSchema,
  skillDatabaseSharesInputSchema,
  skillDatabaseSharesResponseSchema,
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
    expect(() => skillDatabaseDeclarationSchema.parse({
      tables: {
        state: {
          columns: { id: { type: "text", nullable: true } },
          primary_key: ["id"],
        },
      },
    })).toThrow(/primary-key column must be non-nullable/);
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

  it("accepts an opaque personal realm selector and rejects it for organization data", () => {
    const realmId = "3da39fa7-a8a4-4d91-a5fc-b09baf73447d";
    expect(skillDatabaseStatementInputSchema.parse({
      audience: "personal",
      realm_id: realmId,
      sql: "SELECT 1",
    }).realm_id).toBe(realmId);
    expect(() => skillDatabaseStatementInputSchema.parse({
      audience: "organization",
      realm_id: realmId,
      sql: "SELECT 1",
    })).toThrow(/only valid for personal/);
    expect(() => skillDatabaseStatementInputSchema.parse({
      audience: "personal",
      realm_id: "predictable-owner-id",
      sql: "SELECT 1",
    })).toThrow();
  });

  it("rejects duplicate realm share recipients", () => {
    expect(skillDatabaseSharesInputSchema.parse({ user_ids: ["u-a", "u-b"] }).user_ids).toEqual(["u-a", "u-b"]);
    expect(() => skillDatabaseSharesInputSchema.parse({ user_ids: ["u-a", "u-a"] })).toThrow(/must be unique/);
  });

  it("validates visible realm ownership and sharing responses", () => {
    const realmId = "3da39fa7-a8a4-4d91-a5fc-b09baf73447d";
    const member = {
      user_id: "user-a",
      name: "Ada Lovelace",
      initials: "AL",
      avatar_url: null,
    };
    expect(skillDatabaseDescribeResponseSchema.parse({
      skill_id: "skill-a",
      slug: "stateful-skill",
      schema_generation: 2,
      limits: {
        maxBytes: 16_777_216,
        statementTimeoutMs: 2_000,
        maxResultRows: 1_000,
        maxResultBytes: 1_048_576,
      },
      tables: [{
        name: "notes",
        audience: "personal",
        columns: [{ name: "id", type: "integer", nullable: false }],
        primary_key: ["id"],
        unique: [],
      }],
      realms: [{
        id: realmId,
        audience: "personal",
        owner: member,
        access: "shared",
        size_bytes: 8_192,
        schema_generation: 2,
        last_accessed_at: "2026-07-31T12:00:00.000Z",
      }],
    }).realms[0]?.access).toBe("shared");
    expect(skillDatabaseSharesResponseSchema.parse({
      realm_id: realmId,
      members: [{ ...member, shared: true }],
    }).members[0]?.shared).toBe(true);
    expect(() => skillDatabaseDescribeResponseSchema.parse({
      skill_id: "skill-a",
      slug: "stateful-skill",
      schema_generation: 1,
      limits: {
        maxBytes: 1,
        statementTimeoutMs: 1,
        maxResultRows: 1,
        maxResultBytes: 1,
      },
      tables: [],
      realms: [{
        id: "not-a-uuid",
        audience: "personal",
        owner: member,
        access: "shared",
        size_bytes: 0,
        schema_generation: 0,
        last_accessed_at: "now",
      }],
    })).toThrow();
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
