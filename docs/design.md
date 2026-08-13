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
metadata, ACL, chat thread, provider, and Box/Pi lifecycle endpoints. A required
`COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS` exact-domain allowlist is also required before routes
are registered. An unset or empty allowlist keeps Companions disabled even when the master flag is
true. Once enabled, the allowlist gates every endpoint after authentication and before tenant
resolution; missing or malformed emails fail closed.
List, detail, ACL,
thread, provider metadata, and default status reads use PostgreSQL only. Companion sharing is
workspace-only: a Companion Owner grants Editor or Viewer access to the whole workspace, or keeps it
private. There are no per-member grants and no email invites, and authorization ignores any legacy
member-grant row so a stale grant can never open a Companion. Live status, start/stop, plugin
injection, and desktop require owner/editor access before the Box adapter is created, while provider
and share management remain owner-only. Each Companion owns exactly one chat thread. `companion_threads` carries its ordinal and
delivery watermarks and `companion_transcript_entries` carries its messages, so sending persists in
the control plane before any Box contact and an undelivered message stays pending for the same
idempotent send to retry. An Owner/Editor send uses a lightweight runtime observation to deliver
directly when Box and Pi are already running; otherwise it starts the Companion through the same lifecycle path as Wake, so an
archived Box resumes and a stopped Pi starts without making the common online path claim or inject
anything. One send is one turn: the sender names the message it is creating with a
`client_message_id` UUID that becomes the entry's event id, so the transcript's
`(companion_id, event_id)` primary key decides how many turns a send produces and the same send
arriving twice — retried, replayed by a proxy, submitted twice — resolves to the turn already stored
rather than persisting a second one. Because that message is then no longer pending it is never handed
to Pi again either, so a replayed send cannot produce a second reply. Sent messages and projected Pi
output keep separate event-id namespaces, so a sender can never name an entry the Pi log will claim.
Send and sync reach Pi through its owner-only FIFO, while sync also projects new Pi output from a
recorded byte offset. A send that Pi accepts refreshes the Box TTL to six hours, so idle is measured
from the last successful message rather than the last wake. Every user message records its author,
and the thread payload names the reading member,
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
through the transient `mcp_credentials` channel. Their staged disk file is moved into the Box user
runtime tmpfs: systemd can reread it when Pi auto-restarts, while Box stop/reboot destroys it and
cannot snapshot it. Native mobile receives no MCP accounts. Viewer
authorization completes before skill storage, connector decryption, or Box is contacted.

The web has no `/projects` route and no Run/Session state in the Skills URL grammar. Old query parameters are ignored and canonical navigation returns to the Skills detail. By default the only product workspace navigation is Skills. The `COMPANION_COMPANIONS_ENABLED` server-side flag plus a non-empty email-domain allowlist expose an authenticated `/companions` list/create shell, the 1:1 chat thread it opens into, plus the Skills | Companions sidebar mode segment that reaches it; without either setting neither the route nor the segment exists. The route and segment are also absent for authenticated users without a matching email. Opening a Companion replaces the list with its thread and deep-links through a `companion` search parameter. The web and mobile-web list also opens a separate Plugins surface for member-private labeled MCP accounts; native mobile has no Plugins surface. That surface browses the official MCP registry (`registry.modelcontextprotocol.io`): the browser never calls the zero-SLA registry directly, so the API proxies and caches its list/search/detail reads with a ~1h TTL and a last-good fallback, drops `deleted`/`deprecated` entries, and applies curated pin overrides (Linear, GitHub, Notion) that stay available even when the registry is down. Connecting a registry server reuses the THE-321 `saveCompanionPlugin` path — the registry only supplies the provider slug, transport, endpoint, and the credential it describes, while the required account label and any secret are entered by the member — so the same server can be connected under several labels and a duplicate label still fails closed. Registry browse is gated by the same flag and email-domain allowlist as the rest of Companions and needs no tenant row. The thread shows the conversation, one Box status chip, and, for a runner whose Box is asleep, one Wake control; Pi tools, Skills, plugins, and desktop panels stay out of it, and a Viewer gets the transcript with no composer. That conversation and its composer are rendered with the `@assistant-ui/react` Thread, Message, and Composer primitives over an ExternalStore runtime whose only source is the control-plane thread payload and whose only write is the existing `POST /v1/companions/:id/messages` call, so persistence, delivery, and the Owner/Editor boundary stay where they already are: no assistant-ui Cloud, history, thread list, tool, attachment, or generative-UI surface is wired up, and the runtime has nothing of its own to contact, so rendering a Viewer's thread still reaches no Box. The composer keeps a refused message's text, a message appears in the transcript as soon as it is sent already carrying the event id the control plane will store it under — so the saved entry replaces it rather than joining it even if a thread read lands mid-send — and a second submit while one send is in flight is a no-op. The chip is the whole compute surface: it reads `Box · online`, `Box · starting`, `Box · asleep`, or `Box · error`, a runner whose Box is already running clicks it to open the Box desktop Lux drives in a new tab, and for a Viewer it is text only. A runner's open thread re-observes its running Box on a slow interval so the chip cannot go stale; a Viewer's chip stays on the control-plane projection, so neither reading a thread nor reading a status can wake a Box. Because a send can wake this Companion, a settled send re-reads that same control-plane projection, so the chip, the Wake control, the composer footer, and the cadence that projects Pi's reply all leave the pre-send state together rather than waiting for a reload; the footer reads the projected state the chip reads, so a woken Companion's saved messages are reported as waiting for a reply or as waiting on a Companion that is coming up instead of offering a wake that already happened, and a Viewer's footer stays the read-only line. A Companion carries an optional persona of at most 280 characters, stored as one descriptive line and never as a system prompt. Creation asks for the name, that persona, and one compact picker over connected Claude, Codex, and z.ai providers defaulting to the workspace default. Native mobile clients get the Companion list and its thread only; Skills and Plugins management stay on web and mobile web. Pi/Box controls, provider catalogs, and desktop chrome remain invisible.

A failed start or stop records one sanitized line in `companions.last_error` beside the `error`
state and returns that same line, so an `Error` status is never a bare word: the thread explains it,
the list carries it on the status pill, and a reload still shows the reason. Only recognized
configuration, Box, Pi, provider, and lifecycle failures explain themselves; anything else stores a
generic line, and credential-shaped text, signed URL query strings, and every line after the first
are removed. Owner and Editor read the recorded reason. A Viewer reads a generic unavailable line
instead, because an operator hint such as a missing `COMPANION_BOX_API_KEY` would only invite a
reader who cannot run Box to try. Any lifecycle write that leaves `error`, including the claim a
retry takes, clears the line.

Pi sessions, RPC events, and logs live only under `~/.companion/runtime` on snapshotted Box disk.
PostgreSQL stores Box id and last-observed lifecycle metadata so list/open never wakes Box. A start
whose assigned Box failed Pi setup, reached its terminal error state, or no longer exists retires
that Box and provisions a replacement, and a start also clears the start-limit failure systemd
latches onto a unit that crash-looped, so no Companion becomes permanently un-wakeable. The daemon
wrapper records its own failures in the log that reason is read from, so a start that dies before Pi
runs still names itself rather than reporting only an exit status. A warm start whose current-layout
unit is already active with its runtime credential file returns without resource injection or a
systemd start; all other starts use idempotent `systemctl start`, never restart an active Pi. Desktop
URLs are secret-bearing response-only values. See `docs/companions-runtime.md`.

## Process and database roles

The API and worker use distinct `NOSUPERUSER NOBYPASSRLS NOINHERIT` roles in production. `runtime-role-grants.sql` grants the API narrow pre-tenant/public/skill functions and grants the worker only billing, GitHub sync, and Skill Database cleanup functions. No runtime execution function or table grant remains.

## Deployment

Self-hosted development runs PostgreSQL, S3-compatible storage, and email plus API, worker, and web.
The API needs a Box service key only when Companions lifecycle is enabled; the worker needs no Box,
Vercel, OpenCode, or model-provider credentials. ascii.dev hosts the deployed control plane. Conductor
runs native per-workspace PostgreSQL with optional MinIO/Mailpit as documented in `CLAUDE.md`.
