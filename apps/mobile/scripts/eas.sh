#!/usr/bin/env bash
# EAS evaluates app.config.ts before some commands read the selected profile.
# Always force the production application identifiers for remote operations.
set -euo pipefail
cd "$(dirname "$0")/.."
export APP_VARIANT=production
exec pnpm exec eas "$@"
