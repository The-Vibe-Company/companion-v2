#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-all}"
LOG_DIR="${RSC_SMOKE_LOG_DIR:-$ROOT/.context/rsc-smoke}"
API_PID_FILE="$LOG_DIR/api.pid"
WEB_PID_FILE="$LOG_DIR/web.pid"
mkdir -p "$LOG_DIR"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-companion-ci-rsc}"
export COMPOSE_BIND_HOST="${COMPOSE_BIND_HOST:-127.0.0.1}"

if [ -n "${CI_USE_GHA_POSTGRES:-}" ]; then
  export POSTGRES_PORT="${POSTGRES_PORT:-5432}"
  export DATABASE_URL="${DATABASE_URL:-postgres://companion:companion@127.0.0.1:${POSTGRES_PORT}/companion}"
  COMPOSE_SERVICES=(minio mailpit)
else
  export POSTGRES_PORT="${POSTGRES_PORT:-15432}"
  COMPOSE_SERVICES=(postgres minio mailpit)
fi
export MINIO_PORT="${MINIO_PORT:-19000}"
export MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-19001}"
export MAILPIT_SMTP_PORT="${MAILPIT_SMTP_PORT:-11025}"
export MAILPIT_WEB_PORT="${MAILPIT_WEB_PORT:-18025}"
export COMPANION_WEB_PORT="${COMPANION_WEB_PORT:-13300}"
export COMPANION_API_PORT="${COMPANION_API_PORT:-13301}"
export COMPANION_API_HOST="${COMPANION_API_HOST:-127.0.0.1}"
export COMPANION_WEB_HOST="${COMPANION_WEB_HOST:-127.0.0.1}"
if [ -z "${CI_USE_GHA_POSTGRES:-}" ]; then
  export DATABASE_URL="${DATABASE_URL:-postgres://companion:companion@127.0.0.1:${POSTGRES_PORT}/companion}"
fi
export COMPANION_API_URL="${COMPANION_API_URL:-http://127.0.0.1:${COMPANION_API_PORT}}"
export COMPANION_WEB_URL="${COMPANION_WEB_URL:-http://127.0.0.1:${COMPANION_WEB_PORT}}"
export NEXT_PUBLIC_COMPANION_API_URL="${NEXT_PUBLIC_COMPANION_API_URL:-$COMPANION_API_URL}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-$COMPANION_API_URL}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-ci-rsc-smoke-better-auth-secret-with-enough-entropy-for-tests}"
export BETTER_AUTH_COOKIE_PREFIX="${BETTER_AUTH_COOKIE_PREFIX:-companion-ci-rsc}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:${MINIO_PORT}}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-companion}"
export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-companion-secret}"
export S3_BUCKET_SKILL_ARCHIVES="${S3_BUCKET_SKILL_ARCHIVES:-skill-archives}"
export S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"
export EMAIL_PROVIDER="${EMAIL_PROVIDER:-mailpit}"
export EMAIL_FROM="${EMAIL_FROM:-Companion <noreply@companion.local>}"
export MAILPIT_SMTP_HOST="${MAILPIT_SMTP_HOST:-127.0.0.1}"
export COMPANION_SECRETS_MASTER_KEY="${COMPANION_SECRETS_MASTER_KEY:-CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=}"
export APP_URL="$COMPANION_WEB_URL"

log() {
  printf '[ci-rsc-smoke] %s\n' "$*"
}

stop_pid_file() {
  local file="$1"
  local pid
  if [ ! -f "$file" ]; then
    return
  fi
  pid="$(cat "$file")"
  if kill -0 "$pid" >/dev/null 2>&1; then
    pkill -TERM -P "$pid" >/dev/null 2>&1 || true
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    pkill -KILL -P "$pid" >/dev/null 2>&1 || true
    kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$file"
}

stop_stack() {
  stop_pid_file "$WEB_PID_FILE"
  stop_pid_file "$API_PID_FILE"
  docker compose -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true
}

wait_for_url() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  log "$name did not become ready at $url"
  sed -n '1,220p' "$LOG_DIR/api.log" >&2 2>/dev/null || true
  sed -n '1,220p' "$LOG_DIR/web.log" >&2 2>/dev/null || true
  return 1
}

start_stack() {
  stop_stack
  if [ -n "${CI_USE_GHA_POSTGRES:-}" ]; then
    log "Starting Docker services (minio, mailpit) — using external Postgres at $DATABASE_URL"
  else
    log "Starting isolated Docker services (postgres, minio, mailpit)"
  fi
  docker compose -p "$COMPOSE_PROJECT_NAME" up -d --wait "${COMPOSE_SERVICES[@]}"
  docker compose -p "$COMPOSE_PROJECT_NAME" up -d minio-init

  log "Applying migrations and seeding test user"
  NODE_ENV=development pnpm db:migrate
  NODE_ENV=development pnpm --filter @companion/api seed:test-user

  log "Starting built API"
  NODE_ENV=production pnpm --filter @companion/api start >"$LOG_DIR/api.log" 2>&1 < /dev/null &
  printf '%s\n' "$!" >"$API_PID_FILE"
  wait_for_url "$COMPANION_API_URL/health" "API"

  log "Starting built web"
  (
    cd apps/web
    NODE_ENV=production exec pnpm start --hostname "$COMPANION_WEB_HOST" --port "$COMPANION_WEB_PORT"
  ) >"$LOG_DIR/web.log" 2>&1 < /dev/null &
  printf '%s\n' "$!" >"$WEB_PID_FILE"
  wait_for_url "$COMPANION_WEB_URL/login" "web"
}

run_rsc() {
  log "Running RSC smoke"
  node scripts/rsc-smoke.mjs
}

run_e2e() {
  log "Running critical browser flows"
  pnpm test:e2e
}

case "$MODE" in
  start)
    start_stack
    ;;
  rsc)
    run_rsc
    ;;
  e2e)
    run_e2e
    ;;
  stop)
    stop_stack
    ;;
  all)
    trap stop_stack EXIT
    start_stack
    run_rsc
    if [ "${RUN_PLAYWRIGHT:-0}" = "1" ]; then
      run_e2e
    fi
    log "OK"
    ;;
  *)
    printf 'Usage: %s [start|rsc|e2e|stop|all]\n' "$0" >&2
    exit 2
    ;;
esac
