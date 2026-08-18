#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL is required}"

if [ "${GITHUB_ACTIONS:-}" != "true" ] \
  && [ "${COMPANION_CONFIRM_DISPOSABLE_DATABASE:-}" != "1" ]; then
  printf '[ci-create-db-roles] Refusing to install disposable credentials outside GitHub Actions.\n' >&2
  printf '[ci-create-db-roles] Set COMPANION_CONFIRM_DISPOSABLE_DATABASE=1 only for an isolated test database.\n' >&2
  exit 64
fi

database_host="$(node -e '
  try { process.stdout.write(new URL(process.argv[1]).hostname); }
  catch { process.exit(64); }
' "$DATABASE_MIGRATION_URL")" || {
  printf '[ci-create-db-roles] DATABASE_MIGRATION_URL is invalid.\n' >&2
  exit 64
}
case "$database_host" in
  localhost|127.0.0.1|::1|'[::1]') ;;
  *)
    if [ "${COMPANION_ALLOW_REMOTE_DISPOSABLE_DATABASE:-}" != "1" ]; then
      printf '[ci-create-db-roles] Refusing non-loopback database host without explicit remote disposable opt-in.\n' >&2
      exit 64
    fi
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_role="${DATABASE_API_ROLE:-companion_api}"
worker_role="${DATABASE_WORKER_ROLE:-companion_worker}"
runtime_role="${DATABASE_COMPANION_RUNTIME_ROLE:-companion_runtime_v2}"
api_password="${DATABASE_API_PASSWORD:-companion-api}"
worker_password="${DATABASE_WORKER_PASSWORD:-companion-worker}"
runtime_password="${DATABASE_COMPANION_RUNTIME_PASSWORD:-companion-runtime-v2}"

docker run --rm --network host \
  -v "$ROOT/scripts/disposable-db-roles.sql:/bootstrap/disposable-db-roles.sql:ro" \
  postgres:17-alpine \
  psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
    -v api_role="$api_role" -v api_password="$api_password" \
    -v worker_role="$worker_role" -v worker_password="$worker_password" \
    -v runtime_role="$runtime_role" -v runtime_password="$runtime_password" \
    -f /bootstrap/disposable-db-roles.sql
