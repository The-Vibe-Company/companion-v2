const { cpSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const apiRoot = join(__dirname, "..");
const repoRoot = join(apiRoot, "..", "..");

// Drizzle migrations: read at startup by dist/migrate.js.
const migrationsSource = join(repoRoot, "packages", "db", "drizzle");
const migrationsDest = join(apiRoot, "dist", "drizzle");
rmSync(migrationsDest, { recursive: true, force: true });
cpSync(migrationsSource, migrationsDest, { recursive: true });

// Bundled Companion skill: tsup inlines @companion/* into dist/index.js, so the skill source must
// sit next to the bundle for companionSkillDir() to find it (it probes ./companion-skill).
const skillSource = join(repoRoot, "packages", "companion-skill", "skill");
const skillDest = join(apiRoot, "dist", "companion-skill");
rmSync(skillDest, { recursive: true, force: true });
cpSync(skillSource, skillDest, { recursive: true });
