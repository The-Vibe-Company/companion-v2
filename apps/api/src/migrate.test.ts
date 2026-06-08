import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databaseUrl, resolveMigrationsFolder } from "./migrate";

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
  it("requires DATABASE_URL", () => {
    expect(() => databaseUrl({ NODE_ENV: "test" })).toThrow("DATABASE_URL is required");
  });

  it("returns DATABASE_URL when configured", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://example" })).toBe("postgres://example");
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
