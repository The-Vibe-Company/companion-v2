import { parentPort } from "node:worker_threads";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const sqlite3 = await sqlite3InitModule();

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier) || identifier.startsWith("sqlite_")) {
    throw Object.assign(new Error(`invalid SQLite identifier: ${identifier}`), { code: "forbidden_statement" });
  }
  return `"${identifier}"`;
}

const typeSql = {
  text: "TEXT",
  integer: "INTEGER",
  real: "REAL",
  boolean: "INTEGER",
  json: "TEXT",
  timestamp: "TEXT",
};

function defaultSql(value) {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function columnSql(name, column) {
  return [
    quoteIdentifier(name),
    typeSql[column.type],
    column.nullable ? null : "NOT NULL",
    column.default !== undefined ? `DEFAULT ${defaultSql(column.default)}` : null,
  ].filter(Boolean).join(" ");
}

function createTableSql(name, table) {
  const parts = Object.entries(table.columns).map(([columnName, column]) => columnSql(columnName, column));
  if (table.primary_key.length) {
    parts.push(`PRIMARY KEY (${table.primary_key.map(quoteIdentifier).join(", ")})`);
  }
  for (const unique of table.unique) {
    parts.push(`UNIQUE (${unique.map(quoteIdentifier).join(", ")})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(name)} (${parts.join(", ")})`;
}

function simpleIdentifier(token) {
  const trimmed = token.trim();
  const unquoted = (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("`") && trimmed.endsWith("`"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
  )
    ? trimmed.slice(1, -1)
    : trimmed;
  return /^[a-z][a-z0-9_]{0,62}$/i.test(unquoted) ? unquoted.toLowerCase() : null;
}

/**
 * SQLITE_INSERT authorizer callbacks expose only the table, not target columns. Require an explicit
 * simple column list and validate it against the active declaration so retired physical columns
 * and implicit physical-column order can never be written.
 */
function assertInsertTargetsDeclaredColumns(sql, tables) {
  if (!/^insert\b/i.test(sql)) return;
  const match = /^insert\s+(?:or\s+(?:rollback|abort|replace|fail|ignore)\s+)?into\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z][a-z0-9_]*))\s*\(([^)]*)\)/i.exec(sql);
  const tableName = match ? simpleIdentifier(match[1]) : null;
  const declared = tableName ? tables[tableName] : null;
  const columns = match?.[2].split(",").map(simpleIdentifier) ?? [];
  if (
    !declared
    || columns.length === 0
    || columns.some((column) => !column || !(column in declared.columns))
  ) {
    throw Object.assign(
      new Error("INSERT must name only active declared columns explicitly"),
      { code: "forbidden_statement" },
    );
  }
}

function toWireValue(value) {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

function resultBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function errorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not authorized|authorization denied/i.test(message)) return "forbidden_statement";
  if (/database or disk is full|SQLITE_FULL/i.test(message)) return "database_full";
  if (/string or blob too big|SQLITE_TOOBIG/i.test(message)) return "result_too_large";
  return error?.code ?? "sql_error";
}

function deserialize(db, image, maxBytes) {
  if (!image?.byteLength) return;
  if (image.byteLength > maxBytes) throw Object.assign(new Error("skill database exceeds its size limit"), { code: "database_full" });
  const pointer = sqlite3.capi.sqlite3_malloc(maxBytes);
  if (!pointer) throw new Error("could not allocate SQLite image");
  sqlite3.wasm.heap8u().set(image, pointer);
  const rc = sqlite3.capi.sqlite3_deserialize(
    db,
    "main",
    pointer,
    image.byteLength,
    maxBytes,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc !== sqlite3.capi.SQLITE_OK) {
    sqlite3.capi.sqlite3_free(pointer);
    throw new Error(`could not deserialize SQLite image: ${sqlite3.capi.sqlite3_js_rc_str(rc) ?? rc}`);
  }
}

function configureDatabase(db, limits) {
  sqlite3.capi.sqlite3_db_config(db, sqlite3.capi.SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0);
  sqlite3.capi.sqlite3_db_config(db, sqlite3.capi.SQLITE_DBCONFIG_DEFENSIVE, 1);
  sqlite3.capi.sqlite3_limit(db, sqlite3.capi.SQLITE_LIMIT_SQL_LENGTH, 8_192);
  sqlite3.capi.sqlite3_limit(db, sqlite3.capi.SQLITE_LIMIT_LENGTH, limits.maxResultBytes);
  sqlite3.capi.sqlite3_limit(db, sqlite3.capi.SQLITE_LIMIT_VARIABLE_NUMBER, 32);
  sqlite3.capi.sqlite3_limit(db, sqlite3.capi.SQLITE_LIMIT_ATTACHED, 0);
  const pageSize = Number(db.selectValue("PRAGMA page_size") ?? 4096);
  const maxPages = Math.max(1, Math.floor(limits.maxBytes / pageSize));
  db.exec(`PRAGMA max_page_count = ${maxPages}`);
}

function migrate(db, tables, schemaGeneration) {
  const currentGeneration = Number(db.selectValue("PRAGMA user_version") ?? 0);
  if (currentGeneration >= schemaGeneration) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [tableName, table] of Object.entries(tables)) {
      db.exec(createTableSql(tableName, table));
      const existing = new Set(
        db.selectObjects(`PRAGMA table_info(${quoteIdentifier(tableName)})`).map((column) => String(column.name)),
      );
      for (const [columnName, column] of Object.entries(table.columns)) {
        if (!existing.has(columnName)) {
          db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${columnSql(columnName, column)}`);
        }
      }
    }
    db.exec(`PRAGMA user_version = ${schemaGeneration}`);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original migration error is the useful failure.
    }
    throw error;
  }
}

function installAuthorizer(db, tables) {
  const declared = new Map(
    Object.entries(tables).map(([name, table]) => [name, new Set(Object.keys(table.columns))]),
  );
  const generallyAllowed = new Set([
    sqlite3.capi.SQLITE_SELECT,
    sqlite3.capi.SQLITE_FUNCTION,
    sqlite3.capi.SQLITE_RECURSIVE,
  ]);
  sqlite3.capi.sqlite3_set_authorizer(
    db,
    (_context, action, arg1, arg2) => {
      if (generallyAllowed.has(action)) return sqlite3.capi.SQLITE_OK;
      if (action === sqlite3.capi.SQLITE_READ) {
        const columns = declared.get(String(arg1));
        // SQLite reports an empty column name for table-level reads such as COUNT(*). The table
        // still has to be declared; non-empty names remain restricted to declared columns.
        return columns && (!arg2 || columns.has(String(arg2)))
          ? sqlite3.capi.SQLITE_OK
          : sqlite3.capi.SQLITE_DENY;
      }
      if (
        action === sqlite3.capi.SQLITE_INSERT
        || action === sqlite3.capi.SQLITE_DELETE
      ) {
        return declared.has(String(arg1)) ? sqlite3.capi.SQLITE_OK : sqlite3.capi.SQLITE_DENY;
      }
      if (action === sqlite3.capi.SQLITE_UPDATE) {
        return declared.get(String(arg1))?.has(String(arg2))
          ? sqlite3.capi.SQLITE_OK
          : sqlite3.capi.SQLITE_DENY;
      }
      return sqlite3.capi.SQLITE_DENY;
    },
    0,
  );
}

async function execute(input) {
  const db = new sqlite3.oo1.DB(":memory:", "c");
  try {
    deserialize(db, input.image ? new Uint8Array(input.image) : null, input.limits.maxBytes);
    configureDatabase(db, input.limits);
    const migrated = migrate(db, input.tables, input.schemaGeneration);
    if (input.mode === "read") db.exec("PRAGMA query_only = ON");
    installAuthorizer(db, input.tables);
    assertInsertTargetsDeclaredColumns(input.sql, input.tables);

    const statement = db.prepare(input.sql);
    let readOnly = true;
    const rows = [];
    let columns = [];
    let totalResultBytes = 0;
    try {
      if (statement.parameterCount !== input.params.length) {
        throw new Error(`SQL expects ${statement.parameterCount} parameters but received ${input.params.length}`);
      }
      if (input.params.length) statement.bind(input.params);
      readOnly = sqlite3.capi.sqlite3_stmt_readonly(statement) !== 0;
      if (input.mode === "read" && !readOnly) {
        throw Object.assign(new Error("query endpoint accepts read-only SQL only"), { code: "forbidden_statement" });
      }
      if (input.mode === "write" && readOnly) {
        throw Object.assign(new Error("execute endpoint accepts INSERT, UPDATE, or DELETE SQL only"), { code: "forbidden_statement" });
      }
      columns = statement.columnCount ? statement.getColumnNames([]) : [];
      while (statement.step()) {
        if (rows.length >= input.limits.maxResultRows) {
          throw Object.assign(new Error("skill database result is too large; add LIMIT"), { code: "result_too_large" });
        }
        const row = statement.get([]).map(toWireValue);
        totalResultBytes += resultBytes(row);
        if (totalResultBytes > input.limits.maxResultBytes) {
          throw Object.assign(new Error("skill database result is too large; add LIMIT"), { code: "result_too_large" });
        }
        rows.push(row);
      }
    } finally {
      statement.finalize();
    }

    const changesBigInt = sqlite3.capi.sqlite3_changes64(db);
    const lastRowidBigInt = sqlite3.capi.sqlite3_last_insert_rowid(db);
    const changes = changesBigInt > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(changesBigInt);
    const lastInsertRowid = lastRowidBigInt === 0n ? null : toWireValue(lastRowidBigInt);
    const changed = migrated || !readOnly;
    // The WASM export helper consults the connection authorizer while serializing. The untrusted
    // statement is finalized at this point; temporarily permit the internal export operation.
    if (changed) {
      sqlite3.capi.sqlite3_set_authorizer(db, () => sqlite3.capi.SQLITE_OK, 0);
    }
    const image = changed ? sqlite3.capi.sqlite3_js_db_export(db) : null;
    if (image && image.byteLength > input.limits.maxBytes) {
      throw Object.assign(new Error("skill database exceeds its size limit"), { code: "database_full" });
    }
    return {
      columns,
      rows,
      changes,
      lastInsertRowid,
      readOnly,
      image,
      dbSizeBytes: image?.byteLength ?? input.image?.byteLength ?? 0,
    };
  } finally {
    db.close();
  }
}

parentPort.on("message", async ({ id, input }) => {
  try {
    const result = await execute(input);
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

parentPort.postMessage({ ready: true });
