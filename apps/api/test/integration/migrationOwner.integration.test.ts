/**
 * Fresh deployments apply every migration as a dedicated, non-superuser owner. PostgreSQL permits
 * that role to set a custom GUC at runtime, but rejects a CREATE FUNCTION `SET app.*` clause unless
 * a cluster administrator grants parameter privileges first. Replaying the real files as the real
 * privilege class catches that otherwise CI-only-superuser blind spot.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run as runMigrations } from "../../src/migrate";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("migration-owner integration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `migration_owner_${suffix}`;
const ownerRole = `migration_owner_${suffix}`;
const apiRole = `migration_api_${suffix}`;
const workerRole = `migration_worker_${suffix}`;
const runtimeRole = `migration_runtime_${suffix}`;
const ownerPassword = `migration-owner-${suffix}`;
const processRolePassword = `migration-process-${suffix}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const ownerUrl = new URL(databaseUrl);
ownerUrl.pathname = `/${databaseName}`;
ownerUrl.username = ownerRole;
ownerUrl.password = ownerPassword;
ownerUrl.search = "";
let ownerSql: ReturnType<typeof postgres> | undefined;

describe("dedicated migration owner", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`
      create role ${ownerRole}
      login password '${ownerPassword}' nosuperuser nobypassrls noinherit;
      create role ${apiRole}
      login password '${processRolePassword}' nosuperuser nobypassrls noinherit;
      create role ${workerRole}
      login password '${processRolePassword}' nosuperuser nobypassrls noinherit;
      create role ${runtimeRole}
      login password '${processRolePassword}' nosuperuser nobypassrls noinherit;
    `);
    await adminSql.unsafe(`create database ${databaseName} owner ${ownerRole}`);
    await runMigrations({
      env: {
        DATABASE_MIGRATION_URL: ownerUrl.toString(),
        DATABASE_API_ROLE: apiRole,
        DATABASE_WORKER_ROLE: workerRole,
        DATABASE_COMPANION_RUNTIME_ROLE: runtimeRole,
        COMPANION_MIGRATIONS_DIR: migrationsDir,
      },
    });
    ownerSql = postgres(ownerUrl.toString(), { max: 1 });
  }, 120_000);

  afterAll(async () => {
    await ownerSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists ${databaseName} with (force)`);
    await adminSql.unsafe(`
      drop role if exists ${apiRole};
      drop role if exists ${workerRole};
      drop role if exists ${runtimeRole};
      drop role if exists ${ownerRole};
    `);
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
    const grantTargets = await adminSql<Array<{ role_name: string; can_login: boolean }>>`
      select rolname as role_name, rolcanlogin as can_login
      from pg_catalog.pg_roles
      where rolname in (${apiRole}, ${workerRole}, ${runtimeRole})
      order by rolname
    `;
    expect(grantTargets).toHaveLength(3);
    expect(grantTargets.every((role) => role.can_login === true)).toBe(true);
  });
});
