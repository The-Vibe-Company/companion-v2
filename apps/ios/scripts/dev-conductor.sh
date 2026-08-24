#!/usr/bin/env bash
set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_PORT="${CONDUCTOR_PORT:-3000}"
SIMULATOR_OVERRIDE="${COMPANION_IOS_SIMULATOR:-}"

if [ "$(uname -s)" != "Darwin" ]; then
  printf '[ios-dev] Native iOS development requires a local macOS workspace.\n' >&2
  exit 1
fi
if ! [[ "$BASE_PORT" =~ ^[0-9]+$ ]] || [ "$BASE_PORT" -gt 65526 ]; then
  printf '[ios-dev] CONDUCTOR_PORT must be an integer between 0 and 65526, got: %s\n' "$BASE_PORT" >&2
  exit 2
fi
if ! command -v xcodebuildmcp >/dev/null 2>&1; then
  printf '[ios-dev] xcodebuildmcp is required. Install it with Homebrew before launching iOS.\n' >&2
  exit 1
fi

API_PORT="$((BASE_PORT + 1))"
API_URL="http://127.0.0.1:${API_PORT}"

if [ -n "$SIMULATOR_OVERRIDE" ]; then
  if [[ "$SIMULATOR_OVERRIDE" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]; then
    SIMULATOR_ARGS=(--simulator-id "$SIMULATOR_OVERRIDE")
  else
    SIMULATOR_ARGS=(--simulator-name "$SIMULATOR_OVERRIDE" --use-latest-os true)
  fi
  SIMULATOR_LABEL="$SIMULATOR_OVERRIDE"
else
  SIMULATOR_ID="$(xcodebuildmcp simulator list --output json | /usr/bin/python3 -c '
import json
import sys

simulators = [
    simulator
    for simulator in json.load(sys.stdin).get("data", {}).get("simulators", [])
    if simulator.get("isAvailable", True)
]
selected = next((simulator for simulator in simulators if simulator.get("state") == "Booted"), None)
selected = selected or (simulators[0] if simulators else None)
print(selected.get("simulatorId", "") if selected else "")
')"
  if [ -z "$SIMULATOR_ID" ]; then
    printf '[ios-dev] No available iOS simulator was found. Create one in Xcode first.\n' >&2
    exit 1
  fi
  SIMULATOR_ARGS=(--simulator-id "$SIMULATOR_ID")
  SIMULATOR_LABEL="$SIMULATOR_ID (booted simulator preferred)"
fi

printf '[ios-dev] API: %s\n' "$API_URL"
printf '[ios-dev] Simulator: %s\n' "$SIMULATOR_LABEL"

exec xcodebuildmcp simulator build-and-run \
  --workspace-path "$IOS_DIR/Companion.xcworkspace" \
  --scheme Companion \
  --configuration Debug \
  "${SIMULATOR_ARGS[@]}" \
  --launch-args "-COMPANION_API_URL" "$API_URL"
