# Contributor guidance

Companion v2 is a self-hostable, multi-tenant **Skills Hub only**. Read `docs/vision.md`, `docs/product.md`, `docs/design.md`, `docs/PRD.md`, `docs/testing.md`, and root `DESIGN.md` before non-trivial changes.

## Domain vocabulary

- Hierarchy: **Organization → User**; roles: **Owner, Admin, Developer**.
- Skills use `scope: personal | org`. Personal skills are creator-only with no admin override. Organization skills are manageable by every member.
- Share is the sole owner-only, one-way `personal → org` transition.
- Organization and personal label trees organize skills without changing access.
- External coding agents are delegated clients of the Skills Hub. Companion never launches or executes them.

Do not introduce Projects, runs, sessions, prompts, transcripts, launch actions, sandboxes, model/provider connections, containers, deployments, runtime supervisors, or feature flags that can enable them.

## Architecture anchors

- `packages/db/src/schema.ts`: tenant data source of truth.
- `packages/core/src/authz.ts`: membership, RBAC, personal-skill privacy.
- `packages/core/src/services.ts`: shared skill domain services.
- `packages/skills`: package parsing, validation, versioning.
- `packages/skilldb`: hosted declared SQLite state.
- `packages/db/runtime-role-grants.sql`: split API/worker grants.
- `apps/worker/src/supervisors.ts`: GitHub, billing, and Skill Database cleanup only.
- `apps/api/src/agentAuthRoutes.ts`: skill-facing delegated client approval.

## Invariants

- TypeScript, pnpm workspaces, Turborepo, Drizzle, and tRPC plus REST. Authentication uses Better Auth;
  object storage is S3-compatible.
- `packages/core` has no Next.js dependency. Shared contracts belong in `packages/contracts`.
- Every tenant row/query is scoped by `org_id`; RLS is defense in depth.
- Secrets are envelope-encrypted, write-only, referenced by id, and never logged or returned as plaintext.
- The control plane never executes package scripts. Archives and transfer tickets remain fail-closed.
- Public releases pin an exact immutable version and checksum.
- Desired GitHub mirrors and Skill Database cleanup are idempotent.
- Frontend work follows root `DESIGN.md`.

## Conductor

Use `.conductor/settings.toml`. Setup runs `corepack enable && pnpm install`; run executes `bash scripts/dev-conductor.sh`; archive executes `bash scripts/dev-conductor.sh archive`.

The native Conductor stack starts per-workspace PostgreSQL plus optional MinIO and Mailpit under `.conductor-pg/`, then API, worker, and web. Ports derive from `CONDUCTOR_PORT`: web `+0`, API `+1`, PostgreSQL `+2`, MinIO API `+3`, console `+4`, SMTP `+5`, Mailpit UI `+6`. Cloud workspaces use base `3000`. Internal services bind loopback; cloud web binds `0.0.0.0`. Cookies use a workspace-specific prefix. Missing MinIO disables uploads; missing Mailpit falls back to logged email.

## Tests and completion

- Follow `docs/testing.md`; prefer behavior-level coverage.
- Authorization matrices must cover non-members, cross-tenant access, and no-admin-override privacy.
- Frontend changes require `APP_URL=http://127.0.0.1:<port> pnpm browser:smoke` plus manual `agent-browser` checks for changed paths.
- Changes under `packages/companion-skill/skill/` require a version bump, top changelog entry, and `pnpm --filter @companion/companion-skill update:integrity`.
- Run `pnpm verify:change`; exit 2 means printed follow-up gates are still required.
- Architecture/data/auth/API changes must keep `docs/design.md` and the bundled Companion skill aligned.
- PR titles use Commitizen style, for example `feat(skills): simplify Companion to Skills Hub`.
