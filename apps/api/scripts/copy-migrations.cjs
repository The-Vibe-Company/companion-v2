const { cpSync, copyFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const apiRoot = join(__dirname, "..");
const repoRoot = join(apiRoot, "..", "..");

// Drizzle migrations: read at startup by dist/migrate.js.
const migrationsSource = join(repoRoot, "packages", "db", "drizzle");
const migrationsDest = join(apiRoot, "dist", "drizzle");
rmSync(migrationsDest, { recursive: true, force: true });
cpSync(migrationsSource, migrationsDest, { recursive: true });

// The migration entrypoint applies least-privilege runtime grants immediately after migrations
// when the separated DATABASE_API_ROLE + DATABASE_WORKER_ROLE contract (or the legacy single
// DATABASE_RUNTIME_ROLE fallback) is configured.
copyFileSync(
  join(repoRoot, "packages", "db", "runtime-role-grants.sql"),
  join(apiRoot, "dist", "runtime-role-grants.sql"),
);

// Bundled Companion skill: tsup inlines @companion/* into dist/index.js, so the skill source must
// sit next to the bundle for companionSkillDir() to find it (it probes ./companion-skill).
const skillSource = join(repoRoot, "packages", "companion-skill", "skill");
const skillDest = join(apiRoot, "dist", "companion-skill");
rmSync(skillDest, { recursive: true, force: true });
cpSync(skillSource, skillDest, { recursive: true });
