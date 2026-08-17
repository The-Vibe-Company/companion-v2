#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL must point at an explicitly disposable PostgreSQL cluster}"
: "${DATABASE_API_URL:?DATABASE_API_URL is required}"
: "${DATABASE_WORKER_URL:?DATABASE_WORKER_URL is required}"
: "${DATABASE_COMPANION_RUNTIME_URL:?DATABASE_COMPANION_RUNTIME_URL is required}"

node - "$DATABASE_API_URL" "$DATABASE_WORKER_URL" "$DATABASE_COMPANION_RUNTIME_URL" <<'COMPANION_RUNTIME_DB_URLS'
const urls = process.argv.slice(2).map((raw) => new URL(raw));
const roles = urls.map((url) => decodeURIComponent(url.username));
if (roles.some((role) => !role)) throw new Error("every runtime integration URL must name a login role");
if (new Set(roles).size !== roles.length) {
  throw new Error("API, worker, and Companion runtime database roles must be distinct");
}
COMPANION_RUNTIME_DB_URLS

# These suites replay the real migrations into disposable databases and prove
# split grants, fencing, takeover, stale epochs, and projection idempotence.
COMPANION_INTEGRATION_TESTS=1 DATABASE_URL="$DATABASE_MIGRATION_URL" \
  pnpm --filter @companion/api exec vitest run \
    --config vitest.integration.config.ts \
    test/integration/companionRuntimeV2.integration.test.ts \
    test/integration/companionRuntimeExecutor.integration.test.ts

# The runtime-owned purge command also runs against a freshly migrated real
# database; the Box provider itself remains deterministic and local.
DATABASE_URL="$DATABASE_MIGRATION_URL" \
  pnpm --filter @companion/runtime test:integration
pnpm --filter @companion/box-sim test
