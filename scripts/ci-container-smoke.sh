#!/usr/bin/env bash
set -euo pipefail

for image in companion-api:ci companion-worker:ci companion-web:ci; do
  test "$(docker image inspect --format '{{.Config.User}}' "$image")" = "node"
done
docker run --rm companion-api:ci test -f dist/runtime-role-grants.sql

network_args=(--network host)
api_publish_args=()
web_publish_args=()
container_migration_url="${DATABASE_MIGRATION_URL:-$DATABASE_URL}"
container_runtime_url="${DATABASE_RUNTIME_URL:-$DATABASE_URL}"
if [ "$(uname -s)" = "Darwin" ]; then
  network_args=(--add-host host.docker.internal:host-gateway)
  api_publish_args=(-p 18082:18082)
  web_publish_args=(-p 18080:18080)
  container_migration_url="${container_migration_url/127.0.0.1/host.docker.internal}"
  container_runtime_url="${container_runtime_url/127.0.0.1/host.docker.internal}"
fi

runtime_role_args=()
if [ -n "${DATABASE_RUNTIME_ROLE:-}" ]; then
  runtime_role_args=(-e "DATABASE_RUNTIME_ROLE=$DATABASE_RUNTIME_ROLE")
fi

docker run --rm "${network_args[@]}" \
  -e DATABASE_URL="$container_runtime_url" \
  -e DATABASE_MIGRATION_URL="$container_migration_url" \
  "${runtime_role_args[@]}" \
  companion-api:ci node dist/migrate.js

worker_id="$(docker run -d "${network_args[@]}" \
  -e COMPANION_BILLING_MODE=off \
  -e COMPANION_RUNS_ENABLED=true \
  -e COMPANION_GOLDEN_SNAPSHOT_ID=ci-placeholder-snapshot \
  -e COMPANION_SECRETS_MASTER_KEY=CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk= \
  -e DATABASE_URL="$container_runtime_url" \
  -e VERCEL_TOKEN=ci-placeholder-token \
  -e VERCEL_TEAM_ID=ci-placeholder-team \
  -e VERCEL_PROJECT_ID=ci-placeholder-project \
  companion-worker:ci)"
api_id=""
web_id=""
cleanup() {
  docker rm -f "$web_id" "$api_id" "$worker_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 20); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$worker_id")" = "true" ]; then
    break
  fi
  sleep 0.25
done
test "$(docker inspect --format '{{.State.Running}}' "$worker_id")" = "true"

worker_ready=""
for _ in $(seq 1 20); do
  worker_ready="$(
    docker run --rm "${network_args[@]}" postgres:16-alpine \
      psql "$container_migration_url" -Atc "select companion_skill_run_worker_ready()" 2>/dev/null || true
  )"
  if [ "$worker_ready" = "t" ]; then
    break
  fi
  sleep 0.25
done
if [ "$worker_ready" != "t" ]; then
  docker logs "$worker_id" >&2
  exit 1
fi

sleep 2
test "$(docker inspect --format '{{.State.Running}}' "$worker_id")" = "true"

api_id="$(docker run -d "${network_args[@]}" "${api_publish_args[@]}" \
  -e PORT=18082 \
  -e COMPANION_API_HOST=0.0.0.0 \
  -e DATABASE_URL="$container_runtime_url" \
  -e COMPANION_WEB_URL=http://127.0.0.1:18080 \
  -e COMPANION_API_URL=http://127.0.0.1:18080 \
  -e BETTER_AUTH_URL=http://127.0.0.1:18080 \
  -e BETTER_AUTH_SECRET=ci-railway-smoke-better-auth-secret-with-enough-entropy \
  -e EMAIL_PROVIDER=log \
  companion-api:ci)"

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:18082/health >/dev/null; then
    break
  fi
  sleep 0.5
done
curl -fsS http://127.0.0.1:18082/health

web_id="$(docker run -d "${network_args[@]}" "${web_publish_args[@]}" \
  -e PORT=18080 \
  -e HOSTNAME=0.0.0.0 \
  companion-web:ci)"

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:18080/login >/dev/null; then
    break
  fi
  sleep 0.5
done
curl -fsS http://127.0.0.1:18080/login >/dev/null
