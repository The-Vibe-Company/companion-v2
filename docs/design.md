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
adds `profiles`, `organizations`, `memberships`, `invitations`,
`skills`, `skill_versions`, `skill_version_dependencies`, `skill_stars`, `labels`, `skill_labels`,
`skill_filter_preferences`, `skill_comments`, `skill_comment_images`, `local_skill_installs`,
`api_tokens`, and `audit_log`. There are **no teams**: the hierarchy is `Organization → User`.

Every tenant-owned table carries `org_id`. A skill lives in one of two libraries, set by a single
`skills.scope` enum (`'org'` default, or `'personal'`):

- **`org`** — the flat org-wide library: every member of the org can read it, and any member can edit,
  publish, archive, or delete it. Organized by org-wide shared **labels**.
- **`personal`** — a private "My Skills" library, visible **only to its creator** (admins included —
  there is no admin override). The owner is `creator_id`; only the owner can read, edit, share, or
  delete it. Organized by that user's **personal folders** (`personal_labels`).

`creator_id` (always recorded, for Activity/audit) doubles as the **owner** of a personal skill. There
is still no `owner_team_id`, `everyone` flag, `skill_team_shares` table, or `PUT /v1/skills/:slug/owner`
endpoint. A slug is **workspace-unique across both scopes** (`skills_org_slug_uq (org_id, slug)`), so the
slug-keyed dependency graph stays unambiguous and Share can never collide. The one scope transition is
**Share** (`POST /v1/skills/:slug/share`): owner-only, one-way `personal → org`, which also drops the
skill's personal-folder assignments. "Installed" is not a copied row — a member's My Skills =
(`scope='personal' AND creator=them`) ∪ (org skills they have a `skill_installs` row for), surfaced
together. A version's declared tools
(`skill_versions.tools`) come from the Agent Skills `allowed-tools` frontmatter string.
Companion-specific package data lives in root `companion.json`, not `SKILL.md`: `name`, `version`,
human-facing `title`/`description`, Markdown-compatible `notes`, `metadata.companionSkillId`,
`metadata.changelog`, `environment.env` / `environment.secrets` declarations (never values),
`commands`, and un-versioned skill `dependencies` as `{ skillName: skillId }`. `description` updates the existing
`skills.description` listing field; the full normalized manifest rides in the existing
`skill_versions.frontmatter` JSON under `companion` and is parsed back into the read shape
(`skillListRowSchema.display` / `skillListRowSchema.requirements`) for the skill detail view. Legacy
packages that still declare `requirements` in `SKILL.md`, `display`, or dependency arrays are readable
for compatibility and are normalized into `companion.json` on publish. Companion registry data is
written into `companion.json` when a package is published. On targeted re-publish, callers may send
`expect_slug` and `expect_skill_id`; validation and publication reject mismatched frontmatter names
and any present `companion.json.metadata.companionSkillId` (or legacy
`metadata.companion_skill_id`) that points at a different skill.
On re-publish of an existing Companion package, reserved version metadata is treated as provenance; the API/CLI still assigns the
next registry version unless the caller passes an explicit version. Legacy top-level `version`,
`tools`, and unknown fields are warnings and are not preserved as top-level fields in newly stored
packages; top-level `scope` or `visibility` is still rejected because a skill never self-declares
access — every skill is org-wide, and organization is by **labels** (assigned on the publish request
via repeatable `label` values), never declared inside the package.

**Labels (org-wide shared folders).** Skills are organized — never gated — by an org-wide shared tree
of slash-separated **label** paths (e.g. `marketing/seo`) with optional human-facing display names
(e.g. `SEO`). Two org-scoped, RLS-tenanted tables hold the model, and the path string is stored **on
the junction** (no FK to a label id) so rename is a prefix `UPDATE`, delete is a prefix `DELETE`, and
roll-up counts need no join:

- `labels` — the canonical path set plus per-path display/appearance, and what lets an **empty**
  folder exist: `(org_id, path, display_name, color, icon, created_by, created_at, updated_at)`, PK
  `(org_id, path)`.
- `skill_labels` — the assignment edge (a skill has N paths): `(org_id, skill_id, path, created_by,
  created_at)`, PK `(org_id, skill_id, path)`, with an org-scoped composite FK
  `(org_id, skill_id) → skills(org_id, id)` cascade.

The tree is **derived** in the service by splitting paths on `/` (intermediate parents are derived;
nodes are `labels` ∪ distinct `skill_labels.path`). A node's roll-up count = skills whose assigned path
`= node` OR `LIKE node || '/%'`, de-duped per skill. A `text_pattern_ops` index on `(org_id, path)`
keeps the prefix `LIKE` index-friendly. Rename and delete cascade over `path = $p OR path LIKE $p ||
'/%'` across **both** tables in one transaction; rename rejects a collision with an existing path. Paths
validate as slash-separated kebab segments (`[a-z0-9]+(?:-[a-z0-9]+)*`), no empty/leading/trailing
slash, bounded length. `display_name` is optional per explicit path and falls back to the path leaf
when absent; renaming can set a display name such as `Dev` while moving the canonical path to its
slugified form (`dev`). For org labels there is no owner and no per-label permission: **any** member
can create, assign, unassign, rename, recolor, re-icon, or delete labels, including empty folders.

**Personal folders.** The My Skills library has a per-user counterpart to the org label tables:
`personal_labels` and `personal_skill_labels`, identical in shape but keyed `(org_id, owner_id, path)`
/ `(org_id, owner_id, skill_id, path)` and scoped to the owner on every query (with user-scoped RLS as
defense-in-depth, since both `app.org_id` and `app.user_id` GUCs are set per request). They organize a
member's authored personal skills only (installed copies stay unfiled) and are reached through the
mirrored `/v1/personal-labels` + `/v1/skills/:slug/personal-labels` endpoints. Sharing a personal skill
drops its `personal_skill_labels` rows; org folders apply from then on.

**Skill dependencies (un-versioned skill→skill links).** A skill version can declare that it
requires other skills. Edges live in `skill_version_dependencies` (`(skill_version_id,
depends_on_slug)` PK, plus `org_id`, the dependent `skill_id`, and a resolved `depends_on_skill_id`
that is `null` when the declared slug is not published — a *missing* dependency), so each version
keeps its exact graph. Dependencies are **un-versioned**: there are no semver ranges, no resolved
version pins, and no "update available" status — versions are a skill's own publish concern, not the
dependency graph's. Each edge's status is computed live on read from current state: **Satisfied**,
**Missing** (target unpublished), **Archived** (target archived), or **Cycle blocked**
(the edge sits in a directed cycle). Because every skill is org-wide-visible, there is no
visibility/owner-cover status. Publishing **hard-blocks**
declared dependencies that are missing or cyclic; edges are written in the
same transaction as the version. `POST /v1/skills?action=validate` returns a `dependencyPlan`
(declared / already-published / must-upload / removed-since-previous / archival candidates) that
drives the upload dialog's **Dependency preflight** step. In this slice declared dependencies are
read from package `companion.json`; legacy `dependency=` upload parameters are accepted only when a
package has no Companion manifest.

**Skill archive.** `skills.archived_at` / `archived_by` / `archive_reason` soft-hide a skill: archived
skills drop out of the normal org-wide and search lists but stay viewable, **restorable**, and
**downloadable while a published version still references them** (so existing installs never break).
They surface in a dedicated **Archived skills** view; `archiveSkill`/`restoreSkill` are allowed for any
org member (like every skill mutation) and write `skill.archive` / `skill.restore` audit entries.
`listSkills` excludes archived by default, with an `archived`-only mode and an `includeArchived` mode
(detail / dependency / download resolution).

**Companion skills (local skills).** A built-in catalog of official helper skills users install on
their own machine or hand to a coding assistant, surfaced in the "Companion skills" sidebar section
(above Settings). The catalog currently has one entry, `companion` — the management skill that an
assistant uses to upload, update, validate, and check whether the user's skills are up to date
(comparing each local skill's `companion.json.metadata.companionSkillId` / `version` and local
`~/.companion/skills.lock.json` snapshot against the registry). The package and its presentation manifest ship in `packages/companion-skill`; the
authoritative version is the `version` in the bundled `companion.json`, which the API packs (and
caches) on demand. Only per-member install state is persisted in the workspace, in
`local_skill_installs` (`(org_id, user_id, skill_key)` PK, the reported `installed_version`, an
optional `agent_label`, `installed_at`, and `last_reported_at`). The skill reports its own install
at the end of its install flow, and status is derived (Not installed / Installed / Update available)
by comparing the reported version against the bundled version. Installs are recorded with an
`audit_log` `local_skill.install` entry.

`api_tokens` holds scoped personal access tokens for programmatic publish/install.
Only the `sha256` `token_hash` is stored (the plaintext `cmp_pat_…` is shown once); each row carries
`scopes` (`skills:read` / `skills:write`), an `expires_at` (90-day default), and `revoked_at`.

`skill_filter_preferences` stores the current user's Skills Hub filter state for one organization.
The row is keyed by `(org_id, user_id)` and contains `active_filters` JSONB (the status / starred /
dependency / label filter chips). Saved custom views were removed, so there is no `custom_views`
column. It is personal UI state, not a shared organization resource.

`skill_comments` powers the threaded **Discussion** on a skill's detail page. Beyond `body`/`author_id`
it carries `parent_id` (a self-FK — `null` is a root thread, non-null is a reply; single-level nesting),
`version_id` (FK → `skill_versions`, `on delete set null`; `null` = a *global* thread, otherwise the
thread is linked to that version), and `deprecated` (threads are greyed/struck-through, never deleted).
Cross-skill integrity for `parent_id`/`version_id` is not FK-enforceable and is validated in the service
layer; a reply inherits its thread context (its `version_id` is forced `null`). Marking a thread
deprecated is allowed for the comment author or any org member (every member can modify any skill).

`skill_comment_images` holds image attachments on a comment (one row per image, ordered by `position`,
tenant-scoped with RLS, cascade-deleted with the parent comment). Only metadata lives in the row
(`storage_key`, `content_type`, `byte_size`); the bytes are stored in object storage under
`${orgId}/comments/${id}`. A comment `POST` switches to `multipart/form-data` when it carries images
(text-only comments stay JSON); the API validates each file (PNG/JPEG/WebP/GIF, ≤ 10 MB, ≤ 6 per comment),
uploads the bytes, then persists the comment + image rows. Attachments are served by
`GET /v1/skills/:slug/comments/:commentId/images/:imageId`, gated by org membership and streamed with
`X-Content-Type-Options: nosniff`.

Onboarding adds cosmetic `organizations.color`/`logo_url`.
`profiles.onboarded_at` records that a user has finished onboarding. Domain-based discovery and
self-serve joining live in `organization_domains`: each row belongs to one org, stores a normalized
email domain, and is unique only within that org (`org_id`, `lower(domain)`). Multiple orgs may share
the same domain, and one org may allow multiple domains. Legacy `organizations.domain` +
`organizations.domain_auto_join` columns may still be populated for compatibility, but they are not
the source of truth for onboarding joins.

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
  When forwarding to Better Auth, these proxy routes use the configured canonical `COMPANION_WEB_URL` as
  the trusted origin, so alias hosts such as `www` can still re-emit cookies without being registered as
  separate Better Auth origins. The Google start route must also re-emit Better Auth's transient OAuth
  state cookie before redirecting to Google; otherwise the API callback cannot validate `state`. The
  callback itself still lands on `/auth/*` through the web origin's rewrite. The reused 6-digit OTP UI is a
  single client state machine in `(auth)/login/LoginForm.tsx`.

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
- A **corporate** domain that matches one or more `organization_domains` rows → the user is offered the
  matching org list and chooses one. The selected org id is revalidated server-side against the actor's
  verified email domain before membership is created.
- Otherwise the user creates an org (name, optional website + best-effort logo/brand color, and
  teammate invites).

`completeOnboarding` writes the org, invitations, and `onboarded_at` in one transaction;
`joinOrgByDomain` adds the membership and stamps `onboarded_at`; `acceptInvitation` stamps it too.
Onboarding-created domain access is only honored for the actor's **own** corporate domain, and joining
requires a verified email when `COMPANION_REQUIRE_VERIFIED_DOMAIN_JOIN` is on (default: production).
Org owners/admins can later add or remove access domains from Workspace settings, but adding a domain
requires the admin's own verified corporate email domain to match the requested domain. `ensureUserBootstrap` now only upserts the `profiles` row — the legacy
"first user owns the seeded Acme org" auto-bootstrap was removed in favor of this flow.

## Authorization

The service layer in `packages/core` is the primary enforcement point. It applies:

- tenant/membership gate (`assertMember`): every service call resolves the actor's org role or throws;
  all queries are scoped to the selected `org_id`. Skill visibility collapses to `eq(skills.org_id,
  orgId)` — every member sees every skill in the org;
- capability gate (org role): skill actions (read/create/update/delete/publish, archive/restore, and
  all label create/assign/rename/recolor/delete operations) are allowed for **any** member; the org-role
  gate (`isOrgAdmin` / `canManageOrg`) still governs org-level actions like member management, role
  changes, and token revocation. There is no per-skill owner or visibility check.

Postgres RLS scopes the new `labels` / `skill_labels` tables (and the others) by the `app.org_id` GUC
as defense-in-depth, but browser and CLI clients never connect directly to Postgres.

## Public API

- Auth: `/auth/*` Better Auth endpoints (email/password, `email-otp/*` verification + reset, and
  `sign-in/social` + `callback/google`), plus `/v1/auth/login`, `/v1/auth/logout`,
  `/v1/auth/whoami` for CLI ergonomics. `whoami` also returns `onboarded` / `needsOnboarding`.
- Onboarding: `GET /v1/onboarding/context` (email-domain classification + `matched_orgs[]` for
  domain-access orgs), `POST /v1/onboarding/join` (join a selected org after server-side domain
  revalidation),
  `POST /v1/onboarding/create` (create org + invites, finish onboarding).
- Tokens: `GET /v1/tokens` (list the caller's own active keys, no plaintext — it backs the personal
  Account pane, so it is caller-scoped even for admins), `POST /v1/tokens` (issue a scoped `cmp_pat_…`,
  plaintext returned once), `DELETE /v1/tokens/:id` (an org admin may revoke any token by id).
  Session-authenticated only — a token cannot mint another.
- Skills: `/v1/skills` (the list accepts `label` and `nolabel` filters; no `owner`/`visibility`/`mine`),
  `/v1/skills/:slug`, `/v1/skills/:slug/versions`,
  `/v1/skills/:slug/download`, `/v1/skill-filter-preferences`,
  `POST /v1/skills/create` (author a SKILL.md inline),
  `GET /v1/skills/:slug/versions/:version/package` (download a version as `.zip`), and
  `GET /v1/skills/:slug/versions/:version/files` (read a version's package contents for the in-app
  file explorer — text files are returned UTF-8-decoded and capped, binaries carry `content: null`).
  Threaded discussion: `GET`/`POST /v1/skills/:slug/comments` (a `POST` may carry `parent_id` for a
  reply and `version_id` to link the thread to a version; a `multipart/form-data` `POST` may also carry
  up to 6 image attachments),
  `GET /v1/skills/:slug/comments/:commentId/images/:imageId` (serve an attachment, membership-gated), and
  `PATCH /v1/skills/:slug/comments/:id` (deprecate / restore a thread).
  Dependencies & archive: `GET /v1/skills/:slug/dependencies?version=` (the Requires + Used by graph
  with live statuses), `POST /v1/skills/:slug/archive` (optional `{reason}`) and
  `POST /v1/skills/:slug/restore`, and `GET /v1/skills?archived=true` (the Archived view). `POST
  /v1/skills` accepts declared `dependency` fields and, on `action=validate`, returns a
  `dependency_plan`; an unresolved-dependency publish returns 422 with that plan.
- Labels: `GET /v1/labels` (the org-wide tree + flat list with roll-up counts), `POST /v1/labels`
  (create a path — and its ancestors — including an empty folder, optional `displayName`),
  `PUT /v1/labels/rename` (move a path/subtree, optional `displayName` for the moved root),
  `PUT /v1/labels/color`, `PUT /v1/labels/icon`, and `DELETE /v1/labels`. The label path travels in the
  **body/query**, never a URL segment, so embedded slashes survive. Per-skill assignment:
  `POST`/`DELETE /v1/skills/:slug/labels` (assign / unassign one path). Every label route is
  session-authenticated, tenant-scoped, and allowed for any member.
- Local skills (Companion skills): `GET /v1/local-skills` (built-in catalog with the caller's
  per-machine status), `GET /v1/local-skills/:key`, `GET /v1/local-skills/:key/package` (download the
  bundled skill as `.zip`), and `POST /v1/local-skills/:key/installed` (the install callback: the
  skill reports `{ version, agent? }` so the workspace learns it is installed and at which version).
- Schemas: `GET /v1/schemas/companion-manifest.v2.schema.json` serves the public JSON Schema used by
  assistants and editors to create or repair `companion.json`.
- Orgs & settings: `/v1/orgs`, `GET`/`POST`/`PUT /v1/orgs/current` (read/select/rename+reslug the org,
  admin only for `PUT`), `GET /v1/orgs/current/settings` (members, invitations,
  access domains), `POST /v1/orgs/current/domains` and
  `DELETE /v1/orgs/current/domains/:domainId` (admin-only domain access list management),
  `PUT /v1/users/me` (update display name), and `/v1/invitations`. There are no `/v1/teams` endpoints.

Requests authenticate by Better Auth cookie session. An `Authorization: Bearer cmp_pat_…` token is
accepted **only** on the PAT-enabled skills endpoints (`POST /v1/skills`, `POST /v1/skills/create`,
`GET /v1/skills/:slug/download`,
`GET /v1/skills/:slug/versions/:version/package`,
`GET /v1/skills/:slug/versions/:version/files`, and the `/v1/local-skills*` endpoints); every other
endpoint rejects tokens. Token requests are scope-gated (`skills:write` to publish/create,
`skills:read` to download). Reading the local-skills catalog
and downloading its package require `skills:read`; the install callback
(`POST /v1/local-skills/:key/installed`) mutates state and writes an audit row, so it requires
`skills:write` — the read+write token the install prompt mints satisfies
both, while a read-only token cannot spoof an install. `POST /v1/skills` accepts a multipart `file` (browser/CLI) or a raw
`application/zip` / `application/gzip` body with `version` and repeatable `label` query params (initial
labels to file the skill under on publish). Setting
`action=validate` runs the same package checks without publishing; targeted updates also accept
`expect_slug` and `expect_skill_id` in form fields or query params for both validation and
publication. Uploads accept `.zip` or `.tar.gz`; the canonical stored, checksummed format is `.tar.gz`.

Skill archives are stored under `{org_id}/{slug}/{version}.tar.gz` in the `skill-archives` bucket;
the per-version package endpoint repackages them as `.zip` on the fly. Clients never receive S3
admin credentials.
