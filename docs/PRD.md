# Companion v2 PRD — Skills Hub and optional Companions

## Goal

Give organizations one secure, self-hostable place to govern reusable AI coding skills and,
optionally, assign work to persistent hosted Companions. Skills remain the product core. The hosted
runtime succeeds when every accepted message reaches a reply, a decision, an explicit error, or an
explicitly recoverable interruption even after the browser, API, or one runtime replica disappears.

## Skills Hub requirements

### Identity and tenancy

- Better Auth, organizations, memberships, Owner/Admin/Developer RBAC, invitations, and
  tenant-scoped queries.
- Billing changes for runtime capacity are outside this program; existing Skills Hub entitlements
  remain unchanged.

### Skill lifecycle

- Personal and organization libraries with workspace-unique slugs.
- Safe ZIP upload, browser authoring, manifest validation, immutable versions, archive/restore,
  rename, and one-way Share.
- Dependencies, labels, comments, Activity, install/update reporting, and local inventory.
- Pinned public releases and safe package downloads for verified sessions, approved Agent Auth
  tickets, and exact `public-skills:install` PATs.
- GitHub App synchronization and REST/CLI workflows.

### Skill capabilities

- Write-only skill secrets with audience/recipient controls, stable bindings, redaction, preflight,
  and one-time redemption grants.
- Declared hosted Skill Databases with organization and personal realms, additive schemas,
  parameterized statements, and explicit personal-realm shares.
- Delegated Agent Auth limited to skills, Skill Databases, public installs, and skill secrets.
  Connected clients are external consumers, never hosted Companions.
- Short-lived child PATs inherit only the server-computed active exact-workspace Agent Auth grant
  snapshot; callers cannot choose broader scopes or organizations.

## Optional Companions requirements

### Product and access

- `COMPANION_COMPANIONS_ENABLED` and the existing exact email-domain allowlist gate every route and
  navigation entry. Disabled blocks new runtime claims.
- A Companion is one immutable Owner, optional workspace-wide Editor/Viewer access, one durable
  thread, one persistent Box, and one Pi daemon.
- Owner and Editor may send, answer `ask_user`, update allowed settings, and request runtime actions.
  Only Owner may share or permanently delete. Viewer reads PostgreSQL-only projections and never
  contacts Box.
- Creation selects one connected Pi provider, one validated model, selected Skills, optional
  write-on-behalf, and selected member MCP accounts. Provider and MCP credentials stay write-only.

### Durable turns and lifecycle

- `POST /v1/companions/:id/messages` persists the message and turn atomically, idempotent on
  `(companion_id, client_message_id)`, then returns `202` without contacting Box.
- Turn states are
  `queued → starting → dispatching → running ↔ needs_input → succeeded|failed|interrupted|cancelled`.
  One attempt is active per Companion; later turns remain ordered in PostgreSQL.
- Retry requires a new `retry_id`, creates a new attempt on the same turn, and warns that earlier
  external effects may have succeeded. Cancel settles an interrupted turn and releases the queue.
- A dedicated `apps/runtime` service is the only Box/Pi lifecycle owner. Durable operations,
  checkpoints, leases, and attempt epochs let another replica continue after a crash without
  accepting stale settlements.
- Runtime revalidates membership, Companion ACL, selected Skills, plugins, and provider access
  before each Box interaction. A configuration change during a turn applies after settlement and
  before the next turn.
- Sending is the only normal wake action. There is no Wake button and no first-keystroke prewarm.
  A successful Pi acknowledgement refreshes Box TTL to six hours.
- Pi-only recycle is the automatic repair. Full Box restart and permanent deletion are explicit,
  confirmed user operations; deletion is cleanup, never healing.

### Pi protocol and failure semantics

- Layout 14 installs a Node broker between runtime commands and Pi. It uses an owner-only Unix
  socket for correlated commands and a segmented, monotonic, acknowledged event journal.
- Before `prompt`, Pi must answer `get_state` as idle with no queued messages. The broker associates
  the sole active attempt with events through `agent_settled`.
- Unknown Pi events are counted and ignored. Only explicitly supported terminal event shapes settle
  a turn; malformed or oversized lines advance safely without storing their raw content.
- A missing acknowledgement after a possible prompt write is `interrupted` and never auto-replayed.
  A proven negative acknowledgement may be retried under the lifecycle retry policy.
- Ten minutes without correlated activity stalls a turn; every attempt also has a two-hour absolute
  deadline. “Companion is replying…” is true only after Pi ACK and before terminal settlement.
- Persisted failures contain only a stable code, an expurgated message of at most 500 characters,
  and an allowed action. Provider payloads, tokens, signed URLs, and raw Pi lines are forbidden.
- Model catalog normalization preserves Pi's `input` capability so a text-only model rejects image
  work explicitly before an unbounded turn.

### Cutover

- A one-shot report/dry-run/confirmed purge runs only with Companions disabled and under an advisory
  lock. It permanently deletes each legacy Box and waits for provider confirmation before deleting
  the row that owns it; `404` means already deleted and every other failure blocks cutover.
- All legacy Companions, Boxes, transcripts, runtime state, pools, shares, member state, and leases
  are removed with no history migration or backfill.
- Encrypted provider connections, member MCP accounts, Skills, secrets, organizations, users,
  billing, and audit history survive.

## Security invariants

- Every tenant row carries `org_id`; personal resources remain creator-only with no admin override.
- API, worker, and runtime use distinct `NOSUPERUSER NOBYPASSRLS NOINHERIT` database roles. Runtime
  receives only narrow `SECURITY DEFINER` claim/renew/checkpoint/settle functions.
- Only `apps/runtime` has the Box service key. API keeps user authorization and hands desktop access
  to runtime through short-lived HMAC-authenticated private requests; neither side persists or logs
  the returned URL.
- The control plane never executes skill package scripts.
- Archive extraction rejects traversal, links, special files, collisions, ZIP64, excessive entries,
  and excessive expanded size.
- Transfer tickets are short-lived, purpose-bound, non-replayable, and revalidated before use.
- Plaintext secrets never appear in API responses, logs, audit metadata, projections, test fixtures,
  or ordinary process output.

## Explicit exclusions

- Generic Projects and skill runs, multi-Bot orchestration, Bot-to-Bot handoffs, group Bot chats,
  routines, schedules, proactive jobs, voice, and a new navigation or visual language.
- A file library, file versioning, or any artifact surface outside a thread. Chat files themselves
  are in scope: bounded image and document uploads on a message, and bounded images Pi hands back.
- Harnesses other than Pi, runtime providers other than box.ascii.dev, generic provider/model
  marketplaces, Box pools, container catalogs, deployment management, and arbitrary application
  automation platforms.
- SSE, Box-to-control-plane push agents, bearer tokens exposed inside Pi's OS identity, detached API
  executors, global learned capability tables, and automatic replay after ambiguous dispatch.

## Success measures

- Skills Hub publication, install, GitHub sync, and Skill Database reliability remain unchanged.
- Send acknowledgement is under one second outside load; runtime claims work within five seconds.
- Cold start finishes or fails explicitly within three minutes.
- A stalled attempt settles within ten minutes plus one sweep; absolute deadline settles within two
  hours plus one sweep.
- Runtime takeover completes within 45 seconds after a replica dies.
- Zero cross-tenant/privacy violations, plaintext-secret leaks, silent terminal Pi failures,
  duplicate turns, or automatic replays of ambiguous prompts.

## Acceptance gates

- Unit, real PostgreSQL, simulator fault-injection, and browser suites in `docs/testing.md` pass.
- The full API + worker + runtime + web + Box/Pi simulator topology passes cold send, image,
  decision, stop/wake, takeover, interruption, Retry/Cancel, and permanent deletion scenarios.
- The daily real-provider canary is green for seven consecutive days, no P0/P1 runtime incident is
  open, and the purge report contains no owned legacy resource before legacy orchestration removal.
- `pnpm verify:change` and every printed PostgreSQL, container, dependency, and browser gate pass.
