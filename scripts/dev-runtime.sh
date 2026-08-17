#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/dev-runtime-mode.sh"

if [ "$#" -lt 1 ]; then
  printf 'Usage: %s <runtime-command> [args...]\n' "$0" >&2
  exit 64
fi

box_sim_pid=""
cleanup_box_sim() {
  if [ -n "$box_sim_pid" ] && kill -0 "$box_sim_pid" 2>/dev/null; then
    kill "$box_sim_pid" 2>/dev/null || true
    wait "$box_sim_pid" 2>/dev/null || true
  fi
}
trap cleanup_box_sim EXIT HUP INT TERM

# Conductor enables Companions for its demo account. When no real provider is
# configured, use the deterministic simulator rather than making the fourth
# process crash or granting a Box credential to another child.
if companion_dev_uses_box_simulator; then
  box_sim_port="${COMPANION_BOX_SIM_PORT:-13400}"
  export COMPANION_BOX_API_KEY="box-sim-api-key"
  export COMPANION_BOX_API_BASE="http://127.0.0.1:${box_sim_port}"
  export COMPANION_BOX_POLL_INTERVAL_MS="${COMPANION_BOX_POLL_INTERVAL_MS:-10}"
  export COMPANION_BOX_READY_TIMEOUT_MS="${COMPANION_BOX_READY_TIMEOUT_MS:-10000}"
  export BOX_SIM_HOST=127.0.0.1
  export BOX_SIM_PORT="$box_sim_port"
  export BOX_SIM_API_KEY="$COMPANION_BOX_API_KEY"
  bash "$SCRIPT_DIR/dev-process.sh" box-sim \
    pnpm --filter @companion/box-sim dev &
  box_sim_pid=$!
  if ! COMPANION_WAIT_READY_URL="http://127.0.0.1:${box_sim_port}/health" \
    COMPANION_WAIT_READY_PID="$box_sim_pid" \
    COMPANION_WAIT_READY_TIMEOUT_MS="${COMPANION_BOX_SIM_READY_TIMEOUT_MS:-10000}" \
    node "$SCRIPT_DIR/wait-http-ready.mjs"; then
    wait "$box_sim_pid" 2>/dev/null || true
    printf 'Box/Pi simulator failed to become ready; runtime was not started.\n' >&2
    exit 1
  fi
fi

bash "$SCRIPT_DIR/dev-process.sh" runtime "$@"
