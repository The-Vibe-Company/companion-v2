#!/usr/bin/env bash
# Run the bundled Companion skill guard suite and refuse a vacuous pass.
#
# `unittest discover` exits 0 while printing "Ran 0 tests" when its pattern matches nothing, and
# both callers of this script are required CI gates. Renaming or moving anything under the suite
# directory would otherwise leave the gates green while proving nothing, including on the macOS
# runner that exists precisely because descriptor permissions differ from Linux there.
set -euo pipefail

MINIMUM_TESTS="${MINIMUM_TESTS:-100}"
SUITE_DIR="packages/companion-skill/skill/scripts"
PYTHON="${PYTHON:-python}"

status=0
output="$("$PYTHON" -m unittest discover -s "$SUITE_DIR" -p 'test_*.py' 2>&1)" || status=$?
printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  exit "$status"
fi

count="$(printf '%s\n' "$output" | sed -n 's/^Ran \([0-9][0-9]*\) test.*/\1/p' | tail -n 1)"
if [ -z "$count" ] || [ "$count" -lt "$MINIMUM_TESTS" ]; then
  printf 'Expected at least %s guard tests from %s, got %s.\n' \
    "$MINIMUM_TESTS" "$SUITE_DIR" "${count:-none}" >&2
  exit 1
fi
