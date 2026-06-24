# Verification

- `python3 -m py_compile packages/companion-skill/skill/scripts/check_updates.py`
- Inline Python semver assertions for stable vs prerelease, numeric prerelease ordering, alphanumeric prerelease ordering, and ignored build metadata.
- `pnpm --filter @companion/contracts test`
- `pnpm --filter @companion/skills test`
- `pnpm --filter @companion/api test`
- `git diff --check`
