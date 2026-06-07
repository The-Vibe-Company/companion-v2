#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$WORKSPACE_ROOT"

log() {
  printf '[conductor] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[conductor] Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

sanitize_project_name() {
  local raw="${CONDUCTOR_WORKSPACE_NAME:-$(basename "$WORKSPACE_ROOT")}"
  local cleaned

  cleaned="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"
  if [ -z "$cleaned" ]; then
    cleaned="workspace"
  fi
  if ! printf '%s' "$cleaned" | grep -Eq '^[a-z0-9]'; then
    cleaned="w-${cleaned}"
  fi

  printf 'companion-%s' "$cleaned"
}

port_at() {
  local offset="$1"
  printf '%s' "$((BASE_PORT + offset))"
}

configure_workspace_env() {
  BASE_PORT="${CONDUCTOR_PORT:-3000}"
  if ! printf '%s' "$BASE_PORT" | grep -Eq '^[0-9]+$'; then
    printf '[conductor] CONDUCTOR_PORT must be numeric, got: %s\n' "$BASE_PORT" >&2
    exit 1
  fi

  WEB_PORT="$(port_at 0)"
  API_PORT="$(port_at 1)"
  POSTGRES_PORT_VALUE="$(port_at 2)"
  MINIO_PORT_VALUE="$(port_at 3)"
  MINIO_CONSOLE_PORT_VALUE="$(port_at 4)"
  MAILPIT_SMTP_PORT_VALUE="$(port_at 5)"
  MAILPIT_WEB_PORT_VALUE="$(port_at 6)"
  COMPOSE_PROJECT_NAME="$(sanitize_project_name)"

  export COMPOSE_PROJECT_NAME
  export POSTGRES_PORT="$POSTGRES_PORT_VALUE"
  export MINIO_PORT="$MINIO_PORT_VALUE"
  export MINIO_CONSOLE_PORT="$MINIO_CONSOLE_PORT_VALUE"
  export MAILPIT_SMTP_PORT="$MAILPIT_SMTP_PORT_VALUE"
  export MAILPIT_WEB_PORT="$MAILPIT_WEB_PORT_VALUE"

  export DATABASE_URL="postgres://companion:companion@127.0.0.1:${POSTGRES_PORT}/companion"
  export COMPANION_API_PORT="$API_PORT"
  export COMPANION_API_URL="http://127.0.0.1:${API_PORT}"
  export COMPANION_WEB_URL="http://127.0.0.1:${WEB_PORT}"
  export NEXT_PUBLIC_COMPANION_API_URL="$COMPANION_API_URL"
  export BETTER_AUTH_URL="$COMPANION_API_URL"
  export BETTER_AUTH_COOKIE_PREFIX="$COMPOSE_PROJECT_NAME"

  export S3_ENDPOINT="http://127.0.0.1:${MINIO_PORT}"
  export S3_REGION="${S3_REGION:-us-east-1}"
  export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-companion}"
  export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-companion-secret}"
  export S3_BUCKET_SKILL_ARCHIVES="${S3_BUCKET_SKILL_ARCHIVES:-skill-archives}"
  export S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"

  export EMAIL_PROVIDER="${EMAIL_PROVIDER:-mailpit}"
  export EMAIL_FROM="${EMAIL_FROM:-Companion <noreply@companion.local>}"
  export MAILPIT_SMTP_HOST="${MAILPIT_SMTP_HOST:-127.0.0.1}"
}

ensure_tooling() {
  require_command node
  require_command corepack
  require_command docker

  corepack enable
  require_command pnpm
}

compose() {
  docker compose -p "$COMPOSE_PROJECT_NAME" "$@"
}

stop_port_listeners() {
  local port="$1"
  local pids
  local workspace_pids=""
  local foreign_pids=""

  assert_no_published_port_containers "$port"

  if ! command -v lsof >/dev/null 2>&1; then
    log "lsof is unavailable; skipping cleanup for port ${port}"
    return
  fi

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
  if [ -z "$pids" ]; then
    return
  fi

  for pid in $pids; do
    if is_workspace_pid "$pid"; then
      workspace_pids="${workspace_pids} ${pid}"
    else
      foreign_pids="${foreign_pids} ${pid}"
    fi
  done

  if [ -n "$foreign_pids" ]; then
    log "Port ${port} is already used by non-workspace process(es):${foreign_pids}"
    log "Stop those process(es) or choose a different CONDUCTOR_PORT."
    exit 1
  fi

  log "Stopping existing workspace process(es) listening on port ${port}:${workspace_pids}"
  kill $workspace_pids 2>/dev/null || true

  for _ in $(seq 1 20); do
    sleep 0.1
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
    if [ -z "$pids" ]; then
      return
    fi
  done

  log "Force stopping process(es) still listening on port ${port}: ${pids}"
  kill -9 $workspace_pids 2>/dev/null || true
}

stop_dev_servers() {
  stop_port_listeners "$WEB_PORT"
  stop_port_listeners "$API_PORT"
}

is_workspace_pid() {
  local pid="$1"
  local cwd

  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  case "$cwd" in
    "$WORKSPACE_ROOT"|"$WORKSPACE_ROOT"/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

assert_no_published_port_containers() {
  local port="$1"
  local names

  names="$(docker ps --filter "publish=${port}" --format '{{.Names}}' | sort -u | tr '\n' ' ' || true)"
  if [ -n "$names" ]; then
    log "Port ${port} is already published by non-workspace Docker container(s): ${names}"
    log "Stop those container(s) or choose a different CONDUCTOR_PORT."
    exit 1
  fi
}

stop_published_port_containers() {
  local port="$1"
  local containers
  local names

  containers="$(docker ps --filter "publish=${port}" --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" --format '{{.ID}}' | sort -u || true)"
  if [ -n "$containers" ]; then
    names="$(docker ps --filter "publish=${port}" --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" --format '{{.Names}}' | sort -u | tr '\n' ' ')"
    log "Stopping workspace Docker container(s) publishing port ${port}: ${names}"
    docker stop $containers >/dev/null
  fi

  assert_no_published_port_containers "$port"
}

stop_infra_port_containers() {
  stop_published_port_containers "$POSTGRES_PORT"
  stop_published_port_containers "$MINIO_PORT"
  stop_published_port_containers "$MINIO_CONSOLE_PORT"
  stop_published_port_containers "$MAILPIT_SMTP_PORT"
  stop_published_port_containers "$MAILPIT_WEB_PORT"
}

print_urls() {
  log "Workspace: ${CONDUCTOR_WORKSPACE_NAME:-$(basename "$WORKSPACE_ROOT")}"
  log "Compose project: ${COMPOSE_PROJECT_NAME}"
  log "Web: ${COMPANION_WEB_URL}"
  log "API: ${COMPANION_API_URL}"
  log "Postgres: 127.0.0.1:${POSTGRES_PORT}"
  log "MinIO console: http://127.0.0.1:${MINIO_CONSOLE_PORT}"
  log "Mailpit: http://127.0.0.1:${MAILPIT_WEB_PORT}"
}

start_infra() {
  log "Restarting isolated Postgres, MinIO, and Mailpit"
  compose down --remove-orphans
  stop_infra_port_containers
  compose up -d postgres minio mailpit minio-init
}

run_dev() {
  configure_workspace_env
  ensure_tooling
  print_urls
  stop_dev_servers
  start_infra

  log "Applying Drizzle migrations"
  pnpm db:migrate

  log "Seeding local test user"
  pnpm --filter @companion/api seed:test-user
  if [ -n "${COMPANION_SEED_PASSWORD:-}" ]; then
    log "Local test user: ${COMPANION_SEED_EMAIL:-admin@tvc.dev} / [COMPANION_SEED_PASSWORD]"
  else
    log "Local development credentials for a new workspace: ${COMPANION_SEED_EMAIL:-admin@tvc.dev} / adminadmin"
  fi
  log "Existing local users keep their current password."

  log "Starting API and web"
  pnpm exec concurrently -k -n api,web \
    "pnpm --filter @companion/api dev" \
    "cd apps/web && pnpm dev --port ${WEB_PORT}"
}

archive() {
  configure_workspace_env
  require_command docker

  log "Removing isolated Docker Compose project ${COMPOSE_PROJECT_NAME}"
  compose down -v
}

case "${1:-run}" in
  run)
    run_dev
    ;;
  archive)
    archive
    ;;
  *)
    printf 'Usage: %s [run|archive]\n' "$0" >&2
    exit 64
    ;;
esac
