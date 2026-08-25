import {
  RuntimeDatabaseRoleError,
  verifyRuntimeDatabaseRole,
} from "@companion/db/runtime-role";
import postgres, { type Sql } from "postgres";

import type { RuntimeServiceConfig } from "./config";

export { RuntimeDatabaseRoleError, verifyRuntimeDatabaseRole };

export interface RuntimeDatabase {
  sql: Sql;
  verifyRole(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A single runtime statement never legitimately runs longer than this. It caps a wedged query so a
 * stuck connection surfaces as an error instead of silently holding a pool slot forever. Comfortably
 * above every runtime definer's own internal budgets, which are seconds-scale.
 */
export const RUNTIME_DB_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Pool options for the runtime database connection, separated so they can be asserted without
 * opening a real connection. The pool is sized for the claim loop plus each in-flight execution's
 * fenced mutations (concurrency * 2) with headroom (+4) for health, role checks, and shutdown.
 */
export function runtimeDatabasePoolOptions(
  config: RuntimeServiceConfig,
): NonNullable<Parameters<typeof postgres>[1]> {
  return {
    max: config.concurrency * 2 + 4,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: {
      application_name: "companion-runtime",
      statement_timeout: RUNTIME_DB_STATEMENT_TIMEOUT_MS,
    },
    onnotice: () => undefined,
  };
}

export function createRuntimeDatabase(config: RuntimeServiceConfig): RuntimeDatabase {
  const sql = postgres(config.databaseUrl, runtimeDatabasePoolOptions(config));
  let closePromise: Promise<void> | null = null;
  return {
    sql,
    verifyRole: async () => await verifyRuntimeDatabaseRole(sql, config.databaseRole),
    close: () => {
      closePromise ??= sql.end({ timeout: 5 });
      return closePromise;
    },
  };
}
