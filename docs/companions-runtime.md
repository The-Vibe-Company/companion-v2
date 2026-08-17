# Companions Runtime v2

This document is the normative Runtime v2 Box/Pi contract for the stacked rollout. Companion remains
a Skills Hub at its core; the optional Companions surface adds one bounded hosted shape. Legacy
orchestration may remain temporarily until cutover, but it is not the contract described here:

```text
1 Companion = 1 durable thread = 1 persistent Box = 1 Pi daemon
```

Pi is the only agent harness. box.ascii.dev is the only Box provider. The product does not expose a
harness selector, Box marketplace, generic deployment surface, or multi-Bot orchestration.

## Ownership boundary

The process boundary is strict:

| Process | Runtime responsibility | Box/Pi access |
|---|---|---|
| `apps/web` | Render durable state; submit user intent | Never |
| `apps/api` | Authenticate, authorize, persist intent, return `202` | Never |
| `apps/worker` | Billing, GitHub, Skill Database cleanup | Never |
| `apps/runtime` | Claim, execute, observe, checkpoint, and settle runtime work | Sole owner |

Only `apps/runtime` receives the Box service key. API, worker, and runtime use distinct PostgreSQL
roles. Runtime has no broad tenant access: narrow `SECURITY DEFINER` functions claim, renew,
checkpoint, and settle work under forced RLS and attempt-epoch fencing.

The browser is never a watchdog. Closing it, killing the API after its response, or losing one
runtime replica does not abandon accepted work.

## Feature gate and kill switch

The surface requires both:

- `COMPANION_COMPANIONS_ENABLED=true`;
- a non-empty `COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS` exact-domain allowlist.

Without both, navigation and routes fail closed. Runtime also stops taking new claims. Active work
may advance only to its next safe checkpoint and is then settled `interrupted`; it is not silently
replayed after re-enable.

The flag is the operational kill switch and rollback once v2 rows exist. A legacy API or worker must
never execute them. The flag is not a mechanism for enabling excluded harness, provider, deployment,
routine, schedule, or multi-Bot surfaces.

SIGTERM or an ordinary runtime service shutdown is instead a replica handoff. The process stops new
claims and local I/O, does not settle or release already-active work, and stops renewing those leases
so another replica can take over after expiry. A claim returned by PostgreSQL but not yet handed to
the engine is safe to release immediately. This path never substitutes for the feature-gate kill
switch, which still explicitly interrupts active work.

During the stacked deployment, the flag remains disabled from the destructive purge through the
runtime-service layer. Those intermediate binaries install the fenced v2 schema but are not an
activatable mixed-protocol release. The flag may be re-enabled only once the asynchronous API/web
cutover is deployed; rollback after that point means disabling claims, never sending v2 rows back to
the legacy executor.

## Durable data model

All runtime rows carry `org_id`, force RLS, and use foreign keys/cascades that preserve external
cleanup ownership until the provider side effect is confirmed.

### Runtime instance

`companion_runtime_instances` is the one current execution projection per Companion. It stores:

- runtime generation and canonical `box_id`;
- observed Box state and Pi daemon state;
- installed disk-layout version and applied settings/skills revision;
- current Pi invocation id and last successful observation;
- lifecycle-safe deletion/retirement metadata.

This projection is not a lease and cannot authorize work. List, thread, ordinary status, and Viewer
reads consume it without contacting Box.

### Turn

`companion_turns` stores one logical user request:

- unique `(companion_id, client_message_id)`;
- initiating `actor_id` and client surface;
- ordered queue position and durable state;
- inactivity and absolute deadlines;
- current attempt reference and terminal outcome;
- stable error code, expurgated message (maximum 500 characters), and allowed next action.

The user transcript message and turn are inserted in one transaction. Repeating the same POST returns
the existing turn and never produces a second Pi attempt merely because a proxy or client retried.

The state machine is:

```text
queued → starting → dispatching → running ↔ needs_input
                                      └→ succeeded | failed | interrupted | cancelled
```

Only one turn attempt may be active per Companion. Later turns remain queued in PostgreSQL.
`interrupted` blocks that queue until an Owner/Editor chooses Retry or Cancel.

### Attempt

`companion_turn_attempts` stores one execution try:

- unique `retry_id` for an explicit retry;
- runtime claim epoch and Pi invocation id;
- dispatch-started and acknowledgement facts;
- correlated event-journal cursor and activity timestamp;
- terminal result and expurgated error.

The initial attempt is created by runtime when it claims the turn. Retry creates a new attempt on the
same turn with a new `retry_id`; it never reuses `client_message_id` as an attempt key.

### Operation

`companion_operations` stores lifecycle intent for start, stop, restart Pi, restart Box, settings
apply, and permanent delete. Multiple operations may be `pending`; a partial uniqueness constraint
allows only one `running` operation per Companion. Checkpoints make idempotent provider work
resumable without pretending external side effects are transactional.

Work precedence is:

1. permanent delete;
2. explicit stop or restart;
3. durable answer to `ask_user`;
4. current active turn attempt;
5. pending configuration apply;
6. next queued turn;
7. health observation.

### Lease

`companion_runtime_leases` stores claim token, epoch, executor id, and expiration. Runtime sweeps
every two seconds, claims for 30 seconds, and renews every ten seconds. Eight Companions may execute
concurrently by default.

Every checkpoint and terminal update includes the exact token and epoch in its predicate. Once a
lease expires, its old holder cannot commit database progress. Provider calls are not fenceable, so
the engine combines epoch fencing with deterministic Box identity, provider idempotence where
available, and explicit interruption when prompt delivery is ambiguous.

## Send, wake, and queue behavior

`POST /v1/companions/:id/messages` performs only:

1. authenticate and authorize Owner/Editor;
2. validate `client_message_id` and input;
3. insert or resolve the durable transcript message and turn in one transaction;
4. return the turn and `202`.

It never creates a Box, observes Pi, opens a runtime lease, or waits for delivery. The expected HTTP
acknowledgement is under one second outside load; runtime should claim new work within five seconds.

Sending is the sole normal wake path. There is no Wake button and no first-keystroke prewarm. A cold
send moves through durable start/dispatch checkpoints and finishes or fails explicitly within three
minutes. A successful Pi prompt acknowledgement refreshes the Box TTL to six hours.

Before every Box interaction, runtime re-evaluates:

- current organization membership and Companion Owner/Editor ACL;
- provider connection and selected model;
- selected accessible Skills and `can_write_skills` policy;
- selected MCP accounts still owned and connected by the actor performing the Box interaction;
- the latest settings revision.

The immutable Companion Owner is never a fallback resource owner for an Editor. A decision delivery
requires both the turn actor and the responder to retain access to every personal resource used by
the attempt. Revocation fails closed before secrets are decrypted or Box is contacted. A settings
change accepted while a turn is active waits until that turn settles, then applies before the next
turn.

## Box lifecycle

Box identity is generation-qualified:

```text
Companion <companion-id> g<runtime-generation>
```

Before create, runtime searches every provider list page for the exact name. It chooses one canonical
Box and permanently deletes duplicates. The public Box create contract cannot assign that name and
has no idempotency key: runtime therefore writes `creating_box`, performs exactly one `POST /boxes`
with a five-minute provisional TTL, and never retries an ambiguous result. A positive `202` exposes
the provider id; runtime checkpoints that id before an idempotent `PATCH` applies the deterministic
name and six-hour TTL. It then lists again, chooses the canonical id, and durably deletes duplicates.

A transport loss around the create POST is irreducibly ambiguous under the provider's current
public contract. It interrupts the operation explicitly and may leave one unnamed Box which
auto-archives after the provisional TTL; runtime never guesses its id from account-wide list order
and never creates a second Box automatically. Operators must keep the real-provider canary and
orphan inventory enabled until the provider offers a create idempotency key or client-supplied name.
An exact-name Box discovered after any acknowledged create is always adopted and permanently
deleted before retirement.

Known-idempotent lifecycle calls retry network failures, `429`, and `5xx` responses up to five times
with jittered backoff of 1, 2, 5, 10, and 30 seconds. A provider operation id is retained whenever
the API returns one.

Stop snapshots/archives the Box. A later send queues wake after stop reaches a safe archive
checkpoint; it does not race Pi start against an in-flight archive. Restart Pi keeps the Box and
replaces only the daemon invocation. Full Box restart is never automatic and requires explicit
Owner/Editor confirmation because it interrupts all Box work. Permanent delete is Owner-only
cleanup, never healing.

Automatic recovery may recycle Pi for a proven daemon/protocol failure. It may not invoke Full Box,
replace a merely unhealthy Box, archive/delete to make a test pass, or discard an interrupted turn.

## Layout 14 Pi broker

Layout 14 replaces the FIFO wrapper with a small Node broker supervised independently under systemd.
It is the only runtime protocol boundary to Pi.

The broker provides:

- an owner-only Unix socket (`0600`) for correlated commands;
- a segmented, monotonically ordered event journal;
- explicit event acknowledgement and safe segment retention;
- the current Pi invocation id and process-exit observation;
- one binding between the sole active attempt and its events through `agent_settled`.

Runtime must obtain a correlated `get_state` response showing Pi idle with no queued messages before
`prompt`. It omits Pi `streamingBehavior`, so a concurrent turn is refused rather than silently
queued as a `followUp`.

Pi command responses carry the command id; general Pi events do not. The broker therefore owns the
one-active-attempt association. An `agent_settled` for that association ends the attempt only when
its shape is explicitly supported. Tool and `ask_user` activity renews the turn's correlated
activity timestamp.

Unknown event types are counted and ignored. Malformed or oversized lines are recorded only as
bounded counters and stable codes, then skipped so the journal progresses. Raw event lines,
provider response bodies, stderr, tokens, auth JSON, and signed URLs are never stored in PostgreSQL
or ordinary logs.

Runtime commits each supported event projection and its monotonic cursor in one PostgreSQL
transaction. A supported `agent_settled` or Pi process-exit observation records the terminal
checkpoint in that same commit. Only then may runtime acknowledge the cursor to the broker. After a
lease takeover, the new owner acknowledges an already-durable terminal cursor before settling the
turn, so neither a crash after projection nor a duplicate journal delivery can lose or duplicate the
terminal result.

## Dispatch ambiguity and Retry/Cancel

Dispatch has three relevant outcomes:

- **positive ACK:** attempt becomes `running`; replying UI may begin;
- **proven negative ACK:** runtime may apply the bounded retry policy without claiming Pi executed
  the prompt;
- **prompt may have been written, no ACK:** attempt and turn become `interrupted` immediately.

The ambiguous case is never automatically replayed, including after lease takeover, Pi restart,
runtime restart, or a new user message. Later turns stay queued.

`POST /v1/companions/:id/turns/:turnId/retry` requires a unique `retry_id`, recycles Pi, creates a new
attempt on the same turn, and shows a warning that earlier external effects may already have
succeeded. Repeating the same retry request resolves to that attempt.

`POST /v1/companions/:id/turns/:turnId/cancel` settles the interrupted turn `cancelled` and releases
the next queued turn. Cancel does not claim that prior effects were rolled back.

## Decisions and deadlines

Pi's `ask_user` is projected as durable `needs_input`. Owner/Editor answers are stored before runtime
delivery; Viewer can read but not answer. A runtime failure after persistence resumes delivery under
the same attempt and decision identity.

A running attempt has two bounds:

- inactivity stall after ten minutes without correlated activity;
- absolute deadline two hours after attempt start, regardless of activity.

The two-second sweep settles either deadline no later than one additional sweep. Settlement is
visible and expurgated. “Companion is replying…” is true only after positive prompt ACK and before
`needs_input` or a terminal state; queued, starting, dispatching, interrupted, cancelled, or settled
turns never show it.

## Model capability and errors

The Pi model catalog's `input` field is preserved through normalization. A model without image input
support rejects image work before prompt dispatch with a stable `model_capability` error and an
action to switch model. A bounded bundled catalog may cover Pi catalog outage. Runtime does not
learn or globally publish capability claims from arbitrary provider errors.

Persisted runtime errors contain exactly:

- stable `code`;
- expurgated one-line `message`, maximum 500 characters;
- allowed action such as retry, cancel, restart Pi, switch model, reconnect provider, or none.

Sanitization removes credential-shaped values, URL queries, newlines, and unrecognized internal
diagnostics. Unknown failures receive a generic message. Owner/Editor may receive an actionable
operator-safe message; Viewer receives a generic unavailable message.

## Skills, MCP, and provider credentials

Web and mobile-web runtime work stages the currently authorized selected Skills plus the bundled
Companion skill. Empty selection means no library Skills. Native mobile receives no Skills source.
The control plane never executes package scripts.

Member MCP accounts are selected by id, labeled, envelope-encrypted, and write-only. Runtime decrypts
only accounts authorized for the current operation and injects values through the transient
owner-only runtime channel. Durable Box JSON contains references, not values. Native mobile receives
no MCP accounts.

Provider connections are workspace-scoped and Owner/Admin-managed. Runtime resolves only the
Companion's selected provider/model after ACL revalidation. API keys and OAuth refresh material stay
encrypted server-side except for the minimal owner-only Pi auth entry required on Box disk. Provider
and MCP plaintext never appears in responses, projections, audit metadata, fixtures, or logs.

Before dispatch, the attempt pins the exact provider and MCP credential revisions used to stage Pi.
Every takeover that may still project Pi events must resolve the same revisions; if an account
rotates after Pi accepted the prompt, runtime interrupts rather than projecting output with a
different redaction dictionary. Once a terminal projection is already committed, takeover reads
only its fenced cursor/output proof and may ACK and settle without loading credentials. OAuth
refresh compare-and-swap is allowed only while applying settings or another pre-dispatch operation,
never while consuming an accepted attempt or decision.

The projection boundary receives an in-memory dictionary built from every string leaf of those
validated, decrypted credentials. Assistant text and decision copy are scrubbed against those exact
values plus bounded generic credential patterns. Tool activity is deliberately metadata-only: it
stores a safe kind/name/title and an opaque hashed call id, never tool arguments or results. A
decision request key that would require redaction fails closed and interrupts the turn. The
dictionary, ciphertext, and raw Pi event are never serialized or logged.

Provider connections and MCP accounts survive the Runtime v2 cutover. Legacy Companion rows and
Box disks do not.

## Reads, polling, and desktop

The following always read PostgreSQL only:

- Companion list and detail;
- default runtime status;
- thread/transcript;
- active turn and queued count;
- Viewer access;
- ordinary settled polling.

The web polls every three seconds while a turn or lifecycle operation is active and returns to a
slower cadence when stable. There is no SSE and no Box-to-control-plane push agent.

Desktop remains Owner/Editor-only and never wakes Box. API performs user authorization, then sends a
short-lived HMAC-authenticated request to a private runtime endpoint. Runtime revalidates access and
mints the provider desktop URL only when the exact current settings and Skills revisions are already
staged and every selected personal Skill and MCP account belongs to that actor. A pending restage or
foreign personal resource denies desktop access, so a warm shared Box cannot bypass creator-only
privacy. Neither process stores or logs the URL, and Viewer requests fail before a Box client exists.

## Legacy purge

No legacy Companion, transcript, turn watermark, runtime state, pool assignment, lease, or Box is
migrated. Cutover uses a one-shot command with:

- `report` mode;
- dry-run mode;
- destructive `purge --confirm-delete-all-companions` mode.

The feature flag must be disabled and the command takes an advisory lock. It inventories every DB
`box_id` and only exact known legacy Box-name formats, prints targets, requests permanent provider
deletion, persists the operation id, and waits for completion. Provider `404` means already deleted;
any other failure stops the purge with ownership rows intact.

Only after every external delete is confirmed may the command remove legacy Companions, pools,
shares, member states, threads, transcripts, and leases. It preserves provider connections, MCP
accounts, Skills, secret rows, organizations, users, billing, and audit history. The process is
resumable after partial success.

Legacy columns may remain during the stacked rollout solely for deployability; no backfill is
performed. Final removal requires seven consecutive green real-provider canary days, no open P0/P1
runtime issue, and no resource remaining in the purge report.

## Health, observability, and acceptance

`apps/runtime /healthz` is unhealthy when PostgreSQL is unavailable, the claim loop is stalled, or
the latest sweep is stale. Operators must be able to observe queue age, claim latency, operation and
attempt duration, lease takeover, deadline settlement, unknown/malformed event counts, canonical and
duplicate Box discovery, permanent-delete progress, and expurgated failure codes without accessing
secret payloads.

Acceptance bounds:

- API send acknowledgement under one second outside load;
- runtime claim under five seconds;
- cold start success or explicit failure under three minutes;
- replica takeover under 45 seconds;
- inactivity settlement under ten minutes plus one sweep;
- absolute settlement under two hours plus one sweep.

The deterministic simulator and real-provider canary requirements live in `docs/testing.md`.

## Explicit exclusions

Runtime v2 adds no generic Projects/skill runs, multi-Bot team or handoff, group Bot chat, routine,
schedule, proactive task, voice, attachment/artifact, alternate harness, alternate Box provider,
pool, generic model/provider marketplace, container catalog, deployment platform, or AI app builder.
It adds no SSE, Box push bearer, detached API executor, automatic Full Box repair, automatic replay
after ambiguous dispatch, or global learned capability table.
