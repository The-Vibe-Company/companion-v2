#!/usr/bin/env bash

# Pure environment predicates shared by local launchers. This file must not
# mutate credentials or start processes; callers own those trust boundaries.
companion_runtime_effectively_enabled() {
  [ "${COMPANION_COMPANIONS_ENABLED:-}" = "true" ] \
    && [ -n "${COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS//[[:space:],]/}" ]
}

companion_dev_uses_box_simulator() {
  companion_runtime_effectively_enabled \
    && [ -z "${COMPANION_BOX_API_KEY:-}" ] \
    && [ "${COMPANION_DEV_BOX_SIM_ENABLED:-true}" != "false" ]
}
