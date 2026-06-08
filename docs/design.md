# Design - Companion v2

> **Status:** greenfield self-host slice. The Skills Hub is implemented around the target
> stack: Postgres + Drizzle, Better Auth, MinIO/S3, Hono API, Next.js web, and CLI. Agents,
> the Container Catalog, and Temporal workflows are prepared conceptually but not implemented.

## Stack

- **Data:** Postgres with Drizzle schema and migrations in `packages/db`.
- **Auth:** Better Auth in `packages/auth`, mounted by `apps/api` under `/auth/*`.
- **API:** Hono in `apps/api`; REST endpoints under `/v1/*`, tRPC mounted under `/trpc/*`.
- **Storage:** `packages/storage` wraps S3-compatible storage. MinIO is the local default.
- **Email:** `packages/email` supports local log/Mailpit mode and Resend for production.
- **Web:** Next.js App Router in `apps/web`; it calls the API, not Postgres or MinIO directly.
- **CLI:** `cli` stores an API URL plus Better Auth session cookie and uses REST endpoints.

Redis/BullMQ are intentionally excluded. Temporal is the intended future workflow engine for
deployments, reconcile loops, retries, compensation, and schedules.

## Local And Conductor Runtime

Manual local development uses `pnpm dev` as the idempotent full-stack entrypoint. The script starts
Postgres, MinIO, and Mailpit with the defaults from `.env.example`, applies Drizzle migrations, seeds
the local test user, and starts only the long-running API and web processes. Local Docker ports bind
to `COMPOSE_BIND_HOST`, which defaults to `127.0.0.1`. `pnpm dev:app` is the app-only loop when infra
is already prepared.

Conductor workspaces use `scripts/conductor-workspace.sh` instead of a shared root stack. The
script runs from the current worktree, derives a Docker Compose project name from the workspace,
and allocates all local services from `CONDUCTOR_PORT`: web `+0`, API `+1`, Postgres `+2`,
MinIO API `+3`, MinIO console `+4`, Mailpit SMTP `+5`, and Mailpit UI `+6`. It injects
workspace-specific `DATABASE_URL`, API URLs, S3 endpoint, Mailpit ports, and Better Auth cookie
prefix without mutating `.env`. Archiving a workspace runs Compose `down -v` for that project.

## Repository Layout

```
apps/
  api/        # Hono backend, Better Auth, REST + tRPC
  web/        # Next.js portal
packages/
  db/         # Drizzle schema, migrations, seeds
  auth/       # Better Auth config
  core/       # framework-free services, RBAC, scoping
  storage/    # S3/MinIO wrapper
  email/      # Mailpit/log/Resend providers
  contracts/  # shared Zod schemas and types
  skills/     # SKILL.md validation, packing, unpacking
cli/          # companion CLI
```

## Data Model

Better Auth owns the core `user`, `session`, `account`, and `verification` tables. Companion
adds `profiles`, `organizations`, `memberships`, `teams`, `team_memberships`, `invitations`,
`skills`, `skill_versions`, `skill_stars`, `skill_comments`, `api_tokens`, and `audit_log`.

Every tenant-owned table carries `org_id`. Skills keep ownership, visibility, and provenance
separate: `owner_id`, `scope`, `team_id`, and `creator_id`. Valid scopes are `private`, `team`,
and `public`.

`api_tokens` holds short-lived, scoped personal access tokens for programmatic publish/install.
Only the `sha256` `token_hash` is stored (the plaintext `cmp_pat_…` is shown once); each row carries
`scopes` (`skills:read` / `skills:write`), an `expires_at` (24h default), and `revoked_at`.

## Authorization

The service layer in `packages/core` is the primary enforcement point. It applies:

- visibility gate: private owner, team member, or public inside the selected org;
- capability gate: org/team role, owner checks, and scope-specific action checks;
- tenant gate: all service queries are scoped to the selected `org_id`.

Postgres RLS may be added later as defense-in-depth, but browser and CLI clients never connect
directly to Postgres.

## Public API

- Auth: `/auth/*` Better Auth endpoints, plus `/v1/auth/login`, `/v1/auth/logout`,
  `/v1/auth/whoami` for CLI ergonomics.
- Tokens: `POST /v1/tokens` (issue a scoped `cmp_pat_…`, plaintext returned once),
  `DELETE /v1/tokens/:id`. Session-authenticated only — a token cannot mint another.
- Skills: `/v1/skills`, `/v1/skills/:slug`, `/v1/skills/:slug/versions`,
  `/v1/skills/:slug/download`, `/v1/skills/:slug/scope`, `POST /v1/skills/create` (author a
  SKILL.md inline), and `GET /v1/skills/:slug/versions/:version/package` (download a version as `.zip`).
- Orgs: `/v1/orgs`, `/v1/orgs/current`, `/v1/teams`, `/v1/invitations`.

Requests authenticate by Better Auth cookie session **or** an `Authorization: Bearer cmp_pat_…`
token. Token requests are gated by scope (`skills:write` to publish, `skills:read` to download).
`POST /v1/skills` accepts a multipart `file` (browser/CLI) or a raw `application/zip` /
`application/gzip` body with `visibility`/`team`/`version` query params (the guided-prompt curl).
Uploads accept `.zip` or `.tar.gz`; the canonical stored, checksummed format is `.tar.gz`.

Skill archives are stored under `{org_id}/{slug}/{version}.tar.gz` in the `skill-archives` bucket;
the per-version package endpoint repackages them as `.zip` on the fly. Clients never receive S3
admin credentials.
