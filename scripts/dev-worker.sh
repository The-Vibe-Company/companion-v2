#!/usr/bin/env bash
set -euo pipefail

# Keep the package's normal DATABASE_URL fallback when neither URL is configured. An explicit empty
# DATABASE_URL changes postgres.js semantics, so only override the API URL when a worker URL exists.
if [ -n "${DATABASE_WORKER_URL:-}" ]; then
  export DATABASE_URL="$DATABASE_WORKER_URL"
fi

exec "$@"
