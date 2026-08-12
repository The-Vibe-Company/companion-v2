# Companion v2

Companion v2 is an open-source, self-hostable, multi-tenant **Skills Hub** for organizations and the coding agents their members already use.

It manages personal and organization `SKILL.md` libraries, labels, safe uploads, validation, immutable versions, dependencies, comments, installs and updates, public releases, GitHub synchronization, write-only skill secrets, and hosted Skill Databases.

Companion does **not** create, launch, run, resume, chat with, or deploy agents. External coding agents connect as delegated Skills Hub clients through Agent Auth.

## Product model

- Hierarchy: **Organization → User**
- Roles: **Owner, Admin, Developer**
- Libraries: private **My Skills** (`personal`) and shared organization skills (`org`)
- Organization skills are manageable by every member.
- Personal skills are creator-only, including against admins.
- **Share** is the one-way, owner-only `personal → org` transition.
- Labels organize each library; install rows track organization skills used by a member.

## Repository

```text
apps/web       Next.js Skills workspace
apps/api       REST/tRPC API
apps/worker    GitHub, billing, and Skill Database maintenance
cli            Companion skill CLI
packages/      auth, billing, contracts, core, db, skills, skilldb, storage, GitHub
docs/          product and architecture
deploy/        self-hosted and Railway deployment
```

See [vision](docs/vision.md), [product](docs/product.md), [architecture](docs/design.md), [PRD](docs/PRD.md), and [testing](docs/testing.md).

## Local development

Requirements: Node.js 20+, pnpm 9, PostgreSQL, and optionally MinIO/Mailpit.

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm compose:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Conductor uses `.conductor/settings.toml` and `bash scripts/dev-conductor.sh` for isolated native services.

### Companions scaffold

The inert Companions list scaffold is disabled by default. To expose its authenticated web route,
sidebar entry, and API route locally, set the same server-side flag for both web and API, then restart:

```bash
COMPANION_COMPANIONS_ENABLED=true
```

With the flag unset or `false`, `/companions` and `/v1/companions` return not found and no Companions
navigation is rendered. The scaffold does not create or run agents, chat, plugins, or sharing. The
configuration is provider-neutral and uses no Vercel-specific deployment behavior.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm verify:change
APP_URL=http://127.0.0.1:3000 pnpm browser:smoke
```

License: MIT.
