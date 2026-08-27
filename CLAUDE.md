# Contributor guidance

Companion v2 is a self-hostable, multi-tenant **Skills Hub at its core**, with an optional
Companions control plane. When Companions are enabled, each Companion is one named teammate with
one persistent box.ascii.dev Box, one Pi daemon, and one durable chat thread. Read
`docs/vision.md`, `docs/product.md`, `docs/design.md`, `docs/PRD.md`, `docs/testing.md`, root
`DESIGN.md`, and `docs/companions-runtime.md` before non-trivial Companion or runtime changes.

## Domain vocabulary

- Tenant hierarchy: **Organization → User**; organization roles: **Owner, Admin, Developer**.
- Skills use `scope: personal | org`. Personal skills are creator-only with no admin override.
  Organization skills are manageable by every member.
- Share is the sole owner-only, one-way `personal → org` transition.
- Organization and personal label trees organize skills without changing access.
- External coding agents are delegated Skills Hub clients. They are not hosted Companions and
  Companion never launches them through Agent Auth.
- A hosted Companion has an immutable Companion **Owner** and optional workspace-wide **Editor** or
  **Viewer** access. Owner/Editor may send and operate it; Viewer reads control-plane projections
  only and never contacts Box.
- A **turn** is the durable result of one accepted `client_message_id`; a **turn attempt** is one
  explicit dispatch try; an **operation** is durable lifecycle intent such as start, stop, restart,
  settings apply, or delete.

Do not introduce generic Projects or skill runs, multi-Bot orchestration, agent-to-agent handoffs,
voice, another agent harness, another Box provider, or a deployment platform. Scheduled Companion
routines are in scope: they enqueue ordinary turns as the immutable Companion Owner and never
contact Box or Pi from the worker. Webhook-fired Companion triggers are in scope: the API webhook
route only persists an ordinary turn as the immutable Companion Owner and never contacts Box or
Pi. Chat files are in scope and bounded: a member may attach images
and documents to a message, and Pi may hand back images it leaves in its outbox. Nothing else is
an artifact — there is no file library, no versioning, and no artifact surface outside the thread
the file was sent in. Pi remains the only harness and box.ascii.dev the only runtime provider. Keep
the existing Companions feature flag and email-domain allowlist; do not add flags that can enable an
excluded product surface.

## Architecture anchors

- `packages/db/src/schema.ts`: tenant and runtime data source of truth.
- `packages/core/src/authz.ts`: membership, RBAC, personal-skill privacy, and Companion ACLs.
- `packages/core/src/services.ts`: shared skill domain services.
- `packages/skills`: package parsing, validation, versioning.
- `packages/skilldb`: hosted declared SQLite state.
- `packages/box-runtime`: ascii.dev transport, Box disk layout, and the Pi broker integration.
- `packages/companion-runtime`: Runtime v2 state machine and durable execution engine.
- `apps/runtime`: the only process allowed to claim runtime work or contact Box/Pi.
- `packages/db/runtime-role-grants.sql`: split API, worker, and runtime grants.
- `apps/worker/src/supervisors.ts`: GitHub, billing, Skill Database cleanup, and Companion routines.
  Routine fire is API-level turn persistence; the worker never contacts Box or Pi.
- `apps/api/src/agentAuthRoutes.ts`: skill-facing delegated client approval.

## Invariants

- TypeScript, pnpm workspaces, Turborepo, Drizzle, and tRPC plus REST. Authentication uses Better
  Auth; object storage is S3-compatible.
- `packages/core` has no Next.js dependency. Shared contracts belong in `packages/contracts`.
- Every tenant row/query is scoped by `org_id`; RLS is defense in depth.
- Secrets are envelope-encrypted, write-only, referenced by id, and never logged or returned as
  plaintext.
- The control plane never executes skill package scripts. Archives and transfer tickets remain
  fail-closed.
- Public releases pin an exact immutable version and checksum.
- Desired GitHub mirrors and Skill Database cleanup are idempotent.
- Frontend work follows root `DESIGN.md`.
- Every Companion plugin in `COMPANION_PLUGIN_CATALOG` must ship with its provider mark (logo):
  add the SVG path to `MARK_PATHS` in `apps/web/src/components/companions/PluginMark.tsx` and its
  tile colors in `companions.css`. The provider union type makes a missing mark a build failure.
- The API authorizes and persists runtime intent, then returns. It never calls Box or Pi and never
  owns a runtime lease.
- `apps/runtime` is the sole lifecycle owner. The API and worker have no Box credential; runtime
  receives the Box key and only narrow `SECURITY DEFINER` claim/renew/checkpoint/settle access.
- One `(companion_id, client_message_id)` creates exactly one turn. Only one attempt may be active
  per Companion; later turns remain ordered in PostgreSQL.
- An ambiguous dispatch is never replayed automatically. It becomes `interrupted` and blocks the
  queue until an Owner/Editor explicitly retries with a new `retry_id` or cancels it.
- Full Box restart is an explicit user action only. Automatic repair may recycle Pi but never
  restart, replace, archive, or delete a healthy Box as healing.
- Runtime errors persist only a stable code, an expurgated message of at most 500 characters, and an
  allowed action. Never persist provider payloads, tokens, signed URLs, or raw Pi lines.

## Conductor

Use `.conductor/settings.toml`. Setup installs PostgreSQL 17 plus `lsof` with `dnf` in cloud
workspaces, or PostgreSQL 17 plus optional MinIO/Mailpit with Homebrew locally, then runs
`corepack enable && pnpm install`. Run executes `bash scripts/dev-conductor.sh`; archive executes
`bash scripts/dev-conductor.sh archive`.

The native Conductor stack starts per-workspace PostgreSQL plus optional MinIO and Mailpit under
`.conductor-pg/`, then API, worker, runtime, and web in one process group. Ports derive from
`CONDUCTOR_PORT`: web `+0`, API `+1`, PostgreSQL `+2`, MinIO API `+3`, console `+4`, SMTP `+5`,
Mailpit UI `+6`, and private runtime `+7`; `+8` is available to the deterministic Box/Pi simulator.
Cloud workspaces use base `3000`. Internal services, including runtime, bind loopback; cloud web
alone binds `0.0.0.0`. Cookies and the runtime desktop HMAC key are workspace-specific. Missing
MinIO disables uploads; missing Mailpit falls back to logged email. The launcher gives the Box key
and runtime database URL only to `apps/runtime` without changing the published web/API port contract.

## Companions Runtime v2 contract

- An Owner/Editor send persists the message, its attachments, and the turn atomically and returns
  `202` in under one second outside load; a send carrying files is bounded by the upload it performs
  first. Sending is the only normal wake action; there is no Wake button and no first-keystroke
  prewarm.
- Turn states are
  `queued → starting → dispatching → running ↔ needs_input → succeeded|failed|interrupted|cancelled`.
  “Companion is replying…” is true only after Pi acknowledges the current attempt and before its
  terminal settlement.
- The runtime re-evaluates membership, Companion ACL, selected Skills, plugins, and provider access
  immediately before Box contact. Revoked authority fails closed.
- Pi must be idle with no queued messages before prompt dispatch. The layout-14 broker correlates
  the single active attempt through `agent_settled`; unknown events are counted and ignored, while
  only supported terminal shapes settle a turn.
- Staged Pi instructions (`composedInstructions()` in `packages/box-runtime`, written to
  `~/.companion/runtime/state/instructions.txt` and passed as `--append-system-prompt`) are how Pi
  learns what this runtime actually provides. A Companion capability is not shipped until that brief
  names it: web, subagents, memory, files/outbox, skills, plugins, the Skills Hub, ask_user,
  propose_config, request_plugin_connection, routines (`propose_routine`), and triggers
  (`propose_trigger`). Interpolate the real
  constants rather than literals. First-party clients share one Companion API and capability
  contract; the iOS app must not request reduced staging through a client-surface discriminator or
  invent mobile-only endpoints. Do not describe a capability the Box does not have. Voice stays in
  the persona line.
- A turn stalls after ten minutes without correlated activity and has a two-hour absolute deadline.
  A timed-out or ambiguous turn becomes visible and actionable; it never appears to reply forever.
- Retry creates a new attempt and warns that earlier external effects may have succeeded. Cancel
  terminates the interrupted turn and releases the ordered queue.
- Box stays warm for six hours after successful Pi acceptance. Reads, lists, ordinary status, and
  Viewer access are PostgreSQL-only and never wake or observe Box directly.
- Disabling the Companions flag stops new runtime claims. Active work reaches a safe checkpoint and
  becomes interrupted. Re-enabling is the operational rollback; old executors must never process v2
  rows.
- Legacy Companions, transcripts, runtime state, and Boxes are purged fail-closed before v2 cutover;
  they are not migrated. Encrypted provider connections and member MCP accounts survive.

## Tests and completion

- Follow `docs/testing.md`; prefer behavior-level coverage.
- Authorization matrices must cover non-members, cross-tenant access, actor revocation, and
  no-admin-override privacy.
- Runtime work requires deterministic Box/Pi simulation, real PostgreSQL lease/fencing tests, and
  fault injection before and after every external side effect and durable checkpoint.
- Frontend changes require `APP_URL=http://127.0.0.1:<port> pnpm browser:smoke` plus manual
  `agent-browser` checks for changed paths.
- Changes under `packages/companion-skill/skill/` require a version bump, top changelog entry, and
  `pnpm --filter @companion/companion-skill update:integrity`.
- Run `pnpm verify:change`; exit 2 means printed follow-up gates are still required.
- Every required CI test must protect an identifiable product promise at the lowest layer that
  proves it. Apple Quality is capped at five minutes; its iOS path runs only `CompanionKit`
  behavior tests plus a generic iOS Simulator build, while the conditional skill path retains the
  Darwin-only private-transport guard. Never boot a simulator or run XCUITests in that gate. Keep
  UI validation local and manual unless the repository owner explicitly approves a separate CI job.
- Never install or invoke `xcodebuildmcp` in CI. Apple CI uses native `swift test` and `xcodebuild`;
  reserve XcodeBuildMCP for local interactive agent work.
- Before adding a GitHub Actions workflow, CI job, required check, or trigger, obtain explicit
  approval from the repository owner.
- Architecture/data/auth/API/runtime changes must keep `docs/design.md`,
  `docs/companions-runtime.md`, and the bundled Companion skill aligned. A new Companion capability
  also updates `composedInstructions()` so Pi is told it exists.
- PR titles use Commitizen style, for example
  `feat(runtime): add the dedicated Companion runtime service`.
