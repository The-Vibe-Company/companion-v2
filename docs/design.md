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

`creator_id` (always recorded, for Activity/audit) doubles as the **owner** of a personal skill, and is
distinct from the **last updater**: the authenticated `GET /v1/skills` and `GET /v1/skills/:slug` read
models carry both the `creator_*` ("Created by") and `updater_*` ("Last updated by") display fields, the
latter derived from the uploader of the current version (`skill_versions.created_by` of
`skills.current_version_id`) — no `updated_by` column. There
is still no `owner_team_id`, `everyone` flag, `skill_team_shares` table, or `PUT /v1/skills/:slug/owner`
endpoint. A slug is **workspace-unique across both scopes** (`skills_org_slug_uq (org_id, slug)`), so the
slug route stays unambiguous and Share can never collide. Dependency reads prefer the stable target
`skills.id`, so an explicit rename can change the slug without replacing the skill. The one scope transition is
**Share** (`POST /v1/skills/:slug/share`): owner-only, one-way `personal → org`, which also drops the
skill's personal-folder assignments. "Installed" is not a copied row — a member's My Skills =
(`scope='personal' AND creator=them`) ∪ (org skills they have a `skill_installs` row for), surfaced
together. A version's declared tools
(`skill_versions.tools`) come from the Agent Skills `allowed-tools` frontmatter string.
Every skill also carries a unique, unguessable `skills.share_token` generated by the database. For a
live `org` skill, `/s/<token>` is the canonical public share URL: signed-in members see the in-app
skill detail with that token URL in the address bar, while anonymous visitors and social crawlers get
an anyone-with-the-link public preview backed by `GET /v1/public/skills/:token`. The preview is
metadata-only: display name, slug, summary, current version, creator display name/initials, star
count, and `updated_at`. It never returns `id`, `org_id`, `creator_id`, SKILL.md body, package files,
downloads, requirements, secrets, or labels. The creator's avatar is intentionally not exposed on
this anonymous surface (initials only). Personal skills are never exposed through this path; the
owner must Share the skill into the org library first, and archived org skills return 404.
`skills.display_name` is a nullable, mutable display-title override used by explicit rename. It is
overlaid onto the current read model as `display.name` but never rewrites existing
`skill_versions.frontmatter` rows or stored package archives.
Companion-specific package data lives in root `companion.json`, not `SKILL.md`: `name`, `version`,
human-facing `title`/`description`, Markdown-compatible `notes`, `metadata.companionSkillId`,
`metadata.changelog`, `environment.env` / `environment.secrets` declarations (never values),
`commands`, local-only `checks`, and un-versioned skill `dependencies` as `{ skillName: skillId }`.
`description` updates the existing `skills.description` listing field; the full normalized manifest rides in the existing
`skill_versions.frontmatter` JSON under `companion` and is parsed back into the read shape
(`skillListRowSchema.display` / `skillListRowSchema.requirements`) for the skill detail view; the
skill-level `display_name` override wins over the manifest title when present. Legacy
packages that still declare `requirements` in `SKILL.md`, `display`, or dependency arrays are readable
for compatibility and are normalized into `companion.json` on publish. Companion registry data is
written into `companion.json` when a package is published. On targeted re-publish, callers may send
`expect_slug` and `expect_skill_id`; validation and publication reject mismatched frontmatter names
and any present `companion.json.metadata.companionSkillId` (or legacy
`metadata.companion_skill_id`) that points at a different skill.
Renaming a skill is not a publish side effect: `POST /v1/skills/:slug/rename` updates the existing
`skills` row's `slug` (and optional display title) in place, keeps the same `id`, and leaves the
normal anti-retargeting guard on `POST /v1/skills` intact.
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
keeps its exact graph. Runtime reads resolve `depends_on_skill_id` first and fall back to
`depends_on_slug` only for unresolved legacy/missing edges; the displayed slug is the target skill's
current slug when the id resolves. Dependencies are **un-versioned**: there are no semver ranges, no resolved
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
(comparing each local skill's `companion.json.metadata.companionSkillId` / `version` and the active
workspace-id entry in the local `~/.companion/skills.lock.json` snapshot against the registry). Local
credentials live separately in `~/.companion/credentials.json`, keyed by `organizations.id`; the
lockfile keeps `apiUrl` metadata but never stores tokens. Legacy URL-keyed lockfiles are migrated on
the next write, and `skills.log.json` is only a read-once legacy alias. Installs fan out through the
bundled `scripts/tools.json` registry, currently covering Claude Code, Codex, and OpenCode; OpenCode
uses the shared Agent Skills paths (`~/.agents/skills` and `.agents/skills`). The package and its presentation manifest ship in `packages/companion-skill`; the
authoritative version is the `version` in the bundled `companion.json`, which the API packs (and
caches) on demand. Local skill rows also expose official integrity metadata: the canonical package
checksum plus SHA-256 hashes for tracked files such as `SKILL.md`, `companion.json`, and
`scripts/bootstrap.py`. The packaged skill also ships `companion.integrity.json`, a version-matched
baseline for the installed copy. The installed bootstrap compares tracked files against that local
baseline before auto-updating Companion, falling back to the workspace hashes only when the installed
version is already the current bundled version; modified or missing tracked files are treated as
local customizations and are never overwritten automatically. Only per-member install state is persisted in the workspace, in
`local_skill_installs` (`(org_id, user_id, skill_key)` PK, the reported `installed_version`, an
optional `agent_label`, `installed_at`, and `last_reported_at`). The skill reports its own install
at the end of its install flow, and status is derived (Not installed / Installed / Update available)
by comparing the reported version against the bundled version. Installs are recorded with an
`audit_log` `local_skill.install` entry.

`GET /v1/skills` is token-readable with `skills:read`: `lib=org` returns the org library, `lib=mine`
returns the caller's authored personal skills plus reported installed org skills, and
`installed=true` narrows the list to skills with a `skill_installs` row for that caller. This is
Companion-reported install state; exact disk inventory remains local in `~/.companion/skills.lock.json`.

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

Onboarding adds cosmetic `organizations.color`/`logo_url`. Workspace settings also carry
`organizations.skill_naming_policy`, a nullable free-text convention for naming and filing skills.
Companion reads it during skill upload/triage; `null` means the org imposes no naming convention.
`profiles.avatar_url` holds the same-origin serve path for a custom profile photo (binary in object
storage at `users/{id}/avatar`). `GET /v1/users/:userId/avatar` serves it only while that marker is
set and only to the user themselves or a member who shares an organization with them (tenant-scoped,
mirroring the org-logo serve gate). When null, a user's avatar resolves to their Gravatar (`?d=404`),
and the client falls back to colored initials. The resolver (`packages/core/src/avatar.ts`) produces
one `avatarUrl` per user reference so every authenticated surface — members, skill bylines, the
per-version Activity feed, comments — renders the same identity.
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

The public skill preview service is the only intentional unauthenticated skill read. It does not take
an actor or org id, resolves only by `share_token`, and hard-filters to non-archived org skills before
returning the narrow metadata shape described above.
The signed-in web deep link uses a separate authenticated resolver,
`GET /v1/skills/share-target/:token`, which returns `{org_id, slug}` only when the user is already a
member of the token's workspace; `/s/:token/go` then sets `companion_org` before redirecting to the
slug-keyed detail route, where the client replaces the address bar back to `/s/:token`.

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
- Skills: `/v1/skills` (the list accepts `lib`, `label`, `nolabel`, `installed`, and `archived`
  filters; no `owner` or `visibility` filters),
  `/v1/skills/:slug`, `/v1/skills/:slug/versions`,
  `/v1/skills/:slug/download`, `/v1/skill-filter-preferences`,
  `POST /v1/skills/create` (author a SKILL.md inline),
  `POST /v1/skills/:slug/rename` (explicit in-place slug/title rename, preserving the skill id),
  `GET /v1/skills/:slug/versions/:version/package` (download a version as `.zip`), and
  `GET /v1/skills/:slug/versions/:version/files` (read a version's package contents for the in-app
  file explorer — text files are returned UTF-8-decoded and capped, binaries carry `content: null`).
  Threaded discussion: `GET`/`POST /v1/skills/:slug/comments` (a `POST` may carry `parent_id` for a
  reply and `version_id` to link the thread to a version; a `multipart/form-data` `POST` may also carry
  up to 6 image attachments),
  `GET /v1/skills/:slug/comments/:commentId/images/:imageId` (serve an attachment, membership-gated), and
  `PATCH /v1/skills/:slug/comments/:id` (deprecate / restore a thread).
  Dependencies & archive: `GET /v1/skills/:slug/dependencies?version=` (the Requires + Used by graph
  with live statuses, dependency install/update metadata, and a deduplicated transitive dependency
  list with `depth` + `via` provenance), `POST /v1/skills/:slug/archive` (optional `{reason}`) and
  `POST /v1/skills/:slug/restore`, and `GET /v1/skills?archived=true` (the Archived view). `POST
  /v1/skills` accepts declared `dependency` fields and, on `action=validate`, returns a
  `dependency_plan`; an unresolved-dependency publish returns 422 with that plan.
- Public skill previews: `GET /v1/public/skills/:token` is unauthenticated and returns the narrow
  metadata-only preview for a live org skill share token, or 404 for personal, archived, or unknown
  tokens. It is used by the public web route `/s/:token` for anonymous previews and Open
  Graph/Twitter unfurls. `/s/:token` is also the canonical in-app address-bar URL for live org skill
  details; signed-in web navigation goes through `GET /v1/skills/share-target/:token` and
  `/s/:token/go` so the current workspace cookie is switched to the token's org before opening the
  slug-keyed detail route, which immediately rewrites back to `/s/:token`.
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
  Local skill rows include `workspaceId` (`organizations.id`) so token-authenticated assistants can
  key credentials and local lockfiles without calling session-only org endpoints, plus `integrity`
  metadata used by the bootstrap to verify current packages and as a same-version fallback for local
  customization detection before replacement.
- Schemas: `GET /v1/schemas/companion-manifest.v2.schema.json` serves the public JSON Schema used by
  assistants and editors to create or repair `companion.json`.
- Orgs & settings: `/v1/orgs`, `GET`/`POST`/`PUT /v1/orgs/current` (read/select/rename+reslug the org,
  plus `skillNamingPolicy` on admin-only `PUT`), `GET /v1/orgs/current/settings` (members,
  invitations, access domains), `GET /v1/orgs/current/skill-naming-policy` (PAT-readable with
  `skills:read`, returns `{ policy: string | null }`), `POST /v1/orgs/current/domains` and
  `DELETE /v1/orgs/current/domains/:domainId` (admin-only domain access list management),
  `PUT /v1/users/me` (update display name), and `/v1/invitations`. There are no `/v1/teams` endpoints.

Requests authenticate by Better Auth cookie session. An `Authorization: Bearer cmp_pat_…` token is
accepted **only** on the PAT-enabled skills endpoints (`GET /v1/skills`, `POST /v1/skills`,
`POST /v1/skills/create`, `POST /v1/skills/:slug/rename`,
`GET /v1/skills/:slug/download`,
`GET /v1/skills/:slug/versions/:version/package`,
`GET /v1/skills/:slug/versions/:version/files`, the skills install/dependency/archive/share/label
surfaces, `GET /v1/orgs/current/skill-naming-policy`, and the `/v1/local-skills*` endpoints); every
other endpoint rejects tokens. Token requests are scope-gated (`skills:write` to publish/create/rename/mutate,
`skills:read` to read/download and read the org skill-naming policy).
Reading the local-skills catalog
and downloading its package require `skills:read`; the install callback
(`POST /v1/local-skills/:key/installed`) mutates state and writes an audit row, so it requires
`skills:write` — the read+write token the install prompt mints satisfies
both, while a read-only token cannot spoof an install. `POST /v1/skills` accepts a multipart `file` (browser/CLI) or a raw
`application/zip` / `application/gzip` body with `version` and repeatable `label` query params (initial
labels to file the skill under on publish). Setting
`action=validate` runs the same package checks without publishing; targeted updates also accept
`expect_slug` and `expect_skill_id` in form fields or query params for both validation and
publication. Uploads accept `.zip` or `.tar.gz`; the canonical stored, checksummed format is `.tar.gz`.

Skill archives are stored under `{org_id}/{slug}/{version}.tar.gz` in the `skill-archives` bucket
using the slug at publish time; a later rename does not move historical archive objects. The
per-version package endpoint repackages them as `.zip` on the fly. Clients never receive S3
admin credentials.

## Skill Runs (one-shot sandboxed sessions)

Skill runs are the first execution surface on the portal: from a skill's page, any member who can
SEE the skill can click **Run skill**, provide a prompt (plus optional attachments and a model),
and get a live sandboxed agent session with exactly that skill mounted. The control plane (this
repo) launches, records and proxies chat; it never executes skill content itself — bytes are pushed
into a **Vercel Sandbox** (Firecracker microVM) forked fresh from a **golden snapshot** with a
pinned **OpenCode** server pre-installed, and run there. This reinforces the standing security
boundary: untrusted skill code only ever executes inside sandboxed provider workloads.

Vocabulary: a run **pins** the skill's published version at launch (`skill_runs.skill_version`);
the **golden snapshot** is created once per `OPENCODE_VERSION` by
`pnpm --filter @companion/sandbox golden`; the runtime provider seam is the `RunSandboxRuntime`
port (`packages/core/src/runRuntime.ts`), implemented by `packages/sandbox` (`@vercel/sandbox` +
`@opencode-ai/sdk`, both pinned exactly — OpenCode releases break near-daily).

### Data model

- `skill_runs` — one row per run: `org_id`, `skill_id` (composite org FK), `creator_id` (the
  launcher — the ONLY member who ever sees the run), pinned `skill_version`, `model`
  (`provider/model-id` from the models.dev catalog), original `prompt`, 4-value `status`
  (`starting → running → frozen | error`) plus a free-text `status_detail` (launch step in
  progress, or the human error message), sandbox identity (`sandbox_name` = `run-<org8>-<run8>`,
  domain, golden provenance), `opencode_session_id`, `server_password_enc` (secretbox
  `wrappedDek|ciphertext`, AAD `org:runId:OPENCODE_SERVER_PASSWORD`), `timeout_ms` (sandbox
  lifetime AND the freeze window), the `transcript` (jsonb — see below), `last_active_at`,
  `frozen_at`, `sandbox_cleaned_at` (set once the provider sandbox is confirmed destroyed;
  NULL = the sweep still owes a destroy — partial index `skill_runs_sweep_idx`, mig 0035).
- `skill_run_attachments` — files the launcher attached (≤5 × 10 MB): bytes in S3 under
  `{org}/run-attachments/{id}`, metadata here, streamed back creator-only with `nosniff` +
  `Content-Disposition: attachment`.
- `skill_run_artifacts` — files the agent saved into `artifacts/`, published to Vanish
  (path-deduped per run via `UNIQUE(run_id, path)`); only metadata + the public URL live here.
- All three tables carry the tenant RLS policy (migration `0032_skill_runs.sql`).
- `user_model_preferences` / `org_model_preferences` (mig 0036) — the ACTIVATED-model lists (see
  "Activated models" below): a jsonb array of `provider/model-id` refs per member (PK
  `org_id+user_id`, user-scoped RLS) and per workspace (PK `org_id`, tenant RLS, nullable
  `created_by` so `db:seed` can seed it).

**No state machine**: a run's lifecycle is 4 enum values + `status_detail`. A FRESH sandbox is
forked per run; there is no pause/wake/retry — retry means a new run. The launcher polls
`GET /v1/runs/:id` every 1.5 s while `starting`.

### Launch pipeline + recorder

`createRun` (packages/core/src/skillRuns.ts) validates at submit time — the skill must be visible
(personal-skill privacy via the same predicate as everywhere), unarchived and published, the model
must be in the launcher's ACTIVATED set (personal ∪ org — the hard gate behind the picker filter),
must exist in the catalog AND a decryptable provider key must reach it — then persists the row
(status `starting`) and the attachment metadata, and audits `skill.run`. The API kicks
`launchAndRecordRun` fire-and-forget in-process (deduped per run): fork golden → push
`opencode.json` (model pin + `{edit:"allow", bash:"allow", webfetch:"allow"}`) + the extracted
skill folder (same traversal/symlink/size guards as every other archive reader) + attachments +
an `artifacts/.keep` → start `opencode serve` with the injected env (never persisted, never
logged) → health-check → create the OpenCode session and send the composed prompt (user text +
skill-usage nudge + attachment listing + the artifacts instruction when enabled). Any prelude or
step failure lands the row in `error` with a human `status_detail` — never a stuck `starting`.

The **recorder** (same job) then consumes the sandbox event stream independently of any browser:
on every `session.idle` it snapshots the FULL transcript (`loadSessionItems` → replace
`skill_runs.transcript`, capped ~512 KB by trimming oldest tool outputs first) and collects
artifacts. When nothing has happened for `timeout_ms` (~5 min, refreshed by events and by the
prompt route), or the stream dies, the run **freezes**: final snapshot + final artifact collection,
`status = frozen`, then sandbox teardown. `withTenantContext` opens a transaction, so the job
interleaves short tenant transactions with un-transacted runtime calls. The in-process job assumes
a mono-process API (same precedent as before a worker/Temporal takes this over); a read that finds
`starting`/`running` with no live job lazily flips the row to the designed "interrupted" state
(`error` if it never left `starting`, else `frozen` keeping the last snapshot) — DB-only, so reads
never make network calls.

### Sandbox cleanup

A terminal run's sandbox has zero residual value (no wake; transcript + artifacts are persisted
BEFORE teardown), so it is **destroyed, not just stopped** — two layers, with Vercel's own hard
`timeout` as the compute backstop:

1. **In-path** (`teardownSandbox` in `packages/core/src/skillRuns.ts`): every terminal transition
   (freeze, launch-step failure) persists the terminal status first, then best-effort
   `runtime.stop()` + `runtime.destroy()`; on confirmed destroy the row gets
   `sandbox_cleaned_at`. A prelude failure (no sandbox forked yet) marks the row cleaned
   directly. The port contract: `destroy` treats a missing sandbox as success (idempotent) but
   MUST throw on transient provider failures so the cleanup stays owed.
2. **Sweep** (`sweepRunSandboxes` in `packages/core/src/runSweeper.ts`, `setInterval` in apps/api
   every `COMPANION_RUN_SWEEP_INTERVAL_MS`, default 10 min, `0` disables, plus one pass ~30 s
   after boot): cross-org drain of terminal rows with `sandbox_cleaned_at IS NULL` (failed
   in-path destroys, historical backlog) and **orphan kill** of `starting`/`running` rows whose
   in-process job is gone — rewritten via the same `markRunInterrupted`, then destroyed. Orphans
   are only killed past `updated_at + 2×timeout_ms + grace` (never on "no local job" alone; the
   2× covers the SDK's ADDITIVE `extendTimeout`), and destroys are idempotent so double-sweeps
   are harmless. Like `liveRunJobs`, the orphan kill assumes the documented mono-process API —
   fix run-liveness tracking before scaling the API horizontally.

### Privacy

Runs are **private to their creator** — `canAccessRun` in `packages/core/src/authz.ts`, the same
owner-only shape as personal skills, deliberately with **no admin override**. `GET
/v1/skills/:slug/runs` returns only the caller's runs; anyone else's `GET /v1/runs/:id` is a 404.
Any member may RUN any skill they can see; running confers no visibility into others' runs.

### Chat proxy

The browser never sees the sandbox: `GET /v1/runs/:id/events` (SSE, `x-accel-buffering: no`,
15 s keepalive pings) and `POST /v1/runs/:id/prompt` proxy through the API, which decrypts the
per-run basic-auth password server-side. `packages/sandbox/src/opencodeChat.ts` translates
pinned-SDK OpenCode events into the stable `RunChatEvent` vocabulary in `@companion/contracts`,
so SDK churn is absorbed in one file. A frozen run 409s both routes ("This session has ended —
start a new run."); the client renders the persisted transcript instead. Recorder-side artifact
publish failures merge into the live stream as normalized `error` events via a small in-process
event bus.

### Model provider connections (personal + workspace keys, referenced live)

The control plane never supplies model API keys. A provider is **connected** with a real key,
envelope-encrypted (AES-256-GCM; per-secret DEK wrapped by the `COMPANION_SECRETS_KEY` KEK; AAD
binds each blob to its exact row — `packages/core/src/secretbox.ts`) and write-only, at two
scopes: **personal** (`user_provider_connections`, mig 0033, per-user) and **workspace-shared**
(`org_provider_connections`, mig 0034, PK `org_id+provider`, AAD
`${orgId}:workspace:provider:${provider}`, **owner/admin write** via `canManageOrg`, any member
reads). Both are managed on the merged **Settings** Models panes — Account → *Models* and
Workspace → *Shared models* (see "Activated models" below) — and the raw env var name is never
shown to the user.

The key is **referenced live, not copied**: `createRun` validates that a key exists but stores
nothing; the launch job resolves it at serve time (`getDecryptedProviderKey`) with
**personal-overrides-workspace** precedence and injects it into the serve env, so rotating a key
in Settings affects the next run and the key never appears anywhere in the run's rows.
`GET /v1/models` marks a provider connected when the caller has a personal key **or** the
workspace shares one. Reserved runtime env names (`OPENCODE_SERVER_*`) can never be used as key
names.

### Activated models (curated picker + hard gate)

The run launcher's picker does NOT show the full models.dev catalog — it shows only the
**activated** set: the member's personal list (`user_model_preferences`) ∪ the workspace list
(`org_model_preferences`, owner/admin write via `canManageOrg` + `models.activate.org` audit).
Both lists are curated in Settings — Account → **Models** and Workspace → **Shared models**
(`ModelsPane`, one component keyed per scope; the old *Model providers*/*Shared providers* panes
are MERGED into it, `?view=providers`/`org-providers` are normalized aliases). The pane is
organized around READINESS: a top "deck" mirroring exactly what the launcher offers (each row
`Ready` or `Needs key`, with inline write-only key capture on the row; the personal pane also
shows the workspace's contributions read-only), then a search-first add bar over the full catalog
(flat one-click Activate rows, capped at 50 visible matches), then a per-provider browse accordion
whose headers carry connect/disconnect for THIS scope's keys. The launcher's "Add more models"
button opens the pane via the shell's `openSettings({view:"models"})` (the skills shell renders
Settings as a LOCAL surface with `history.pushState`, so a plain `router.push` would be swallowed —
the opener is threaded SkillsApp → DetailView → RunLauncherDialog) and an empty effective set
renders an empty state instead of a picker. Enforcement is **hard**: `createRun` rejects a
non-activated model (`RunValidationError`), so the raw API honors the same rule as the UI. Core
(`packages/core/src/modelPreferences.ts`) is catalog-agnostic: ids are validated against the live
catalog at the API layer on write (400 on unknown ids) and pruned against it at read time
(`GET /v1/models` returns `activated: { personal, org }`), and run time stays safe regardless via
`resolveModelKeys`. Seeds activate a default Anthropic trio so fresh workspaces are not bricked by
the gate; real deployments must activate models before members can run skills.

### Artifacts via Vanish

A run can publish deliverables as shareable links. The launcher stores their **Vanish API key** in
Settings → Account → *Artifacts (Vanish)* — persisted as a `user_provider_connections` row under
the reserved provider id `vanish` (identical write-only/envelope-encrypted semantics, zero extra
migration; the model picker is built from the models.dev catalog, so `vanish` never appears in it).
Its presence ENABLES artifacts: the composed prompt tells the agent to save deliverables into
`./artifacts/`, and on every `session.idle` (and at freeze) the recorder collects that directory
**server-side** (`collectFiles`: BFS depth ≤ 3, skip dotfiles, ≤20 files × ≤10 MB), filters
Vanish-blocked executable extensions, skips already-published paths, and uploads each new file to
`POST {VANISH_API_URL:-https://vanish.sh}/upload` with an idempotency key
(`runId:path:byteSize`). The decrypted key lives only in the API process for the duration of the
publish — **it never enters the sandbox env**. Successful publishes persist a `skill_run_artifacts`
row (public URL + expiry); failures persist nothing and surface on the live stream. v1 publishes
per-file uploads only; Vanish's multi-file `/sites` API is a noted follow-up.

### Endpoints (session-only — PATs are rejected; not a skills API surface)

`GET /v1/models` (full tool-capable models.dev catalog + `connected` flags + the caller's
`activated` lists, pruned to the catalog), `PUT /v1/model-preferences` +
`PUT /v1/org-model-preferences` (replace the activated lists; owner/admin for the org one),
`GET/PUT /v1/provider-connections` + `DELETE /v1/provider-connections/:provider`,
`GET/PUT /v1/org-provider-connections` + `DELETE /v1/org-provider-connections/:provider`,
`POST /v1/skills/:slug/runs` (multipart: `prompt`, `model`, repeatable `file`; 201 → run detail),
`GET /v1/skills/:slug/runs` (caller's runs only), `GET /v1/runs/:id`,
`POST /v1/runs/:id/prompt` (202; 409 when frozen), `GET /v1/runs/:id/events` (SSE; 409 when
frozen), `GET /v1/runs/:id/attachments/:attachmentId`. Because every route rejects personal access
tokens, the bundled Companion skill's API surface is unchanged.

### Non-goals (v1)

Wake/resume of frozen runs, retries/pause, per-run skill secrets/variables (declared skill
requirements are out of scope), fan-out, a reconcile worker, multi-file Vanish sites, and
golden-snapshot management UI (`COMPANION_GOLDEN_SNAPSHOT_ID` env is the single golden).
Real-sandbox verification lives in `pnpm --filter @companion/sandbox smoke:vercel` (cred-gated,
not CI).

### Ops runbook

One-time golden snapshot (per OpenCode pin):
`VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… OPENCODE_VERSION=1.17.13
pnpm --filter @companion/sandbox golden` → export the printed `COMPANION_GOLDEN_SNAPSHOT_ID`.

Environment: `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`,
`COMPANION_GOLDEN_SNAPSHOT_ID`, `OPENCODE_VERSION` (pin, e.g. `1.17.13`),
`COMPANION_SECRETS_KEY` (base64 32 B; `generateSecretsKey()` helper — the Conductor dev script
persists a per-workspace key in `.conductor-pg/companion-secrets.key`),
`COMPANION_SANDBOX_TIMEOUT_MS` (default `300000`), `COMPANION_RUN_SWEEP_INTERVAL_MS` (sandbox
cleanup sweep, default `600000`, `0` disables), `VANISH_API_URL` (default
`https://vanish.sh`). Provider connections and Settings work without the Vercel variables; only
launching runs requires them.
