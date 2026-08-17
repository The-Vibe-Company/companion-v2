/**
 * Product promise:
 * The irreversible Runtime v2 migration cannot start until the exact split-role grant contract has
 * succeeded on the same PostgreSQL backend and every former union credential is already inert.
 *
 * Regression caught:
 * Applying 0093 before validating grants strands a deployment on the destructive schema while a
 * missing role/object or still-live legacy login leaves the old executor privileged.
 *
 * Why integrated:
 * Drizzle's migration journal, session GUC lifetime, pg_stat_activity and ACL/default-ACL catalogs
 * are PostgreSQL behavior. String-shape tests cannot prove the two-phase commit boundary.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  RUNTIME_V2_FINAL_CUTOVER_TAG,
  extractRuntimeRoleGrantBlock,
  prepareMigrationPhases,
  resolveRuntimeRoleGrantsFile,
  run as runMigrations,
} from "../../src/migrate";

const adminUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!adminUrl?.trim()) {
  throw new Error("Runtime cutover migration test requires an explicit disposable DATABASE_URL");
}
const requiredAdminUrl: string = adminUrl;

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const adminSql = postgres(requiredAdminUrl, { max: 1 });
const cleanupDatabases: string[] = [];
const cleanupRoles: string[] = [];
const tempDirs: string[] = [];

interface Fixture {
  databaseName: string;
  databaseUrl: string;
  apiRole: string;
  workerRole: string;
  runtimeRole: string;
}

function name(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function createRole(role: string, options?: { login?: boolean; password?: string }): Promise<void> {
  const login = options?.login === false ? "nologin" : "login";
  const password = options?.password ? ` password '${options.password}'` : "";
  await adminSql.unsafe(
    `create role ${role} ${login}${password} nosuperuser nobypassrls noinherit`,
  );
  cleanupRoles.push(role);
}

async function createFixture(): Promise<Fixture> {
  const databaseName = name("runtime_cutover");
  const apiRole = name("cutover_api");
  const workerRole = name("cutover_worker");
  const runtimeRole = name("cutover_runtime");
  await createRole(apiRole);
  await createRole(workerRole);
  await createRole(runtimeRole);
  await adminSql.unsafe(`create database ${databaseName}`);
  cleanupDatabases.push(databaseName);
  const url = new URL(requiredAdminUrl);
  url.pathname = `/${databaseName}`;
  url.search = "";
  return { databaseName, databaseUrl: url.toString(), apiRole, workerRole, runtimeRole };
}

function migrationEnv(fixture: Fixture, retiredRuntimeRole?: string): NodeJS.ProcessEnv {
  return {
    DATABASE_MIGRATION_URL: fixture.databaseUrl,
    DATABASE_API_ROLE: fixture.apiRole,
    DATABASE_WORKER_ROLE: fixture.workerRole,
    DATABASE_COMPANION_RUNTIME_ROLE: fixture.runtimeRole,
    ...(retiredRuntimeRole ? { DATABASE_RETIRED_RUNTIME_ROLE: retiredRuntimeRole } : {}),
    COMPANION_MIGRATIONS_DIR: migrationsDir,
  };
}

async function migrateThrough0092(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });
  const phases = await prepareMigrationPhases(migrationsDir);
  try {
    expect(phases.hasFinalCutover).toBe(true);
    await migrate(drizzle(client), { migrationsFolder: phases.checkpointFolder });
  } finally {
    await client.end({ timeout: 1 });
    await phases.cleanup();
  }
}

async function lastMigration(databaseUrl: string): Promise<number | null> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await client<Array<{ createdAt: string | null }>>`
      select max(created_at)::text as "createdAt" from drizzle.__drizzle_migrations
    `;
    return row?.createdAt === null || row?.createdAt === undefined ? null : Number(row.createdAt);
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function expect0093Absent(databaseUrl: string): Promise<void> {
  expect(await lastMigration(databaseUrl)).toBe(1_788_109_600_000);
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await client<Array<{ legacyTable: string | null }>>`
      select to_regclass('public.companion_runtime_pools')::text as "legacyTable"
    `;
    expect(row?.legacyTable).toBe("companion_runtime_pools");
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function seedLegacyUnionAcl(
  databaseUrl: string,
  role: string,
): Promise<void> {
  const owner = postgres(databaseUrl, { max: 1 });
  try {
    await owner.unsafe(`grant connect on database ${new URL(databaseUrl).pathname.slice(1)} to ${role}`);
    await owner.unsafe(`grant usage on schema public to ${role}`);
    await owner.unsafe(`grant select, insert, update, delete on all tables in schema public to ${role}`);
    await owner.unsafe(`grant update (email) on table public."user" to ${role}`);
    await owner.unsafe(`grant usage, select on all sequences in schema public to ${role}`);
    await owner.unsafe(`grant execute on all functions in schema public to ${role}`);
    await owner.unsafe(
      `alter default privileges in schema public
       grant select, insert, update, delete on tables to ${role}`,
    );
    await owner.unsafe(
      `alter default privileges in schema public grant usage, select on sequences to ${role}`,
    );
    await owner.unsafe(
      `alter default privileges in schema public grant execute on functions to ${role}`,
    );
  } finally {
    await owner.end({ timeout: 1 });
  }
}

afterAll(async () => {
  for (const database of cleanupDatabases.reverse()) {
    await adminSql.unsafe(`drop database if exists ${database} with (force)`);
  }
  for (const role of cleanupRoles.reverse()) {
    await adminSql.unsafe(`drop role if exists ${role}`);
  }
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await adminSql.end({ timeout: 1 });
}, 30_000);

describe("Runtime v2 final migration protocol", () => {
  it("applies a fresh database through 0093 and reruns idempotently without a retired role", async () => {
    const fixture = await createFixture();
    await runMigrations({ env: migrationEnv(fixture) });
    expect(await lastMigration(fixture.databaseUrl)).toBe(1_788_196_000_000);

    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      const [row] = await client<Array<{ legacyTable: string | null }>>`
        select to_regclass('public.companion_runtime_pools')::text as "legacyTable"
      `;
      expect(row?.legacyTable).toBeNull();
    } finally {
      await client.end({ timeout: 1 });
    }

    await expect(runMigrations({ env: migrationEnv(fixture) })).resolves.toBeUndefined();
    expect(await lastMigration(fixture.databaseUrl)).toBe(1_788_196_000_000);
  }, 120_000);

  it("leaves 0093 unapplied when an active role or a grant-block object is missing", async () => {
    const missingRole = await createFixture();
    await adminSql.unsafe(`drop role ${missingRole.runtimeRole}`);
    cleanupRoles.splice(cleanupRoles.indexOf(missingRole.runtimeRole), 1);
    await expect(runMigrations({ env: migrationEnv(missingRole) })).rejects.toThrow("does not exist");
    await expect0093Absent(missingRole.databaseUrl);

    const missingObject = await createFixture();
    const grantsSource = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    const dir = await mkdtemp(join(tmpdir(), "companion-cutover-broken-grants-"));
    tempDirs.push(dir);
    const grantsFile = join(dir, "runtime-role-grants.sql");
    await writeFile(
      grantsFile,
      grantsSource.replace(
        "'public.companion_runtime_gate_status()'::regprocedure",
        "'public.companion_runtime_missing_object()'::regprocedure",
      ),
    );
    await expect(
      runMigrations({
        env: { ...migrationEnv(missingObject), COMPANION_RUNTIME_GRANTS_FILE: grantsFile },
      }),
    ).rejects.toThrow();
    await expect0093Absent(missingObject.databaseUrl);
  }, 120_000);

  it("retires the historical union role before applying 0093 and leaves no direct/default ACL", async () => {
    const fixture = await createFixture();
    await migrateThrough0092(fixture.databaseUrl);
    const retiredRole = name("cutover_retired");
    await createRole(retiredRole);
    await seedLegacyUnionAcl(fixture.databaseUrl, retiredRole);
    await adminSql.unsafe(`alter role ${retiredRole} nologin`);

    await expect(runMigrations({ env: migrationEnv(fixture) }))
      .rejects.toThrow("legacy union runtime role detected but not named for retirement");
    await expect0093Absent(fixture.databaseUrl);
    await runMigrations({ env: migrationEnv(fixture, retiredRole) });
    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      const [attributes] = await client<Array<{ canLogin: boolean }>>`
        select rolcanlogin as "canLogin" from pg_catalog.pg_roles where rolname = ${retiredRole}
      `;
      expect(attributes?.canLogin).toBe(false);
      const [acl] = await client<Array<{
        defaults: number;
        objects: number;
        columns: number;
        functions: number;
        schema: number;
        database: number;
      }>>`
        select
          (select count(*)::int from pg_catalog.pg_default_acl d
            cross join lateral pg_catalog.aclexplode(d.defaclacl) a
            where a.grantee = ${retiredRole}::regrole) as defaults,
          (select count(*)::int from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            cross join lateral pg_catalog.aclexplode(c.relacl) a
            where n.nspname = 'public' and a.grantee = ${retiredRole}::regrole) as objects,
          (select count(*)::int from pg_catalog.pg_attribute attribute
            join pg_catalog.pg_class c on c.oid = attribute.attrelid
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            cross join lateral pg_catalog.aclexplode(attribute.attacl) a
            where n.nspname = 'public' and a.grantee = ${retiredRole}::regrole) as columns,
          (select count(*)::int from pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            cross join lateral pg_catalog.aclexplode(p.proacl) a
            where n.nspname = 'public' and a.grantee = ${retiredRole}::regrole) as functions,
          (select count(*)::int from pg_catalog.pg_namespace n
            cross join lateral pg_catalog.aclexplode(n.nspacl) a
            where n.nspname = 'public' and a.grantee = ${retiredRole}::regrole) as schema,
          (select count(*)::int from pg_catalog.pg_database d
            cross join lateral pg_catalog.aclexplode(d.datacl) a
            where d.datname = current_database()
              and a.grantee = ${retiredRole}::regrole) as database
      `;
      expect(acl).toEqual({
        defaults: 0,
        objects: 0,
        columns: 0,
        functions: 0,
        schema: 0,
        database: 0,
      });
    } finally {
      await client.end({ timeout: 1 });
    }
  }, 120_000);

  it("rejects an absent or spoofed same-connection grant marker before any 0093 DDL", async () => {
    const fixture = await createFixture();
    await migrateThrough0092(fixture.databaseUrl);
    const source = await readFile(join(migrationsDir, `${RUNTIME_V2_FINAL_CUTOVER_TAG}.sql`), "utf8");
    const guard = source.split("--> statement-breakpoint", 1)[0]?.trim();
    if (!guard) throw new Error("0093 no longer has a first-statement grants guard");
    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      await expect(client.unsafe(guard)).rejects.toThrow("grants were not verified");
      await client`select
        set_config('companion.api_role', ${fixture.apiRole}, false),
        set_config('companion.worker_role', ${fixture.workerRole}, false),
        set_config('companion.companion_runtime_role', ${fixture.runtimeRole}, false),
        set_config('companion.retired_runtime_role', '', false),
        set_config('companion.runtime_grants_nonce', ${"0".repeat(32)}, false),
        set_config('companion.runtime_grants_verified', 'v1:verified', false)`;
      await expect(client.unsafe(guard)).rejects.toThrow("grants were not verified");
    } finally {
      await client.end({ timeout: 1 });
    }
    await expect0093Absent(fixture.databaseUrl);
  }, 120_000);

  it("rejects partial role variables and a retired role reused as an active role", async () => {
    const fixture = await createFixture();
    await expect(
      runMigrations({
        env: {
          DATABASE_MIGRATION_URL: fixture.databaseUrl,
          DATABASE_API_ROLE: fixture.apiRole,
          COMPANION_MIGRATIONS_DIR: migrationsDir,
        },
      }),
    ).rejects.toThrow("must be configured together");
    await expect(
      runMigrations({
        env: {
          ...migrationEnv(fixture),
          DATABASE_RETIRED_RUNTIME_ROLE: fixture.runtimeRole,
        },
      }),
    ).rejects.toThrow("must be distinct");
    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      const [row] = await client<Array<{ schemaName: string | null }>>`
        select to_regnamespace('drizzle')::text as "schemaName"
      `;
      expect(row?.schemaName).toBeNull();
    } finally {
      await client.end({ timeout: 1 });
    }
  });

  it("rejects a NOLOGIN retired role while one of its old sessions is still active", async () => {
    const fixture = await createFixture();
    await migrateThrough0092(fixture.databaseUrl);
    const retiredRole = name("cutover_live_retired");
    const password = `legacy-${randomUUID()}`;
    await createRole(retiredRole, { password });
    await seedLegacyUnionAcl(fixture.databaseUrl, retiredRole);
    const retiredUrl = new URL(fixture.databaseUrl);
    retiredUrl.username = retiredRole;
    retiredUrl.password = password;
    const oldSession = postgres(retiredUrl.toString(), { max: 1 });
    try {
      await oldSession`select 1`;
      await adminSql.unsafe(`alter role ${retiredRole} nologin`);
      await expect(runMigrations({ env: migrationEnv(fixture, retiredRole) }))
        .rejects.toThrow("still has active sessions");
      await expect0093Absent(fixture.databaseUrl);
    } finally {
      await oldSession.end({ timeout: 1 });
    }
  }, 120_000);
});
