#!/usr/bin/env bash
set -euo pipefail

for image in companion-api:ci companion-worker:ci companion-web:ci; do
  test "$(docker image inspect --format '{{.Config.User}}' "$image")" = "node"
done

network_args=(--network host)
api_publish_args=()
web_publish_args=()
container_database_url="$DATABASE_URL"
if [ "$(uname -s)" = "Darwin" ]; then
  network_args=(--add-host host.docker.internal:host-gateway)
  api_publish_args=(-p 18082:18082)
  web_publish_args=(-p 18080:18080)
  container_database_url="${DATABASE_URL/127.0.0.1/host.docker.internal}"
fi

docker run --rm "${network_args[@]}" \
  -e DATABASE_URL="$container_database_url" \
  companion-api:ci node dist/migrate.js

worker_id="$(docker run -d -e COMPANION_BILLING_MODE=off companion-worker:ci)"
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
sleep 2
test "$(docker inspect --format '{{.State.Running}}' "$worker_id")" = "true"

api_id="$(docker run -d "${network_args[@]}" "${api_publish_args[@]}" \
  -e PORT=18082 \
  -e COMPANION_API_HOST=0.0.0.0 \
  -e DATABASE_URL="$container_database_url" \
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
