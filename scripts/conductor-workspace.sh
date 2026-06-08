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

compose_projects_for_workspace() {
  {
    printf '%s\n' "$(sanitize_project_name)"
    docker ps -a \
      --filter "label=com.docker.compose.project.working_dir=${WORKSPACE_ROOT}" \
      --format '{{.Label "com.docker.compose.project"}}'
  } | sed '/^$/d' | sort -u
}

run() {
  exec pnpm dev
}

archive() {
  require_command docker

  local project

  while IFS= read -r project; do
    log "Removing isolated Docker Compose project ${project}"
    docker compose -p "$project" down -v --remove-orphans
  done < <(compose_projects_for_workspace)
}

case "${1:-run}" in
  run)
    run
    ;;
  archive)
    archive
    ;;
  *)
    printf 'Usage: %s [run|archive]\n' "$0" >&2
    exit 64
    ;;
esac
