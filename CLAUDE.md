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

Use `.conductor/settings.toml`. Setup installs PostgreSQL 17 plus `lsof` with `dnf` in cloud workspaces, or PostgreSQL 17 plus optional MinIO/Mailpit with Homebrew locally, then runs `corepack enable && pnpm install`. Run executes `bash scripts/dev-conductor.sh`; archive executes `bash scripts/dev-conductor.sh archive`.

The native Conductor stack starts per-workspace PostgreSQL plus optional MinIO and Mailpit under `.conductor-pg/`, then API, worker, and web. Ports derive from `CONDUCTOR_PORT`: web `+0`, API `+1`, PostgreSQL `+2`, MinIO API `+3`, console `+4`, SMTP `+5`, Mailpit UI `+6`. Cloud workspaces use base `3000`. Internal services bind loopback; cloud web binds `0.0.0.0`. Cookies use a workspace-specific prefix. Missing MinIO disables uploads; missing Mailpit falls back to logged email.

## Legacy Companions wake-on-send playbook

- An Owner/Editor send to a new or Asleep Companion persists first, reports Starting while one
  lifecycle owner wakes it, reaches Online only after Pi's current systemd invocation marks its RPC
  FIFO ready, and then produces an
  assistant reply or a visible Error. Starting → Asleep → Online → Asleep with no reply is a
  lifecycle failure. A first-keystroke prewarm carries delivery intent and must drain a send that
  loses the concurrent provisioning claim to it. Viewer reads remain control-plane-only.
- “Companion is replying…” means Pi accepted the current, non-timeout turn and is generating. Do
  not show it for a durable message whose `pending_count` is nonzero, an Asleep/Error runtime, a
  timed-out tool tail, or a post-timeout user tail until a fresh Pi event proves recovery.
- Do not use Full Box, archive, delete, or replacement as a wake-on-send repair. Use the normal
  start/resume path and Pi-only recycle for daemon, layout, provider, skill, or timed-out-turn
  recovery. Full Box remains an explicit operator action for a Box-level reset after narrower
  recovery is ruled out; deletion is lifecycle cleanup, never healing.
- The local and production happy-path suite is the same: create a fresh disposable Companion; send
  and require an assistant reply; ask it to `read` an image such as `conductor-cli.png` and require
  a settled result rather than an unbounded hang; stop/sleep the Box through the runtime stop API;
  send again and require Starting → Online plus another assistant reply with no intervening Asleep;
  then clean up the disposable fixture. Never run this suite against a named incident Companion.
- A timed-out-tail fixture is a separate regression suite: seed or preserve a settled `timeout`
  tool chip with user messages behind it; verify control-plane and Viewer reads keep that chip
  timed out and do not wake Box or show stale replying; then an Owner/Editor send may recycle Pi
  only, deliver the exact pending suffix once, and receive a reply. Do not convert this fixture into
  the fresh-Companion suite, and do not Full Box it to make the test pass.

## Tests and completion

- Follow `docs/testing.md`; prefer behavior-level coverage.
- Authorization matrices must cover non-members, cross-tenant access, and no-admin-override privacy.
- Frontend changes require `APP_URL=http://127.0.0.1:<port> pnpm browser:smoke` plus manual `agent-browser` checks for changed paths.
- Changes under `packages/companion-skill/skill/` require a version bump, top changelog entry, and `pnpm --filter @companion/companion-skill update:integrity`.
- Run `pnpm verify:change`; exit 2 means printed follow-up gates are still required.
- Architecture/data/auth/API changes must keep `docs/design.md` and the bundled Companion skill aligned.
- PR titles use Commitizen style, for example `feat(skills): simplify Companion to Skills Hub`.
