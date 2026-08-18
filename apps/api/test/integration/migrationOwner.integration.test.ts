/**
 * Fresh deployments apply every migration as a dedicated, non-superuser owner. PostgreSQL permits
 * that role to set a custom GUC at runtime, but rejects a CREATE FUNCTION `SET app.*` clause unless
 * a cluster administrator grants parameter privileges first. Replaying the real files as the real
 * privilege class catches that otherwise CI-only-superuser blind spot.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("migration-owner integration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `migration_owner_${suffix}`;
const ownerRole = `migration_owner_${suffix}`;
const ownerPassword = `migration-owner-${suffix}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const ownerUrl = new URL(databaseUrl);
ownerUrl.pathname = `/${databaseName}`;
ownerUrl.username = ownerRole;
ownerUrl.password = ownerPassword;
ownerUrl.search = "";
let ownerSql: ReturnType<typeof postgres> | undefined;

async function replayMigrations(client: ReturnType<typeof postgres>): Promise<void> {
  const names = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const name of names) {
    const statements = (await readFile(`${migrationsDir}/${name}`, "utf8"))
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    await client.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    });
  }
}

describe("dedicated migration owner", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`
      create role ${ownerRole}
      login password '${ownerPassword}' nosuperuser nobypassrls noinherit
    `);
    await adminSql.unsafe(`create database ${databaseName} owner ${ownerRole}`);
    ownerSql = postgres(ownerUrl.toString(), { max: 1 });
    await replayMigrations(ownerSql);
  }, 120_000);

  afterAll(async () => {
    await ownerSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists ${databaseName} with (force)`);
    await adminSql.unsafe(`drop role if exists ${ownerRole}`);
    await adminSql.end({ timeout: 1 });
  });

  it("replays without administrator parameter grants or protocol proconfig", async () => {
    if (!ownerSql) throw new Error("migration owner database is not initialized");
    const functions = await ownerSql<Array<{ name: string; config: string[] | null }>>`
      select p.oid::regprocedure::text as name, p.proconfig as config
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace namespace on namespace.oid = p.pronamespace
      where namespace.nspname = 'public'
        and coalesce(array_to_string(p.proconfig, ','), '') ~ 'app\\.companion_.*_protocol'
    `;
    expect(functions).toEqual([]);
  });
});
