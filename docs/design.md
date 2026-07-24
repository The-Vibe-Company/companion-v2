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
- **Worker:** `apps/worker` runs independent billing, skill-run, and GitHub-mirror supervisors. `packages/billing`
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
  worker/     # Stripe, durable skill-run, and GitHub-mirror supervisors
  web/        # Next.js portal
packages/
  billing/    # framework-free Stripe gateway
  github/     # GitHub App OAuth, installation tokens, deterministic Git trees
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

Better Auth owns the core `user`, `session`, `account`, and `verification` tables. The delegated
Agent Auth plugin owns the global identity tables `agent_host`, `agent`, `agent_capability_grant`,
and `approval_request`; `agent_auth_ephemeral` is its shared PostgreSQL TTL/rate-limit/JTI store.
Companion adds `profiles`, `organizations`, `memberships`, `invitations`,
`skills`, `skill_versions`, `skill_version_dependencies`, `labels`, `skill_labels`,
`skill_filter_preferences`, `skill_comments`, `skill_comment_images`, `local_skill_installs`,
`api_tokens`, `github_connections`, `github_sync_destinations`,
`github_sync_destination_skills`, `billing_subscriptions`, `stripe_webhook_events`, `audit_log`, the secret-vault
tables, the creator-private Project workspace/session/file tables, and the Skill Run tables described
below. There are **no teams**:
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
distinct from the **last updater**: the session-, Agent Auth `skills:read`-, or explicit legacy
PAT-authenticated `GET /v1/skills`
and `GET /v1/skills/:slug` read
models carry both the `creator_*` ("Created by") and `updater_*` ("Last updated by") display fields, the
latter derived from the uploader of the current version (`skill_versions.created_by` of
`skills.current_version_id`) — no `updated_by` column. There
is still no `owner_team_id`, `everyone` flag, `skill_team_shares` table, or `PUT /v1/skills/:slug/owner`
endpoint. A slug is **workspace-unique across both scopes** (`skills_org_slug_uq (org_id, slug)`), so the
slug route stays unambiguous and Share can never collide. Dependency reads prefer the stable target
`skills.id`, so an explicit rename can change the slug without replacing the skill, except while a
public release is pinned (see below). The one scope transition is
**Share** (`POST /v1/skills/:slug/share`): owner-only, one-way `personal → org`, which also drops the
skill's personal-folder assignments. "Installed" is not a copied row — a member's My Skills =
(`scope='personal' AND creator=them`) ∪ (org skills they have a `skill_installs` row for), surfaced
together. A version's declared tools
(`skill_versions.tools`) come from the Agent Skills `allowed-tools` frontmatter string.
Every skill also carries a unique, unguessable `skills.share_token` generated by the database and a
nullable `skills.public_version_id` pointing to one immutable version of that same skill. No migration
backfills the pointer. For a live `org` skill, `/s/<token>` is the stable public destination for
anonymous visitors, authenticated users, and social crawlers; it is `noindex` and never redirects
automatically into the authenticated app. The explicit **Open in Companion** action uses the separate
member-only resolver.

`GET /v1/public/skills/:token` is metadata-only and remains available when the pointer is null. It
returns display metadata plus
`public_release: { version, checksum, size_bytes, released_at } | null`. When a release exists, the
page and Open Graph image use that pinned version's metadata even if a newer internal version exists.
The public checksum and size describe the deterministic ZIP transport bytes, not the canonical
uncompressed-tar checksum stored on `skill_versions`; they are frozen on the skill row alongside
`public_released_at` when promotion succeeds. Before that pointer CAS, the API writes those exact ZIP
bytes once with `If-None-Match: *` to the tenant-scoped content address
`{org_id}/public-releases/sha256/{digest}.zip`; an existing object is accepted only after its size and
digest are revalidated. Public downloads read this frozen object directly and never regenerate ZIP
bytes from the canonical tarball. The preview never returns `id`, `org_id`, `creator_id`,
SKILL.md body, package bytes, secret values, or labels. Personal skills are never exposed; their owner
must first Share into the org library. Archived org skills return 404 while retaining both token and
pointer so a restore can reactivate the same URL and release.

Only the org skill's creator or a current Owner/Admin may set or remove `public_version_id`; this is
the deliberate exception to the normal any-member org-skill mutation rule. Only
`current_version_id` may be promoted. Publishing a newer immutable version never moves the pointer,
and the publish UI/Companion skill asks a separate default-no promotion question. Promotion is a
compare-and-set transaction and returns `409` when its observed current/public state was changed by a
concurrent request. Removal is idempotent, clears only the pointer and release transport metadata,
and leaves the share token intact. Both operations write value-free audit events.
An explicit rename is rejected with `409` while `public_version_id` is set: even though historical
version rows and ZIP bytes are immutable, changing the mutable slug/title would make the public page
describe a different identity from the pinned package. The operator must first withdraw the release,
rename, publish a new current version whose `SKILL.md` name matches the new slug, and then explicitly
promote it. Core rejects promotion of an older current version whose immutable name no longer matches
the skill slug. This also prevents an ordinary Developer—who may rename org skills but cannot manage
another creator's public release—from taking that release offline indirectly.
`skills.display_name` is a nullable, mutable display-title override used by explicit rename. It is
overlaid onto the current read model as `display.name` but never rewrites existing
`skill_versions.frontmatter` rows or stored package archives.
Companion-specific package data lives in root `companion.json`, not `SKILL.md`: `name`, `version`,
an optional portable `icon` from the curated Skills icon catalog,
human-facing `title`/`description`, Markdown-compatible `notes`, `metadata.companionSkillId`,
`metadata.changelog`, `environment.env` / `environment.secrets` declarations (never values),
`commands`, local-only `checks`, and un-versioned skill `dependencies` as `{ skillName: skillId }`.
Each `environment.secrets[ENV_KEY]` declaration has a stable UUID `slotId`. It remains optional at
the package boundary for backwards compatibility; normalization assigns a deterministic UUID from
the stable skill id plus the environment key. An explicit id survives a key rename, while an
unidentified declaration creates a new slot. `environment.env` is intentionally outside this model.
`description` updates the existing `skills.description` listing field; the full normalized manifest rides in the existing
`skill_versions.frontmatter` JSON under `companion` and is parsed back into the read shape
(`skillListRowSchema.display` / `skillListRowSchema.icon` / `skillListRowSchema.requirements`) for the
skill list and detail view; missing icons read as `null` and require no `skills.icon` column. The
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
credentials live separately in schema-v3 `~/.companion/credentials.json`, keyed by
`organizations.id`. Each active workspace stores only `{issuer, agentId}` plus `apiUrl`; SDK-generated
private keys live outside that index under `~/.companion/agent-auth/` in `0600` files within `0700`
directories. A v2 token migrates to a preserved `legacyPat` value that is ignored unless the user
explicitly selects `COMPANION_AUTH_MODE=legacy-pat`. The lockfile keeps `apiUrl` metadata but never
stores tokens, JWTs, tickets, or keys. Legacy URL-keyed lockfiles are migrated on
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

`GET /v1/skills` is readable with a browser session, Agent Auth `skills:read`, or explicit legacy PAT
`skills:read`: `lib=org` returns the org library, `lib=mine`
returns the caller's authored personal skills plus reported installed org skills, and
`installed=true` narrows the list to skills with a `skill_installs` row for that caller. This is
Companion-reported install state; exact disk inventory remains local in `~/.companion/skills.lock.json`.

`api_tokens` holds scoped personal access tokens for backward-compatible programmatic workflows.
Only the `sha256` `token_hash` is stored (the plaintext `cmp_pat_…` is shown once); each row carries
`scopes` (`skills:read` / `skills:write` / `secrets:read` / `secrets:write`), an `expires_at`
(90-day default), and `revoked_at`. `POST /v1/tokens/refresh` is the single expired-PAT exception to
normal authentication: it leaves active tokens unchanged and lets an unrevoked token expired no more
than 30 days ago create exactly one 90-day successor with the same user, organization, name, and
scopes. A narrow pre-tenant `SECURITY DEFINER` lookup verifies current membership and locks both the
old token and membership rows; successor insertion, old-token revocation, and a value-free
`api_token.refresh` audit event then
commit in one tenant-scoped transaction. Unknown, revoked, stale, and departed-user credentials are
indistinguishable. The bundled bootstrap uses this only for file-backed credentials and atomically
updates the active workspace entry under the same inter-process lock used by the **Use** prompt;
environment-provided tokens require manual replacement. The bundled Companion client never selects
these credentials unless the user explicitly sets `COMPANION_AUTH_MODE=legacy-pat`; Agent Auth
failure has no silent PAT fallback.
`secrets:write` gives a PAT the same metadata and binding mutation
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

`skill_filter_preferences` stores the current user's Skills Hub filter, grouping, and sidebar order for one organization.
The row is keyed by `(org_id, user_id)` and contains `active_filters` JSONB (the status / dependency /
label filter chips), non-null `group_by` (`folder` or `none`, default `folder`), and `sidebar_order` JSONB
with independent depth-first path arrays for `mine` and `org`. The preference is saved as one complete
snapshot so changing one axis cannot erase the others. Saved custom views were removed, so there is no
`custom_views` column. It is personal UI state, not a shared organization resource.

Without a saved sidebar order, folder siblings remain alphabetical. Once customized, ranked siblings lead
and newly discovered paths follow alphabetically. The sidebar accepts insertion drops only between siblings;
those drops update the caller's preference without mutating labels. A center drop retains the existing folder
reparent operation, which remains shared for org labels. Rename preserves the caller's relative order, delete
prunes the removed subtree, and reparent appends the moved subtree under its new parent. The grouped Skills list
mirrors the same sibling order at the root and at every visible subfolder level.

The My Skills and Organization lists use a flat Rhythm grouping by default. A section represents the
first segment of a folder path; a skill is deduplicated inside that root and repeated only when assigned
under distinct roots. Rows show at most two most-specific relative subpaths (ancestors are suppressed),
with an accessible overflow count. My Skills appends `Installed`, then `Without folder`; the organization
list appends `Without folder`. Root sections follow the existing tree order, remain single-level, and use
quiet icon/name/count/chevron headers rather than cards or colored bands. Only collapsed root keys are
stored locally per workspace and library; searching temporarily reveals matching collapsed sections.
Selecting a sidebar folder still rolls up skills from its descendants, while group occurrences, visible
paths, and inherited folder icons are restricted to that selected branch; assignments under other roots
do not reappear in the scoped view. Grouped sections advance to the immediate subfolder level, with a
leading headerless block of plain rows for skills filed directly in the selected folder. These rows are
not collapsible. In unscoped root sections, direct rows lead and the remaining rows are clustered by
immediate subfolder, preserving the selected sort inside each cluster. All grouped rows use
the same horizontal inset regardless of relative path depth; ordering and quiet path metadata express the
hierarchy instead of additional indentation. Flat mode renders one row per skill with full folder chips from that
branch. Both modes use the literal monospace slug as
the only row title and A-Z key. A row icon resolves from `companion.json.icon`, then the deepest custom
folder icon for that occurrence (lexical path breaks equal-depth ties), then neutral `package`; inherited
icons also inherit that folder's color. Local Skills and Archived keep their existing presentation.

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

`packages/auth` configures Better Auth with email/password, **email verification**, **Google OAuth**,
and the pinned unstable Agent Auth plugin (`@better-auth/agent-auth@0.6.2`). The bundled client pins
`@auth/agent@0.6.2`; copied install prompts pin `@auth/agent-cli@0.5.1`:

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
- **Rolling browser sessions.** Remembered sessions expire after 30 days of inactivity and refresh at
  most once per day. The API session middleware requests Better Auth's response headers and forwards
  every refreshed `Set-Cookie`; the authenticated web shell also performs a same-origin session check
  when it mounts or becomes visible (throttled to five minutes), so both database and browser expiry
  advance together. Server-rendered API calls explicitly disable session refresh because a React Server
  Component cannot re-emit the API cookie; the browser keepalive is therefore the request that consumes
  the daily refresh and persists it.
- **Web ↔ API glue.** The web app never uses the Better Auth client SDK. Next.js route handlers under
  `apps/web/src/app/v1/auth/*` (`signin`, `signup`, `verify-email`, `verify-email/send`,
  `forgot-password`, `reset-password`, `google`) forward to the API's `/auth/*` server-side and re-emit
  the `Set-Cookie` on the **web origin**, keeping the session cookie same-origin (`shared lib/authProxy.ts`).
  When forwarding to Better Auth, these proxy routes use the configured canonical `COMPANION_WEB_URL` as
  the trusted origin. The web middleware permanently redirects the matching `www`/apex alias to that
  canonical origin before auth starts, preventing split host-only cookies. The Google start route must
  also re-emit Better Auth's transient OAuth
  state cookie before redirecting to Google; otherwise the API callback cannot validate `state`. The
  callback itself still lands on `/auth/*` through the web origin's rewrite. The reused 6-digit OTP UI is a
  single client state machine in `(auth)/login/LoginForm.tsx`.
- **Delegated agents.** Agent Auth is delegated-only, device-authorization-only, permits dynamic host
  registration with inline public JWKs (remote JWKS URLs are rejected before the pinned plugin and by
  database constraints), grants nothing automatically, signs 60-second JWTs, and keeps approved grants until
  explicit revocation. `/.well-known/agent-configuration` is public instance discovery. The approval
  page `/device/capabilities` accepts any active rolling browser session (up to 30 days without activity), identifies the
  agent and host, names the target workspace and requested permissions, and accepts or denies the
  request. Settings → Connected agents lists grants, constraints, last use, agent/host state, and can
  revoke one capability, one agent, or one host. Agent Auth rate limits stay enabled in development and
  production and use the shared PostgreSQL secondary store; Agent Auth requests intentionally fail
  closed when its migrations are absent.
- **Closed capabilities.** The fixed registry contains `skills:read`, `skills:write`, `secrets:read`,
  `secrets:write`, and instance-wide `public-skills:install`. The first four require an exact
  `{ workspaceId: { eq: <uuid> } }` constraint. A JWT is accepted only when its HTTP method and route
  match a registered operation; capabilities never authorize caller-provided arbitrary methods or
  paths. The actor still passes through Core membership, RBAC, tenant, personal-skill, secret-audience,
  and departure checks. `public-skills:install` resolves only known live public tokens and grants no
  workspace membership.
- **Binary transfer tickets.** Agent capability execution mints an opaque 60-second ticket for a
  registered upload/download operation. Only its SHA-256 hash is stored—no plaintext-derived prefix
  or other bearer fragment—bound to user, agent, action, workspace, skill/version, checksum, and size.
  The binary route receives it in a header, atomically
  consumes it once, and revalidates current membership/revocation/release state before returning or
  accepting bytes. Tickets and secret values never appear in URLs, argv, logs, or audit payloads.

Server-rendered auth checks treat only an API `401` as signed out. Network failures and `5xx` responses
are retried after 250 ms and 750 ms, then render a recoverable session-verification error instead of
redirecting to Google; this preserves a valid browser cookie across API replacement during deployment.

Production requirements: set `BETTER_AUTH_URL` to the API's public origin (the Google redirect URI is
derived as `${BETTER_AUTH_URL}/auth/callback/google` and must be registered in Google Cloud); keep web
and API **same-site** (prefer a same-origin reverse proxy for `/auth/*`) so both the OAuth-callback cookie
and the re-emitted email/password cookie reach the web app; do **not** enable `crossSubDomainCookies`
(host-only cookies are what the re-emit pattern relies on); serve over HTTPS so `Secure` cookies survive.
`BETTER_AUTH_SECRET` and `BETTER_AUTH_COOKIE_PREFIX` must remain unchanged across deploys; changing either
intentionally invalidates existing browser sessions.

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
  changes, and token revocation. Public-release promotion/removal alone requires the skill creator or
  Owner/Admin. There is otherwise no per-skill owner or visibility check for org skills.
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
returning the narrow metadata shape described above. Public package bytes are a separate boundary:
they require either a verified browser session (membership in the publishing org is not required) or
a consumed `public-skills:install` Agent Auth transfer ticket; anonymous requests and PATs are denied.
The signed-in web deep link uses a separate authenticated resolver,
`GET /v1/skills/share-target/:token`, which returns `{org_id, slug}` only when the user is already a
member of the token's workspace; `/s/:token/go` then sets `companion_org` before redirecting to the
slug-keyed detail route, where the client replaces the address bar back to `/s/:token`.

## GitHub Skill Mirrors

Workspace Owners and Admins manage one-way `Companion → GitHub` mirrors from **Settings → GitHub**.
Developers, non-members, cross-tenant actors, and every PAT are rejected: the HTTP surface is browser-session
only and the framework-free core service repeats the membership plus `canManageOrg` gate. GitHub is never a
source of truth. There are no import webhooks and no two-way domain state; the next explicit, event-driven, or
15-minute drift sync replaces direct GitHub changes only inside Companion-owned paths and the managed README
block while preserving unrelated repository content.

Authentication uses one GitHub App end to end. The browser authorization is a GitHub App user-to-server OAuth
grant, protected by a ten-minute HMAC-signed `state` bound to `org_id`, `user_id`, and a matching HTTP-only
nonce cookie. User access and refresh tokens use the existing per-org envelope encryption and never appear in
responses, logs, or audit metadata. Refresh happens outside the database transaction and is persisted only by an
update-only credential-generation-and-version compare-and-swap. If disconnect or reconnect wins that race, the API
revokes the newly issued access token instead of recreating or overwriting the connection. Disconnect serializes
on the org GitHub lifecycle lock and revokes the stored user token before deleting its encrypted envelope; a
revocation failure rolls back the local disconnect rather than orphaning a live credential. The API uses the user
token to list accessible App installations/repos and to create a public or private repo in the authorized account.
The worker independently mints short-lived
installation tokens from the App private key for Git Database writes. The private key and App ID are worker-only;
the internet-facing API receives only the App slug, client ID, and client secret. SaaS sets
`COMPANION_GITHUB_APP_MANAGED=true` and owns the official Companion App; self-hosted operators may register an
App of any name/owner using `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_PRIVATE_KEY`, split across those services, and set
`COMPANION_GITHUB_SYNC_ENABLED=true` on the API only after both halves are ready. Incomplete configuration
disables the panel or supervisor without affecting the rest of Companion.

The additive, RLS-protected model is:

- `github_connections`: at most one user authorization per `org_id`, public GitHub identity metadata, encrypted
  access/refresh credential envelopes, expiries, and credential generation/version fencing;
- `github_sync_destinations`: multiple mirrors per org with installation/repository ids, default branch,
  visibility, `all|selected` desired mode, desired/applied revisions, result metadata, retry schedule, and a
  worker lease with owner, expiry, and a monotonic generation incremented on every claim. `repository_id` is
  globally unique so two destinations or tenants cannot control the same repo;
- `github_sync_destination_skills`: explicit selected-mode roots, joined by composite tenant foreign keys.

Publishing or republishing an org skill, Share (`personal → org`), rename, archive, and restore increments the
desired revision for every destination. The supervisor claims due rows through a narrow security-definer
`FOR UPDATE SKIP LOCKED` function, coalesces revisions, and atomically binds the worker, exact claimed revision,
five-minute lease, and new lease generation. Planning is one short tenant transaction: a lock-free read requires
that exact live claim plus an existing connection, then snapshots the destination, selected roots, versions, and
dependencies before releasing the database connection. Selected mode requires at least one explicit root;
archived roots are temporarily omitted, while dependency closure follows stable `depends_on_skill_id` before the
historical slug. A missing or archived required dependency fails before S3/GitHub I/O, preserving the last valid
branch.

All archive, render, and Git-object preparation happens after the planning transaction. A one-second per-claim
monitor repeatedly checks the same connection/owner/generation/revision/expiry fence and aborts work when a
disconnect, delete, newer desired revision, reclaim, or lease loss makes it stale. The whole attempt is bounded to
240 seconds, below the five-minute lease; it does not extend the lease. If a newer revision overtakes a claim, the
failure transition releases it directly to `pending` without consuming an attempt or backoff. A failure still
owned by the exact current claim consumes the exponential retry budget; a stale claim cannot mutate error state.
A 15-minute stale observation also becomes a desired revision.

The renderer verifies each fetched archive against its persisted canonical checksum before expanding it without
executing it, normalizes a wrapper directory, preserves exact binary bytes and executable bits, and emits a
deterministic projection for `.companion-sync.json`, the managed README block, and `skills/<slug>/…`. The README
block is delimited by `<!-- COMPANION:START -->` / `<!-- COMPANION:END -->`, links each mirrored skill to its
public Companion preview, and uses the configured web origin for brand assets. An absent or empty README is fully
generated; an unmarked custom README receives the block at the end; later syncs replace only the single valid
managed block. Bytes outside the markers are preserved. The repository must contain at most one case-insensitive
root `README.md` variant, stored as a regular UTF-8 blob whose merged result is at most 1 MiB; ambiguous casing,
symlinks or other non-blob entries, invalid UTF-8, oversized results, and malformed or duplicate markers fail
before publication. An unchanged pre-marker README from the last successful Companion commit is migrated in place.
Ordering and metadata remain deterministic and match the repository discovery shape consumed by
`npx skills add owner/repo`. Archive fetches and blob uploads use bounded concurrency and aggregate
size/file limits. On the first pool error they stop dequeuing, abort active requests, and settle every started
operation before returning, so failed work cannot continue after its claim is released.

For each write attempt, the worker re-fetches repository metadata and requires GitHub's immutable repository id to
equal the stored `repository_id`; a replacement already present at the same owner/name is rejected before object
preparation. A size-zero repository is probed for branches because GitHub reports both truly empty and small
repositories as zero KB. GitHub's Git References API cannot initialize a repository with no branches, so the
worker uses the Contents API under the final publication fence to create `.companion-sync.json` with an empty
signed ownership set, releases the fence, then re-observes that managed bootstrap commit as the parent. It then observes the
branch, uploads blobs, and overlays managed entries on the observed tree with `base_tree`, comparing tree SHAs
for no-op detection and preparing a commit whose parent is the observed head—all outside PostgreSQL. The current
repository is not imported into Companion: it is read only to preserve unmanaged paths and merge the README.
`.companion-sync.json` from the destination's database-recorded last successful commit is the trusted ownership
record, but only after GitHub proves that commit is an ancestor of the observed head. Companion signs its generated
schema-1 manifest ownership metadata with the configured App key, repository id, previous applied commit, and exact
slug set. That proof lets a retry recover an ambiguously accepted publication—even after a subsequent user commit
or desired-state change—without treating editable GitHub content as authority. An unchanged signed manifest is
reused byte-for-byte for steady-state no-ops; its predecessor-bound proof is refreshed only when another managed
change requires a commit. Companion replaces desired or previously owned `skills/<slug>` subtrees and removes retired owned slugs,
but preserves every other path, including manual folders under `skills/`. A desired slug colliding with an
existing unowned folder fails before blob creation. Missing or invalid trusted ownership history disables
uncertain deletes and keeps acquisition conflicts fail-closed. Only the branch ref changes the managed branch.
Finalization opens a short transaction, takes the org lifecycle
advisory lock and connection row first, then locks and revalidates the exact destination claim. That fence is held
only across a no-op completion, a 30-second-bounded empty-repository bootstrap, ref creation, or one update with
`force:false`, followed
immediately by the database completion. A one-second transaction keepalive aborts the publish on database-session
loss.
Non-fast-forward `409`/`422` races release the final transaction and re-observe/reprepare, for at most three write
attempts; rate limits, revocation, and branch protection remain actionable destination errors.

A ref timeout, abort, process loss, or database-session loss can be ambiguous: GitHub may have accepted the
non-force update while the completion transaction rolled back. The retry heals this by observing the current
branch, verifying any pending ownership proof bound to the still-recorded applied commit, and recomputing the README
merge and managed overlay from the latest head. An exact tree match performs no ref write and records the observed
head commit; a mismatch prepares and publishes a non-force child while retaining ownership only for signed pending
slugs. This observation never
imports files, merges GitHub state into Companion, or creates a two-way sync. A successful disconnect clears all
destination leases, and the monitor
stops slow preparation without waiting for it; if a worker already owns the final fence, disconnect or destination
deletion waits only for the bounded ref update plus completion. Reconnecting leaves destinations paused until an
admin explicitly resumes each mirror.

Settings → GitHub has repository-centric and skill-centric views for Owners and Admins. The skill view lists only
active organization skills and computes desired inclusion per destination as `all` (automatic root), `selected`
(explicit root), `dependency` (transitively required by another selected root), or `none`. Inclusion is intentionally
separate from the destination's operational status: until a pending/syncing/error destination reaches `synced`, its
GitHub branch may still contain the last applied revision. Broken or archived dependency edges never make this
governance view unreadable; the strict worker plan still rejects them before GitHub I/O and exposes the destination
error. All-mode, dependency-only, and disconnected rows are read-only in the skill view.

Skill-centric selection changes use additive, idempotent endpoints rather than replacing a potentially stale full
selection array. They take the same org lifecycle lock as destination editing, lock the destination, require a live
connection plus `selected` mode, and update the join plus desired revision atomically. Removing the final explicit
root is rejected, as are personal/archived/cross-tenant skills. Effective changes clear stale retry/error state,
preserve an in-flight `syncing` status (otherwise set `pending`), and write a per-skill audit event.

Browser-only endpoints are:

- `GET /v1/integrations/github`, `POST /v1/integrations/github/connect`, and
  `GET /v1/integrations/github/callback`;
- `GET /v1/integrations/github/skills`;
- `DELETE /v1/integrations/github/account`;
- `GET|POST /v1/integrations/github/repositories`;
- `POST /v1/integrations/github/destinations`,
  `PATCH|DELETE /v1/integrations/github/destinations/:id`, and
  `POST /v1/integrations/github/destinations/:id/sync`;
- `PUT|DELETE /v1/integrations/github/destinations/:id/skills/:skillId`.

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

Settings → Billing uses a compact invoice-ledger layout: plan, estimated subtotal, active seats, and renewal
lead; sandbox usage, subscription state, and seat synchronization follow as aligned operational rows. The
member-readable `GET /v1/billing` remains database-backed so loading settings and entitlement gates never
depends on Stripe. Owners and Admins may additionally call browser-only `GET /v1/billing/preview` when the
Billing pane is open. That endpoint reads Stripe live and returns only a sanitized default-payment summary
(type, card brand/last four/expiry when applicable) plus the latest non-draft invoice (number, date, amount,
status, and hosted invoice URL). Developers and non-members receive `403`; Stripe failures degrade only the
preview and never hide the subscription, usage, or Customer Portal action. Preview data is not persisted.

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
- Run Skill has zero sandbox minutes. Pro receives a shared UTC-calendar-month pool equal to active
  membership count × `COMPANION_SANDBOX_MINUTES_PER_SEAT` (default 250). An organization-period
  advisory lock serializes reservations, so concurrent launch, reactivation, follow-up, and prewarm
  requests cannot oversubscribe the enforced pool. Reservations are 5 minutes for prewarm, 10 for a
  launch/reactivation, and 7 for each further prompt. There are no paid overage packs in v1.

Self-hosted billing mode bypasses sandbox accounting and remains unlimited. In managed mode,
`sandbox_usage_sessions` stores one reservation per sandbox activation; unstarted reservations expire,
started reservations grow with elapsed wall time, and the worker settles them to whole minutes when
the provider session stops or is destroyed. A prewarm reservation transfers atomically to its run
instead of double-counting. `user_run_preferences` stores the creator-only prewarm toggle, default on.
Prewarming consumes the same pool and is visible in the launcher before it starts. `GET /v1/billing`
returns used, reserved, remaining, pool size, and reset boundary. The quota bounds ordinary compute;
provider-level spend management remains the emergency guardrail for atypical network transfer. The
pool is recomputed from the current active-seat count: adding a seat increases capacity immediately;
removing one never erases recorded usage and blocks further work if consumption now meets or exceeds
the lower limit.

The worker re-admits every claimed activation immediately before provider I/O, including commands
created by a replica from before the usage migration. In enforced mode it clamps the provider's
initial timeout to the admitted reservation and extends that timeout only by minutes subsequently
reserved for follow-up prompts or for the exact post-turn idle runway. The idle extension is
idempotent: after the final active turn, the worker reserves only the delta required to reach the
advertised idle deadline, then extends the provider to that admitted deadline. If quota denies the
delta, the worker checkpoints and stops immediately instead of publishing an unreachable warm
deadline. During a rolling deployment, an already-running named sandbox whose provider lease exceeds
the fresh reservation is stopped, deleted, and recreated; stopped persistent sessions remain eligible
for normal conversation reactivation. The admitted provider lifetime also ends at the next UTC month
boundary, so a sandbox cannot carry unused prior-month capacity into a fresh pool. Deferred and
membership-revocation cleanup settle the newest open activation before marking cleanup complete;
provider teardown remains idempotent and is retried if accounting persistence fails.

The structured entitlement rejection is `{ code, feature, message, effectivePlan, limit?, current?,
upgradeUrl? }`, including `sandbox_plan_required` and `sandbox_quota_exhausted` for Run Skill.

Membership acceptance, domain join, and removal mark the tenant billing row `pending` in the same
database transaction. `apps/worker` claims rows with `FOR UPDATE SKIP LOCKED` every 15 seconds, updates
Stripe quantities with `proration_behavior=create_prorations`, retries from 30 seconds up to one hour,
and refreshes all subscriptions every 15 minutes. The billing supervisor also retries its own startup
every 15 seconds after transient Stripe or database failures; scheduled batch failures remain isolated
and retry on the next interval instead of disabling billing or producing an unhandled rejection.
Stripe webhook signatures are verified against the
raw body; event ids are deduplicated, then the current Stripe subscription is always re-read before
persisting so delivery order cannot corrupt local state.

## Public API

- Auth: `/auth/*` Better Auth endpoints (email/password, `email-otp/*` verification + reset, and
  `sign-in/social` + `callback/google`), plus `/v1/auth/login`, `/v1/auth/logout`,
  `/v1/auth/whoami` for CLI ergonomics. `whoami` also returns `onboarded` / `needsOnboarding`.
  `/.well-known/agent-configuration` exposes public Agent Auth discovery; plugin device endpoints live
  under `/auth/*`. The authenticated `/v1/agent-auth/device-approval` wrappers back the five-minute
  fresh-session consent page, and `/v1/agent-auth/grants`, `/agents/:id`, and `/hosts/:id` back
  Connected agents inspection and revocation.
- Onboarding: `GET /v1/onboarding/context` (email-domain classification + `matched_orgs[]` for
  domain-access orgs), `POST /v1/onboarding/join` (join a selected org after server-side domain
  revalidation),
  `POST /v1/onboarding/create` (create org + invites, finish onboarding).
- Billing: session-only `GET /v1/billing` for any member; session-only
  `POST /v1/billing/checkout` and `/portal` for Owners/Admins; public
  `POST /v1/billing/webhooks/stripe` authenticated only by the Stripe signature. Billing endpoints
  never accept PATs. Pro invitations and domain-access additions require `acknowledgeSeatBilling`.
- Run preferences: session-only `GET/PATCH /v1/run-preferences`; the PATCH accepts the complete
  `{ prewarm_enabled }` preference. Run routes and preferences reject PATs.
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
  `PUT /v1/skills/:slug/public-version` with `{version}` and
  `DELETE /v1/skills/:slug/public-version` (creator or Owner/Admin; only the current org version may
  be selected; promotion is compare-and-set and concurrent publication returns `409`),
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
- Public skill releases: `GET /v1/public/skills/:token` is unauthenticated and returns the narrow
  metadata-only preview for a live org skill share token, including nullable `public_release`.
  `GET /v1/public/skills/:token/versions/:version/package` returns bytes only for the exact active
  release and only to a verified browser session or a consumed 60-second `public-skills:install`
  ticket; PATs, anonymous requests, mismatched versions, personal skills, archived skills, and null
  pointers are refused. The public web route `/s/:token` is stable, `noindex`, and offers explicit
  **Open in Companion**, **Copy install prompt**, and **Download ZIP** actions without an automatic
  signed-in redirect. Login/signup returns to the same public page. Public-package canonicalization
  and installation reject NTFS alternate-data-stream syntax, DOS device names, trailing-dot/space
  aliases, and case-folding path collisions in addition to traversal, links, and special files.
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
  Delegated Agent Auth performs grant+redeem only through the bundled client's `secret-redeem`
  action: the redeemed JSON travels over an inherited anonymous pipe that refuses stdout, stderr,
  and regular files. The ordinary JSON stdout envelope contains counts only, so secret values never
  enter agent output or Agent Auth events.
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

Requests authenticate by Better Auth cookie session or, on the fixed registered operation surface,
a short Better Auth Agent JWT. The four tenant capabilities require an exact workspace-id constraint
and always re-enter the same Core services as REST/PAT. The bundled client requests `skills:read` at
bootstrap and requests its first write or Secrets capability only when needed. An
`Authorization: Bearer cmp_pat_…` token remains
accepted **only** on the PAT-enabled skills endpoints (`GET /v1/skills`, `GET /v1/skills/:slug`,
`POST /v1/skills`,
`POST /v1/skills/create`, `POST /v1/skills/:slug/rename`,
`GET /v1/skills/:slug/download`,
`GET /v1/skills/:slug/versions/:version/package`,
`GET /v1/skills/:slug/versions/:version/files`, the skills install/dependency/archive/share/label
surfaces, `GET /v1/orgs/current/skill-naming-policy`, the `/v1/local-skills*` endpoints, and the
Secrets metadata, configuration, retrieval, vault, binding, and suggestion routes listed above); every
other endpoint rejects tokens. Public release package download explicitly rejects PATs. The one
recovery-only exception is `POST /v1/tokens/refresh`, which
reads the bearer directly because an eligible token may already be expired and cannot authenticate
elsewhere. Token requests are scope-gated (`skills:write` to publish/create/rename/mutate,
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
Agent-authenticated binary operations use a one-use transfer ticket rather than sending the Agent JWT
to the byte stream.

Skill archives are stored under `{org_id}/{slug}/{version}.tar.gz` in the `skill-archives` bucket
using the slug at publish time; a later rename does not move historical archive objects. The
per-version package endpoint repackages them as `.zip` on the fly. Clients never receive S3
admin credentials. Public promotion persists a separate immutable, content-addressed ZIP snapshot
and freezes its checksum and byte length; public clients verify both before extracting.

## Projects (creator-private Cowork workspaces)

A Project is one creator-private, durable work environment: one persistent named Vercel Sandbox, one
OpenCode server, a shared managed filesystem, and many independent OpenCode sessions. Projects are the
member-facing work surface across the three pillars, not another deployable resource. The UI calls the
resource a **Project** and its sessions **Conversations**; `project_sessions` remains the internal
storage name. Sandbox ids, ports, passwords, checkpoints,
package paths, and provider state remain control-plane details.

Projects are creator-private with no Owner/Admin override, matching personal Skills and Skill Runs.
Every read and mutation requires current organization membership plus `creator_id = actor.id`; an
inaccessible Project is indistinguishable from a missing one. Prompt text, transcripts, filenames, file
contents, Secret names/keys, and plaintext never enter audit metadata.

### Data model and isolation

- `projects` stores tenant and creator identity, creator-scoped create idempotency key and payload
  hash, name, default activated model, optimistic revision, `archived_at`, deletion intent, and
  timestamps. Archived Projects leave the normal list but retain their conversations, Files, and
  workspace until an explicit permanent deletion. It does not require an objective.
- `project_workspaces` is the one-to-one desired/observed runtime record: deterministic sandbox name,
  provider identity, encrypted OpenCode password, lifecycle state, activation and sync generations,
  latest checkpoint, lease fencing, activity/deadline timestamps, and bounded user-safe failure
  state. Golden snapshot and OpenCode release provenance remain deployment configuration rather than
  user-editable Project state.
- `project_skills` contains selected roots. Immutable `project_skill_snapshots` records the complete
  exact dependency closure, versions, checksums, and mount order for each applied generation.
- `project_sessions` stores one OpenCode session identity, immutable model plus the catalog's exact
  provider/env-key declaration, title, `archived_at`, `last_viewed_at`, durable transcript cursor and
  user-facing state. Active and archived libraries use the same canonical
  `created_at DESC, id DESC` order, cursor pagination, and title search; runtime activity never
  reorders a conversation. `last_viewed_at` makes a later terminal result durably unread until the
  owner opens or acknowledges it. Archived conversations are hidden from normal lists and may be
  restored, but V1 has no permanent conversation deletion. An empty env-key snapshot explicitly means
  credentialless; otherwise admission requires the effective connection's key to match.
  `project_prompts` is the idempotent per-session command outbox;
  `project_session_events` backs bounded live replay. Events use the same closed, size-bounded
  vocabulary as Skill Runs; completed prefixes are removed only after the bounded redacted transcript
  snapshot records their sequence. A single session preserves prompt order while different sessions
  may work concurrently.
- `project_attachments`, `project_files`, and immutable `project_file_versions` expose only the managed
  `files/` tree. Every attachment retains its exact `prompt_id`; every created or updated file version
  retains the session and prompt that produced it. This lets a reloaded transcript render input files
  beside the originating member message and exact `Created files` / `Updated files` blocks after the
  responsible turn. Files can also be added directly to the Project without a synthetic prompt. Those
  S3-backed immutable versions advance a separate desired file revision; a warm supervisor applies the
  complete managed projection only at a quiescent boundary before advancing the applied revision.
  Runtime directories, `.claude`, OpenCode state, sandbox URLs, and arbitrary filesystem paths never
  cross the API.
- Activation input snapshots pin references to the exact generic Secret and model-provider credential
  versions actually injected. They never copy plaintext or ciphertext.
- Child foreign keys include tenant, Project, and creator identity. RLS derives creator ownership
  through the Project, while narrow worker claim functions expose only fenced leased rows.
- Skill Runs remain structurally and operationally independent. There is no `skill_runs.project_id`,
  and `RunSandboxRuntime` keeps its one-run/one-sandbox contract.

### Runtime boundary and lifecycle

`ProjectWorkspaceRuntime` is a separate Core port implemented by the Vercel adapter in
`packages/sandbox`. A deterministic Project name creates or restores a persistent sandbox from the
golden snapshot. The provider configuration uses persistent snapshots, no snapshot expiration, and a
three-checkpoint retention window. Project creation provisions immediately and applies Skills without
injecting Secrets; the OpenCode server starts only for actual work.

One fenced worker lease owns a Project activation. One server-level OpenCode event subscription is
demultiplexed by `sessionID`, avoiding duplicate global streams while allowing concurrent native
sessions. Each prompt passes its session's model explicitly to OpenCode; `opencode.json` is never
rewritten per session. OpenCode permissions are configured as allowed and any real permission request
is answered automatically by the server adapter. Companion renders the resulting messages and tool
activity but invents no plan, approval, review, or progress protocol. Message completion and session
status are independent OpenCode views: after a turn becomes idle, the worker keeps reconciling for a
bounded confirmation window before declaring an attempted prompt interrupted. It never replays the
prompt during that window. An interrupted or failed turn is a recoverable conversation-level outcome,
not a Project workspace failure: the transcript, attachments, and managed Files remain available and
a later explicit prompt may continue the same OpenCode session. Companion never automatically retries
a turn that may have produced external effects. Any `running` workspace whose worker lease expires is
claimable even when no prompt remains and no idle deadline was installed, so a crash after durable turn
completion or during an in-flight turn cannot strand the activation.

Provider admission is revalidated before a stopped workspace reserves billing, at prompt claim, and
at the final pre-send edge. A missing or incompatible effective connection leaves the command queued
under `project_provider_unavailable`; another prompt cannot wake that state. A relevant effective
provider connection signal reopens it, including an organization fallback exposed by deleting a
personal override, while an idle deadline can still checkpoint a previously warm VM. Create/resume
uses a durable pending-admission token as its linearization point: later Secret/provider mutations
fence that token for recycle, and the worker must consume the exact token under its lease before
pinning credentials. Provider activation is secretless until that final preparation succeeds. A crash
reuses the same token and billing revision; an ambiguous provider response is observed before either
is cleared or settled.

Skills reconcile only at a quiescent filesystem boundary. The worker materializes the latest accessible
root versions and complete closure into a staging directory, verifies checksums, swaps the directory
atomically, then restarts OpenCode. A failed update leaves the previous complete generation applied.
Every personal and organization Skill update is automatic. Consequently, every member allowed to
publish an organization Skill is deliberately trusted as a code author by all Projects using that
Skill; sandboxing does not prevent that code from reading or exfiltrating injected credentials.

At activation the worker resolves every active generic Secret the creator can currently use (owned,
organization audience, or explicit restricted recipient) plus every effective configured provider
credential, with personal-over-organization provider precedence. Control-plane
credentials are never candidates. Duplicate environment keys, `OPENCODE_SERVER_*`, provider collisions,
or more than 128 generic Secrets block before decryption, usage reservation, or provider activation.
The workspace remains in the recoverable `project_environment_invalid` error state: queued prompts do
not churn the worker claim, while a relevant Secret/provider change explicitly returns it to `queued`
for one fresh admission check. Values exist only in worker memory and the
OpenCode process environment, never in `.env` or Project files; the existing literal redactor protects
Companion persistence and logs. It cannot protect a value transformed or exfiltrated by sandbox code.

Additions and rotations apply at the next quiescent restart. Access revocation, provider disconnect, or
membership loss closes admission, aborts active sessions, stops the VM, and rebuilds the environment.
This cannot retract a credential that code already copied or transmitted.

Different Sessions intentionally share one filesystem and may write concurrently. The contract is
last-writer-wins, not merge isolation. File hashes and prompt workspace generations identify overlapping
managed paths, previous versions remain available, and the UI warns without claiming automatic conflict
resolution.

`files/` is a managed product projection, not a second security boundary inside the Project VM. The
Vercel adapter performs managed writes and captures through an in-sandbox `openat`/`O_NOFOLLOW`
helper, rejects symlinks, hard links, reserved roots and unstable inode identities, then verifies the
isolated bytes again before persistence. This closes the filesystem check/use race for Companion's
projection code. It does not isolate mutually trusted code running under the same Project user:
skills and OpenCode can still read and copy other sandbox paths while the VM is active.

After ten minutes with no active prompt, pending synchronization, or upload, the worker persists
transcripts and managed Files, checkpoints, stops the VM, and settles its `project` sandbox usage
activation. After a non-zero turn, `Ready` is published only after the same usage activation and
provider expiry both reach `lastActivityAt + 10 minutes`, bounded by the activation maximum. The worker
extends the durable reservation by only the missing delta; a quota refusal checkpoints and stops the
workspace as a normal scale-to-zero outcome. A later prompt resumes the named sandbox or restores the
last checkpoint. Missing provider state plus a missing checkpoint becomes `needs_attention`; Companion
never fabricates an empty recovery.
An explicit creator retry only returns that terminal workspace to the durable queue and clears its
retry schedule/error counter. It preserves sandbox, checkpoint, generation, activation-admission, and
accounting identity, so a duplicate retry is harmless and recovery still cannot create an empty Project.
Deleting a Project or removing its creator's membership schedules idempotent sandbox, checkpoint, and
object cleanup.

Project creation admits an exact ten-minute activation reservation in the same transaction as the
durable Project. Every accepted prompt reserves seven additional minutes on the open activation; if
the prior activation is settled, that prompt admits the next ten-minute reactivation instead. Expired
unstarted and month-boundary reservations are re-admitted in full before their deadline is refreshed.
The initial reservation remains exactly ten minutes. At the final post-turn boundary, the worker
idempotently reserves only any extra milliseconds needed for the ten-minute idle window, then reads
the refreshed durable budget before extending Vercel. Provider expiry and the member-visible idle
deadline therefore cannot outrun admitted usage.

### Member-facing Cowork surface

The `Skills | Projects` route switch keeps both libraries one click apart. In Projects mode every
creator-owned Project appears in a scrollable sidebar disclosure with at most five non-archived
conversations beneath it, followed by `All conversations · N`. The sidebar, Project page, and API all
use canonical `created_at DESC, id DESC` order. Only `Working`, `New result`, and `Failed` are promoted
to sidebar status; ready and idle state stay quiet. A background terminal result sets unread state,
increments the Project count, and may produce a clickable in-app notification. Opening the
conversation acknowledges it.

The Project page is a conversation library, not a runtime dashboard. It has paginated title search and
exactly two views, `Conversations` and `Archived`. A conversation can be renamed, archived, restored,
or acknowledged. Archiving active work requires `Stop and archive`; inactive work archives
immediately and may offer a local Undo toast. There is no permanent conversation deletion. Archiving
a Project is a normal reversible mutation after active conversations stop. Permanent Project deletion
remains a separate confirmation that names the loss of conversations, Files, and workspace state.

Workspace failures that block every conversation render as `Project needs attention` and may offer the
explicit retry described above. A failed or interrupted turn instead uses the non-destructive message
`Previous task stopped. Your conversation and files are safe.` with `Continue`, `Start new
conversation`, and `Archive`. The composer remains enabled when a new prompt can resume the session.
OpenCode codes and diagnostics live behind `Technical details`; primary copy never exposes workers,
snapshots, control-plane terms, sandbox ids, or server credentials.

Each member message restores its durable prompt attachments. Each completed turn may render the exact
created and updated file versions attributed to that prompt. Desktop opens Files in a persistent
non-modal side panel so the transcript and composer remain usable; mobile uses a focus-trapped drawer
with Escape and focus restoration. Images, PDF, text, Markdown, JSON, and CSV can be previewed inline.
Office formats are download/open-external in V1. Composer file input supports selection, drag-and-drop,
and paste; those attachments stay prompt-linked. The Project Files surface also accepts direct uploads
as shared durable desired state without creating a conversation. Conversation text drafts are restored
from per-conversation `sessionStorage`.

The contextual rail has `Files`, `Skills`, and `Access`. `Access` returns and renders only safe
metadata: Secret names and sources plus effective model providers and sources, never values or
ciphertext. Model selection uses a friendly model/provider label such as `GLM 5.2 · Z.ai`, with the
exact route reserved for technical details. The full Project graph, all archive/read mutations, prompt
attachments, file attribution, and Access metadata remain creator-only under the service-layer gate
and parent-derived RLS; a same-org Owner/Admin has no override.

### Endpoints (session-only)

`GET/POST /v1/projects`, `GET/PATCH/DELETE /v1/projects/:id`,
`POST /v1/projects/:id/retry`,
`PUT /v1/projects/:id/skills`, `GET/POST /v1/projects/:id/sessions`,
`GET /v1/projects/:id/sessions/:sessionId`,
`PATCH /v1/projects/:id/sessions/:sessionId`,
`GET /v1/projects/:id/sessions/:sessionId/attachments/:attachmentId`,
`POST /v1/projects/:id/sessions/:sessionId/prompts`,
`POST /v1/projects/:id/sessions/:sessionId/stop`,
`GET /v1/projects/:id/sessions/:sessionId/events`,
`GET/POST /v1/projects/:id/files`, `GET /v1/projects/:id/files/:fileId`,
`GET /v1/projects/:id/files/:fileId/versions`, and
`GET /v1/projects/:id/files/:fileId/versions/:version` are
verified-browser-session-only. PAT and Agent Auth callers are rejected. `GET /sessions` accepts `q`,
`view=active|archived`, `cursor`, and a bounded `limit`, then returns a canonical page plus
`next_cursor`. The session PATCH permits only title, archive/restore, read acknowledgement, and the
explicit stop-while-archiving signal. Project PATCH also carries reversible archive state. Project
creation, Session creation, and follow-up prompts use mandatory idempotency keys. Direct Project file
uploads publish immutable S3-backed versions and advance the file-projection fence. The API validates
and persists desired state but never calls Vercel or OpenCode.

The Skills UI action **Run skill** selects a Project, adds the Skill root when absent, and creates a
Project Session. The legacy standalone Skill Run routes keep their existing meaning for compatibility;
the public Skills API and bundled Companion Skill contract do not change.

The complete surface is rollout-gated by `COMPANION_PROJECTS_ENABLED`. API admission, worker claiming,
web navigation, and launch actions stay disabled until the same release has the Project migrations,
runtime adapter, worker supervisor, and UI available. Vercel credentials and golden-snapshot settings
remain worker-only.

Project instructions, cross-conversation memory, scheduled tasks, browser control, live artifacts, and
native Office preview are deliberately outside this Cowork pass.

## Skill Runs (one-shot sandboxed sessions)

Skill runs are private, durable sandbox sessions launched from a published skill. Any member may run
a skill they can access. Creation atomically pins the exact root version, its complete accessible
dependency closure, every selected vault-secret version, and every declared non-sensitive value.
Prompts and attachments belong to one run; each attachment is linked to the exact initial/follow-up
prompt that introduced it. Named personal configurations save only model, live secret
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
  folded event cursor, a monotonic activation revision, a bounded reactivation deadline, and a
  redacted warning snapshot that survives event retention. Public lifecycle is
  `queued → starting → running → frozen | interrupted | error | canceled`, with creator-triggered
  `frozen | interrupted | canceled → queued` while the retained sandbox is still eligible.
  `interrupted` retains partial output but never replays the interrupted prompt; only a new explicit
  prompt starts another activation. `runtime_state` (`healthy | degraded`) blocks prompt admission
  while the recorder is recovering. `runtime_idle_activation_revision` is a durable idle proof for
  the latest completed turn only: claiming the next prompt clears it before dispatch can begin.
- `skill_run_skills`, `skill_run_secret_inputs`, `skill_run_model_provider_inputs`, and
  `skill_run_variable_inputs` are immutable input snapshots. Generic secret inputs contain vault
  references and exact versions only, with provenance `skill` or `runtime`. The model-provider row
  instead pins a dedicated connection id and credential version; it never appears in the generic
  secret collection. Ordinary responses never contain plaintext.
- `skill_run_jobs` is the retryable orchestration queue. `skill_run_prompts` is the initial/follow-up
  FIFO outbox with deterministic OpenCode `messageID`s; it stores user-visible text separately from
  the runtime prompt enriched with private attachment-path instructions. Dispatch protocol 2 records
  a write-once `send_attempted_at` under the exact job and prompt leases immediately before
  `sendPrompt`, distinguishing a proven pre-send retry from an ambiguous external side effect.
  `attachments_retained` explicitly controls canceled-prompt file visibility and sweeper eligibility.
  At most five follow-ups may remain queued behind the single processing prompt. A prompt-level
  cancellation request stops or removes exactly that row without terminalizing the run.
  `skill_run_events` holds redacted, monotonically sequenced events for replayable SSE, including
  every durable prompt-status change.
- `skill_run_attachments` — files attached to any prompt (≤5 × 10 MB per message, ≤100 MB per run):
  bytes in S3 under `{org}/run-attachments/{id}`, prompt-linked metadata here, mounted as
  `<attachmentId>-<filename>`, and streamed back creator-only. A server-derived
  `preview_content_type` permits inline PNG, JPEG, GIF, WebP, AVIF, MP4, or WebM only after binary
  signature validation; browser MIME and filename extensions never grant inline rendering. Other
  files and `?download=1` use `Content-Disposition: attachment`. The additive `preview_kind`
  (`text | markdown | csv | image | video | pdf | xlsx | null`) selects a read-only frontend
  renderer independently from response disposition; text requires an allowed extension plus valid
  UTF-8, while PDF/XLSX require their binary/package signatures. HTML and SVG are always null.
  Every response uses `nosniff`,
  private/no-store caching and same-origin isolation. Videos support strict single HTTP byte ranges.
  A partial response honors `If-Range` only when its strong ETag matches the selected object; weak,
  stale, date, or malformed validators ignore Range and return the complete `200` representation.
  The S3 GET remains pinned to the HEAD generation with `If-Match`, including when an overwrite
  forces a retry.
  Failed request paths never delete these deterministic objects
  synchronously: a concurrent idempotent retry may still be committing the same key. Unreferenced
  bytes are retained for at least 24 hours. `skill_run_attachment_uploads` reserves each deterministic
  key before S3 I/O; prompt commits consume the reservation under row lock, while the age-gated worker
  sweep holds that same lock through S3 deletion. A concurrent retry therefore waits and recreates
  bytes after cleanup instead of losing a committed file. The sweep starts from aged reservation
  rows, so even a failed S3 creation remains reachable for cleanup. Multipart follow-ups also run an
  ownership/status/quota/protocol preflight before uploading bytes.
- `skill_run_artifacts` — creator-private outputs cached independently from a live sandbox for 24
  hours. The worker collects at most 20 files, 10 MB each and 100 MB total from `./artifacts/` (three
  directory levels) plus raster paths explicitly opened by OpenCode's `read` tool. It never scans the
  workspace. Traversal, hidden paths, `.claude/`, `attachments/`, escaping symlinks, sockets, and
  special files are rejected. Exact injected secret bytes are redacted before upload. A deterministic
  run/path id and storage key make later versions replace the prior object and renew its TTL; an ETag
  compare-and-swap plus an exact lease check immediately before every PUT fences stale workers.
  Metadata follows `ready=false reservation → conditional S3 overwrite → ready=true`; only ready,
  unexpired rows are visible. Every successful full scan first marks paths absent from its current
  `./artifacts/` path set non-ready under the exact worker lease, expires them for asynchronous object
  cleanup, and immediately releases their ready-row quota. Explicitly read raster files outside that
  managed tree are cached snapshots: later directory scans do not invalidate them, and their normal
  24-hour TTL bounds retention. Directory/stat/read errors and scan guard exhaustion
  fail the scan instead of treating a partial result as authoritative deletion. Raster images plus
  signature-validated MP4/WebM may render inline;
  `preview_kind` additionally allows escaped UTF-8 text/Markdown/CSV and signature-validated PDF or
  XLSX to be fetched as attachments and rendered by isolated read-only viewers. XLSX classification
  rejects excessive per-entry/total expansion and compression ratios before the bounded Worker parser
  runs; the client also terminates parsing that exceeds its deadline. Artifact Markdown blocks remote
  image loads, and direct media URLs carry the artifact update generation so same-path rewrites reload.
  HTML, SVG, archives,
  and unknown binaries are download-only.
  video delivery uses the same conditional, range-streamed object path as input attachments. The API
  reads replaceable artifact metadata on both sides of S3 `HEAD`, pins the streamed `GET` with that
  object's ETag, and retries when either generation changes; a response can therefore expose bytes
  from only one metadata/object generation. Cleanup bounds and aborts S3 deletion while holding its
  final row lock,
  and conditions that deletion on the observed ETag so a late request cannot remove a replacement.
- `skill_run_prewarms` and `skill_run_prewarm_skills` hold creator-private, secretless launcher
  warm-ups. They pin only the root/dependency versions and sandbox lifecycle state; they never join
  the Sessions query. A run may atomically adopt one through nullable `skill_runs.prewarm_id`.
- `sandbox_usage_sessions` records the org pool period, source activation, temporary reservation,
  absolute runtime deadline, provider observation, actual start/stop, and bounded settled duration.
  Safety-capped activations use the configured maximum; enforced activations use the minimum of that
  cap, the admitted reservation, and the UTC billing-period boundary. `user_run_preferences` records the per-user
  prewarm default. Migration `0040_sandbox_usage.sql` adds tenant/owner forced RLS and unique source
  plus sandbox-activation keys so retries cannot reserve or settle twice.
- Migration `0034_skill_runs.sql` creates the durable run tables; `0039_run_prewarms.sql` adds the
  private warm-up lifecycle. Both force creator-only RLS on runs, warm-ups, configurations,
  snapshots, prompts, events, and attachments. Child policies derive the
  creator through their parent run/configuration; admins receive no override. The only cross-tenant
  queue operations are narrow internal `SECURITY DEFINER` functions using `FOR UPDATE SKIP LOCKED`
  and exact unexpired lease identities; claimed work then runs under the recorded tenant and creator
  context. Caller-controlled GUCs are not authority: policies additionally require the table-owner
  execution identity used only inside those functions.
- Migration `0038_skill_run_prompt_attachments.sql` separates visible prompt text from runtime text,
  links every attachment to its prompt, and backfills existing launch attachments to ordinal `0`.
  Legacy-write triggers keep old API replicas compatible during rollout: omitted initial
  `user_text` is recovered from the parent run's raw prompt (follow-ups use their prompt), while the
  old attachment-before-prompt insert order is linked by a deferred constraint trigger at commit.
  Job claiming is protocol-aware: once a follow-up with files is pending, only a live protocol-1
  worker can claim or reclaim that run during a rolling deployment.
- Migration `0037_reactivate_runs.sql` adds the seven-day reactivation window and activation
  revision, permits multiple queued prompts while retaining one processing prompt, and delays
  terminal cleanup claims until a retained frozen/canceled sandbox expires.
- Migration `0041_run_artifacts.sql` adds artifact metadata, creator-through-run forced RLS and the
  exact worker-lease write policy. Narrow reservation/finalization and cleanup functions are the only
  cross-tenant seams. Cleanup locks and rechecks the expired row across S3 deletion before removing
  metadata, so replacement and sweeping cannot orphan or publish bytes.
- Migration `0051_run_file_previews.sql` additively adds `preview_kind` to artifacts and attachments,
  backfills only previously verified media and safely escaped textual formats, and adds the exact
  lease-scoped v2 metadata writer. PDF/XLSX rows are classified only when newly inspected from bytes.
- Migration `0042_run_prompt_queue_stop.sql` adds prompt-level cancellation, worker stop-protocol negotiation and
  the signature-derived attachment preview type. Existing attachments remain download-only.
- Migration `0043_run_prompt_dispatch_barrier.sql` adds dispatch protocol 2, the immutable pre-send
  marker and explicit attachment disposition. It conservatively marks legacy attempted rows,
  expires pending protocol-1 leases without consuming another attempt, and gates launch, claim and
  queued-to-processing dispatch on a live turn-stop-v2 worker during rolling deployment. Ambiguous
  cancellation is routed through worker stop recovery; only a queued follow-up proven never sent
  becomes hidden and eligible for deferred attachment sweeping.
- `user_model_preferences` / `org_model_preferences` (mig 0036) — the ACTIVATED-model lists (see
  "Activated models" below): a jsonb array of `provider/model-id` refs per member (PK
  `org_id+user_id`, user-scoped RLS) and per workspace (PK `org_id`, tenant RLS, nullable
  `created_by` so `db:seed` can seed it).

Live events are retained for 24 hours after a terminal state and then removed; the transcript remains
the durable history and its folded cursor remains the lower bound for future event sequences. Frozen
and canceled runs retain their stopped named sandbox for seven days. Sending a new prompt during that
window atomically requeues the same run and resumes the same OpenCode session; a missing retained
session fails closed rather than silently losing context. Each later freeze/cancel starts a fresh
seven-day window. Files created by sandbox code survive within the retained sandbox until cleanup.
Generated outputs also remain available from the private S3 cache for 24 hours without resuming that
sandbox; attached input files retain their separate attachment lifecycle.

### Launch pipeline + recorder

Opening the launcher creates a best-effort warm-up after loading the caller's default-on preference
and the current pool. The worker forks
the golden snapshot and uploads only immutable skill bundles: it does not create an OpenCode server,
password, provider credential, generic secret input, variable, prompt, attachment, event, audit row,
or public run. The browser heartbeats every 10 seconds; the client lease expires after 30 seconds,
the absolute lifetime is five minutes, and at most two active warm-ups exist per creator. Explicit
launcher close/navigation requests durable cleanup, while the lease covers crashes and lost beacons.

At launch, the transaction locks selected secret parents in stable id order and serializes provider
connection changes per org/provider. It resolves every selected secret id and the effective
personal-then-workspace model credential to their latest accessible immutable versions. Those exact
versions become the run snapshot; launcher-observed provider versions are backward-compatible hints,
not authority. Idempotent replay hashes the selected references, not mutable resolved versions.

A compatible live warm-up is adopted under the same transaction lock. A ready adoption skips fork
and skill upload; an in-flight adoption waits for its lease or resumes idempotently with the same
sandbox name. If an early run teardown observes no sandbox while an adopted fork is still in flight,
the prewarm cleanup waits for that lease to end and reconciles the deterministic sandbox name after
the terminal run records its cleanup. Only after static preparation does the worker decrypt the
committed pins, upload the dynamic OpenCode config/attachments, and pass plaintext through
`startServer` environment variables.
The environment is cleared after redactor creation/server start. Rotations before commit are used;
rotations after commit do not change the run, while ACL loss before injection fails closed.

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

1. revalidate run ownership and load only non-sensitive materialization snapshots;
2. adopt a compatible warm-up or get/fork the deterministic sandbox;
3. push any missing skill bundles, then uniquely named initial attachments and `opencode.json`;
4. decrypt the click-time pins, then start and health-check OpenCode with the exact environment;

For each follow-up, the worker fetches only that prompt's attachment objects and idempotently writes
them into the live sandbox before checking/sending its deterministic OpenCode message. A retry may
rewrite the same paths, but it never sends a prompt before every referenced file is mounted. Worker
heartbeats advertise attachment-prompt protocol `1` and turn-stop protocol `2`. Turn-stop v2 also
identifies dispatch-v2 workers: the queued-to-processing transition requires their exact live job
lease, and they persist the write-once send marker before any possible `sendPrompt` side effect.
Migration 0043 expires old protocol-1 leases that could dispatch pending work; a v2 worker reclaims
the same job attempt and reconciles the deterministic message id instead of allowing the old lease
to advance.
5. establish the recorder, then find or create the deterministic session;
6. send the persisted initial/follow-up prompt with its deterministic `messageID`;
7. batch redacted events and snapshot the transcript;
8. after every artifact-targeted `write`, `edit`, patch, or shell tool completes, enqueue a
   single-flight/coalesced bounded output scan. Emit `artifacts.collecting` before each scan and
   always emit `artifacts.updated` after a successful scan, including an empty result. Keep the
   definitive end-of-turn, pre-freeze, and recovery scans; collection failures emit a durable
   non-terminal `run.warning`;
9. freeze after inactivity, stop the named sandbox for bounded reactivation, then destroy it
   idempotently after the seven-day deadline.

Runtime/network calls never occur inside a database transaction. On worker replacement, an expired
lease resumes the same sandbox/session/message instead of duplicating them. A transient recorder
closure enters one durable degraded episode and reconnects with backoff while preserving
recorder-local cumulative part cursors across new network signals. Its iterator and abort controller
are always closed before another subscription opens. While degraded, the worker observes provider
truth every 15 seconds. A stopped/missing provider freezes an idle run or interrupts an
active/ambiguous turn; a still-running provider gets at most five minutes to restore OpenCode.
Follow-ups receive `409 run_runtime_degraded` until recovery. Each idle transcript snapshot and its
`session.idle` barrier event are committed in
one transaction with the same watermark, so SSE can never hydrate an older snapshot after observing
that event. Normal process shutdown stops claiming work and lets leases expire;
it does not destroy active sandboxes.

The exact-lease watcher also observes cancellation of the processing prompt. A prompt proven unsent
is finalized without contacting OpenCode. A marked or legacy-ambiguous queued retry instead becomes
`cancel_requested` processing work and is reclaimed by the stop path ahead of the recorder busy gate.
The worker reconciles its deterministic message id, proves the shared session idle or aborts it, then
waits for the recorder's durable atomic idle/transcript barrier before preserving the partial answer,
collecting outputs and claiming the next FIFO prompt. Completion and cancellation are compare-and-set
transitions, so a late request can never stop the successor. If abort or snapshot stabilization fails
after retries, the run fails closed and its sandbox is destroyed before another prompt can start.

### Sandbox cleanup

A terminal run's transcript is persisted before suspension or teardown. Frozen/canceled runs stop
without destroying their named sandbox, remain creator-reactivatable for seven days, and are excluded
from cleanup claims until that deadline. Cancellation aborts the active OpenCode turn before the
final snapshot so a later resume starts from a stable context. Error runs and revoked memberships
still destroy immediately; provider failures keep cleanup owed for a later worker attempt. The
event-retention sweeper, age-gated run-attachment orphan sweep, artifact expiry sweep, and
sandbox-cleanup work live in the runs supervisor, not the API. Artifact routes reject expiry
immediately; physical S3/row deletion is an idempotent asynchronous follow-up.

### Privacy

Runs are **private to their creator** — `canAccessRun` in `packages/core/src/authz.ts`, the same
owner-only shape as personal skills, deliberately with **no admin override**. `GET
/v1/skills/:slug/runs` returns only the caller's runs; anyone else's `GET /v1/runs/:id` is a 404.
Any member may RUN any skill they can see; running confers no visibility into others' runs.

### Chat proxy

The browser never sees the sandbox. A follow-up route inserts one durable FIFO outbox row and returns
`202`; while a run is live, up to five rows may wait behind its single processing prompt. For an
eligible frozen/canceled run, only the first prompt is admitted while the same transaction increments
the activation revision and requeues its orchestration job. Each transition emits a replayable
`prompt.status` event. Canceling a queued prompt removes it from future dispatch; canceling the exact
processing prompt requests a turn-level stop while leaving the run and sandbox active.
`GET /v1/runs/:id/events` first replays persisted
rows strictly after `Last-Event-ID`, then switches to PostgreSQL `LISTEN/NOTIFY` without a race. The
notification contains only run id and sequence, and every SSE frame has a real `id:`. Reconnect uses
the last accepted sequence and transcript snapshots reconcile whenever `transcript_updated_at`
advances.

The web chat composes the headless shadcn Message Scroller with Companion-owned message, marker,
attachment and composer components. User turns anchor the viewport; streaming follows only while the
reader remains at the live edge, otherwise a labeled jump control exposes new content. The assistant
is unframed, user turns use compact neutral bubbles, and tools/reasoning remain dense operational
markers. The multiline composer stays available during a turn and displays the durable FIFO above
it. Input files render beside their prompt. The first generated artifact automatically opens a
non-modal right-hand canvas and selects that file; later files add a badge without stealing the
active selection. Desktop uses a keyboard-accessible, locally remembered 420px–70vw split pane
(640px initial width). Mobile/tablet uses a full-screen `Files → Preview` flow. The explorer preserves
the `./artifacts/` hierarchy under Generated and groups Uploaded files by prompt. Bounded viewers
render escaped text/code/Markdown/JSON/YAML, CSV tables, XLSX sheets in a dynamically loaded Web
Worker, signature-validated media, and PDF. Every obsolete fetch is aborted and every local object
URL is revoked; unsupported, oversized, expired, empty, collecting, loading, and retry/download error
states are explicit. Generated-file markers and matching `./artifacts/...` Markdown paths open the
same canvas.

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
variable fails. Any `OPENCODE_SERVER_*` collision fails. The launcher presents declared inputs in
their skill groups without a separate credential-exposure summary.

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
`GET /v1/skills/:slug/run-options`, `GET/PATCH /v1/run-preferences`,
`GET/POST /v1/skills/:slug/run-configurations`,
`PATCH/DELETE /v1/run-configurations/:id`,
`POST /v1/skills/:slug/runs` (multipart: optional prompt when at least one file is present, model,
exact version, authoritative JSON inputs, repeatable file; mandatory `Idempotency-Key`; `201` for a
new run and the same result on replay),
`GET /v1/skills/:slug/runs` (caller's runs only), `GET /v1/runs/:id`,
`POST /v1/runs/:id/prompt` (legacy JSON text or multipart optional text + repeatable file; text or a
file is required; mandatory idempotency, `202`),
`POST /v1/runs/:id/prompts/:promptId/cancel` (idempotent removal/turn stop),
`POST /v1/runs/:id/cancel` (terminal run cancellation),
`GET /v1/runs/:id/events` (replayable SSE), and
`GET /v1/runs/:id/attachments/:attachmentId`, plus creator-only
`GET /v1/runs/:id/artifacts/:artifactId`. Attachment and artifact routes send only
signature-validated PNG, JPEG, GIF, WebP, AVIF, MP4, and WebM as `inline`; SVG, HTML, PDF, unknown
types, and `?download=1` always use `attachment`. MP4/WebM support a single conditional byte range
without buffering the whole object. RFC `If-Range` semantics require a matching strong ETag for
`206`; a mismatch returns the full current object with `200`, while S3 `If-Match` fences every stream
to one object generation. Because every route rejects personal access
tokens, the bundled Companion skill's API surface is unchanged.

### Non-goals (v1)

Arbitrary undeclared variables, organization-shared configurations, fan-out, and golden-snapshot
management UI
(`COMPANION_GOLDEN_SNAPSHOT_ID` is the single golden) remain out of scope.
Real-sandbox verification lives in `pnpm --filter @companion/sandbox smoke:vercel` (cred-gated,
not CI).

### Ops runbook

One-time golden snapshot (per OpenCode pin), deployed after migration/application compatibility:
`VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… OPENCODE_VERSION=1.17.13
pnpm --filter @companion/sandbox golden` → export the printed `COMPANION_GOLDEN_SNAPSHOT_ID`.
The snapshot starts from Vercel `python3.13`, selects Amazon Linux `nodejs24`/`nodejs24-npm`, and
verifies Python 3.13 union syntax, pip, `openai==2.45.0`, `requests==2.34.2`, `PyYAML==6.0.3`,
`uv==0.11.29`, Node 24, npm, and the exact OpenCode pin. It also includes git, curl, jq, ripgrep,
file, zip, and unzip. Existing retained sandboxes keep their old runtime until expiry; re-running a
session creates a new run from the configured golden.

Environment: `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`,
`COMPANION_GOLDEN_SNAPSHOT_ID`, `OPENCODE_VERSION` (pin, e.g. `1.17.13`),
`COMPANION_SECRETS_MASTER_KEY` (the same base64 32-byte root used with distinct AAD domains for the
vault, dedicated provider credentials, and opaque internal run credentials),
`COMPANION_RUNS_ENABLED`, `COMPANION_RUN_PREWARM_ENABLED` (defaults on with RunSkill),
`COMPANION_SANDBOX_REGION`, `COMPANION_SANDBOX_TIMEOUT_MS` (default `300000`),
`COMPANION_SANDBOX_VCPUS` (default `2`; supported `1`, `2`, `4`, `8`),
`COMPANION_SANDBOX_MINUTES_PER_SEAT` (managed SaaS default `250`),
`COMPANION_RUN_CONCURRENCY`, `COMPANION_RUN_PREWARM_CONCURRENCY`,
`COMPANION_RUN_CLAIM_INTERVAL_MS`, `COMPANION_RUN_LEASE_SECONDS`,
`COMPANION_RUN_HEARTBEAT_MS`, `COMPANION_RUN_INACTIVITY_MS`, bounded recorder reconnect settings,
`COMPANION_RUN_RECORDER_UNAVAILABLE_MS`, `COMPANION_SANDBOX_LIFECYCLE_V2`,
`COMPANION_SANDBOX_LIFECYCLE_V2_ORGS`, `COMPANION_SANDBOX_MAX_SESSION_MS` (10–60 minutes),
`COMPANION_RUN_EVENT_RETENTION_INTERVAL_MS`, `COMPANION_RUN_SWEEP_INTERVAL_MS`, S3 settings for
attachments/artifacts/packages. Event retention itself is
fixed at 24 hours after terminal state. The worker receives these settings. Keep the feature flag off
when Vercel/golden configuration is absent; only RunSkill is disabled, while API, web, billing,
provider settings, and vault still run. Disabling prewarming also prevents adoption of tickets issued
before the flag changed, so every run not yet committed immediately returns to the cold path.

Each activation uses an absolute deadline instead of a rolling lease.
`RunSandboxRuntime.observe` returns `running | stopped | missing` plus `expiresAt`;
`extendTimeout` extends only the remaining shortfall and returns a fresh observation. Provider
failures propagate, except not-found which normalizes to `missing`. A 60-second reconciler claims
stale runs without a live job lease or runs degraded for more than 60 seconds, observes outside
PostgreSQL, and applies results under an exact reconciliation lease, monotonic generation, and
activation-revision fence. The reconciliation lease is at least 105 seconds so up to three bounded
extension observations remain fenced. The same loop settles terminal runs whose usage session stayed
open after a transient settlement failure, independently of provider cleanup retention. A live worker
that recovers the recorder before completion changes the degraded predicate and makes the stale
provider response inapplicable.

Production API and worker processes use distinct `LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` roles,
with no table ownership or membership in the migration-owner role. The API service `DATABASE_URL`
uses the API role and the worker service `DATABASE_URL` uses the worker role.
`DATABASE_MIGRATION_URL` is available only to the API migration step; that step also receives
`DATABASE_API_ROLE` and `DATABASE_WORKER_ROLE` and applies
`packages/db/runtime-role-grants.sql` under the same advisory lock after every migration. The API
role owns creator-facing Project CRUD and pre-tenant discovery only. Project claim, lease entry,
heartbeat, removal, and cleanup functions are executable only by the worker role. Narrow boolean
worker-readiness probes are shared so the API can disable launches when no compatible worker is live.
`companion_project_exact_lease_visible` is shared because the creator-facing RLS row predicate calls
it internally; it returns only a boolean and cannot confer access without the server-issued exact
lease context. `DATABASE_RUNTIME_ROLE` remains a legacy union role for simple installs, not the
production topology. The grant hook rejects any API↔worker membership that permits `SET ROLE` and
revokes wrong-side function grants on every application, so reusing a former union-role name cannot
silently preserve worker authority. A split-role cutover may name the old login once through
`DATABASE_RETIRED_RUNTIME_ROLE`; the hook removes its current grants and the migration owner's
table/sequence default privileges before operators disable or drop that login. Organization creation
and domain joining generate/select an org id first, then
run under normal RLS with explicit tenant context. Running application processes as the table owner,
superuser, or a `BYPASSRLS` role invalidates the forced-RLS security boundary.

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
