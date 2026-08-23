#!/usr/bin/env bash
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-metro}"
BASE_PORT="${CONDUCTOR_PORT:-3000}"

if ! [[ "$BASE_PORT" =~ ^[0-9]+$ ]] || [ "$BASE_PORT" -gt 65526 ]; then
  printf '[mobile-dev] CONDUCTOR_PORT must be an integer between 0 and 65526, got: %s\n' "$BASE_PORT" >&2
  exit 2
fi

API_PORT="$((BASE_PORT + 1))"
METRO_PORT="$((BASE_PORT + 9))"
API_URL_SOURCE="shell"
if [ -z "${EXPO_PUBLIC_API_URL:-}" ]; then
  if [ -f "$MOBILE_DIR/.env.local" ] && grep -Eq '^EXPO_PUBLIC_API_URL=' "$MOBILE_DIR/.env.local"; then
    API_URL_SOURCE="apps/mobile/.env.local"
  else
    export EXPO_PUBLIC_API_URL="http://127.0.0.1:${API_PORT}"
    API_URL_SOURCE="Conductor default"
  fi
fi
export RCT_METRO_PORT="$METRO_PORT"
export REACT_NATIVE_PACKAGER_HOSTNAME="${REACT_NATIVE_PACKAGER_HOSTNAME:-127.0.0.1}"

install_dependencies() {
  local fingerprint
  local install_state="$MOBILE_DIR/node_modules/.companion-install-fingerprint"
  fingerprint="$(cksum "$MOBILE_DIR/package.json" "$MOBILE_DIR/pnpm-lock.yaml")"
  if [ -x "$MOBILE_DIR/node_modules/.bin/expo" ] && \
    [ -f "$install_state" ] && \
    [ "$(<"$install_state")" = "$fingerprint" ]; then
    return
  fi

  printf '[mobile-dev] Installing standalone mobile dependencies...\n'
  CI=1 pnpm --dir "$MOBILE_DIR" --ignore-workspace install --frozen-lockfile
  printf '%s\n' "$fingerprint" >"$install_state"
}

print_endpoints() {
  if [ -n "${EXPO_PUBLIC_API_URL:-}" ]; then
    printf '[mobile-dev] API: %s (%s)\n' "$EXPO_PUBLIC_API_URL" "$API_URL_SOURCE"
  else
    printf '[mobile-dev] API: loaded by Expo from %s\n' "$API_URL_SOURCE"
  fi
  printf '[mobile-dev] Metro: http://127.0.0.1:%s\n' "$METRO_PORT"
}

case "$MODE" in
  setup)
    install_dependencies
    ;;
  metro)
    install_dependencies
    print_endpoints
    exec pnpm --dir "$MOBILE_DIR" --ignore-workspace exec expo start --lan --port "$METRO_PORT"
    ;;
  ios)
    if [ "$(uname -s)" != "Darwin" ]; then
      printf '[mobile-dev] iOS requires a local macOS workspace with Xcode.\n' >&2
      exit 1
    fi
    command -v xcodebuild >/dev/null 2>&1 || {
      printf '[mobile-dev] Xcode command-line tools are required.\n' >&2
      exit 1
    }
    install_dependencies
    print_endpoints
    if command -v xcodebuildmcp >/dev/null 2>&1; then
      printf '[mobile-dev] XcodeBuildMCP is available to the coding agent.\n'
    else
      printf '[mobile-dev] XcodeBuildMCP is optional; install it with pnpm mobile:mcp:setup.\n'
    fi
    exec pnpm --dir "$MOBILE_DIR" --ignore-workspace exec expo run:ios --port "$METRO_PORT"
    ;;
  android)
    install_dependencies
    print_endpoints
    if command -v adb >/dev/null 2>&1; then
      adb reverse "tcp:${API_PORT}" "tcp:${API_PORT}" >/dev/null || \
        printf '[mobile-dev] Warning: could not reverse the API port through adb.\n' >&2
      adb reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}" >/dev/null || \
        printf '[mobile-dev] Warning: could not reverse the Metro port through adb.\n' >&2
    else
      printf '[mobile-dev] adb is not on PATH; Android loopback forwarding was skipped.\n' >&2
    fi
    exec pnpm --dir "$MOBILE_DIR" --ignore-workspace exec expo run:android --port "$METRO_PORT"
    ;;
  ports)
    printf 'api=%s\n' "$API_PORT"
    printf 'metro=%s\n' "$METRO_PORT"
    ;;
  *)
    printf '[mobile-dev] Unknown mode: %s\n' "$MODE" >&2
    printf '[mobile-dev] Available modes: setup, ios, android, metro, ports\n' >&2
    exit 2
    ;;
esac
