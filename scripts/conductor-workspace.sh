#!/usr/bin/env bash
# Back-compat shim: Conductor may still read archive/run from a stale root_path
# clone whose .conductor/settings.toml references this script name.
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dev-conductor.sh" "$@"
