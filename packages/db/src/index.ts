import { drizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import * as schema from "./schema";

export { schema };
export * from "./schema";

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? "postgres://companion:companion@127.0.0.1:5432/companion";
  return url;
}

const configuredPoolMax = Number.parseInt(process.env.COMPANION_DATABASE_POOL_MAX ?? "10", 10);
const poolMax = Number.isSafeInteger(configuredPoolMax) && configuredPoolMax > 0 ? configuredPoolMax : 10;

export const sql = postgres(getDatabaseUrl(), { max: poolMax });
// Long-lived cross-replica coordination must not occupy the request pool while it waits on Box I/O.
// Two reserved sessions keep unrelated API/database work available even when several Boxes are
// degraded, while still allowing healthy Companions to deliver in parallel.
const advisoryLockSql = postgres(getDatabaseUrl(), { max: 2 });
export const db = drizzle(sql, { schema });
export type Db = typeof db;

/** Hold one process-independent, session-scoped PostgreSQL lock for the duration of `fn`. */
export async function withDatabaseAdvisoryLock<T>(input: {
  key: string;
  namespace: number;
}, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const connection = await advisoryLockSql.reserve();
    let locked = false;
    try {
      const [row] = await connection<{ locked: boolean }[]>`
        select pg_try_advisory_lock(
          hashtextextended(${input.key}, ${input.namespace})
        ) as locked
      `;
      locked = row?.locked === true;
      if (locked) return await fn();
    } finally {
      if (locked) {
        await connection`
          select pg_advisory_unlock(hashtextextended(${input.key}, ${input.namespace}))
        `.catch(() => undefined);
      }
      connection.release();
    }
    // A same-key waiter must not pin this tiny coordination pool. Release its session before the
    // retry so a different Companion can acquire the other key while this delivery remains busy.
    await sleep(25);
  }
}

export async function withTenantContext<T>(
  input: { orgId: string; userId: string },
  fn: (database: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`select
        set_config('app.org_id', ${input.orgId}, true),
        set_config('app.user_id', ${input.userId}, true),
        set_config('app.companion_delivery_protocol', '2', true)`,
    );
    return fn(tx as unknown as Db);
  });
}

export async function closeDb(): Promise<void> {
  await Promise.all([sql.end(), advisoryLockSql.end()]);
}
