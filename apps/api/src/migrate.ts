import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const MIGRATION_LOCK_CLASS_ID = 72_401;
const MIGRATION_LOCK_OBJECT_ID = 20_260_608;
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to apply database migrations");
  }
  return url;
}

async function isReadableMigrationFolder(path: string): Promise<boolean> {
  try {
    await access(join(path, "meta", "_journal.json"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function migrationLockTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.COMPANION_MIGRATION_LOCK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
}

async function acquireMigrationLock(client: ReturnType<typeof postgres>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const [row] = await client<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${MIGRATION_LOCK_CLASS_ID}, ${MIGRATION_LOCK_OBJECT_ID}) as locked
    `;
    if (row?.locked) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for Drizzle migration lock after ${timeoutMs}ms`);
    }
    await sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
  }
}

export async function resolveMigrationsFolder(input?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  scriptDir?: string;
}): Promise<string> {
  const env = input?.env ?? process.env;
  const cwd = input?.cwd ?? process.cwd();
  const scriptDir = input?.scriptDir ?? dirname(fileURLToPath(import.meta.url));
  if (env.COMPANION_MIGRATIONS_DIR) {
    if (await isReadableMigrationFolder(env.COMPANION_MIGRATIONS_DIR)) return env.COMPANION_MIGRATIONS_DIR;
    throw new Error(`COMPANION_MIGRATIONS_DIR does not contain a readable Drizzle journal: ${env.COMPANION_MIGRATIONS_DIR}`);
  }

  const candidates = [
    join(cwd, "packages", "db", "drizzle"),
    join(cwd, "..", "..", "packages", "db", "drizzle"),
    join(scriptDir, "drizzle"),
    join(scriptDir, "..", "..", "..", "packages", "db", "drizzle"),
  ];

  for (const candidate of candidates) {
    if (await isReadableMigrationFolder(candidate)) return candidate;
  }

  throw new Error(`could not find Drizzle migrations folder; checked: ${candidates.join(", ")}`);
}

export async function run(): Promise<void> {
  const migrationsFolder = await resolveMigrationsFolder();
  const client = postgres(databaseUrl(), { max: 1 });
  const database = drizzle(client);
  let lockAcquired = false;

  console.log("Applying Drizzle migrations");
  console.log(`Migrations folder: ${migrationsFolder}`);

  try {
    await acquireMigrationLock(client, migrationLockTimeoutMs());
    lockAcquired = true;
    await migrate(database, { migrationsFolder });
    console.log("Drizzle migrations applied");
  } finally {
    if (lockAcquired) {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_CLASS_ID}, ${MIGRATION_LOCK_OBJECT_ID})`.catch(
        () => undefined,
      );
    }
    await client.end();
  }
}

function isMain(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && pathToFileURL(entrypoint).href === import.meta.url);
}

if (isMain()) {
  run().catch((error: unknown) => {
    console.error("Failed to apply Drizzle migrations");
    if (error instanceof Error) {
      console.error(error.stack ?? error.message);
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  });
}
