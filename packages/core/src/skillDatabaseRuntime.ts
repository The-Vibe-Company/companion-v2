import type {
  SkillDatabaseLimits,
  SkillDatabaseParam,
  SkillDatabaseStatementMode,
  SkillDatabaseTable,
} from "@companion/contracts";

export type SkillDatabaseErrorCode =
  | "forbidden_statement"
  | "timeout"
  | "database_full"
  | "result_too_large"
  | "sql_error"
  | "conflict"
  | "overloaded"
  | "storage_unavailable";

export class SkillDatabaseError extends Error {
  readonly code: SkillDatabaseErrorCode;

  constructor(code: SkillDatabaseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SkillDatabaseError";
    this.code = code;
  }
}

export interface SkillDatabaseRuntimeResult {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  changes: number;
  lastInsertRowid: number | string | null;
  readOnly: boolean;
  image: Buffer | null;
  dbSizeBytes: number;
}

/** SQLite execution seam. Core stays independent of the selected engine and worker implementation. */
export interface SkillDatabaseRuntime {
  execute(input: {
    image: Buffer | null;
    tables: Record<string, SkillDatabaseTable>;
    schemaGeneration: number;
    fileSchemaGeneration: number;
    sql: string;
    params: SkillDatabaseParam[];
    mode: SkillDatabaseStatementMode;
    limits: SkillDatabaseLimits;
    signal?: AbortSignal;
    /**
     * When false, reject unless a ready worker can start immediately. Core uses this while holding
     * a PostgreSQL realm lock so the SQLite queue can never consume the application connection pool.
     */
    queueIfBusy?: boolean;
  }): Promise<SkillDatabaseRuntimeResult>;
}

export interface SkillDatabaseStorage {
  get(key: string, signal?: AbortSignal): Promise<{ body: Buffer; etag: string } | null>;
  put(
    key: string,
    body: Buffer,
    condition: { ifMatch?: string; ifNoneMatch?: "*" },
    signal?: AbortSignal,
  ): Promise<{ etag: string | null }>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}
