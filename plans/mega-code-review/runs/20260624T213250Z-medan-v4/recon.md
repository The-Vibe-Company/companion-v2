# Recon

## Scope
- Repository root: `/Users/stan/conductor/workspaces/companion-v2/medan-v4`
- Mode: `uncommitted`
- Diff truncation: none reported by `context.json`
- Changed files reviewed: 17

## Project Context
- Monorepo using pnpm workspaces and TypeScript packages under `apps/` and `packages/`.
- Public skills API changes must update bundled Companion skill docs and contracts.
- Security boundary from project docs: the control plane validates and serves packages but must not execute untrusted skill scripts.

## Review Method
- Read repository instructions from `AGENTS.md` and `CLAUDE.md`.
- Read root package/workspace metadata.
- Reviewed the collected diff and full contents for new files.
- Inspected related implementation context for skills listing, install filtering, manifest validation, packaging, and semver behavior.
- Used an inline focused check instead of spawning a delegated reviewer because the available multi-agent instructions require explicit user request for sub-agents.
