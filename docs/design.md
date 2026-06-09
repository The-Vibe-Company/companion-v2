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

Conductor workspaces use a separate, **native (Docker-free)** entrypoint, `scripts/dev-conductor.sh`
(modeled on `~/Dev/monkapps`). It starts a per-workspace Postgres cluster — plus optional native MinIO
and Mailpit — under `.conductor-pg/`, applies migrations, seeds the test user, and runs only the
long-running API and web processes via `concurrently`. All services are allocated from
`CONDUCTOR_PORT`: web `+0`, API `+1`, Postgres `+2`, MinIO API `+3`, MinIO console `+4`, Mailpit SMTP
`+5`, and Mailpit UI `+6`. It injects workspace-specific `DATABASE_URL`, API URLs, S3 endpoint,
Mailpit ports, and a `companion-<workspace>` Better Auth cookie prefix inline — without mutating
`.env`. MinIO/Mailpit degrade gracefully when their binaries are absent (S3 uploads disabled, email
falls back to `EMAIL_PROVIDER=log`). A cleanup trap stops every native service on exit; archiving a
workspace runs `scripts/dev-conductor.sh archive`, which stops the services and removes
`.conductor-pg/`.

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
`skills`, `skill_versions`, `skill_stars`, `skill_filter_preferences`, `skill_comments`,
`api_tokens`, and `audit_log`.

Every tenant-owned table carries `org_id`. Skills keep ownership, visibility, and provenance
separate: `owner_id`, `scope`, `team_id`, and `creator_id`. Valid scopes are `private`, `team`,
and `public`.

`api_tokens` holds short-lived, scoped personal access tokens for programmatic publish/install.
Only the `sha256` `token_hash` is stored (the plaintext `cmp_pat_…` is shown once); each row carries
`scopes` (`skills:read` / `skills:write`), an `expires_at` (24h default), and `revoked_at`.

`skill_filter_preferences` stores the current user's Skills Hub filter state for one organization.
The row is keyed by `(org_id, user_id)` and contains `active_filters` plus `custom_views` JSONB.
It is personal UI state, not a shared organization resource.

Onboarding adds a few columns: `organizations.domain` + `organizations.domain_auto_join` (a verified
email domain that grants membership, and whether matching signups join automatically), plus cosmetic
`organizations.color`/`logo_url` and `teams.color`/`teams.icon`. `teams.description` holds an optional
free-text summary shown on the team's settings page. `profiles.onboarded_at` records that a
user has finished onboarding. A partial unique index on `lower(organizations.domain)` enforces one org
per verified domain.

## Authentication

`packages/auth` configures Better Auth with email/password, **email verification**, and **Google OAuth**:

- **Email verification (6-digit OTP).** `emailAndPassword.requireEmailVerification` is on, and the
  `emailOTP` plugin (with `overrideDefaultEmailVerification`) replaces the default magic-link with a
  6-digit code. Codes are delivered via `@companion/email` (`verificationCodeEmail` /
  `passwordResetCodeEmail` → Resend in production, Mailpit/log locally). A signup creates the user but no
  session; the OTP auto-sends. `autoSignInAfterVerification` makes `/auth/email-otp/verify-email` create
  the session, so the user lands logged in and is routed to `/onboarding`. `sendOnSignIn` re-mails a code
  when an unverified user signs in, so the UI can jump straight to the verify screen. Password reset uses
  the same code aesthetic (`/auth/email-otp/request-password-reset` → `/auth/email-otp/reset-password`).
- **Google OAuth** is conditional: wired only when `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` are set
  (the button always renders; otherwise the web route returns a friendly error). New Google users go to
  `/onboarding`, returning users to their `next` target.
- **Web ↔ API glue.** The web app never uses the Better Auth client SDK. Next.js route handlers under
  `apps/web/src/app/v1/auth/*` (`signin`, `signup`, `verify-email`, `verify-email/send`,
  `forgot-password`, `reset-password`, `google`) forward to the API's `/auth/*` server-side and re-emit
  the `Set-Cookie` on the **web origin**, keeping the session cookie same-origin (`shared lib/authProxy.ts`).
  Google OAuth is the exception — the browser hits the API callback directly, which sets the cookie on the
  API origin. The reused 6-digit OTP UI is a single client state machine in `(auth)/login/LoginForm.tsx`.

Production requirements: set `BETTER_AUTH_URL` to the API's public origin (the Google redirect URI is
derived as `${BETTER_AUTH_URL}/auth/callback/google` and must be registered in Google Cloud); keep web
and API **same-site** (prefer a same-origin reverse proxy for `/auth/*`) so both the OAuth-callback cookie
and the re-emitted email/password cookie reach the web app; do **not** enable `crossSubDomainCookies`
(host-only cookies are what the re-emit pattern relies on); serve over HTTPS so `Secure` cookies survive.

## Onboarding & bootstrap

New users complete a domain-driven onboarding immediately after signup (the web app routes signups to
`/onboarding`, and `whoami.needsOnboarding` gates the app shells). The signed-in, verified email domain
drives the flow:

- A **free/consumer** domain (e.g. `gmail.com`) — classified via the maintained `free-email-domains`
  blocklist in `packages/core/email-domains.ts` — has no inferable org, so the user creates one.
- A **corporate** domain that matches an existing `domain_auto_join` org → the user is offered to join it
  (the org is re-derived server-side from the verified email; the client never supplies an org id).
- Otherwise the user creates an org (name, optional website + best-effort logo/brand color, a first team
  with a color + emoji icon, and teammate invites).

`completeOnboarding` writes the org, first team, invitations, and `onboarded_at` in one transaction;
`joinOrgByDomain` adds the membership and stamps `onboarded_at`; `acceptInvitation` stamps it too.
Domain claiming and auto-join are only honored for the actor's **own** corporate domain, and joining (or
enabling auto-join) requires a verified email when `COMPANION_REQUIRE_VERIFIED_DOMAIN_JOIN` is on
(default: production). `ensureUserBootstrap` now only upserts the `profiles` row — the legacy
"first user owns the seeded Acme org" auto-bootstrap was removed in favor of this flow.

## Authorization

The service layer in `packages/core` is the primary enforcement point. It applies:

- visibility gate: private owner, team member, or public inside the selected org;
- capability gate: org/team role, owner checks, and scope-specific action checks;
- tenant gate: all service queries are scoped to the selected `org_id`.

Postgres RLS may be added later as defense-in-depth, but browser and CLI clients never connect
directly to Postgres.

## Public API

- Auth: `/auth/*` Better Auth endpoints (email/password, `email-otp/*` verification + reset, and
  `sign-in/social` + `callback/google`), plus `/v1/auth/login`, `/v1/auth/logout`,
  `/v1/auth/whoami` for CLI ergonomics. `whoami` also returns `onboarded` / `needsOnboarding`.
- Onboarding: `GET /v1/onboarding/context` (email-domain classification + any auto-join org, no org id),
  `POST /v1/onboarding/join` (join the auto-join org for the verified domain),
  `POST /v1/onboarding/create` (create org + first team + invites, finish onboarding).
- Tokens: `GET /v1/tokens` (list the caller's own active keys, no plaintext — it backs the personal
  Account pane, so it is caller-scoped even for admins), `POST /v1/tokens` (issue a scoped `cmp_pat_…`,
  plaintext returned once), `DELETE /v1/tokens/:id` (an org admin may revoke any token by id).
  Session-authenticated only — a token cannot mint another.
- Skills: `/v1/skills`, `/v1/skills/:slug`, `/v1/skills/:slug/versions`,
  `/v1/skills/:slug/download`, `/v1/skills/:slug/scope`, `/v1/skill-filter-preferences`,
  `POST /v1/skills/create` (author a SKILL.md inline), and
  `GET /v1/skills/:slug/versions/:version/package` (download a version as `.zip`).
- Orgs & settings: `/v1/orgs`, `GET`/`POST`/`PUT /v1/orgs/current` (read/select/rename+reslug the org,
  admin only for `PUT`), `GET /v1/orgs/current/settings` (members, invitations, teams + descriptions),
  `PUT /v1/users/me` (update display name), `/v1/teams` + `PUT`/`DELETE /v1/teams/:id` (rename/describe,
  or delete a team — org admin, re-scoping the team's skills to private), and `/v1/invitations`.

Requests authenticate by Better Auth cookie session. An `Authorization: Bearer cmp_pat_…` token is
accepted **only** on the PAT-enabled skills endpoints (`POST /v1/skills`, `POST /v1/skills/create`,
`GET /v1/skills/:slug/download`, `GET /v1/skills/:slug/versions/:version/package`); every other
endpoint rejects tokens. Token requests are scope-gated (`skills:write` to publish/create,
`skills:read` to download). `POST /v1/skills` accepts a multipart `file` (browser/CLI) or a raw
`application/zip` / `application/gzip` body with `visibility`/`team`/`version` query params (the
guided-prompt curl). Uploads accept `.zip` or `.tar.gz`; the canonical stored, checksummed format
is `.tar.gz`.

Skill archives are stored under `{org_id}/{slug}/{version}.tar.gz` in the `skill-archives` bucket;
the per-version package endpoint repackages them as `.zip` on the fly. Clients never receive S3
admin credentials.
