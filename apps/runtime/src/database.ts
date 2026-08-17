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

export function createRuntimeDatabase(config: RuntimeServiceConfig): RuntimeDatabase {
  const sql = postgres(config.databaseUrl, {
    max: Math.max(4, config.concurrency + 2),
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
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
