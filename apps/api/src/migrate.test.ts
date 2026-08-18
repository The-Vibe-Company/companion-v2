import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CUTOVER_GUARD_MESSAGE,
  CUTOVER_GUARD_SQLSTATE,
  databaseRuntimeRole,
  databaseRuntimeRoles,
  databaseUrl,
  extractRuntimeRoleGrantBlock,
  formatMigrationFailure,
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

describe("databaseRuntimeRole", () => {
  it("is opt-in", () => {
    expect(databaseRuntimeRole({})).toBeNull();
    expect(databaseRuntimeRole({ DATABASE_RUNTIME_ROLE: "" })).toBeNull();
  });

  it("accepts a strict lowercase PostgreSQL identifier", () => {
    expect(databaseRuntimeRole({ DATABASE_RUNTIME_ROLE: "companion_runtime_2" })).toBe("companion_runtime_2");
  });

  it.each(["Companion", " companion_runtime", "companion-runtime", "9runtime", "a".repeat(64)])(
    "fails closed for invalid configured role %s",
    (role) => {
      expect(() => databaseRuntimeRole({ DATABASE_RUNTIME_ROLE: role })).toThrow(
        "DATABASE_RUNTIME_ROLE must be a lowercase PostgreSQL identifier",
      );
    },
  );
});

describe("databaseRuntimeRoles", () => {
  it("is opt-in", () => {
    expect(databaseRuntimeRoles({})).toBeNull();
  });

  it("returns distinct API and worker roles", () => {
    expect(
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
      }),
    ).toEqual({
      apiRole: "companion_api",
      workerRole: "companion_worker",
      companionRuntimeRole: null,
      legacySingleRole: false,
      retiredRuntimeRole: null,
    });
  });

  it("accepts an optional, distinct Companion runtime role after the API/worker split", () => {
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
      legacySingleRole: false,
      retiredRuntimeRole: null,
    });
  });

  it("accepts an optional retired union role during a separated-role cutover", () => {
    expect(
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_RETIRED_RUNTIME_ROLE: "companion_runtime",
      }),
    ).toEqual({
      apiRole: "companion_api",
      workerRole: "companion_worker",
      companionRuntimeRole: null,
      legacySingleRole: false,
      retiredRuntimeRole: "companion_runtime",
    });
  });

  it("keeps the active runtime and retired union login separate during cutover", () => {
    expect(
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime_v2",
        DATABASE_RETIRED_RUNTIME_ROLE: "companion_runtime_v1",
      }),
    ).toEqual({
      apiRole: "companion_api",
      workerRole: "companion_worker",
      companionRuntimeRole: "companion_runtime_v2",
      legacySingleRole: false,
      retiredRuntimeRole: "companion_runtime_v1",
    });
  });

  it("supports the legacy single-role contract for simple installations", () => {
    expect(databaseRuntimeRoles({ DATABASE_RUNTIME_ROLE: "companion_runtime" })).toEqual({
      apiRole: "companion_runtime",
      workerRole: "companion_runtime",
      companionRuntimeRole: "companion_runtime",
      legacySingleRole: true,
      retiredRuntimeRole: null,
    });
  });

  it("requires both separated roles and rejects ambiguous or ineffective separation", () => {
    expect(() => databaseRuntimeRoles({ DATABASE_API_ROLE: "companion_api" })).toThrow(
      "DATABASE_API_ROLE and DATABASE_WORKER_ROLE must be configured together",
    );
    expect(() =>
      databaseRuntimeRoles({ DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime_v2" }),
    ).toThrow("DATABASE_API_ROLE and DATABASE_WORKER_ROLE must be configured together");
    expect(() =>
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_runtime",
        DATABASE_WORKER_ROLE: "companion_runtime",
      }),
    ).toThrow("DATABASE_API_ROLE and DATABASE_WORKER_ROLE must be distinct");
    expect(() =>
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_RUNTIME_ROLE: "companion_runtime",
      }),
    ).toThrow("DATABASE_RUNTIME_ROLE cannot be combined");
    expect(() =>
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime_v2",
        DATABASE_RETIRED_RUNTIME_ROLE: "companion_runtime_v2",
      }),
    ).toThrow("DATABASE_RETIRED_RUNTIME_ROLE must be distinct from every active database role");
    expect(() =>
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_api",
      }),
    ).toThrow("DATABASE_COMPANION_RUNTIME_ROLE must be distinct");
    expect(() =>
      databaseRuntimeRoles({
        DATABASE_API_ROLE: "companion_api",
        DATABASE_WORKER_ROLE: "companion_worker",
        DATABASE_RUNTIME_ROLE: "companion_runtime",
        DATABASE_COMPANION_RUNTIME_ROLE: "companion_runtime_v2",
      }),
    ).toThrow("DATABASE_RUNTIME_ROLE cannot be combined");
    expect(() =>
      databaseRuntimeRoles({
        DATABASE_RETIRED_RUNTIME_ROLE: "companion_runtime",
      }),
    ).toThrow("DATABASE_RETIRED_RUNTIME_ROLE requires");
  });

  it.each([
    ["DATABASE_API_ROLE", { DATABASE_API_ROLE: "Companion", DATABASE_WORKER_ROLE: "companion_worker" }],
    ["DATABASE_WORKER_ROLE", { DATABASE_API_ROLE: "companion_api", DATABASE_WORKER_ROLE: " worker" }],
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
        DATABASE_RETIRED_RUNTIME_ROLE: "retired-role",
      },
    ],
  ])("validates %s as a strict PostgreSQL identifier", (name, env) => {
    expect(() => databaseRuntimeRoles(env)).toThrow(
      `${name} must be a lowercase PostgreSQL identifier`,
    );
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
        "\\if :{?runtime_role}\n-- companion-runtime-grants-begin\nDO $$ BEGIN NULL; END $$;\n-- companion-runtime-grants-end\n\\endif",
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

  it("tolerates a self-referential cause chain", () => {
    const error: Error & { cause?: unknown } = new Error("looping failure");
    error.cause = error;

    expect(formatMigrationFailure(error).split("\n")[0]).toBe("looping failure");
  });

  it("still reports non-database failures", () => {
    expect(formatMigrationFailure("boom")).toBe("boom");
  });
});
