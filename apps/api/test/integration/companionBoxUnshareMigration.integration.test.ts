/**
 * Product promise:
 * 1 Companion = 1 Box = 1 Pi. After the upgrade no Companion still records the Box a whole workspace
 * shared, so no wake, stop, live status, or thread sync can reach one machine on behalf of several
 * Companions.
 *
 * Regression caught:
 * The restore in 0074 copied each shared pool's runtime onto every Companion in its scope, which is
 * how two Companions in one organization came to record the same Box id in production. A fresh-schema
 * test cannot see that state, because only the replay of 0074 against existing pool rows creates it.
 *
 * Why this test is integrated:
 * The guarantee is a data fact about rows the historical migrations produced, so it replays the real
 * migration history through 0074, seeds the Companion rows that restore left behind, and applies the
 * exact 0075 SQL against PostgreSQL.
 *
 * Failure proof:
 * Dropping the `companion_runtime_pools` predicate, the state reset, or the whole statement makes an
 * assertion fail; so does clearing a Companion that reached a Box of its own.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Companion Box unshare migration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `companion_box_unshare_${randomUUID().replaceAll("-", "")}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const upgradeUrl = new URL(databaseUrl);
upgradeUrl.pathname = `/${databaseName}`;
upgradeUrl.search = "";

const org = randomUUID();
const owner = "unshare-owner";
/** The Box a THE-330 org pool owned, which 0074 then copied onto every Companion in the workspace. */
const sharedBox = "bx_5neg83t4";
/** A Companion that reached a Box of its own, which this migration must leave alone. */
const ownBox = "bx_wn234567";
const shared = { first: randomUUID(), second: randomUUID() };
const solo = randomUUID();

let upgradeSql: ReturnType<typeof postgres>;

interface RuntimeRow {
  boxId: string | null;
  runtimeState: string;
  daemonState: string;
  desktopAvailable: boolean;
  lastError: string | null;
}

async function applyMigrationFile(name: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${name}`, "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) await upgradeSql.unsafe(sql);
  }
}

function runtimeRow(companionId: string): Promise<RuntimeRow[]> {
  return upgradeSql<RuntimeRow[]>`
    select
      box_id as "boxId",
      runtime_state::text as "runtimeState",
      daemon_state::text as "daemonState",
      desktop_available as "desktopAvailable",
      last_error as "lastError"
    from companions
    where id = ${companionId}::uuid
  `;
}

describe("0075 unshares the Box the runtime restore handed every Companion in a workspace", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const historical = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0075_companion_box_unshare.sql")
      .sort();
    for (const migration of historical) await applyMigrationFile(migration);

    await upgradeSql`
      insert into "user" (id, name, email, email_verified)
      values (${owner}, 'Unshare Owner', 'unshare@example.test', true)
    `;
    await upgradeSql`
      insert into organizations (id, name, slug, kind)
      values (${org}::uuid, 'Unshare Org', ${`unshare-${org}`}, 'team')
    `;
    await upgradeSql`
      insert into memberships (org_id, user_id, org_role)
      values (${org}::uuid, ${owner}, 'owner')
    `;
    // The pool row 0074 left in place, unused, and the runtime it copied onto each Companion.
    await upgradeSql`
      insert into companion_runtime_pools (org_id, scope, owner_id, box_id, runtime_state, daemon_state)
      values (${org}::uuid, 'org', null, ${sharedBox}, 'running', 'running')
    `;
    for (const [name, id] of [["Smoke 5", shared.first], ["Smoke 6", shared.second]] as const) {
      await upgradeSql`
        insert into companions (
          id, org_id, owner_id, name, box_id, runtime_state, daemon_state, desktop_available, last_error
        ) values (
          ${id}::uuid, ${org}::uuid, ${owner}, ${name}, ${sharedBox}, 'running', 'running', true,
          ${"Pi event log could not be read from Box (exit 1): {\"type\":\"extension_ui_request\"}"}
        )
      `;
    }
    await upgradeSql`
      insert into companions (
        id, org_id, owner_id, name, box_id, runtime_state, daemon_state, desktop_available
      ) values (
        ${solo}::uuid, ${org}::uuid, ${owner}, 'Own machine', ${ownBox}, 'running', 'running', true
      )
    `;

    await applyMigrationFile("0075_companion_box_unshare.sql");
  }, 60_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 1 });
  });

  it("drops the shared Box from every Companion that recorded it and resets the chip", async () => {
    for (const companionId of [shared.first, shared.second]) {
      const [row] = await runtimeRow(companionId);
      expect(row).toEqual({
        boxId: null,
        // No machine to be running on, so the chip cannot read Online against nothing, and the
        // reason the shared machine recorded does not outlive it either.
        runtimeState: "not_created",
        daemonState: "unknown",
        desktopAvailable: false,
        lastError: null,
      });
    }
  });

  it("leaves a Companion that reached a Box of its own untouched", async () => {
    const [row] = await runtimeRow(solo);
    expect(row).toMatchObject({ boxId: ownBox, runtimeState: "running", daemonState: "running" });
  });

  it("keeps the retired pool row in place rather than dropping it", async () => {
    const [pool] = await upgradeSql<{ boxId: string | null }[]>`
      select box_id as "boxId" from companion_runtime_pools where org_id = ${org}::uuid
    `;
    expect(pool?.boxId).toBe(sharedBox);
  });
});
