#!/usr/bin/env bash
set -euo pipefail

API_URL="${COMPANION_API_URL:-http://127.0.0.1:${COMPANION_API_PORT:-18081}}"
API_URL="${API_URL%/}"

log() {
  printf '[ci-api-smoke] %s\n' "$*"
}

wait_for_health() {
  for _ in $(seq 1 30); do
    if curl -fsS "$API_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  log "API did not become ready at $API_URL/health"
  exit 1
}

log "Waiting for API health at $API_URL"
wait_for_health

log "Checking /health"
health_body="$(curl -fsS "$API_URL/health")"
if ! printf '%s' "$health_body" | grep -q '"ok":true'; then
  log "Unexpected health response: $health_body"
  exit 1
fi

log "Checking auth rejects invalid credentials"
auth_status="$(
  curl -sS -o /tmp/ci-api-smoke-auth.json -w '%{http_code}' \
    -X POST "$API_URL/auth/sign-in/email" \
    -H 'content-type: application/json' \
    -d '{"email":"nobody@example.com","password":"wrong-password"}'
)"
if [ "$auth_status" -lt 400 ]; then
  log "Expected 4xx from invalid sign-in, got $auth_status"
  sed -n '1,20p' /tmp/ci-api-smoke-auth.json >&2 || true
  exit 1
fi

log "OK"
