#!/usr/bin/env bash
set -euo pipefail

if [ "${CONDUCTOR_IS_LOCAL:-1}" = "0" ]; then
  command -v sudo >/dev/null 2>&1 \
    || { printf '[setup-conductor] sudo is required in cloud workspaces\n' >&2; exit 1; }
  command -v dnf >/dev/null 2>&1 \
    || { printf '[setup-conductor] dnf is required in cloud workspaces\n' >&2; exit 1; }
  sudo dnf install -y lsof postgresql17 postgresql17-server
else
  command -v brew >/dev/null 2>&1 \
    || { printf '[setup-conductor] Homebrew is required in local workspaces\n' >&2; exit 1; }
  HOMEBREW_NO_ASK=1 brew install postgresql@17
  if ! HOMEBREW_NO_ASK=1 brew install minio mailpit; then
    printf '[setup-conductor] MinIO/Mailpit installation failed; continuing without optional services\n' >&2
  fi
fi

corepack enable
pnpm install
