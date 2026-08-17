import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CUTOVER_GUARD_MESSAGE,
  CUTOVER_GUARD_SQLSTATE,
  RUNTIME_V2_FINAL_CUTOVER_TAG,
  RUNTIME_V2_CUTOVER_GUARD_MESSAGE,
  RUNTIME_V2_GRANTS_GUARD_MESSAGE,
  databaseRuntimeRoles,
  databaseUrl,
  extractRuntimeRoleGrantBlock,
  formatMigrationFailure,
  prepareMigrationPhases,
  resolveMigrationsFolder,
  resolveRuntimeRoleGrantsFile,
} from "./migrate";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "companion-api-migrate-test-"));
  tempDirs.push(dir);
  return dir;
}

async function createMigrationFolder(root: string): Promise<string> {
  const folder = join(root, "drizzle");
  await mkdir(join(folder, "meta"), { recursive: true });
  await writeFile(join(folder, "meta", "_journal.json"), "{}");
  return folder;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("databaseUrl", () => {
  it("requires a migration or runtime database URL", () => {
    expect(() => databaseUrl({ NODE_ENV: "test" })).toThrow("DATABASE_MIGRATION_URL or DATABASE_URL is required");
  });

  it("returns DATABASE_URL when configured", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://example" })).toBe("postgres://example");
    expect(
      databaseUrl({ DATABASE_URL: "postgres://runtime", DATABASE_MIGRATION_URL: "postgres://owner" }),
    ).toBe("postgres://owner");
  });
});

describe("databaseRuntimeRoles", () => {
  it("is opt-in", () => {
    expect(databaseRuntimeRoles({})).toBeNull();
  });

  it("requires and returns three distinct application roles", () => {
    expect(
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime_v2",
      }),
    ).toEqual({
      apiRole: "companion_api",
      workerRole: "companion_worker",
      companionRuntimeRole: "companion_runtime_v2",
      retiredRuntimeRole: null,
    });

    expect(
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime_v2",
        DATABASE_RETIRED_RUNTIME_ROLE: "companion_runtime_legacy",
      }),
    ).toEqual({
      apiRole: "companion_api",
      workerRole: "companion_worker",
      companionRuntimeRole: "companion_runtime_v2",
      retiredRuntimeRole: "companion_runtime_legacy",
    });
  });

  it("rejects partial or shared role configuration", () => {
    expect(() => databaseRuntimeRoles({ DATABASE_API_ROLE: "companion_api" })).toThrow(
      "must be configured together",
    );
    expect(() =>
      databaseRuntimeRoles({ DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime_v2" }),
    ).toThrow("must be configured together");
    expect(() =>
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_runtime",
        DATABASE_WORKER_ROLE: "companion_runtime",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime_v2",
      }),
    ).toThrow("must be distinct");
    expect(() =>
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_api",
      }),
    ).toThrow("must be distinct");
    expect(() =>
      databaseRuntimeRoles({ DATABASE_RETIRED_RUNTIME_ROLE: "companion_runtime_legacy" }),
    ).toThrow("must be configured together");
    expect(() =>
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime_v2",
        DATABASE_RETIRED_RUNTIME_ROLE: "companion_runtime_v2",
      }),
    ).toThrow("must be distinct");
  });

  it("rejects the former union role as an active migration credential", () => {
    expect(() =>
      databaseRuntimeRoles({ DATABASE_RUNTIME_ROLE: "companion_runtime" }),
    ).toThrow("retired union credential");
    expect(() =>
      databaseRuntimeRoles({
        DATABASE_RUNTIME_ROLE: "companion_runtime",
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime_v2",
      }),
    ).toThrow("DATABASE_RUNTIME_ROLE is a retired union credential");
  });

  it.each([
    ["DATABASE_API_ROLE", {
      DATABASE_API_ROLE: "Companion",
      DATABASE_WORKER_ROLE: "companion_worker",
      DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime",
    }],
    ["DATABASE_WORKER_ROLE", {
      DATABASE_API_ROLE: "companion_api",
      DATABASE_WORKER_ROLE: " worker",
      DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime",
    }],
    [
      "DATABASE_COMPANION_RUNTIME_ROLE",
      {
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_COMPANION_RUNTIME_ROLE: "runtime-role",
      },
    ],
    [
      "DATABASE_RETIRED_RUNTIME_ROLE",
      {
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime",
        DATABASE_RETIRED_RUNTIME_ROLE: "RetiredRuntime",
      },
    ],
  ])("validates %s as a strict PostgreSQL identifier", (name, env) => {
    expect(() => databaseRuntimeRoles(env)).toThrow(
      `${name} must be a lowercase PostgreSQL identifier`,
    );
  });
});

describe("prepareMigrationPhases", () => {
  it("builds a temporary Drizzle journal ending at 0092 and leaves 0093 for phase two", async () => {
    const root = await tempDir();
    const folder = join(root, "drizzle");
    await mkdir(join(folder, "meta"), { recursive: true });
    const entries = [
      { idx: 91, version: "7", when: 91, tag: "0091_companion_runtime_executor" },
      { idx: 92, version: "7", when: 92, tag: "0092_companion_runtime_api" },
      { idx: 93, version: "7", when: 93, tag: RUNTIME_V2_FINAL_CUTOVER_TAG },
    ];
    await writeFile(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries }),
    );
    for (const entry of entries) await writeFile(join(folder, `${entry.tag}.sql`), "select 1;");

    const phases = await prepareMigrationPhases(folder);
    expect(phases.hasFinalCutover).toBe(true);
    expect(phases.checkpointFolder).not.toBe(folder);
    const checkpoint = JSON.parse(
      await readFile(join(phases.checkpointFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    expect(checkpoint.entries.map((entry) => entry.tag)).toEqual([
      "0091_companion_runtime_executor",
      "0092_companion_runtime_api",
    ]);
    await expect(access(join(phases.checkpointFolder, `${RUNTIME_V2_FINAL_CUTOVER_TAG}.sql`)))
      .rejects.toThrow();
    await phases.cleanup();
    await expect(access(phases.checkpointFolder)).rejects.toThrow();
  });

  it("keeps later migrations in phase two behind the 0093 grant guard", async () => {
    const root = await tempDir();
    const folder = join(root, "drizzle");
    await mkdir(join(folder, "meta"), { recursive: true });
    const entries = [
      { tag: RUNTIME_V2_FINAL_CUTOVER_TAG },
      { tag: "0094_must_not_skip_cutover_protocol" },
    ];
    await writeFile(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries,
      }),
    );
    for (const entry of entries) await writeFile(join(folder, `${entry.tag}.sql`), "select 1;");

    const phases = await prepareMigrationPhases(folder);
    expect(phases.hasFinalCutover).toBe(true);
    const checkpoint = JSON.parse(
      await readFile(join(phases.checkpointFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    expect(checkpoint.entries).toEqual([]);
    const full = JSON.parse(
      await readFile(join(folder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    expect(full.entries.map((entry) => entry.tag)).toEqual([
      RUNTIME_V2_FINAL_CUTOVER_TAG,
      "0094_must_not_skip_cutover_protocol",
    ]);
    await expect(access(join(folder, "0094_must_not_skip_cutover_protocol.sql"))).resolves.toBeUndefined();
    await phases.cleanup();
  });
});

describe("resolveMigrationsFolder", () => {
  it("prefers COMPANION_MIGRATIONS_DIR when it points at a Drizzle journal", async () => {
    const root = await tempDir();
    const migrations = await createMigrationFolder(root);

    await expect(
      resolveMigrationsFolder({
        cwd: join(root, "missing-cwd"),
        env: { COMPANION_MIGRATIONS_DIR: migrations },
        scriptDir: join(root, "missing-script-dir"),
      }),
    ).resolves.toBe(migrations);
  });

  it("rejects an invalid explicit COMPANION_MIGRATIONS_DIR instead of falling back", async () => {
    const root = await tempDir();
    await createMigrationFolder(join(root, "packages", "db"));

    await expect(
      resolveMigrationsFolder({
        cwd: root,
        env: { COMPANION_MIGRATIONS_DIR: join(root, "missing") },
        scriptDir: join(root, "apps", "api", "dist"),
      }),
    ).rejects.toThrow("COMPANION_MIGRATIONS_DIR does not contain a readable Drizzle journal");
  });

  it("finds migrations from a repository root cwd", async () => {
    const root = await tempDir();
    const migrations = await createMigrationFolder(join(root, "packages", "db"));

    await expect(
      resolveMigrationsFolder({
        cwd: root,
        env: {},
        scriptDir: join(root, "apps", "api", "dist"),
      }),
    ).resolves.toBe(migrations);
  });

  it("finds migrations copied next to the built API entrypoint", async () => {
    const root = await tempDir();
    const migrations = await createMigrationFolder(join(root, "apps", "api", "dist"));

    await expect(
      resolveMigrationsFolder({
        cwd: join(root, "apps", "api"),
        env: {},
        scriptDir: join(root, "apps", "api", "dist"),
      }),
    ).resolves.toBe(migrations);
  });

  it("fails when no candidate contains a Drizzle journal", async () => {
    const root = await tempDir();

    await expect(
      resolveMigrationsFolder({
        cwd: join(root, "missing-cwd"),
        env: {},
        scriptDir: join(root, "missing-script-dir"),
      }),
    ).rejects.toThrow("could not find Drizzle migrations folder");
  });
});

describe("runtime role grants", () => {
  it("finds the grants file copied next to the built API entrypoint", async () => {
    const root = await tempDir();
    const scriptDir = join(root, "apps", "api", "dist");
    await mkdir(scriptDir, { recursive: true });
    const grantsFile = join(scriptDir, "runtime-role-grants.sql");
    await writeFile(grantsFile, "-- companion-runtime-grants-begin\nselect 1;\n-- companion-runtime-grants-end\n");

    await expect(
      resolveRuntimeRoleGrantsFile({
        cwd: join(root, "missing-cwd"),
        env: {},
        scriptDir,
      }),
    ).resolves.toBe(grantsFile);
  });

  it("rejects a missing explicit grants file", async () => {
    const root = await tempDir();
    const missing = join(root, "missing.sql");
    await expect(
      resolveRuntimeRoleGrantsFile({
        cwd: root,
        env: { COMPANION_RUNTIME_GRANTS_FILE: missing },
        scriptDir: root,
      }),
    ).rejects.toThrow("COMPANION_RUNTIME_GRANTS_FILE is not readable");
  });

  it("extracts only the driver-safe marked SQL block", () => {
    expect(
      extractRuntimeRoleGrantBlock(
        "\\if :{?api_role}\n-- companion-runtime-grants-begin\nDO $$ BEGIN NULL; END $$;\n-- companion-runtime-grants-end\n\\endif",
      ),
    ).toBe("DO $$ BEGIN NULL; END $$;");
  });

  it("rejects an unmarked grants file", () => {
    expect(() => extractRuntimeRoleGrantBlock("select 1;")).toThrow("missing its marked SQL block");
  });
});

describe("formatMigrationFailure", () => {
  it("surfaces the PostgreSQL detail and hint a stack trace drops", () => {
    const error = Object.assign(new Error("permission denied for table skills"), {
      code: "42501",
      detail: "role companion_api lacks INSERT",
      hint: "apply packages/db/runtime-role-grants.sql",
    });

    const formatted = formatMigrationFailure(error);

    expect(formatted.split("\n")[0]).toBe("permission denied for table skills");
    expect(formatted).toContain("SQLSTATE: 42501");
    expect(formatted).toContain("DETAIL: role companion_api lacks INSERT");
    expect(formatted).toContain("HINT: apply packages/db/runtime-role-grants.sql");
    expect(formatted).not.toContain("cutover.js");
  });

  it("reads through the wrapper Drizzle throws around the failed statement", () => {
    const error = new Error("Failed query: DO $ensure_runtime_resources_drained$ ...", {
      cause: Object.assign(new Error(CUTOVER_GUARD_MESSAGE), {
        code: CUTOVER_GUARD_SQLSTATE,
        detail: "pending storage records=12, Projects=3, sandboxes=0, active usage sessions=0",
      }),
    });

    const formatted = formatMigrationFailure(error);

    expect(formatted.split("\n")[0]).toBe(CUTOVER_GUARD_MESSAGE);
    expect(formatted).toContain("pending storage records=12");
    expect(formatted).toContain("node dist/cutover.js purge --confirm-provider-cleanup");
    expect(formatted).toContain("deploy/railway/README.md");
  });

  it("explains the fail-closed Runtime v2 purge remediation", () => {
    const error = new Error("Failed query", {
      cause: Object.assign(new Error(RUNTIME_V2_CUTOVER_GUARD_MESSAGE), {
        code: CUTOVER_GUARD_SQLSTATE,
        detail: "legacy runtime pools remain",
        hint: "Disable Companions and complete the legacy purge.",
      }),
    });

    const formatted = formatMigrationFailure(error);
    expect(formatted.split("\n")[0]).toBe(RUNTIME_V2_CUTOVER_GUARD_MESSAGE);
    expect(formatted).toContain("0093_companion_runtime_cutover.sql");
    expect(formatted).toContain("node dist/companionPurge.js report");
    expect(formatted).toContain("purge --confirm-delete-all-companions");
  });

  it("explains the same-connection split-role grant protocol", () => {
    const error = Object.assign(new Error(RUNTIME_V2_GRANTS_GUARD_MESSAGE), {
      code: CUTOVER_GUARD_SQLSTATE,
      detail: "the grant marker is missing or stale",
    });

    const formatted = formatMigrationFailure(error);
    expect(formatted).toContain("two-phase API migration runner");
    expect(formatted).toContain("DATABASE_RETIRED_RUNTIME_ROLE");
    expect(formatted).toContain("Do not execute 0093 directly");
  });

  it("tolerates a self-referential cause chain", () => {
    const error: Error & { cause?: unknown } = new Error("looping failure");
    error.cause = error;

    expect(formatMigrationFailure(error).split("\n")[0]).toBe("looping failure");
  });

  it("still reports non-database failures", () => {
    expect(formatMigrationFailure("boom")).toBe("boom");
  });
});
