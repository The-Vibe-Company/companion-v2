#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/dev-runtime-mode.sh"

if [ "$#" -lt 1 ]; then
  printf 'Usage: %s <runtime-command> [args...]\n' "$0" >&2
  exit 64
fi

box_dev_pid=""
box_dev_name="Box/Pi development service"
cleanup_box_dev() {
  local pid="$box_dev_pid"
  box_dev_pid=""
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    local attempt=0
    while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt 40 ]; do
      local state
      state="$(ps -p "$pid" -o stat= 2>/dev/null || true)"
      case "$state" in
        ''|Z*) break ;;
      esac
      sleep 0.05
      attempt=$((attempt + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      state="$(ps -p "$pid" -o stat= 2>/dev/null || true)"
      case "$state" in
        Z*) ;;
        *) kill -KILL "$pid" 2>/dev/null || true ;;
      esac
    fi
    wait "$pid" 2>/dev/null || true
  fi
}
trap cleanup_box_dev EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Conductor enables Companions for its demo account. `auto` preserves the
# historical provider-or-simulator selection; `lab` is an explicit local-only
# request for a real Linux VM managed by @companion/box-lab.
if ! box_mode="$(companion_dev_box_mode)"; then
  printf 'Invalid COMPANION_DEV_BOX_MODE=%s; expected auto, sim, live, or lab.\n' \
    "${COMPANION_DEV_BOX_MODE:-}" >&2
  exit 64
fi

box_dev_port=""
case "$box_mode" in
  sim)
    box_dev_port="${COMPANION_BOX_SIM_PORT:-13400}"
    box_dev_name="Box/Pi simulator"
    export COMPANION_BOX_API_KEY="box-sim-api-key"
    export COMPANION_BOX_API_BASE="http://127.0.0.1:${box_dev_port}"
    export COMPANION_BOX_POLL_INTERVAL_MS="${COMPANION_BOX_POLL_INTERVAL_MS:-10}"
    export COMPANION_BOX_READY_TIMEOUT_MS="${COMPANION_BOX_READY_TIMEOUT_MS:-10000}"
    export BOX_SIM_HOST=127.0.0.1
    export BOX_SIM_PORT="$box_dev_port"
    export BOX_SIM_API_KEY="$COMPANION_BOX_API_KEY"
    bash "$SCRIPT_DIR/dev-process.sh" box-sim \
      pnpm --filter @companion/box-sim dev &
    box_dev_pid=$!
    ;;
  lab)
    if [ "${CONDUCTOR_IS_LOCAL:-1}" = "0" ]; then
      printf 'COMPANION_DEV_BOX_MODE=lab requires a local Conductor workspace; run pnpm box:lab:smoke locally.\n' >&2
      exit 64
    fi
    box_dev_port="${BOX_LAB_PORT:-${COMPANION_BOX_SIM_PORT:-13400}}"
    box_dev_name="Box/Pi Linux Lab"
    box_lab_api_key="$(companion_dev_box_lab_api_key)"
    box_lab_workspace_id="${BOX_LAB_WORKSPACE_ID:-${CONDUCTOR_WORKSPACE_ID:-$(basename "$(dirname "$SCRIPT_DIR")")}}"
    # Remove a caller-supplied BOX_LAB_API_KEY from the wrapper environment too. The Lab gets the
    # provider spelling through its one inline assignment; Runtime gets only its canonical spelling.
    unset BOX_LAB_API_KEY BOX_LAB_WORKSPACE_ID
    export COMPANION_BOX_API_KEY="$box_lab_api_key"
    export COMPANION_BOX_API_BASE="http://127.0.0.1:${box_dev_port}"
    BOX_LAB_HOST=127.0.0.1 \
      BOX_LAB_PORT="$box_dev_port" \
      BOX_LAB_API_KEY="$box_lab_api_key" \
      BOX_LAB_WORKSPACE_ID="$box_lab_workspace_id" \
      BOX_LAB_DRIVER="${BOX_LAB_DRIVER:-lima}" \
      bash "$SCRIPT_DIR/dev-process.sh" box-lab \
      bash "$SCRIPT_DIR/box-lab.sh" dev &
    box_dev_pid=$!
    unset box_lab_api_key box_lab_workspace_id
    ;;
  live)
    if [ -z "${COMPANION_BOX_API_KEY:-}" ]; then
      printf 'COMPANION_DEV_BOX_MODE=live requires COMPANION_BOX_API_KEY.\n' >&2
      exit 64
    fi
    ;;
  disabled) ;;
esac

if [ -n "$box_dev_pid" ]; then
  if ! COMPANION_WAIT_READY_URL="http://127.0.0.1:${box_dev_port}/health" \
    COMPANION_WAIT_READY_PID="$box_dev_pid" \
    COMPANION_WAIT_READY_TIMEOUT_MS="${COMPANION_BOX_DEV_READY_TIMEOUT_MS:-${COMPANION_BOX_SIM_READY_TIMEOUT_MS:-10000}}" \
    node "$SCRIPT_DIR/wait-http-ready.mjs"; then
    cleanup_box_dev
    printf '%s failed to become ready; runtime was not started.\n' "$box_dev_name" >&2
    exit 1
  fi
fi

bash "$SCRIPT_DIR/dev-process.sh" runtime "$@"
