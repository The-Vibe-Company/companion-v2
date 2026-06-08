#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bash -n scripts/dev-stack.sh

config="$(
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

printf '[dev-stack-check] OK\n'
