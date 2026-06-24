# Coverage

| File | Coverage | Notes |
| --- | --- | --- |
| `apps/api/src/index.ts` | diff + route context | Checked PAT-compatible list route, `skills:read`, query parsing, and tenant wrapper usage. |
| `apps/api/src/localSkills.test.ts` | diff | Checked bundled skill/package assertions. |
| `apps/api/src/skillCompanionManifest.test.ts` | diff | Checked manifest checks preservation expectation. |
| `apps/api/src/skillListQuery.test.ts` | full file | Checked list query parsing tests for `lib`, `installed`, and search limit behavior. |
| `apps/api/src/skillListQuery.ts` | full file | Checked parsing behavior for `installed=true` and existing filters. |
| `docs/design.md` | diff | Checked docs preserve the control-plane execution boundary. |
| `packages/companion-skill/skill/SKILL.md` | diff | Checked agent-facing listing, installed filter, local inventory, and local check docs. |
| `packages/companion-skill/skill/companion.json` | diff | Checked version, changelog, and `checks.updates`. |
| `packages/companion-skill/skill/reference/api.md` | diff | Checked public API docs and local check boundary. |
| `packages/companion-skill/skill/scripts/check_updates.py` | full file | Checked credential resolution, API calls, lockfile parsing, status reasons, and corrected semver comparison. |
| `packages/contracts/schemas/companion-manifest.v2.schema.json` | diff | Checked JSON Schema constraints for local update checks. |
| `packages/contracts/src/companionManifest.ts` | diff | Checked Zod constraints and serialization behavior. |
| `packages/contracts/test/companionManifest.test.ts` | diff | Checked tests for valid and invalid update check declarations. |
| `packages/core/src/services.ts` | diff + service context | Checked installed-only filter is scoped by org, skill, and caller. |
| `packages/skills/src/manifest.ts` | diff | Checked packaging preserves `checks`. |
| `packages/skills/src/validateSkill.ts` | diff + validation context | Checked package-relative script existence validation. |
| `packages/skills/test/validateSkill.test.ts` | diff | Checked validation and packaging test coverage for checks. |

## Generated Artifacts Not Reviewed As Product Code
- `plans/mega-code-review/runs/20260624T213250Z-medan-v4/*`
- `plans/mega-code-review/runs/20260624T213712Z-medan-v4/context.json`
