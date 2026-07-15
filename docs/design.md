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
- **Worker:** `apps/worker` runs independent billing and skill-run supervisors. `packages/billing`
  is the framework-free Stripe adapter; `packages/core` owns plan computation, entitlements,
  quotas, run validation, and durable orchestration state.

Redis/BullMQ are intentionally excluded. Temporal is the intended future workflow engine for
deployments, reconcile loops, retries, compensation, and schedules.

## Local And Conductor Runtime

Manual local development uses `pnpm dev` as the idempotent full-stack entrypoint. The script starts
Postgres, MinIO, and Mailpit with the defaults from `.env.example`, applies Drizzle migrations, seeds
the local test user, and starts the long-running API, worker, and web processes. Local Docker ports bind
to `COMPOSE_BIND_HOST`, which defaults to `127.0.0.1`. `pnpm dev:app` is the app-only loop when infra
is already prepared.

Conductor workspaces use a separate, **native (Docker-free)** entrypoint, `scripts/dev-conductor.sh`
(modeled on `~/Dev/monkapps`). It starts a per-workspace Postgres cluster — plus optional native MinIO
and Mailpit — under `.conductor-pg/`, applies migrations, seeds the test user, and runs only the
long-running API, worker, and web processes via `concurrently`. All services are allocated from
`CONDUCTOR_PORT`: web `+0`, API `+1`, Postgres `+2`, MinIO API `+3`, MinIO console `+4`, Mailpit SMTP
`+5`, and Mailpit UI `+6`. It injects workspace-specific `DATABASE_URL`, API URLs, S3 endpoint,
Mailpit ports, and a `companion-<workspace>` Better Auth cookie prefix inline — without mutating
`.env`. It also creates a persistent, gitignored 32-byte `COMPANION_SECRETS_MASTER_KEY` under the
workspace state directory (mode `0600`). The Docker-backed local script uses the same pattern under
`.companion-local/`; an explicit environment value always wins. Production never generates this key:
when it is absent or malformed only the Secrets routes return `503`, while the rest of Companion
continues to start. MinIO/Mailpit degrade gracefully when their binaries are absent (S3 uploads disabled, email
falls back to `EMAIL_PROVIDER=log`). A cleanup trap stops every native service on exit; archiving a
workspace runs `scripts/dev-conductor.sh archive`, which stops the services and removes
`.conductor-pg/`.

Production Railway deployments use three services from the same repository plus Railway Postgres. The public
`web` service proxies browser, CLI, auth, and Stripe webhook traffic to the private `api` service over Railway
private DNS; the `worker` is private and has no HTTP surface. Per-service configuration lives in
`deploy/railway/*.railway.json`. Only the API runs Drizzle migrations, as a Railway pre-deploy command guarded by
the existing Postgres advisory lock. The web and API bind Railway's injected/fixed `PORT` on `0.0.0.0`, while the
worker is restarted as a long-running process. `deploy/railway/README.md` is the operational source of truth for
service references, public domains, Stripe webhook registration, initial deployment order, and rollback.

## Repository Layout

```
apps/
  api/        # Hono backend, Better Auth, REST + tRPC
  worker/     # independent Stripe reconciliation + durable skill-run supervisors
  web/        # Next.js portal
packages/
  billing/    # framework-free Stripe gateway
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
`api_tokens`, `billing_subscriptions`, `stripe_webhook_events`, `audit_log`, the secret-vault
tables, and the skill-run tables described below. There are **no teams**:
the hierarchy is `Organization → User`. The former decorative `organizations.plan` column no longer
exists: raw provider state lives in at most one `billing_subscriptions` row per organization, while
the effective plan is derived centrally at request time.

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
Each `environment.secrets[ENV_KEY]` declaration has a stable UUID `slotId`. It remains optional at
the package boundary for backwards compatibility; normalization assigns a deterministic UUID from
the stable skill id plus the environment key. An explicit id survives a key rename, while an
unidentified declaration creates a new slot. `environment.env` is intentionally outside this model.
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
`scopes` (`skills:read` / `skills:write` / `secrets:read` / `secrets:write`), an `expires_at`
(90-day default), and `revoked_at`. `secrets:write` gives a PAT the same metadata and binding mutation
capabilities as its signed-in user: create, rename, rotate, change audience/recipients, bind/unbind,
manage suggestions, and delete. The service still enforces workspace membership, secret
ownership/audience access, skill access, and slot identity. Plaintext remains write-only except
through the separate `secrets:read` one-time retrieval protocol.

**Secret vault and skill projections.** `secrets` stores metadata, owner, audience (`personal`,
`restricted`, or dynamic `organization`), current version, and soft-disable/delete timestamps.
`secret_versions` stores ciphertext only; each version uses a fresh AES-256-GCM DEK and AAD binding
`org_id + secret_id + version`. The DEK is itself AES-256-GCM-wrapped by the base64 32-byte
`COMPANION_SECRETS_MASTER_KEY`; plaintext and the root key never enter Postgres. Values are limited to
64 KiB UTF-8. `secret_recipients` is the explicit restricted audience; the owner is implicit, and an
organization audience includes every current and future member.

Stable declarations live in `skill_secret_slots`; the exact per-version projection is copied to
`skill_version_secret_slots`. Existing versions are backfilled but intentionally receive no user
binding. `skill_secret_bindings` is private per user. `skill_secret_suggestions` is a shared default,
not an ACL: any member may replace one for an org skill, while a personal skill remains owner-only.
Sharing a skill changes neither bindings, suggestions, nor secret ACLs. A removed slot only removes
its local projection at the next sync.

Retrieval is a three-step, non-replayable protocol. `secret_retrieval_plans` plus exact
`secret_retrieval_plan_items` pin the skill/dependency closure, slot, secret id, and secret version
for five minutes. `secret_retrieval_grants` stores only a SHA-256 hash, expires after 60 seconds, and
is consumed once. Membership, audience, recipient access, soft revocation, and the exact version are
rechecked at preflight, grant creation, and redemption. A rotation after preflight leaves that exact
planned version usable; loss of access invalidates the whole redemption. Audit rows record metadata
and denials but never values. Per-user defaults cap preflights at 30/minute and combined grant
creation/redemption attempts at 10/minute. Each attempt is claimed under a transaction-scoped advisory
lock before validation or decryption, so parallel requests cannot exceed the budget; an anomaly audit
signal is emitted after repeated refusals.

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
  all queries are scoped to the selected `org_id`. Org skills are visible to every member; personal
  skills add an owner-only predicate, with no admin override;
- capability gate (org role): skill actions (read/create/update/delete/publish, archive/restore, and
  all label create/assign/rename/recolor/delete operations) are allowed for **any** member; the org-role
  gate (`isOrgAdmin` / `canManageOrg`) still governs org-level actions like member management, role
  changes, and token revocation. There is no per-skill owner or visibility check.
- secret gate: reading/using a secret requires current membership plus owner/audience/recipient
  access. Creating, renaming, rotating, changing audience or recipients, disabling, and deleting are
  strictly owner-only; Owner/Admin roles have no override. Removing a membership immediately removes
  recipient access, disables secrets owned by the departing member without transferring them, and
  invalidates affected bindings and grants. Metadata returned to a non-owner is deliberately narrow;
  an inaccessible suggestion is indistinguishable from no suggestion.

Postgres RLS scopes tenant tables by the `app.org_id` and `app.user_id` GUCs. Secret tables use
composite tenant foreign keys and forced RLS so even the table owner cannot bypass tenant, user, and
audience policies. Billing, `labels` / `skill_labels`, and the other tenant tables are also scoped by
the tenant GUCs as defense-in-depth. Browser and CLI clients never connect directly to Postgres; the
framework-free service layer remains the primary authorization boundary.

The public skill preview service is the only intentional unauthenticated skill read. It does not take
an actor or org id, resolves only by `share_token`, and hard-filters to non-archived org skills before
returning the narrow metadata shape described above.
The signed-in web deep link uses a separate authenticated resolver,
`GET /v1/skills/share-target/:token`, which returns `{org_id, slug}` only when the user is already a
member of the token's workspace; `/s/:token/go` then sets `companion_org` before redirecting to the
slug-keyed detail route, where the client replaces the address bar back to `/s/:token`.

## Billing And Entitlements

Self-hosted installations default to `COMPANION_BILLING_MODE=disabled` and are fully unlocked without
Stripe. SaaS enables `stripe` billing separately from entitlement rollout
(`off → observe → pilot → enforce`), with pilot and temporary Pro allowlists. Disabling Checkout,
webhooks, or enforcement is a non-destructive rollback: Stripe identifiers and subscriptions remain
stored and no cancellation is sent.

Pro is $10 USD per active `memberships` row per month. Checkout fixes the initial quantity server-side,
uses Stripe Tax, disallows quantity adjustment, accepts Stripe-managed promotion codes, and uses durable
idempotency keys. Coupons, validity windows, redemption limits, and promotion codes are created and audited in
Stripe; customers can apply a valid code only during Checkout.
The configured Price must be active, licensed, monthly USD at exactly 1000 cents. The Customer Portal
may manage payment methods, invoices, and end-of-period cancellation, but subscription and quantity
updates must be disabled. Checkout creation is serialized per organization, reuses an open session,
and checks Stripe for an existing subscription before creating another.

`active` subscriptions are Pro, including a scheduled cancellation before `current_period_end`.
`past_due` and `unpaid` keep Pro through one non-renewable seven-day grace window. Missing,
`incomplete`, `incomplete_expired`, `paused`, and `canceled` subscriptions are Free. A later successful
payment or new active subscription clears the grace state.

Free keeps all data but narrows reads and mutations:

- My Skills contains installed org skills only; authored personal skills and their folder tree are
  hidden and locked, including Share.
- Org skills count active and archived rows toward a 20-skill quota. Creation uses an organization
  advisory lock and checks both before S3 upload and again inside the publishing transaction; a race
  loser removes its uploaded object. At exactly 20, existing skills can still publish versions. Above
  20, create, publish, rename, restore, and Share are frozen while reads, installs, downloads, and
  archive remain available.
- Only the current version is readable; historical version requests return the structured 403
  Upgrade response.

The structured entitlement rejection is `{ code, feature, message, effectivePlan, limit?, current?,
upgradeUrl? }`, using `upgrade_required`, `org_skill_limit_reached`, or `catalog_frozen`.

Membership acceptance, domain join, and removal mark the tenant billing row `pending` in the same
database transaction. `apps/worker` claims rows with `FOR UPDATE SKIP LOCKED` every 15 seconds, updates
Stripe quantities with `proration_behavior=create_prorations`, retries from 30 seconds up to one hour,
and refreshes all subscriptions every 15 minutes. Stripe webhook signatures are verified against the
raw body; event ids are deduplicated, then the current Stripe subscription is always re-read before
persisting so delivery order cannot corrupt local state.

## Public API

- Auth: `/auth/*` Better Auth endpoints (email/password, `email-otp/*` verification + reset, and
  `sign-in/social` + `callback/google`), plus `/v1/auth/login`, `/v1/auth/logout`,
  `/v1/auth/whoami` for CLI ergonomics. `whoami` also returns `onboarded` / `needsOnboarding`.
- Onboarding: `GET /v1/onboarding/context` (email-domain classification + `matched_orgs[]` for
  domain-access orgs), `POST /v1/onboarding/join` (join a selected org after server-side domain
  revalidation),
  `POST /v1/onboarding/create` (create org + invites, finish onboarding).
- Billing: session-only `GET /v1/billing` for any member; session-only
  `POST /v1/billing/checkout` and `/portal` for Owners/Admins; public
  `POST /v1/billing/webhooks/stripe` authenticated only by the Stripe signature. Billing endpoints
  never accept PATs. Pro invitations and domain-access additions require `acknowledgeSeatBilling`.
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
- Secrets: `GET/POST /v1/secrets`, `GET/PATCH/DELETE /v1/secrets/:id`, and
  `POST /v1/secrets/:id/rotate` back the metadata-only `/secrets` vault. A PAT with `secrets:write`
  has the same mutation capabilities as its signed-in user; there is no browser-only Secrets gate.
  Skill configuration uses
  `GET /v1/skills/:slug/secret-configuration`, `PUT/DELETE
  /v1/skills/:slug/secret-bindings/:slotId`, `PUT/DELETE
  /v1/skills/:slug/secret-suggestions/:slotId`, and the suggestion acceptance endpoint. Retrieval uses
  `POST /v1/secret-retrievals/preflight`, `POST /v1/secret-retrievals/:planId/grant`, and
  `POST /v1/secret-grants/redeem`. A PAT with `secrets:read` may read authorized metadata and run the
  retrieval protocol; `secrets:write` covers all vault, binding, and suggestion mutations while the
  service keeps the normal owner, audience, workspace, skill-access, and stable-slot checks.
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
surfaces, `GET /v1/orgs/current/skill-naming-policy`, the `/v1/local-skills*` endpoints, and the
Secrets metadata, configuration, retrieval, vault, binding, and suggestion routes listed above); every
other endpoint rejects tokens. Token requests are scope-gated (`skills:write` to publish/create/rename/mutate,
`skills:read` to read/download and read the org skill-naming policy, `secrets:read` to read authorized
secret metadata and perform preflight/grant/redemption, `secrets:write` for every Secrets mutation).
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

Skill runs are private, durable sandbox sessions launched from a published skill. Any member may run
a skill they can access. Creation atomically pins the exact root version, its complete accessible
dependency closure, every selected vault-secret version, and every declared non-sensitive value.
Prompt and attachments belong to one run; named personal configurations save only model, live secret
references, and declared variables.

The API validates and persists commands but never contacts the sandbox. `apps/worker` composes the
`RunSandboxRuntime` port from `packages/core/src/runRuntime.ts` with the Vercel/OpenCode adapter in
`packages/sandbox`. A fresh deterministic sandbox is forked from a golden snapshot, and every pinned
package is mounted below `.claude/skills/<slug>/`. The control plane never executes untrusted skill
content; only the sandbox does.

### Data model

- `skill_run_configs`, `skill_run_config_secrets`, and `skill_run_config_variables` store multiple
  named creator-only configurations. Names are unique per creator and root skill, at most one is the
  default, and optimistic `revision` updates reject stale writers. Secret children reference
  `secrets.id`; deleting a configuration never deletes a vault row and atomically detaches the live
  foreign key from historical runs, whose immutable configuration-name snapshot remains intact.
- `skill_runs` stores the creator, root skill/version snapshot, model, prompt, optional configuration
  name snapshot, idempotency key and payload hash, typed status/phase/error fields, deterministic
  sandbox/session identity, opaque-encrypted internal server password, final transcript with its
  folded event cursor, and a bounded redacted warning snapshot that survives event retention. Public
  lifecycle is `queued → starting → running → frozen | error | canceled`.
- `skill_run_skills`, `skill_run_secret_inputs`, `skill_run_model_provider_inputs`, and
  `skill_run_variable_inputs` are immutable input snapshots. Generic secret inputs contain vault
  references and exact versions only, with provenance `skill` or `runtime`. The model-provider row
  instead pins a dedicated connection id and credential version; it never appears in the generic
  secret collection. Ordinary responses never contain plaintext.
- `skill_run_jobs` is the retryable orchestration queue. `skill_run_prompts` is the initial/follow-up
  outbox with deterministic OpenCode `messageID`s. `skill_run_events` holds redacted, monotonically
  sequenced events for replayable SSE.
- `skill_run_attachments` — files the launcher attached (≤5 × 10 MB): bytes in S3 under
  `{org}/run-attachments/{id}`, metadata here, mounted as `<attachmentId>-<filename>`, and streamed
  back creator-only with `nosniff` +
  `Content-Disposition: attachment`.
- Migration `0034_skill_runs.sql` creates these tables and forces creator-only RLS on runs,
  configurations, snapshots, prompts, events, and attachments. Child policies derive the
  creator through their parent run/configuration; admins receive no override. The only cross-tenant
  queue operations are narrow internal `SECURITY DEFINER` functions using `FOR UPDATE SKIP LOCKED`
  and exact unexpired lease identities; claimed work then runs under the recorded tenant and creator
  context. Caller-controlled GUCs are not authority: policies additionally require the table-owner
  execution identity used only inside those functions.
- `user_model_preferences` / `org_model_preferences` (mig 0036) — the ACTIVATED-model lists (see
  "Activated models" below): a jsonb array of `provider/model-id` refs per member (PK
  `org_id+user_id`, user-scoped RLS) and per workspace (PK `org_id`, tenant RLS, nullable
  `created_by` so `db:seed` can seed it).

Live events are retained for 24 hours after a terminal state and then removed; the transcript remains
the durable history. Runs do not wake after freeze. A retry resumes durable orchestration for the same
run and deterministic external identities; it does not create another run, sandbox, session, or
prompt. Files created by sandbox code are discarded with the sandbox; Companion persists only the
transcript and the metadata/bytes of files the user attached at launch.

### Launch pipeline + recorder

`getRunOptions` returns the complete ordered set of root/dependency version and edge pins. `createRun`
requires the client to echo that exact set and compares it under the same transaction locks that
create the immutable snapshots. It never silently upgrades a dependency between launcher render and
submit. Both paths reject
cycles, missing/archived/inaccessible dependencies, stale root versions, excessive closure size,
undeclared inputs, required omissions, reserved runtime names, and ambiguous environment collisions.
The selected payload is authoritative: installation bindings may prefill `Custom`, but the server
never adds or mutates a binding implicitly. Secret ACL and model readiness are checked while loading
options and again while atomically creating the run snapshots, initial prompt, and queue row.

The runs supervisor advertises a short-lived PostgreSQL readiness heartbeat; run-options and new-run
creation fail closed when no configured worker heartbeat is live, without disabling the rest of the
API. It claims short leases with `FOR UPDATE SKIP LOCKED`, heartbeats them, limits local
concurrency, and retries transient failures at most three times with backoff. Validation failures are
terminal. Raw SQL claim timestamps are decoded and validated before execution; malformed claim
metadata enters the same durable retry/error transition instead of leaving an expiring lease to be
reclaimed forever. A separate exact-lease control watcher aborts in-flight work promptly on
cancellation, membership loss, or lease loss. S3, sandbox control, OpenCode request, probe, and
recorder-connect calls all carry cancellation signals and strict time budgets. Each
external step has persisted before/after progress:

1. revalidate snapshot access and decrypt exact secret versions;
2. get or fork the deterministic sandbox;
3. push root, dependencies, uniquely named attachments, and `opencode.json`;
4. start and health-check OpenCode with the exact environment;
5. establish the recorder, then find or create the deterministic session;
6. send the persisted initial/follow-up prompt with its deterministic `messageID`;
7. batch redacted events and snapshot the transcript;
8. freeze after inactivity, then stop and destroy the sandbox idempotently.

Runtime/network calls never occur inside a database transaction. On worker replacement, an expired
lease resumes the same sandbox/session/message instead of duplicating them. A transient recorder
closure reconnects with backoff while preserving recorder-local cumulative part cursors across new
network signals. Each idle transcript snapshot and its `session.idle` barrier event are committed in
one transaction with the same watermark, so SSE can never hydrate an older snapshot after observing
that event. Normal process shutdown stops claiming work and lets leases expire;
it does not destroy active sandboxes.

### Sandbox cleanup

A terminal run's transcript is persisted before teardown. Stop and destroy are
idempotent; provider failures keep cleanup owed for a later worker attempt. Cancellation is also a
durable command: a queued run becomes `canceled` without a sandbox, while an active run takes a final
snapshot and then tears down. The event-retention sweeper and sandbox-cleanup work live in the runs
supervisor, not the API.

### Privacy

Runs are **private to their creator** — `canAccessRun` in `packages/core/src/authz.ts`, the same
owner-only shape as personal skills, deliberately with **no admin override**. `GET
/v1/skills/:slug/runs` returns only the caller's runs; anyone else's `GET /v1/runs/:id` is a 404.
Any member may RUN any skill they can see; running confers no visibility into others' runs.

### Chat proxy

The browser never sees the sandbox. A follow-up route inserts one durable outbox row and returns
`202`; a concurrent pending prompt returns `409`. `GET /v1/runs/:id/events` first replays persisted
rows strictly after `Last-Event-ID`, then switches to PostgreSQL `LISTEN/NOTIFY` without a race. The
notification contains only run id and sequence, and every SSE frame has a real `id:`. Reconnect uses
the last accepted sequence and transcript snapshots reconcile whenever `transcript_updated_at`
advances.

`packages/sandbox/src/opencodeChat.ts` absorbs pinned-SDK event churn. `run.warning` is non-terminal
(for example a transient recorder reconnect); `run.error` represents a runtime failure. The worker
redacts all injected literal values before database events, SSE, transcripts, errors, audits, and
logs, including tool inputs/outputs and SDK errors. Plaintext maps are cleared after server start;
recovery reconstructs only the in-memory matcher after revalidating and decrypting pinned versions.
This protects Companion surfaces from literal leakage, not from a malicious skill encoding or
exfiltrating a credential it can read inside the sandbox.

### Model provider credentials (personal + workspace, separate from Secrets)

Model-provider keys have a dedicated write-only domain; they are not Secrets rows, vault candidates,
recipients, or bindings. Migration `0035_runtime_credentials.sql` creates
`model_provider_connections` plus immutable `model_provider_credential_versions`. Personal
connections are forced owner-only (admins included, with no override); workspace connections are
readable by members and writable only by owners/admins. The API accepts a key only on PUT and returns
redacted connection metadata. Encryption uses `COMPANION_SECRETS_MASTER_KEY`, but a provider-specific
opaque AAD domain (`model-provider-credential` plus connection id and version) keeps ciphertext
cryptographically distinct from vault secret versions and internal run credentials.

Resolution keeps personal-over-workspace precedence. `createRun` requires the exact redacted
connection/version pin shown by run-options and stores it in `skill_run_model_provider_inputs`, never
in `skill_run_secret_inputs`. Each immutable encrypted version also owns its exact environment key,
so rotating either the key value or its accepted env name leaves already-created runs deterministic;
future runs pin the new version. Disconnect removes the dedicated
connection and its ciphertext without touching any generic Secret, so queued/active pins fail their
next revalidation and cannot be revived by a later reconnect. Provider connection, membership and
version are checked when options load, when the run is created, immediately before injection, before
every follow-up, and periodically during an active lease. Loss before injection fails without
starting a sandbox; loss during a run takes a final snapshot and tears down best-effort. All
`OPENCODE_SERVER_*` names are reserved.

### Activated models (curated picker + hard gate)

The run launcher's picker does NOT show the full models.dev catalog — it shows only the
**activated** set: the member's personal list (`user_model_preferences`) ∪ the workspace list
(`org_model_preferences`, owner/admin write via `canManageOrg` + `models.activate.org` audit).
Both lists are curated in Settings — Account → **Models** and Workspace → **Shared models**
(`ModelsPane`, one component keyed per scope; the old *Model providers*/*Shared providers* panes
are MERGED into it, `?view=providers`/`org-providers` are normalized aliases). The pane is
organized around READINESS: a top "deck" mirroring exactly what the launcher offers (each row
`Ready` or `Needs key`, with a dedicated write-only provider-key form; the personal pane also shows
the workspace's contributions read-only), then a search-first add bar over the full catalog
(flat one-click Activate rows, capped at 50 visible matches), then a per-provider browse accordion
whose headers carry connect/disconnect for THIS scope's bindings. The launcher's "Add more models"
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

### Launcher inputs and saved configurations

The launcher starts from `Custom`, a default configuration, or another named personal
configuration. `Save as`, `Update`, default, rename, and delete operations affect model plus declared
secret/variable selections only; prompt and files are always ephemeral. A `Modified` marker compares
the full draft with its source revision. Drafts are keyed by skill id so navigation cannot leak a
prompt, attachment, model, or credential choice between skills, while the Settings → Models detour
can safely preserve the current skill's draft.

Inputs are grouped root-first by pinned skill. Secrets display metadata only; inline creation writes
to the vault and selects the returned id. Variables accept only keys declared in
`companion.json.environment.env`, retain non-sensitive values in cleartext private history/configs,
and label that visibility explicitly. Removed declarations are obsolete and never injected; a new
required declaration or inaccessible secret makes a configuration `Needs attention`.

There is no silent environment precedence. Secret/variable collisions fail. The same key across
dependencies is allowed only for the same variable value or exact pinned secret id+version. A model
provider key belongs to a separate credential domain, so any collision with a skill secret or
variable fails. Any `OPENCODE_SERVER_*` collision fails. The launcher always summarizes credentials
exposed to sandbox code and explains that literal redaction is not an exfiltration boundary.

For each model, run-options also returns a redacted provider pin containing only environment key,
connection id, scope, and exact credential version. This lets the launcher reject a provider/skill
collision before submit without exposing a value or any vault metadata; the server remains
authoritative.

### Endpoints (session-only — PATs are rejected; not a skills API surface)

`GET /v1/models` (full tool-capable models.dev catalog + `connected` flags + the caller's
`activated` lists, pruned to the catalog), `PUT /v1/model-preferences` +
`PUT /v1/org-model-preferences` (replace the activated lists; owner/admin for the org one),
`GET/PUT /v1/provider-connections` + `DELETE /v1/provider-connections/:provider`,
`GET/PUT /v1/org-provider-connections` + `DELETE /v1/org-provider-connections/:provider`,
`GET /v1/skills/:slug/run-options`, `GET/POST /v1/skills/:slug/run-configurations`,
`PATCH/DELETE /v1/run-configurations/:id`,
`POST /v1/skills/:slug/runs` (multipart: prompt, model, exact version, authoritative JSON inputs,
repeatable file; mandatory `Idempotency-Key`; `201` for a new run and the same result on replay),
`GET /v1/skills/:slug/runs` (caller's runs only), `GET /v1/runs/:id`,
`POST /v1/runs/:id/prompt` (mandatory idempotency, `202`), `POST /v1/runs/:id/cancel`,
`GET /v1/runs/:id/events` (replayable SSE), and
`GET /v1/runs/:id/attachments/:attachmentId`. Because every route rejects personal access
tokens, the bundled Companion skill's API surface is unchanged.

### Non-goals (v1)

Wake/resume of frozen runs, arbitrary undeclared variables, organization-shared configurations,
fan-out, and golden-snapshot management UI
(`COMPANION_GOLDEN_SNAPSHOT_ID` is the single golden) remain out of scope.
Real-sandbox verification lives in `pnpm --filter @companion/sandbox smoke:vercel` (cred-gated,
not CI).

### Ops runbook

One-time golden snapshot (per OpenCode pin):
`VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… OPENCODE_VERSION=1.17.13
pnpm --filter @companion/sandbox golden` → export the printed `COMPANION_GOLDEN_SNAPSHOT_ID`.

Environment: `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`,
`COMPANION_GOLDEN_SNAPSHOT_ID`, `OPENCODE_VERSION` (pin, e.g. `1.17.13`),
`COMPANION_SECRETS_MASTER_KEY` (the same base64 32-byte root used with distinct AAD domains for the
vault, dedicated provider credentials, and opaque internal run credentials),
`COMPANION_RUNS_ENABLED`, `COMPANION_SANDBOX_REGION`,
`COMPANION_SANDBOX_TIMEOUT_MS` (default `300000`), `COMPANION_RUN_CONCURRENCY`,
`COMPANION_RUN_CLAIM_INTERVAL_MS`, `COMPANION_RUN_LEASE_SECONDS`,
`COMPANION_RUN_HEARTBEAT_MS`, `COMPANION_RUN_INACTIVITY_MS`, bounded recorder reconnect settings,
`COMPANION_RUN_EVENT_RETENTION_INTERVAL_MS`, `COMPANION_RUN_SWEEP_INTERVAL_MS`, S3 settings for
attachments/packages. Event retention itself is
fixed at 24 hours after terminal state. The worker receives these settings. Keep the feature flag off
when Vercel/golden configuration is absent; only RunSkill is disabled, while API, web, billing,
provider settings, and vault still run.

Production API and worker processes connect through `DATABASE_URL` using a dedicated login with
`NOSUPERUSER`, `NOBYPASSRLS`, no table ownership, and no membership in the migration-owner role.
`DATABASE_MIGRATION_URL` is available only to the API migration step. With
`DATABASE_RUNTIME_ROLE` configured, that step applies `packages/db/runtime-role-grants.sql` under the
same advisory lock after every migration; the file is also the manual recovery path. It grants
ordinary table access plus only the narrow cross-tenant discovery functions needed before a tenant
GUC exists. Organization creation and domain joining generate/select an org id first, then run under
normal RLS with explicit tenant context. Running application processes as the table owner, superuser,
or a `BYPASSRLS` role invalidates the forced-RLS security boundary.

The bundled Companion skill performs write-only secret creation and binding plus secret-aware
install/update/sync.
Its general Use prompt requests `skills:read + skills:write + secrets:read + secrets:write`; focused
skill-install prompts request only `skills:read + secrets:read`. It creates through the dedicated
stdin/private-prompt helper, then preflights the exact requested versions and dependency closure before
any mutation, then creates and immediately redeems a one-time grant after global confirmation.
Values exist only in process memory and the final projection. Per target, projections are written to
`~/.companion/secrets/<workspace>/<skill>/.env` (`0700` directories, `0600` files) with a same-filesystem
stage, exclusive lock, symlink/path-traversal rejection, atomic rename, and package+projection rollback.
Before any later secrets operation, the runtime scans that workspace for interrupted transaction
markers, restores the last coherent package/projection pair, and deletes transient plaintext backups.
The separate local state records slot/version/environment key/opaque projection/path but no value.
Explicit manual retrievals use `_manual/<profile>/.env`. Bulk sync continues after skips/errors and
reports `updated / skipped / errors`; offline mode keeps the last coherent copy and warns that it may
be stale rather than claiming immediate revocation.
