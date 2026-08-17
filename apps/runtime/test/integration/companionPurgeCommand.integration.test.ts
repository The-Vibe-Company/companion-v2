/**
 * Product promise:
 * The one-shot legacy Companion command durably records provider cleanup before it commits the
 * database cutover, and replaying a completed command cannot delete or rediscover anything.
 *
 * Regression caught:
 * The command seeds JSON inventory and target evidence from inside a postgres-js transaction. A
 * serialization mismatch there fails before the provider journal exists, even though the SQL-only
 * finalizer remains valid in isolation.
 *
 * Why integrated:
 * This test creates a fresh PostgreSQL database, applies the real Drizzle migration history, and
 * drives executeConfirmedLegacyPurge through the 0089 SECURITY DEFINER finalizer. A fake provider
 * supplies one exact legacy Box, then models DELETE 404 by returning `absent` and no longer listing
 * it.
 *
 * Failure proof:
 * Breaking either tx.json write, skipping the provider journal transition, or making the completed
 * command non-idempotent fails an assertion against durable rows in the migrated database.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  BoxDeletionOperation,
  BoxMaintenanceBox,
  BoxMaintenanceClient,
  BoxPermanentDeletionResult,
} from "@companion/box-runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectLegacyPurgeInventory,
  executeConfirmedLegacyPurge,
} from "../../src/companionPurge";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Companion purge command test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `purge_cmd_${randomUUID().replaceAll("-", "")}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const upgradeUrl = new URL(databaseUrl);
upgradeUrl.pathname = `/${databaseName}`;
upgradeUrl.search = "";

const boxId = "bx_23456789";
const companionId = randomUUID();
const observedName = `Companion ${companionId}`;

let databaseCreated = false;
let upgradeSql: ReturnType<typeof postgres> | undefined;

async function replayThroughLegacyPurge(client: ReturnType<typeof postgres>): Promise<void> {
  const migrations = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0090_companion_runtime_v2.sql")
    .sort();
  for (const migration of migrations) {
    const statements = (await readFile(`${migrationsDir}/${migration}`, "utf8"))
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    await client.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    });
  }
}

class GoneOnDeleteBoxClient implements BoxMaintenanceClient {
  listCount = 0;
  operationPollCount = 0;
  readonly deletionRequests: string[] = [];
  private present = true;

  async listAllBoxes(): Promise<BoxMaintenanceBox[]> {
    this.listCount += 1;
    return this.present ? [{ id: boxId, name: observedName }] : [];
  }

  async requestPermanentDeletion(input: { boxId: string }): Promise<BoxPermanentDeletionResult> {
    this.deletionRequests.push(input.boxId);
    this.present = false;
    // This is the maintenance client's normalized representation of provider DELETE 404.
    return { outcome: "absent", boxId: input.boxId };
  }

  async getDeletionOperation(): Promise<BoxDeletionOperation> {
    this.operationPollCount += 1;
    throw new Error("an absent Box must never create or poll a deletion operation");
  }
}

describe("legacy Companion purge command at the guarded pre-v2 cutover checkpoint", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    databaseCreated = true;
    // The destructive command must run after 0089 installed its ledger/finalizer and before 0090+
    // make Runtime v2 rows authoritative. Replaying the exact historical checkpoint also proves the
    // final 0094 migration cannot accidentally be required before external Box cleanup.
    const migrationSql = postgres(upgradeUrl.toString(), { max: 1 });
    try {
      await replayThroughLegacyPurge(migrationSql);
    } finally {
      await migrationSql.end({ timeout: 1 });
    }
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });
  }, 90_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    if (databaseCreated) {
      await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    }
    await adminSql.end({ timeout: 1 });
  }, 30_000);

  it("journals an absent provider Box, finalizes once, and replays as already complete", async () => {
    if (!upgradeSql) throw new Error("temporary purge database was not initialized");
    const boxClient = new GoneOnDeleteBoxClient();
    const logs: string[] = [];

    const initialInventory = await collectLegacyPurgeInventory(upgradeSql, boxClient);
    expect(initialInventory.database.rowCounts).toEqual({
      companions: 0,
      runtimePools: 0,
      workspaceAccess: 0,
      memberState: 0,
      threads: 0,
      transcriptEntries: 0,
      reconcileLeases: 0,
      companionTokens: 0,
    });
    expect(initialInventory.targets).toEqual([{
      boxId,
      observedName,
      evidence: ["provider-name:companion"],
      providerPresent: true,
    }]);

    const first = await executeConfirmedLegacyPurge({
      client: upgradeSql,
      boxClient,
      initialInventory,
      log: (message) => logs.push(message),
    });
    expect(first).toEqual({
      already_complete: false,
      companions: 0,
      runtime_pools: 0,
      workspace_access: 0,
      member_state: 0,
      threads: 0,
      transcript_entries: 0,
      reconcile_leases: 0,
      companion_tokens: 0,
    });

    const [run] = await upgradeSql<Array<{
      phase: string;
      completed: boolean;
      inventory: {
        providerBoxCount: number;
        targets: Array<{ boxId: string; evidence: string[] }>;
      };
    }>>`
      select phase, completed_at is not null as completed, inventory
      from companion_legacy_purge_runs
      where id = 'legacy-companion-purge'
    `;
    expect(run).toMatchObject({
      phase: "database_complete",
      completed: true,
      inventory: {
        providerBoxCount: 1,
        targets: [{ boxId, evidence: ["provider-name:companion"] }],
      },
    });

    const [target] = await upgradeSql<Array<{
      state: string;
      evidence: string[];
      attemptCount: number;
      completed: boolean;
    }>>`
      select state, evidence, attempt_count as "attemptCount",
             completed_at is not null as completed
      from companion_legacy_purge_targets
      where box_id = ${boxId}
    `;
    expect(target).toEqual({
      state: "absent",
      evidence: ["provider-name:companion"],
      attemptCount: 1,
      completed: true,
    });
    expect(boxClient.deletionRequests).toEqual([boxId]);
    expect(boxClient.operationPollCount).toBe(0);
    expect(logs.join("\n")).toContain("provider 404, treated as already deleted");

    const replayInventory = await collectLegacyPurgeInventory(upgradeSql, boxClient);
    const second = await executeConfirmedLegacyPurge({
      client: upgradeSql,
      boxClient,
      initialInventory: replayInventory,
      log: (message) => logs.push(message),
    });
    expect(second).toEqual({ already_complete: true });
    expect(boxClient.deletionRequests).toEqual([boxId]);
    expect(boxClient.listCount).toBe(3);
  }, 30_000);
});
