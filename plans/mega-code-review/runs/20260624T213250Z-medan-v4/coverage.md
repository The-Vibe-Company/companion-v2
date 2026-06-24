# Coverage

| File | Coverage | Notes |
| --- | --- | --- |
| `apps/api/src/index.ts` | diff + route context | Checked PAT path, scope guard, list query integration, and related install endpoints. |
| `apps/api/src/localSkills.test.ts` | diff | Checked updated bundled skill package assertions. |
| `apps/api/src/skillCompanionManifest.test.ts` | diff | Checked manifest `checks` preservation expectation. |
| `apps/api/src/skillListQuery.test.ts` | full file | Checked query parsing coverage for `lib` and `installed`. |
| `apps/api/src/skillListQuery.ts` | full file | Checked boolean parsing behavior and route consumption. |
| `docs/design.md` | diff | Checked architecture docs match local-only execution boundary. |
| `packages/companion-skill/skill/SKILL.md` | diff | Checked agent-facing API and local inventory docs. |
| `packages/companion-skill/skill/companion.json` | diff | Checked manifest version and checks declaration. |
| `packages/companion-skill/skill/reference/api.md` | diff | Checked documented list filters and local check boundary. |
| `packages/companion-skill/skill/scripts/check_updates.py` | full file | Checked credential resolution, API calls, lockfile parsing, version comparison, reporting. |
| `packages/contracts/schemas/companion-manifest.v2.schema.json` | diff | Checked schema constraints for `checks.updates`. |
| `packages/contracts/src/companionManifest.ts` | diff | Checked Zod constraints and package-relative path validation. |
| `packages/contracts/test/companionManifest.test.ts` | diff | Checked tests for valid/invalid checks declarations. |
| `packages/core/src/services.ts` | diff + service context | Checked installed-only filtering, tenant/user scoping, and existing visibility semantics. |
| `packages/skills/src/manifest.ts` | diff | Checked package manifest serialization keeps `checks`. |
| `packages/skills/src/validateSkill.ts` | diff + validation context | Checked manifest script existence validation within package root. |
| `packages/skills/test/validateSkill.test.ts` | diff | Checked validation tests for invalid paths and missing scripts. |

## Related Files Read
- `packages/skills/src/semver.ts`
- `packages/companion-skill/src/index.ts`
- `apps/api/src/context.ts`
- Root `package.json`, `pnpm-workspace.yaml`, `turbo.json`
