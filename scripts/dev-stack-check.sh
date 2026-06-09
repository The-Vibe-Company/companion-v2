#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bash -n scripts/dev-stack.sh scripts/dev-conductor.sh scripts/dev-stack-check.sh

config="$(
  env -u CONDUCTOR_PORT -u CONDUCTOR_WORKSPACE_NAME \
  COMPOSE_BIND_HOST=127.0.0.1 \
  POSTGRES_PORT=15432 \
  MINIO_PORT=19000 \
  MINIO_CONSOLE_PORT=19001 \
  MAILPIT_SMTP_PORT=11025 \
  MAILPIT_WEB_PORT=18025 \
  docker compose config
)"

require_config() {
  local expected="$1"
  if ! printf '%s\n' "$config" | grep -Fq "$expected"; then
    printf '[dev-stack-check] Missing expected Compose config: %s\n' "$expected" >&2
    exit 1
  fi
}

require_config "host_ip: 127.0.0.1"
require_config 'published: "15432"'
require_config "target: 5432"
require_config 'published: "19000"'
require_config "target: 9000"
require_config 'published: "19001"'
require_config "target: 9001"
require_config 'published: "11025"'
require_config "target: 1025"
require_config 'published: "18025"'
require_config "target: 8025"

env_output="$(
  env -u CONDUCTOR_PORT -u CONDUCTOR_WORKSPACE_NAME \
  -u COMPOSE_PROJECT_NAME \
  -u DATABASE_URL \
  -u COMPANION_API_URL \
  -u COMPANION_WEB_URL \
  -u NEXT_PUBLIC_COMPANION_API_URL \
  -u BETTER_AUTH_URL \
  -u S3_ENDPOINT \
  POSTGRES_PORT=15432 \
  COMPANION_API_PORT=13001 \
  COMPANION_WEB_PORT=13000 \
  MINIO_PORT=19000 \
  COMPANION_DEV_SKIP_ENV_FILE=1 \
  bash scripts/dev-stack.sh print-env
)"

require_env() {
  local expected="$1"
  if ! printf '%s\n' "$env_output" | grep -Fxq "$expected"; then
    printf '[dev-stack-check] Missing expected env output: %s\n' "$expected" >&2
    exit 1
  fi
}

require_env "DATABASE_URL=postgres://companion:companion@127.0.0.1:15432/companion"
require_env "COMPANION_API_URL=http://127.0.0.1:13001"
require_env "COMPANION_WEB_URL=http://127.0.0.1:13000"
require_env "NEXT_PUBLIC_COMPANION_API_URL=http://127.0.0.1:13001"
require_env "BETTER_AUTH_URL=http://127.0.0.1:13001"
require_env "S3_ENDPOINT=http://127.0.0.1:19000"

conductor_env_output="$(
  env -u COMPOSE_PROJECT_NAME \
  -u DATABASE_URL \
  -u COMPANION_API_URL \
  -u COMPANION_WEB_URL \
  -u NEXT_PUBLIC_COMPANION_API_URL \
  -u BETTER_AUTH_URL \
  -u S3_ENDPOINT \
  CONDUCTOR_PORT=55100 \
  CONDUCTOR_WORKSPACE_NAME=montpellier-v1 \
  bash scripts/dev-stack.sh print-env
)"

require_conductor_env() {
  local expected="$1"
  if ! printf '%s\n' "$conductor_env_output" | grep -Fxq "$expected"; then
    printf '[dev-stack-check] Missing expected Conductor env output: %s\n' "$expected" >&2
    exit 1
  fi
}

require_conductor_env "COMPOSE_PROJECT_NAME=companion-montpellier-v1"
require_conductor_env "DATABASE_URL=postgres://companion:companion@127.0.0.1:55102/companion"
require_conductor_env "COMPANION_API_URL=http://127.0.0.1:55101"
require_conductor_env "COMPANION_WEB_URL=http://127.0.0.1:55100"
require_conductor_env "NEXT_PUBLIC_COMPANION_API_URL=http://127.0.0.1:55101"
require_conductor_env "BETTER_AUTH_URL=http://127.0.0.1:55101"
require_conductor_env "S3_ENDPOINT=http://127.0.0.1:55103"
require_conductor_env "POSTGRES_PORT=55102"
require_conductor_env "MINIO_PORT=55103"
require_conductor_env "MINIO_CONSOLE_PORT=55104"
require_conductor_env "MAILPIT_SMTP_PORT=55105"
require_conductor_env "MAILPIT_WEB_PORT=55106"

# --- Native Conductor launcher (scripts/dev-conductor.sh) ------------------
# The Conductor run/archive path is native (no Docker). Port-range guards run
# before any service starts, so these reject-cases exit early with no side
# effects (nothing is initialised, no ports are bound, no .conductor-pg/).
assert_conductor_rejects() {
  local label="$1"
  shift
  if bash scripts/dev-conductor.sh "$@" >/dev/null 2>&1; then
    printf '[dev-stack-check] dev-conductor.sh should reject %s\n' "$label" >&2
    exit 1
  fi
}

assert_conductor_rejects "privileged base port" --base 100
assert_conductor_rejects "out-of-range base port" --base 70000
assert_conductor_rejects "non-numeric base port" --base notaport
assert_conductor_rejects "empty --base= value" --base=
assert_conductor_rejects "unknown argument" --bogus-flag

if ! bash scripts/dev-conductor.sh --help >/dev/null 2>&1; then
  printf '[dev-stack-check] dev-conductor.sh --help should exit 0\n' >&2
  exit 1
fi

printf '[dev-stack-check] OK\n'
