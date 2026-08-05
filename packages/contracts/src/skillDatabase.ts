import { z } from "zod";

export const SKILL_DB_MAX_BYTES = 16 * 1024 * 1024;
export const SKILL_DB_STATEMENT_TIMEOUT_MS = 2_000;
export const SKILL_DB_MAX_RESULT_ROWS = 1_000;
export const SKILL_DB_MAX_RESULT_BYTES = 1024 * 1024;
export const SKILL_DB_MAX_SQL_LENGTH = 8_192;
export const SKILL_DB_MAX_PARAMS = 64;
export const SKILL_DB_MAX_PARAM_BYTES = 64 * 1024;
export const SKILL_DB_MAX_DEFAULT_BYTES = 4 * 1024;
export const SKILL_DB_MAX_GENERATED_DDL_BYTES = SKILL_DB_MAX_SQL_LENGTH;
export const SKILL_DB_MAX_TABLES = 16;
export const SKILL_DB_MAX_COLUMNS = 32;
export const SKILL_DB_RATE_LIMIT_PER_MINUTE = 120;

export const skillDatabaseAudienceSchema = z.enum(["organization", "personal"]);
export type SkillDatabaseAudience = z.infer<typeof skillDatabaseAudienceSchema>;

export const skillDatabaseColumnTypeSchema = z.enum([
  "text",
  "integer",
  "real",
  "boolean",
  "json",
  "timestamp",
]);
export type SkillDatabaseColumnType = z.infer<typeof skillDatabaseColumnTypeSchema>;

export const SKILL_DATABASE_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const SQLITE_RESERVED_COLUMN_NAMES = new Set(["rowid", "oid", "_rowid_"]);

export const skillDatabaseDefaultSchema = z.union([
  z.string().max(SKILL_DB_MAX_DEFAULT_BYTES).superRefine((value, ctx) => {
    if (utf8ByteLength(value) > SKILL_DB_MAX_DEFAULT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `database string defaults must not exceed ${SKILL_DB_MAX_DEFAULT_BYTES} bytes`,
      });
    }
  }),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type SkillDatabaseDefault = z.infer<typeof skillDatabaseDefaultSchema>;

export const skillDatabaseColumnSchema = z
  .object({
    type: skillDatabaseColumnTypeSchema,
    nullable: z.boolean().default(true),
    default: skillDatabaseDefaultSchema.optional(),
  })
  .strip()
  .superRefine((column, ctx) => {
    if (!column.nullable && column.default === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: "a non-null database column cannot have a null default",
      });
    }
  });
export type SkillDatabaseColumn = z.infer<typeof skillDatabaseColumnSchema>;

function validDatabaseName(value: string): boolean {
  return SKILL_DATABASE_NAME_RE.test(value) && !value.startsWith("sqlite_");
}

const skillDatabaseColumnRecordSchema = z
  .record(z.string(), skillDatabaseColumnSchema)
  .superRefine((columns, ctx) => {
    const names = Object.keys(columns);
    if (names.length > SKILL_DB_MAX_COLUMNS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `at most ${SKILL_DB_MAX_COLUMNS} columns are allowed`,
      });
    }
    for (const name of names) {
      if (!validDatabaseName(name) || SQLITE_RESERVED_COLUMN_NAMES.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `invalid SQLite column name: ${name}`,
        });
      }
    }
  });

export const skillDatabaseTableSchema = z
  .object({
    audience: skillDatabaseAudienceSchema.default("organization"),
    columns: skillDatabaseColumnRecordSchema,
    primary_key: z.array(z.string()).max(SKILL_DB_MAX_COLUMNS).default([]),
    unique: z.array(z.array(z.string()).min(1).max(SKILL_DB_MAX_COLUMNS)).max(SKILL_DB_MAX_COLUMNS).default([]),
  })
  .strip()
  .superRefine((table, ctx) => {
    const columns = new Set(Object.keys(table.columns));
    if (columns.size === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["columns"], message: "a database table needs at least one column" });
    }
    const constraints = [
      { path: "primary_key", columns: table.primary_key },
      ...table.unique.map((constraint, index) => ({ path: `unique.${index}`, columns: constraint })),
    ];
    for (const constraint of constraints) {
      const seen = new Set<string>();
      for (const name of constraint.columns) {
        if (!columns.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: constraint.path.split("."),
            message: `constraint references undeclared column: ${name}`,
          });
        } else if (seen.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: constraint.path.split("."),
            message: `constraint repeats column: ${name}`,
          });
        }
        seen.add(name);
      }
    }
    for (const name of table.primary_key) {
      if (table.columns[name]?.nullable) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["primary_key"],
          message: `primary-key column must be non-nullable: ${name}`,
        });
      }
    }
  });
export type SkillDatabaseTable = z.infer<typeof skillDatabaseTableSchema>;

export const skillDatabaseDeclarationSchema = z
  .object({
    tables: z.record(z.string(), skillDatabaseTableSchema).default({}),
  })
  .strip()
  .superRefine((database, ctx) => {
    const names = Object.keys(database.tables);
    if (names.length > SKILL_DB_MAX_TABLES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tables"],
        message: `at most ${SKILL_DB_MAX_TABLES} database tables are allowed`,
      });
    }
    for (const name of names) {
      if (!validDatabaseName(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tables", name],
          message: `invalid SQLite table name: ${name}`,
        });
        continue;
      }
      const table = database.tables[name]!;
      if (Object.keys(table.columns).some(
        (columnName) => !validDatabaseName(columnName) || SQLITE_RESERVED_COLUMN_NAMES.has(columnName),
      )) {
        continue;
      }
      const ddl = generateSkillDatabaseCreateTableSql(name, table);
      if (utf8ByteLength(ddl) > SKILL_DB_MAX_GENERATED_DDL_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tables", name],
          message: `generated SQLite table definition must not exceed ${SKILL_DB_MAX_GENERATED_DDL_BYTES} bytes`,
        });
      }
    }
  })
  .default({ tables: {} });
export type SkillDatabaseDeclaration = z.infer<typeof skillDatabaseDeclarationSchema>;

export const skillDatabaseParamSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type SkillDatabaseParam = z.infer<typeof skillDatabaseParamSchema>;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const skillDatabaseStatementInputSchema = z
  .object({
    audience: skillDatabaseAudienceSchema.default("organization"),
    /** Opaque selector for a materialized personal realm shared with the caller. */
    realm_id: z.string().uuid().optional(),
    sql: z.string().min(1).max(SKILL_DB_MAX_SQL_LENGTH),
    params: z.array(skillDatabaseParamSchema).max(SKILL_DB_MAX_PARAMS).default([]),
  })
  .strip()
  .superRefine((value, ctx) => {
    if (value.realm_id && value.audience !== "personal") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["realm_id"],
        message: "realm_id is only valid for personal database realms",
      });
    }
    if (utf8ByteLength(JSON.stringify(value.params)) > SKILL_DB_MAX_PARAM_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params"],
        message: `database parameters must not exceed ${SKILL_DB_MAX_PARAM_BYTES} bytes`,
      });
    }
  });
export type SkillDatabaseStatementInput = z.infer<typeof skillDatabaseStatementInputSchema>;

export type SkillDatabaseStatementMode = "read" | "write";

export interface SkillDatabaseSqlGateResult {
  keyword: "select" | "values" | "with" | "insert" | "update" | "delete";
  readOnly: boolean;
  sql: string;
}

function stripLeadingSqlComments(sql: string): string {
  let remaining = sql.trimStart();
  while (remaining.startsWith("--") || remaining.startsWith("/*")) {
    if (remaining.startsWith("--")) {
      const newline = remaining.indexOf("\n");
      remaining = newline === -1 ? "" : remaining.slice(newline + 1).trimStart();
      continue;
    }
    const end = remaining.indexOf("*/", 2);
    if (end === -1) throw new Error("unterminated SQL comment");
    remaining = remaining.slice(end + 2).trimStart();
  }
  return remaining;
}

function hasNonTerminalSemicolon(sql: string): boolean {
  let quote: "'" | '"' | "`" | "]" | null = null;
  let lineComment = false;
  let blockComment = false;
  let lastSignificant = -1;
  const semicolons: number[] = [];
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    const next = sql[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if ((quote === "]" && char === "]") || (quote !== "]" && char === quote)) {
        if (quote !== "]" && next === char) {
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "[") quote = "]";
    else if (char === ";") semicolons.push(i);
    if (!/\s/.test(char)) lastSignificant = i;
  }
  if (quote || blockComment) throw new Error("unterminated SQL token");
  return semicolons.some((position) => position !== lastSignificant);
}

/**
 * Fast shared rejection gate. The SQLite authorizer remains the security boundary; this gate gives
 * all callers the same deterministic errors before a worker is acquired.
 */
export function gateSkillDatabaseSql(sql: string, mode: SkillDatabaseStatementMode): SkillDatabaseSqlGateResult {
  const normalized = stripLeadingSqlComments(sql);
  if (!normalized) throw new Error("SQL statement is required");
  if (hasNonTerminalSemicolon(normalized)) throw new Error("only one SQL statement is allowed");
  const withoutTerminalSemicolon = normalized.replace(/;\s*$/, "").trimEnd();
  const keyword = /^[a-z]+/i.exec(withoutTerminalSemicolon)?.[0]?.toLowerCase();
  const allowed = mode === "read"
    ? new Set(["select", "values", "with"])
    : new Set(["insert", "update", "delete"]);
  if (!keyword || !allowed.has(keyword)) throw new Error(`SQL statement is not allowed in ${mode} mode`);
  return {
    keyword: keyword as SkillDatabaseSqlGateResult["keyword"],
    readOnly: keyword === "select" || keyword === "values" || (keyword === "with" && mode === "read"),
    sql: withoutTerminalSemicolon,
  };
}

const SQLITE_TYPE_BY_DECLARATION: Record<SkillDatabaseColumnType, string> = {
  text: "TEXT",
  integer: "INTEGER",
  real: "REAL",
  boolean: "INTEGER",
  json: "TEXT",
  timestamp: "TEXT",
};

export function quoteSkillDatabaseIdentifier(identifier: string): string {
  if (!validDatabaseName(identifier) || SQLITE_RESERVED_COLUMN_NAMES.has(identifier)) {
    throw new Error(`invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function sqliteDefault(value: SkillDatabaseDefault): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

export function skillDatabaseColumnSql(name: string, column: SkillDatabaseColumn): string {
  return [
    quoteSkillDatabaseIdentifier(name),
    SQLITE_TYPE_BY_DECLARATION[column.type],
    column.nullable ? null : "NOT NULL",
    column.default !== undefined ? `DEFAULT ${sqliteDefault(column.default)}` : null,
  ].filter(Boolean).join(" ");
}

export function generateSkillDatabaseCreateTableSql(name: string, table: SkillDatabaseTable): string {
  const parts = Object.entries(table.columns).map(([columnName, column]) => skillDatabaseColumnSql(columnName, column));
  if (table.primary_key.length) {
    parts.push(`PRIMARY KEY (${table.primary_key.map(quoteSkillDatabaseIdentifier).join(", ")})`);
  }
  for (const unique of table.unique) {
    parts.push(`UNIQUE (${unique.map(quoteSkillDatabaseIdentifier).join(", ")})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteSkillDatabaseIdentifier(name)} (${parts.join(", ")})`;
}

export interface SkillDatabaseLimits {
  maxBytes: number;
  statementTimeoutMs: number;
  maxResultRows: number;
  maxResultBytes: number;
}

export interface SkillDatabaseStatementResult {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  row_count: number;
  changes: number;
  last_insert_rowid: number | string | null;
  read_only: boolean;
  db_size_bytes: number;
  schema_generation: number;
}

export const skillDatabaseMemberSchema = z.object({
  user_id: z.string(),
  name: z.string(),
  initials: z.string(),
  avatar_url: z.string().nullable(),
});
export type SkillDatabaseMember = z.infer<typeof skillDatabaseMemberSchema>;

export const skillDatabaseDescribeColumnSchema = z.object({
  name: z.string(),
  type: skillDatabaseColumnTypeSchema,
  nullable: z.boolean(),
  default: skillDatabaseDefaultSchema.optional(),
});
export type SkillDatabaseDescribeColumn = z.infer<typeof skillDatabaseDescribeColumnSchema>;

export const skillDatabaseDescribeTableSchema = z.object({
  name: z.string(),
  audience: skillDatabaseAudienceSchema,
  columns: z.array(skillDatabaseDescribeColumnSchema),
  primary_key: z.array(z.string()),
  unique: z.array(z.array(z.string())),
});
export type SkillDatabaseDescribeTable = z.infer<typeof skillDatabaseDescribeTableSchema>;

export const skillDatabaseRealmAccessSchema = z.enum(["organization", "owner", "shared"]);
export type SkillDatabaseRealmAccess = z.infer<typeof skillDatabaseRealmAccessSchema>;

export const skillDatabaseDescribeRealmSchema = z.object({
  id: z.string().uuid(),
  audience: skillDatabaseAudienceSchema,
  owner: skillDatabaseMemberSchema.nullable(),
  access: skillDatabaseRealmAccessSchema,
  size_bytes: z.number().int().nonnegative(),
  schema_generation: z.number().int().nonnegative(),
  last_accessed_at: z.string(),
});
export type SkillDatabaseDescribeRealm = z.infer<typeof skillDatabaseDescribeRealmSchema>;

export const skillDatabaseDescribeResponseSchema = z.object({
  skill_id: z.string(),
  slug: z.string(),
  schema_generation: z.number().int().positive(),
  limits: z.object({
    maxBytes: z.number().int().positive(),
    statementTimeoutMs: z.number().int().positive(),
    maxResultRows: z.number().int().positive(),
    maxResultBytes: z.number().int().positive(),
  }),
  tables: z.array(skillDatabaseDescribeTableSchema),
  realms: z.array(skillDatabaseDescribeRealmSchema),
});
export type SkillDatabaseDescribeResponse = z.infer<typeof skillDatabaseDescribeResponseSchema>;

export const skillDatabaseSharesInputSchema = z
  .object({
    user_ids: z.array(z.string()).max(1_000),
  })
  .strip()
  .superRefine((value, ctx) => {
    if (new Set(value.user_ids).size !== value.user_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["user_ids"],
        message: "database share members must be unique",
      });
    }
  });
export type SkillDatabaseSharesInput = z.infer<typeof skillDatabaseSharesInputSchema>;

export const skillDatabaseSharesResponseSchema = z.object({
  realm_id: z.string().uuid().nullable(),
  members: z.array(skillDatabaseMemberSchema.extend({ shared: z.boolean() })),
});
export type SkillDatabaseSharesResponse = z.infer<typeof skillDatabaseSharesResponseSchema>;
