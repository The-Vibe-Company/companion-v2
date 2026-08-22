# Companion v2 architecture — Skills Hub and optional Companions

This document describes the as-built Runtime v2 architecture. Companion is always a Skills Hub.
Behind the existing Companions feature gate, it also hosts named, persistent Box/Pi teammates
through a dedicated runtime service. The runtime is intentionally narrower than a generic agent
platform: one Companion is one Box, one Pi daemon, and one durable thread. The guarded final cutover
removed the legacy executor surface; it must not be reintroduced.

## System shape

```text
apps/web       Next.js Skills workspace, Companion threads, and settings
apps/api       REST/tRPC authorization and transactional intent persistence
apps/worker    GitHub sync, billing, Skill Database object cleanup, and Companion routines
apps/runtime   sole Box/Pi executor; durable claims, health, and lifecycle
cli            REST client for Skills Hub workflows

packages/contracts         shared Zod/API contracts
packages/db                Drizzle schema, forward migrations, RLS, role grants
packages/core              tenant/authz and domain services; no Next.js dependency
packages/skills            package parsing, validation, versioning
packages/skilldb           hosted SQLite execution for declared Skill Databases
packages/storage           archives, releases, images, logos, database objects
packages/github            GitHub App and deterministic repository writer
packages/box-runtime       ascii.dev adapter, layout-14 Pi broker, and default Pi package pins
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
- `companion_message_attachments` owns the files one transcript entry carries: `user_upload` for what
  a member sent, `pi_output` for an image Pi handed back, plus the content-addressed storage key,
  resolved content type, size, digest, sanitized filename, and position. Deleting a row journals its
  storage key into the durable object-deletion outbox in the same transaction, so an object cannot
  outlive the entry, the Companion, or the tenant.

All rows are org-scoped and force-RLS-enabled. API, worker, and runtime use distinct
`NOSUPERUSER NOBYPASSRLS NOINHERIT` roles. Runtime claims, renewals, checkpoints, and settlements use
narrow worker-style `SECURITY DEFINER` functions; it receives no general auth or tenant-data grant.
The API keeps RLS-scoped `SELECT` on `companions`, workspace access, member state, threads, and
transcript projections, but their `INSERT`, `UPDATE`, and `DELETE` paths exist only behind the
tenant- and actor-scoped `companion_api_*` capability functions. The worker has no hosted Companion
table access, including provider-connection or member-MCP metadata.

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
apply after its settlement and before the next turn. On a warm Box, configuration is published as
applied only after runtime stages the exact snapshot, restarts Pi, and observes a different idle Pi
invocation; takeover repeats those idempotent steps if their final observation was lost.

## Dedicated runtime execution

`apps/runtime` sweeps every two seconds, claims with a 30-second lease, renews every ten seconds,
and defaults to eight concurrent Companions. A completed execution interrupts only the scheduler's
recovery sleep so a start can hand its newly idle Pi directly to the queued turn. `/healthz` fails when PostgreSQL, the claim loop, or the
latest sweep is unhealthy.

Work precedence is permanent delete, explicit stop/restart, decision response, active attempt,
configuration apply, next queued turn, then health observation. Lifecycle calls that are known
idempotent retry network, `429`, and `5xx` failures up to five times with jittered
1/2/5/10/30-second backoff. Epoch predicates prevent an expired executor from committing after a
replacement claims the work, but database fencing never pretends to fence a provider side effect.

Box identity uses the generation-qualified name `Companion <id> g<generation>`. Known ids are read
and resumed directly; global discovery is reserved for absence, `404`, and ambiguous-create
reconciliation. Before create,
runtime searches every Box-list page for that exact name and adopts one canonical Box. Because the
public create request cannot set a name or supply an idempotency key, runtime issues one create with
a five-minute provisional TTL, checkpoints the acknowledged Box id, then applies the name and
six-hour TTL through an idempotent PATCH. An ambiguous create is interrupted and never replayed.
After naming, runtime lists again and permanently deletes duplicates. Permanent deletion is provider
operation tracking, not stop/archive.

Once Box accepts permanent deletion, runtime never sends that `DELETE` again. Each claim performs
one `GET /deletion-operations/{id}` after reauthorization. `completed` or provider `404` proves
absence and permits atomic removal of the Companion aggregate; `pending`, `processing`, `blocked`,
or an explicitly retryable GET failure atomically returns the same operation to `pending`, releases
its lease, and schedules another claim after 5, 15, 30, then at most 60 seconds based on the durable
attempt count. Invalid responses and non-retryable errors retain the normal expurgated terminal
failure. The protocol-versioned claim entrypoint prevents an older runtime from claiming these rows
during a rolling deploy.

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

Staging writes a composed operating brief to `~/.companion/runtime/state/instructions.txt` and Pi
receives it as `--append-system-prompt`. The brief describes the runtime contract Pi is held to —
the thread, the durable disk, turn bounds, tools, routines, triggers, and the ask/propose surface —
not how to speak.
The owner's persona remains one operator-authored line rather than a system prompt, and it is
appended last so it has the final word on voice.

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

PostgreSQL distinguishes the latest available selected-Skills revision from the minimum revision
required before dispatch. A publication advances only the available revision, so waking a Box
reuses its installed immutable version snapshot. Explicit selection and invalidation changes remain
blocking. User Stop, Restart Pi, Full Box restart, and settings apply stop Pi before atomically
replacing the tree. A failed publication update preserves the old tree and does not block lifecycle.

Every Companion may also call the Skills Hub API itself, with the same scopes: skills read/write,
secret reads, and Skill Database read/write. Access is unconditional, so no surface asks anyone to
choose it, neither creation nor settings carries a grant field, and Pi cannot propose one. Staging
mints a short-lived `source_type = 'companion'` token acting as the settings actor, injects it as
`COMPANION_DELEGATION_TOKEN` through the transient runtime channel, and rotates it on every stage.
Each request re-checks that the Companion still exists for that member, so deleting the Companion or
removing the member refuses it immediately; `/v1/companions*` remains cookie-only.

An attempt pins the exact provider and MCP credential revisions before prompt dispatch. A takeover
that observes a later revision interrupts an already-accepted attempt instead of interpreting
unprojected events with new credentials. A terminal projection already committed is read through a
separate fenced metadata-only function, then ACKed and settled without credential material. OAuth
refresh compare-and-swap is limited to pre-dispatch settings and operation staging. Staging records
the earliest bounded expiry across the Skills Hub token and selected OAuth access tokens. That
expiry becomes active only after a different idle Pi invocation is observed. A warm non-native send
dispatches directly only while the snapshot is bound to the current Pi invocation and has more than
two hours and five minutes remaining. Eligibility is checked both at enqueue and again under the
runtime lease immediately before claim; otherwise the ordinary `start` operation restages and
recycles Pi without a Full Box restart. Changing the observed invocation or minting a replacement
Hub token invalidates the old proof before another turn can use it.
Migration 0110 also versions the Runtime claim entrypoint. Replicas from before 0110 retain their
current lease but the legacy four-argument claim returns no new work after the migration commits.
The material-aware five-argument claimer repairs an expired legacy lease by rewinding any
post-staging operation or settings checkpoint that has no staged-expiry ledger, then restages under
the new fence. This prevents a rolling deploy from either publishing an unproven snapshot or
repeating proof-less start operations.
Projection
redaction uses every string leaf of the validated plaintext material in memory plus generic
credential patterns; tool projections retain metadata and an opaque hashed call id only, never
arguments or results, except a delegated `subagent` run, whose child-agent name, task, and latest
progress are redacted against the same dictionary and bounded before they are stored. Generic
scrubbing removes complete Authorization and Cookie header values
before narrower token/assignment matchers run. Redacted or oversized decision identifiers are
rejected fail-closed.

Persisted runtime failures contain a stable code, an expurgated message no longer than 500
characters, and an allowed next action. Provider response bodies, raw Pi lines, tokens, auth files,
signed URL queries, and multiline diagnostics never enter the database or user response.

## API and web contract

The feature gate requires both `COMPANION_COMPANIONS_ENABLED=true` and the existing non-empty exact
email-domain allowlist. Without both, routes and navigation are absent and runtime claims are off.

`POST /v1/companions/:id/messages` persists message plus turn and returns `202` without Box contact.
It also accepts multipart: up to five files of at most 10 MB each are stored under their content
address before the same transaction persists their rows, so an accepted turn always names files that
already exist. `GET /v1/companions/:id/attachments/:attachmentId` serves those bytes, re-authorizing
on every request and contacting only PostgreSQL and object storage. Thread reads add the active turn,
queued count, interruption state, and each entry's attachment metadata — never a storage key or URL. Existing lifecycle paths
persist operations and return `202`; decision answers are durable and runtime-delivered. Config
proposals (`kind: config` plus a bounded `proposal` object) dispatch to
`companion_api_answer_config_decision` after the route validates `model_id` against the provider
catalog. The web thread shows a dedicated config card that names the Companion as proposer, lists
diffs from already-loaded skill/plugin/model names, and keeps the card pending when apply fails.
New explicit recovery actions are:

- `POST /v1/companions/:id/turns/:turnId/retry` with a unique `retry_id`;
- `POST /v1/companions/:id/turns/:turnId/cancel` to stop an active turn, dequeue a follow-up, or
  release an interrupted turn.

`POST /v1/hooks/triggers/:triggerId/:secret` fires a webhook-fired Companion trigger — the
event-driven sibling of a routine. Like the Stripe webhook it is registered before session
middleware, gated on the feature flag, and capped at 1 MB; the URL secret is compared with
`timingSafeEqual`, and there is deliberately no per-provider HMAC because the sources are services
the user controls. The route only persists an ordinary turn as the immutable Companion Owner
through `companion_api_fire_trigger` and never contacts Box or Pi. A delivery id derived from
provider headers, or from the body hash, collapses redeliveries to one turn; disabled, throttled,
and pileup fires are skipped without enqueuing.

The web retains polling: three seconds while activity is present, slower when settled. There is no
SSE or Box push agent. “Companion is replying…” derives only from an acknowledged, non-terminal
attempt; the companion read model carries the same ACK-gated fact as `runtime.replying`, so roster
surfaces animate a working Companion without a thread read. Viewer/list/thread/status reads remain
PostgreSQL-only.

Each Companion carries a cosmetic blob icon — four smallint indexes (`icon_shape`, `icon_mouth`,
`icon_accessory`, `icon_color`) into fixed client-side catalogs rendered as inline SVG. Create and
update accept them; the update path treats them as cosmetic only, so an icon save never bumps a
settings revision or contacts Box. The web animates the icon from the same durable signal as
“Companion is replying…”, never from lifecycle guesses.

Desktop minting remains an Owner/Editor action that cannot wake Box. The API authorizes the member,
then calls a private runtime endpoint with a short-lived HMAC request. Runtime revalidates the
Companion and returns the fresh provider URL only after the current actor owns every selected
personal resource and applied settings/Skills revisions satisfy required state. A publication-only
Skills update may remain pending. This gate
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

The stacked rollout temporarily retained old runtime columns without backfilling them. The final
migration removes those columns together with every old executor, watermark, pool, reconciler,
mutating purge function, and legacy grant. The release process admits that migration only after
confirming there is no open P0/P1 runtime issue and the purge report is empty. The provider-operation
ledger remains owner-readable cutover evidence.

The feature flag remained disabled between purge and the asynchronous API/web cutover. Once v2 rows
exist, rollback uses the kill switch rather than a legacy binary; no legacy executor may process
them.

## Explicit exclusions

No generic Projects or skill runs, multi-Bot coordination, group Bot chat, handoffs, proactive jobs,
voice, file library, file versioning, artifact surface outside a thread, second harness, second Box
provider, Box pool, generic provider marketplace, container catalog, deployment manager, or AI app
builder. Bounded chat files, scheduled Companion routines, and webhook-fired Companion triggers are
in scope.
No SSE, Box-to-control-plane push agent, detached API executor, automatic Full Box recovery,
automatic ambiguous-prompt replay, or global learned model-capability table.

## Deployment

Self-hosted deployments run PostgreSQL, S3-compatible storage, email, API, worker, runtime, and web.
Only runtime receives `COMPANION_BOX_API_KEY`; its desktop endpoint binds a private network. API,
worker, and runtime use separate database credentials and least-privilege grants. Conductor and CI
must start the same four-process topology with the deterministic Box/Pi simulator where applicable.
The as-built operational sequence, including the owner-only gate transition and rollback boundary,
is documented in `docs/runbooks/companions-runtime.md`.

## Internal Box startup research

Box/Pi startup experiments are development tooling, not a Companion product surface. The
operator-launched `pnpm research:box-startup -- --overnight` command uses Conductor Cloud to create
isolated Luna candidate workspaces, then evaluates each validated commit from a controller-owned
disposable checkout under one serialized real-provider lease. A clean Sol workspace integrates only
measured compatible gains. Candidate workspaces have provider credentials explicitly shadowed. The
evaluator checkout runs under a separate unprivileged OS identity and receives only a short-lived
local proxy capability scoped to the campaign's exact Box and snapshot identities; the controller
retains the real provider credential and independently
proves provider readiness, byte-attested broker prompt acceptance, and resource absence. The proxy
exposes one newest ready layout-14 parent read-only for the baker, fails closed without an eligible
parent, and requires later Boxes to clone the deterministic target. Explicit non-2xx creates may retry
with the same source; fetch failures or invalid 2xx observations make the create ambiguous and block
the lease. It never runs from API, worker, web, or the
hosted Companion runtime, and adds no product orchestration feature.

The research evaluator and existing tests are immutable to candidate workspaces. Candidates may
challenge lifecycle ordering, including moving credential-free, revision-bound Skill preparation
to the Stop/archive path. Creation must remain correct without a preceding Stop, a sleeping
settings/Skill change must invalidate prepared state, and credentials must be expunged before every
snapshot. Disposable images are salted by the candidate Git tree and every Box/snapshot is deleted
and provider-absence proven before another lease is granted. A failed proof keeps the lease durably
blocked for controller-owned recovery on resume.
