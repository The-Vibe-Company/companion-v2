import { drizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";
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
export const db = drizzle(sql, { schema });
export type Db = typeof db;

export async function withTenantContext<T>(
  input: { orgId: string; userId: string },
  fn: (database: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`select set_config('app.org_id', ${input.orgId}, true), set_config('app.user_id', ${input.userId}, true)`,
    );
    return fn(tx as unknown as Db);
  });
}

export async function closeDb(): Promise<void> {
  await sql.end();
}
