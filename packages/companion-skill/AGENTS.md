# Bundled Companion skill

This scope owns the packable management skill and its official local client.

- Treat `packages/companion-skill/skill/companion.json` as the source of truth for version, user-facing copy, commands, changelog, environment declarations, and integrity membership.
- Edit the agent client in `packages/companion-skill/client/`. Regenerate `packages/companion-skill/skill/scripts/companion-agent-client.mjs` with `pnpm build --filter=@companion/companion-skill`; do not hand-edit the bundled output.
- When any file under `packages/companion-skill/skill/` changes, increment the manifest version above the merge-base version and add the matching first changelog entry.
- After changing integrity-tracked files, run `node packages/companion-skill/scripts/update-integrity.mjs`; do not hand-edit `packages/companion-skill/skill/companion.integrity.json`.
- Validate with `pnpm --filter @companion/companion-skill check:version-bump` and `python3 -m unittest discover -s packages/companion-skill/skill/scripts -p 'test_*.py'`. Run the relevant TypeScript client tests for changes under `packages/companion-skill/client/`.
- Preserve the security boundary: installation must validate the package before replacing targets, and Agent Auth failure must never silently fall back to a preserved PAT.
