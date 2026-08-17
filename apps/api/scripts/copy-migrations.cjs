const { cpSync, copyFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const apiRoot = join(__dirname, "..");
const repoRoot = join(apiRoot, "..", "..");

// Drizzle migrations: read only by the explicit one-shot dist/migrate.js entrypoint.
const migrationsSource = join(repoRoot, "packages", "db", "drizzle");
const migrationsDest = join(apiRoot, "dist", "drizzle");
rmSync(migrationsDest, { recursive: true, force: true });
cpSync(migrationsSource, migrationsDest, { recursive: true });

// The migration entrypoint checkpoints through 0092, applies least-privilege runtime grants, then
// admits guarded migration 0093 on the same connection. The distinct DATABASE_API_ROLE +
// DATABASE_WORKER_ROLE + DATABASE_COMPANION_RUNTIME_ROLE contract is mandatory for that cutover.
copyFileSync(
  join(repoRoot, "packages", "db", "runtime-role-grants.sql"),
  join(apiRoot, "dist", "runtime-role-grants.sql"),
);

// Skill Databases run in an isolated worker. tsup bundles the pool but cannot discover the
// URL-constructed worker module, so copy that runtime next to the API bundle.
copyFileSync(
  join(repoRoot, "packages", "skilldb", "src", "worker.mjs"),
  join(apiRoot, "dist", "worker.mjs"),
);

// Bundled Companion skill: tsup inlines @companion/* into dist/index.js, so the skill source must
// sit next to the bundle for companionSkillDir() to find it (it probes ./companion-skill).
const skillSource = join(repoRoot, "packages", "companion-skill", "skill");
const skillDest = join(apiRoot, "dist", "companion-skill");
rmSync(skillDest, { recursive: true, force: true });
cpSync(skillSource, skillDest, { recursive: true });
