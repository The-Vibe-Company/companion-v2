#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  printf 'Usage: %s <dev|doctor|smoke|shell|reset> [args...]\n' "$0" >&2
  exit 64
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export BOX_LAB_STATE_DIR="${BOX_LAB_STATE_DIR:-$repo_root/.context/box-lab}"
export BOX_LAB_WORKSPACE_ID="${BOX_LAB_WORKSPACE_ID:-${CONDUCTOR_WORKSPACE_ID:-$(basename "$repo_root")}}"

cd "$repo_root"

if ! command -v pnpm >/dev/null 2>&1; then
  printf '%s\n' \
    '[box-lab] pnpm is required. Run: corepack enable && corepack prepare pnpm@9.12.0 --activate' >&2
  exit 69
fi

# A Conductor workspace can receive Box Lab through cloud-to-Mac sync after its
# one-time setup ran. In that case the lockfile is present but this new package
# has no node_modules links yet. Match the normal Conductor Run preflight and
# repair only that missing-dependency case before invoking the TypeScript CLI.
if [ ! -x "$repo_root/packages/box-lab/node_modules/.bin/tsx" ]; then
  printf '%s\n' \
    '[box-lab] Workspace dependencies are missing; synchronising them with pnpm install.' >&2
  if ! pnpm install --frozen-lockfile --prefer-offline; then
    printf '%s\n' \
      '[box-lab] Dependency sync failed. Run: corepack enable && pnpm install --frozen-lockfile' >&2
    exit 1
  fi
fi

exec pnpm --filter @companion/box-lab run "$@"
