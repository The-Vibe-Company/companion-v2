# Companion v2

Companion v2 is an open-source, self-hostable, multi-tenant **Skills Hub at its core**, with an
optional Companions control plane. It manages personal and organization `SKILL.md` libraries,
labels, safe uploads, validation, immutable versions, dependencies, comments, installs and updates,
public releases, GitHub synchronization, write-only skill secrets, and hosted Skill Databases.

When Companions are enabled, each Companion is one named teammate with one persistent
[box.ascii.dev](https://box.ascii.dev) Box, one Pi daemon, and one durable chat thread. External
coding agents remain delegated Skills Hub clients through Agent Auth; Companion does not turn them
into hosted Companions or launch them as a runtime harness.

## Product model

- Hierarchy: **Organization → User**
- Roles: **Owner, Admin, Developer**
- Libraries: private **My Skills** (`personal`) and shared organization skills (`org`)
- Organization skills are manageable by every member.
- Personal skills are creator-only, including against admins.
- **Share** is the one-way, owner-only `personal → org` transition.
- Labels organize each library; install rows track organization skills used by a member.
- A hosted Companion has an immutable Owner and optional workspace-wide Editor or Viewer access.

## Repository

```text
apps/web                    Next.js Skills workspace and Companion threads
apps/api                    REST/tRPC authorization and durable control-plane intent
apps/worker                 GitHub, billing, Skill Database maintenance, and Companion routines
apps/runtime                sole Box/Pi lifecycle and durable-turn executor
cli                         Companion skill CLI
packages/box-runtime        ascii.dev transport and layout-14 Pi broker
packages/companion-runtime  Runtime v2 state machine
packages/                   auth, billing, contracts, core, db, skills, skilldb, storage, GitHub
docs/                       product, architecture, testing, and operations
deploy/                     self-hosted and Railway deployment
```

The API persists an accepted message or lifecycle operation and returns; it never calls Box or Pi.
`apps/runtime` is the only process that receives `COMPANION_BOX_API_KEY`, claims runtime work, or
owns a runtime lease. API, worker, and runtime use three distinct least-privilege PostgreSQL roles.

See [vision](docs/vision.md), [product](docs/product.md), [architecture](docs/design.md),
[Companions Runtime v2](docs/companions-runtime.md), [PRD](docs/PRD.md), and
[testing](docs/testing.md).

## Local development

Requirements: Node.js 20+, pnpm 9, PostgreSQL, and optionally MinIO/Mailpit.

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

The launcher starts the local dependencies, creates the distinct API/worker/runtime database roles,
runs the guarded two-phase migration and grants step, seeds the test user, then starts all four
processes. Direct `pnpm db:migrate` is also the same two-phase runner and requires the migration URL
plus all three application role names; raw `drizzle-kit migrate` cannot cross Runtime v2 migration
0094 safely.

The application topology is web, API, worker, and private runtime. Conductor uses
`.conductor/settings.toml` and `bash scripts/dev-conductor.sh` to give each workspace isolated
PostgreSQL, optional MinIO/Mailpit, unique cookies, and non-conflicting ports.

### Self-hosted production

Build once, apply migrations with an ephemeral migration-owner credential, and only then start the
long-lived services with their restricted credentials. The API `start` script starts the HTTP
server only; it never applies migrations and must not receive `DATABASE_MIGRATION_URL` or the role
name variables.

```bash
pnpm --filter @companion/api build
DATABASE_MIGRATION_URL=postgres://migration_owner:...@db/companion \
DATABASE_API_ROLE=companion_api \
DATABASE_WORKER_ROLE=companion_worker \
DATABASE_COMPANION_RUNTIME_ROLE=companion_runtime_v2 \
pnpm --filter @companion/api migrate

DATABASE_URL=postgres://companion_api:...@db/companion \
pnpm --filter @companion/api start
```

Treat a successful migration command as a release gate before starting or restarting API, worker,
runtime, and web from that same build. Never use `start` as a migration mechanism.

### Companions runtime

Companions are disabled by default. To enable them, set the same flag and exact-domain allowlist on
web, API, worker, and runtime, then restart those services:

```bash
COMPANION_COMPANIONS_ENABLED=true
COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=example.com
```

With either value missing, Companion routes and navigation stay absent, runtime claims stay off, and
the worker fires no Companion routine. The flag is also the operational kill switch after Runtime v2
data exists; rollback never sends v2 rows to a legacy executor.

Runtime needs its dedicated database URL, the public API origin reachable from Box, and the sole
copy of the Box key. API reaches only the runtime's private desktop endpoint. The two services share
a short-request HMAC key generated independently from the envelope-encryption master key:

```bash
# runtime only
DATABASE_COMPANION_RUNTIME_URL=postgres://companion_runtime_v2:...@127.0.0.1:5432/companion
COMPANION_BOX_API_KEY=box_...
COMPANION_API_URL=http://127.0.0.1:3001
COMPANION_RUNTIME_HOST=127.0.0.1
COMPANION_RUNTIME_PORT=3007

# API + runtime only; base64-encoded 32 random bytes
COMPANION_RUNTIME_DESKTOP_HMAC_SECRET=...

# API only
COMPANION_RUNTIME_PRIVATE_URL=http://127.0.0.1:3007
```

Runtime also needs the envelope master key and read access to selected Skill archives. Prefer a Box
environment with Pi pinned; otherwise configure an operator-pinned `COMPANION_PI_INSTALL_COMMAND`.
The Box TTL is fixed at six hours after successful Pi acceptance. There is no prewarm, Wake button,
or automatic Full Box recovery.

For a Conductor workspace, put `COMPANION_BOX_API_KEY` in the repository-root `.env` before starting
or restarting Run. The local Conductor launcher also accepts ascii.dev's `BOX_API_KEY` spelling and
normalizes it into the runtime-only variable; its startup header says explicitly whether it selected
the configured provider or the deterministic simulator. Model-provider credentials such as
`ZAI_API_KEY` are deliberately ignored in process environments: connect z.ai from **Companions →
Providers**, then select its live Pi model when creating the Companion.

See the [Runtime v2 operations runbook](docs/runbooks/companions-runtime.md) for cutover, purge,
kill-switch, incident, and rollback procedures. Railway deployment details live in
[deploy/railway/README.md](deploy/railway/README.md).

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm verify:change
APP_URL=http://127.0.0.1:3000 pnpm browser:smoke
```

`pnpm lint` runs anti-slop before the existing workspace lint. Anti-slop is intentionally
incremental: it compares the worktree with the merge base of `origin/main` and requires every
changed JavaScript or TypeScript file to satisfy the full rule set, including unchanged lines in
that file. Use `pnpm lint:anti-slop -- --base <ref>` when the target branch differs.

License: MIT.
