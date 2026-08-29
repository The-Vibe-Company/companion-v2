#!/usr/bin/env bash

# Environment resolvers shared by local launchers. This file must not mutate
# credentials or start processes; callers own those trust boundaries.
companion_runtime_effectively_enabled() {
  [ "${COMPANION_COMPANIONS_ENABLED:-}" = "true" ] \
    && [ -n "${COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS//[[:space:],]/}" ]
}

companion_dev_box_mode() {
  local requested_mode="${COMPANION_DEV_BOX_MODE:-auto}"
  case "$requested_mode" in
    auto|sim|live|lab) ;;
    *) return 64 ;;
  esac

  if ! companion_runtime_effectively_enabled; then
    printf 'disabled\n'
    return 0
  fi

  case "$requested_mode" in
    sim|live|lab)
      printf '%s\n' "$requested_mode"
      ;;
    auto)
      if [ -n "${COMPANION_BOX_API_KEY:-}" ]; then
        printf 'live\n'
      elif [ "${COMPANION_DEV_BOX_SIM_ENABLED:-true}" != "false" ]; then
        printf 'sim\n'
      else
        printf 'disabled\n'
      fi
      ;;
  esac
}

companion_dev_uses_box_simulator() {
  [ "$(companion_dev_box_mode 2>/dev/null || true)" = "sim" ]
}

companion_dev_uses_box_lab() {
  [ "$(companion_dev_box_mode 2>/dev/null || true)" = "lab" ]
}

# Print one caller-provided credential or generate a fresh 256-bit value. Generation stays inside
# dev-runtime.sh's process tree, so the secret never enters Conductor's concurrently command strings
# or sibling roles.
companion_dev_box_lab_api_key() {
  node - <<'NODE'
const { randomBytes } = require("node:crypto");

const explicit = process.env.BOX_LAB_API_KEY?.trim();
process.stdout.write(explicit || randomBytes(32).toString("base64url"));
NODE
}
