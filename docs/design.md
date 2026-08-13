# Companion v2 architecture — Skills Hub and optional Companions

This document is the authoritative architecture. Companion is always a Skills Hub; behind the
`companions` flag it is also a control plane for Pi daemons that execute inside box.ascii.dev.

## System shape

```text
apps/web       Next.js Skills workspace and settings
apps/api       REST/tRPC gateway over shared services
apps/worker    GitHub sync, billing reconciliation, Skill Database object cleanup
cli            REST client for skill workflows

packages/contracts       shared Zod/API contracts
packages/db              Drizzle schema, forward migrations, RLS
packages/core            tenant/authz and domain services; no Next.js dependency
packages/skills          package parsing, validation, versioning
packages/skilldb         hosted SQLite execution for declared Skill Databases
packages/storage         archives, releases, images, logos, database objects
packages/github          GitHub App and deterministic repository writer
packages/auth            Better Auth
packages/billing         Stripe integration
packages/companion-skill bundled external-agent workflow
```

There is no Project/skill-run supervisor, model catalog, deployment reconciler, or runtime UI.
The API owns one Box HTTP adapter for the gated Companions lifecycle; Pi remains inside Box.

## Data model

Every tenant-owned row carries `org_id`. The current Drizzle schema in `packages/db/src/schema.ts` is the source of truth.

Core entities are organizations, users, memberships, invitations, skills, immutable skill versions/files, dependencies, installs, labels and personal labels, comments/images, public releases and transfer tickets, GitHub connections/destinations, skill-secret declarations/bindings/suggestions, encrypted secrets/versions/recipients, Skill Database declarations/realms/shares/object deletions, audit records, billing, tokens, onboarding/preferences, Agent Auth identities/grants, and gated Companion control-plane metadata plus encrypted workspace provider connections.

The forward migration `0063_skills_hub_only.sql` intentionally drops all historical Project, skill-run, sandbox-usage, model-provider, prompt, transcript, attachment, artifact, and runtime worker state. The cutover is fail-closed: its first statement refuses to drop ownership rows while Project workspaces, unsettled sandboxes, active usage, or S3-backed runtime metadata remain. Operators must quiesce the old release and drain or explicitly delete those external resources before upgrading. Because the release that owned the cleanup worker no longer exists, the one-shot `apps/api` `cutover` command performs that cleanup once: it reports every referenced object key and provider identity, deletes each object before removing the row that names it, and refuses to discard provider-backed rows without an explicit operator confirmation. Historical migrations remain immutable so already-migrated databases can upgrade safely.

## Authorization

Every service-layer decision combines:

1. membership in the exact organization;
2. the org-role capability;
3. resource ownership where applicable.

Organization skills are readable and manageable by every member. Personal skills are visible and manageable only by `creator_id`; Owner/Admin has no override. Personal Skill Database realms and personal labels use the same owner-private boundary. Cross-tenant access fails closed. Public release reads go only through purpose-built, checksum-bound public functions and tickets.

## Skills lifecycle

Packages are validated without executing scripts. Publication writes immutable version/file metadata, dependency edges, secret slots, database declarations, and an audit event. Share performs the only personal-to-org transition and includes required personal dependencies after an explicit plan. Install records are per member and do not copy skill rows.

Public release promotion pins one exact organization skill version and checksum. Upload/download transfer tickets are short-lived, purpose-specific, single-use where applicable, and revalidated at redemption. GitHub sync writes deterministic, digest-verifiable repository state.

## Secrets

Secret plaintext is accepted only on write/rotation, envelope-encrypted, and never returned by ordinary CRUD. Skill bindings refer to stable slots. External clients retrieve authorized values only through preflight plus short-lived, non-replayable grants. Logs and audit metadata remain value-free. The database usage helper counts active skill bindings only.

## Skill Databases

Skills may declare bounded SQLite tables. Core validates additive schema evolution and access, `packages/skilldb` executes parameterized statements, and object storage persists the realm with conditional generation checks. Organization realms are shared; personal realms are creator-private unless explicitly shared with a current member. The worker cleans queued database objects only.

## Delegated Agent Auth

Agent Auth connects an external coding agent to the Skills Hub. Tenant capabilities are limited to `skills:read`, `skills:write`, `database:read`, `database:write`, `secrets:read`, and `secrets:write`, each constrained to one exact workspace; `public-skills:install` remains instance-wide. This is client authorization, not an internal agent product. Host defaults cannot silently grant tenant capabilities, and transfer-ticket operations are separately registered and revalidated.

An authenticated Agent Auth identity may issue a short-lived child PAT only through the registered inheritance form. The server snapshots its active exact-workspace grants, expands database write to read, caps expiry at seven days and the earliest source expiry, and persists value-free source/target provenance. Request bodies cannot select scopes or another organization, PATs cannot mint or refresh child PATs, and target-bound tokens require the matching delegation-target header. This is bearer binding rather than runtime attestation: possession of both values remains sufficient until expiry or revocation.

## API, Companions, and fail-closed removal

The API exposes auth, organizations, skills, labels, dependencies, comments, files/versions, installs, public releases, GitHub, secrets, Skill Databases, billing, tokens, onboarding, and skill-facing Agent Auth. Historical Project, skill-run, prompt, attachment/artifact, and model-provider endpoints remain unregistered.

`COMPANION_COMPANIONS_ENABLED=true` additionally registers authenticated, tenant-scoped Companion
metadata, ACL, chat thread, provider, and Box/Pi lifecycle endpoints. List, detail, ACL,
thread, provider metadata, and default status reads use PostgreSQL only. A Companion Owner can
grant Editor or Viewer access to the workspace or individual current members; an individual grant
overrides the workspace default. Live status, start/stop, plugin injection, and desktop require
owner/editor access before the Box adapter is created, while provider and share management remain
owner-only. Each Companion owns exactly one chat thread. `companion_threads` carries its ordinal and
delivery watermarks and `companion_transcript_entries` carries its messages, so sending persists in
the control plane before any Box contact and an undelivered message stays pending until a later
owner/editor sync. Sync is the only path that reaches Pi: it delivers pending messages through the
owner-only FIFO and projects new Pi output from a recorded byte offset, which makes retries
idempotent. Every user message records its author, and the thread payload names the reading member,
so a thread shared with Editors attributes each message to the member who sent it. Viewers can read the control-plane thread but cannot send or contact Box. The default remains fail-closed: when
the flag is absent or false, none of these routes are registered. Owner/Admin-managed workspace
model-provider credentials are envelope-encrypted, write-only, and decrypted only after the
Companion wake guard. Start never accepts caller-supplied model-provider credentials; it writes only
the selected provider's Pi auth entry to the owner-only Box auth file.
Owner/editor web and mobile-web starts resolve the actor's valid Installed library and expose those
packages through Pi's explicit native Skills source. Native-mobile starts always replace that source
with an empty tree. Member-private labeled MCP accounts are translated into an isolated
`pi-mcp-adapter` config; durable Box JSON contains environment references only. Connector values are
write-only and envelope-encrypted in PostgreSQL, then decrypted after the runtime guard and passed
through the transient `mcp_credentials` channel. Native mobile receives no MCP accounts. Viewer
authorization completes before skill storage, connector decryption, or Box is contacted.

The web has no `/projects` route and no Run/Session state in the Skills URL grammar. Old query parameters are ignored and canonical navigation returns to the Skills detail. By default the only product workspace navigation is Skills. The same `COMPANION_COMPANIONS_ENABLED` server-side flag exposes an authenticated `/companions` list/create shell, the 1:1 chat thread it opens into, plus the Skills | Companions sidebar mode segment that reaches it; with the flag off neither the route nor the segment exists. Opening a Companion replaces the list with its thread and deep-links through a `companion` search parameter. The web and mobile-web list also opens a separate Plugins surface for member-private labeled MCP accounts; native mobile has no Plugins surface. The thread shows only the conversation and, for a runner whose Box is asleep, one Wake control; Pi tools, Skills, plugins, and desktop chrome stay out of it, and a Viewer gets the transcript with no composer. A Companion carries an optional persona of at most 280 characters, stored as one descriptive line and never as a system prompt. Creation asks for the name, that persona, and one compact picker over connected Claude, Codex, and z.ai providers defaulting to the workspace default. Native mobile clients get the Companion list and its thread only; Skills and Plugins management stay on web and mobile web. Pi/Box controls, provider catalogs, and desktop chrome remain invisible.

Pi sessions, RPC events, and logs live only under `~/.companion/runtime` on snapshotted Box disk.
PostgreSQL stores Box id and last-observed lifecycle metadata so list/open never wakes Box. Desktop
URLs are secret-bearing response-only values. See `docs/companions-runtime.md`.

## Process and database roles

The API and worker use distinct `NOSUPERUSER NOBYPASSRLS NOINHERIT` roles in production. `runtime-role-grants.sql` grants the API narrow pre-tenant/public/skill functions and grants the worker only billing, GitHub sync, and Skill Database cleanup functions. No runtime execution function or table grant remains.

## Deployment

Self-hosted development runs PostgreSQL, S3-compatible storage, and email plus API, worker, and web.
The API needs a Box service key only when Companions lifecycle is enabled; the worker needs no Box,
Vercel, OpenCode, or model-provider credentials. ascii.dev hosts the deployed control plane. Conductor
runs native per-workspace PostgreSQL with optional MinIO/Mailpit as documented in `CLAUDE.md`.
