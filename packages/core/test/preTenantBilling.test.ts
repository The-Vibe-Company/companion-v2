import type { Db } from "@companion/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { listSeatSyncCandidates } from "../src/billingService";

/**
 * Product promise:
 * The billing worker can claim reconciliation candidates with the production postgres-js driver.
 *
 * Regression caught:
 * Passing a JavaScript Date through raw Drizzle SQL reached postgres-js unchanged and failed before PostgreSQL.
 *
 * Why this test is unit-level:
 * This boundary owns SQL parameter encoding; PostgreSQL function behavior is covered by the pre-tenant RLS integration suite.
 *
 * Failure proof:
 * Passing the Date object instead of its ISO timestamptz representation makes the parameter assertion fail.
 */
describe("pre-tenant billing candidate encoding", () => {
  it("serializes the claim timestamp as an ISO timestamptz parameter", async () => {
    const now = new Date("2026-07-16T11:34:21.000Z");
    let captured: SQL | undefined;
    const execute = vi.fn(async (query: SQL) => {
      captured = query;
      return [];
    });

    await listSeatSyncCandidates({
      database: { execute } as unknown as Db,
      now,
      full: false,
      limit: 50,
    });

    expect(captured).toBeDefined();
    const compiled = new PgDialect().sqlToQuery(captured!);
    expect(compiled.sql).toContain("$1::timestamptz");
    expect(compiled.params).toEqual([now.toISOString(), false, 50]);
  });
});
