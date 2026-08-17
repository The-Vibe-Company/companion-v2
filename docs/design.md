# Companion v2 architecture — Skills Hub and optional Companions

This document is the authoritative Runtime v2 target architecture for the stacked rollout.
Companion is always a Skills Hub. Behind the existing Companions feature gate, it also hosts named,
persistent Box/Pi teammates through a dedicated runtime service. The runtime is intentionally
narrower than a generic agent platform: one Companion is one Box, one Pi daemon, and one durable
thread. Until the cutover PR completes, legacy code may remain for deployability but must not expand
its product surface or be treated as the target design.

## System shape

```text
apps/web       Next.js Skills workspace, Companion threads, and settings
apps/api       REST/tRPC authorization and transactional intent persistence
apps/worker    GitHub sync, billing, and Skill Database object cleanup
apps/runtime   sole Box/Pi executor; durable claims, health, and lifecycle
cli            REST client for Skills Hub workflows

packages/contracts         shared Zod/API contracts
packages/db                Drizzle schema, forward migrations, RLS, role grants
packages/core              tenant/authz and domain services; no Next.js dependency
packages/skills            package parsing, validation, versioning
packages/skilldb           hosted SQLite execution for declared Skill Databases
packages/storage           archives, releases, images, logos, database objects
packages/github            GitHub App and deterministic repository writer
packages/box-runtime       ascii.dev adapter and layout-14 Pi broker installer
packages/companion-runtime runtime state machine and operation execution
packages/companion-skill   bundled delegated Skills Hub workflow
```

The API never contacts Box or Pi. It authorizes, persists a message/turn, decision, settings change,
or lifecycle operation, and responds. `apps/runtime` is the only process with the Box service key
and the only owner of runtime leases or external lifecycle side effects. The worker remains limited
to billing, GitHub, and Skill Database cleanup.

## Tenancy and authorization

Every tenant-owned row carries `org_id`; `packages/db/src/schema.ts` is the data source of truth.
Every service decision combines exact-organization membership, org-role capability, and resource
ownership/ACL. Forced RLS is defense in depth, not a substitute for service authorization.

Organization skills are member-wide. Personal skills, personal labels, personal Skill Database
realms, and member MCP accounts are creator-only with no Owner/Admin override. Cross-tenant access
fails closed.

A Companion has one immutable Owner and optional workspace-wide Editor or Viewer access. Owner and
Editor may send and operate it; only Owner manages sharing and permanent deletion. Viewer reads
PostgreSQL projections only. Authorization and current resource access are re-evaluated by runtime
immediately before Box contact, so membership or ACL revocation cannot be hidden in a queued turn.

## Skills Hub

Packages are validated without executing scripts. Publication writes immutable version/file
metadata, dependency edges, secret slots, database declarations, and an audit event. Share performs
the only personal-to-org transition and includes required private dependencies after an explicit
plan. Install records are per member and do not copy skill rows.

Public release promotion pins one exact organization skill version and checksum. Upload/download
transfer tickets are short-lived, purpose-specific, non-replayable where required, and revalidated
at redemption. GitHub sync writes deterministic, digest-verifiable repository state.

Skills may declare bounded SQLite tables. Core validates additive schema evolution and access,
`packages/skilldb` executes parameterized statements, and object storage persists realms with
conditional generation checks. The worker cleans queued database objects only.

## Secrets and delegated Agent Auth

Secret plaintext is accepted only on write or rotation, envelope-encrypted, and never returned by
ordinary CRUD. Skill bindings refer to stable slots. External clients retrieve authorized values
only through preflight and short-lived, non-replayable grants. Logs and audit metadata remain
value-free.

Agent Auth connects external coding agents to the Skills Hub. Tenant capabilities are limited to
skill, Skill Database, and skill-secret operations constrained to one exact workspace;
`public-skills:install` remains instance-wide. Agent Auth never grants Companion chat, provider,
desktop, or lifecycle access.

An Agent Auth child PAT snapshots only active exact-workspace grants, caps expiry at seven days and
the earliest source expiry, and stores value-free provenance. Callers cannot choose scopes or
organizations, PATs cannot mint child PATs, and a target-bound token requires the matching declared
target. Possession remains bearer authority until expiry or revocation.

## Runtime v2 write model

Runtime state is explicit and durable:

- `companion_runtime_instances` owns generation, canonical Box id, observed Box/Pi state, layout,
  invocation id, and applied configuration revision.
- `companion_turns` owns `client_message_id`, initiating actor/surface, queue state, inactivity and
  absolute deadlines, and one stable expurgated error.
- `companion_turn_attempts` owns explicit retry identity, Pi invocation, dispatch/acknowledgement,
  correlated event cursor, and outcome.
- `companion_operations` owns start, stop, Pi restart, Box restart, settings apply, and delete intent
  plus checkpoints. Multiple operations may wait; one may run per Companion.
- `companion_runtime_leases` owns the claim token, attempt epoch, executor id, and expiry used to
  fence every checkpoint and settlement.

All rows are org-scoped and force-RLS-enabled. API, worker, and runtime use distinct
`NOSUPERUSER NOBYPASSRLS NOINHERIT` roles. Runtime claims, renewals, checkpoints, and settlements use
narrow worker-style `SECURITY DEFINER` functions; it receives no general auth or tenant-data grant.

One `(companion_id, client_message_id)` produces exactly one turn. The transaction that stores the
user message also stores that turn. A duplicate POST resolves to the same row. A retry names a new
`retry_id` and creates a new attempt on the same turn; it never reuses `client_message_id` as an
execution identity.

Turn states are:

```text
queued → starting → dispatching → running ↔ needs_input
                                      └→ succeeded | failed | interrupted | cancelled
```

Only one attempt is active per Companion. Later turns remain queued in durable order. An interrupted
turn blocks the queue until Owner/Editor Retry or Cancel. Settings revisions accepted during a turn
apply after its settlement and before the next turn.

## Dedicated runtime execution

`apps/runtime` sweeps every two seconds, claims with a 30-second lease, renews every ten seconds,
and defaults to eight concurrent Companions. `/healthz` fails when PostgreSQL, the claim loop, or the
latest sweep is unhealthy.

Work precedence is permanent delete, explicit stop/restart, decision response, active attempt,
configuration apply, next queued turn, then health observation. Lifecycle calls that are known
idempotent retry network, `429`, and `5xx` failures up to five times with jittered
1/2/5/10/30-second backoff. Epoch predicates prevent an expired executor from committing after a
replacement claims the work, but database fencing never pretends to fence a provider side effect.

Box identity uses the generation-qualified name `Companion <id> g<generation>`. Before create,
runtime searches every Box-list page for that exact name and adopts one canonical Box. Because the
public create request cannot set a name or supply an idempotency key, runtime issues one create with
a five-minute provisional TTL, checkpoints the acknowledged Box id, then applies the name and
six-hour TTL through an idempotent PATCH. An ambiguous create is interrupted and never replayed.
After naming, runtime lists again and permanently deletes duplicates. Permanent deletion is provider
operation tracking, not stop/archive.

After a prompt may have been written, loss of acknowledgement is ambiguous: the attempt becomes
`interrupted`, no automatic replay occurs, and later turns remain blocked. A proven negative ACK may
be retried. Retry warns that an earlier external effect may have succeeded; Cancel explicitly
accepts that uncertainty and releases the queue.

Disabling the existing Companions flag blocks new claims. Active work reaches a safe checkpoint and
becomes interrupted. This kill switch is the operational rollback after v2 data exists; a legacy
executor must never process v2 rows.

A normal runtime process shutdown is a replica handoff, not that kill switch. It stops new claims
and local lease renewal without settling active work; the next replica takes over after lease expiry.

## Box and Pi boundary

box.ascii.dev is the only runtime provider and Pi the only agent harness. Runtime creates/resumes the
Box, installs the controlled disk layout, injects authorized resources, and owns stop/restart/delete.
Pi sessions and work files stay on snapshotted Box disk. PostgreSQL stores the durable transcript and
execution projection needed for no-wake reads.

Layout 14 installs a small Node broker under systemd between runtime commands and Pi:

- an owner-only Unix socket (`0600`) carries correlated `get_state`, `prompt`, and decision commands;
- a segmented, monotonic event journal survives consumer restart and advances only through explicit
  acknowledgement;
- the broker binds the sole active attempt to events through `agent_settled` and records Pi process
  exit separately;
- malformed or oversized lines advance without persisting their raw content;
- unknown event types are counted and ignored rather than treated as user-fatal errors.

Before `prompt`, runtime requires a correlated `get_state` response showing idle Pi and no queued
messages. It omits Pi `streamingBehavior`, so a race is refused rather than hidden as a follow-up.
Only explicitly supported terminal event shapes settle a turn.

Runtime projects an event batch and its monotonic cursor atomically. Supported settlement and
process-exit events also persist their terminal checkpoint in that transaction; broker
acknowledgement happens only after commit. A takeover first acknowledges any already-durable
terminal cursor, then settles from the checkpoint, which makes replay safe across the projection,
acknowledgement, and settlement crash boundaries.

Pi catalog normalization preserves the model `input` capabilities. Image work sent to a text-only
model fails explicitly with a stable capability error. Capability data comes from Pi's catalog or a
bounded bundled fallback; there is no global learned capability table.

## Resources and credentials

Web and mobile-web starts resolve the actor's currently accessible selected Skills and member MCP
accounts. Runtime revalidates every id before staging. Empty selection means no library Skills or
member MCP pins; the bundled Companion skill remains the Skills Hub bridge. Native mobile receives
neither source. Companion ownership is not a resource-access fallback: an Editor cannot stage an
Owner's personal Skill or MCP account, and an Owner cannot stage an Editor's. A cross-actor decision
is deliverable only when both actors can access the attempt's resources.

Provider connections and member MCP accounts are workspace/member-scoped, envelope-encrypted, and
write-only. Runtime decrypts only the selected values after authorization. Durable Box config uses
references where possible; transient connector values use the owner-only runtime channel and never
appear in logs, API responses, audit metadata, or projections. The provider auth file remains on
Box disk only where Pi must refresh it.

An attempt pins the exact provider and MCP credential revisions before prompt dispatch. A takeover
that observes a later revision interrupts an already-accepted attempt instead of interpreting
unprojected events with new credentials. A terminal projection already committed is read through a
separate fenced metadata-only function, then ACKed and settled without credential material. OAuth
refresh compare-and-swap is limited to pre-dispatch settings and operation staging. Projection
redaction uses every string leaf of the validated plaintext material in memory plus generic
credential patterns; tool projections retain metadata and an opaque hashed call id only, never
arguments or results. Generic scrubbing removes complete Authorization and Cookie header values
before narrower token/assignment matchers run. Redacted or oversized decision identifiers are
rejected fail-closed.

Persisted runtime failures contain a stable code, an expurgated message no longer than 500
characters, and an allowed next action. Provider response bodies, raw Pi lines, tokens, auth files,
signed URL queries, and multiline diagnostics never enter the database or user response.

## API and web contract

The feature gate requires both `COMPANION_COMPANIONS_ENABLED=true` and the existing non-empty exact
email-domain allowlist. Without both, routes and navigation are absent and runtime claims are off.

`POST /v1/companions/:id/messages` persists message plus turn and returns `202` without Box contact.
Thread reads add the active turn, queued count, and interruption state. Existing lifecycle paths
persist operations and return `202`; decision answers are durable and runtime-delivered. New explicit
actions are:

- `POST /v1/companions/:id/turns/:turnId/retry` with a unique `retry_id`;
- `POST /v1/companions/:id/turns/:turnId/cancel` for an interrupted turn.

The web retains polling: three seconds while activity is present, slower when settled. There is no
SSE or Box push agent. “Companion is replying…” derives only from an acknowledged, non-terminal
attempt. Viewer/list/thread/status reads remain PostgreSQL-only.

Desktop minting remains an Owner/Editor action that cannot wake Box. The API authorizes the member,
then calls a private runtime endpoint with a short-lived HMAC request. Runtime revalidates the
Companion and returns the fresh provider URL only after the current actor owns every selected
personal resource and the applied settings/Skills revisions exactly match desired state. This gate
keeps a warm Box unavailable during a cross-actor restage. Each authenticated request id is
atomically consumed through a narrow `SECURITY DEFINER` function and retained in PostgreSQL until
its signature window expires, so replicas and restarted processes share one replay boundary;
neither process persists or logs the URL.

Sending is the sole normal wake path. There is no Wake button or first-keystroke prewarm. Successful
Pi acceptance refreshes Box TTL to six hours. Automatic recovery may recycle Pi only. Full Box
restart requires explicit confirmation, and permanent delete is cleanup rather than healing.

## Legacy purge and rollout

Runtime v2 does not backfill legacy ordinals, transcripts, Companions, or Boxes. Before cutover, an
operator runs a one-shot command in report, dry-run, then
`purge --confirm-delete-all-companions` mode with the feature flag disabled and an advisory lock.

The purge inventories DB `box_id` ownership and exact legacy naming formats, prints the targets,
requests permanent Box deletion, records the provider operation id, and waits for completion. A
provider `404` means already deleted; every other error blocks cutover. Only after external deletion
is confirmed may PostgreSQL remove legacy Companions, pools, shares, member state, threads,
transcripts, and leases. Provider connections, MCP accounts, Skills, secrets, organizations, users,
billing, and audit rows survive.

Old runtime columns may remain temporarily only to keep each stacked PR deployable. They receive no
history backfill and are removed with every old executor, watermark, pool, reconciler, function, and
grant after seven green canary days, no open P0/P1 runtime issue, and an empty purge report.

The feature flag stays disabled between purge and the asynchronous API/web cutover. Schema and
runtime-service layers in that interval are deployable only as a fenced, non-activatable rollout;
the legacy executor must not be re-enabled against v2 rows. Once cut over, rollback uses the kill
switch rather than a legacy binary.

## Explicit exclusions

No generic Projects or skill runs, multi-Bot coordination, group Bot chat, handoffs, routines,
schedules, proactive jobs, voice, thread attachments/artifacts, second harness, second Box provider,
Box pool, generic provider marketplace, container catalog, deployment manager, or AI app builder.
No SSE, Box-to-control-plane push agent, detached API executor, automatic Full Box recovery,
automatic ambiguous-prompt replay, or global learned model-capability table.

## Deployment

Self-hosted deployments run PostgreSQL, S3-compatible storage, email, API, worker, runtime, and web.
Only runtime receives `COMPANION_BOX_API_KEY`; its desktop endpoint binds a private network. API,
worker, and runtime use separate database credentials and least-privilege grants. Conductor and CI
must start the same four-process topology with the deterministic Box/Pi simulator where applicable.
