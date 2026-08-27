# Testing standard

Tests defend product promises, not implementation trivia. Every critical suite should state the
promise, regression caught, reason for its test level, and a change that proves it is sensitive.

Prefer the lowest level that proves the boundary, but use real PostgreSQL, object storage, HTTP, or
a browser when the guarantee crosses that boundary. Mock identities and external providers, not
authorization, persistence, queueing, or lease behavior. Runtime tests use the deterministic Box/Pi
simulator; lifecycle commands must never execute against the CI host.

## Critical promise matrix

| Promise | Regression caught | Required level | Sensitivity example |
|---|---|---|---|
| Personal skills and database realms remain creator-only; org skills remain member-wide | Same-org admin override or cross-tenant disclosure | Core + PostgreSQL + HTTP | Remove the creator or tenant predicate |
| Uploads and public packages are archive-safe, checksum-bound, and correctly authorized | Traversal, link, collision, oversized archive, substituted release, or under-scoped download | Package + storage + HTTP | Relax one ZIP, checksum, or scope guard |
| Share is the only personal-to-org transition and includes required private dependencies | Partial closure or unauthorized share | Core + PostgreSQL + HTTP | Skip the owner or dependency-plan gate |
| GitHub mirrors are deterministic, tenant-scoped, and idempotent | Duplicate writes, credential leak, or cross-org destination | Core + worker + provider contract + PostgreSQL | Remove digest, fence, or tenant checks |
| Skill secrets never leak plaintext and grants cannot replay | Value in response/log/audit or reused grant | Core + HTTP + PostgreSQL | Return a value or remove redemption CAS |
| Skill Databases preserve additive schemas, realm privacy, serialization, and conditional storage | Destructive drift, lost update, or personal-realm disclosure | Core + SQLite + storage + PostgreSQL | Remove compatibility, owner key, lock, or ETag condition |
| Agent Auth grants only exact-workspace Skills Hub capabilities | Mixed workspace approval or hosted-runtime access | HTTP + compatibility + PostgreSQL | Broaden the capability registry |
| Agent Auth child PATs inherit only the active exact-workspace grant snapshot | PAT-to-PAT minting, caller-chosen scope/org, expired inheritance, target mismatch, or plaintext persistence | Contracts + Core + HTTP + PostgreSQL + bundled client | Remove provenance, target binding, pipe-only handoff, or redaction |
| One accepted message creates exactly one durable turn | Duplicate message/turn after client or proxy retry | Contracts + HTTP + PostgreSQL | Remove `(companion_id, client_message_id)` uniqueness |
| A due Companion routine fires exactly once per scheduled instant | Duplicate turn after worker retry, catch-up after flag-off, or pileup on an in-flight routine turn | Core + worker + PostgreSQL | Drop uuidv5 stamping, skip-missed grace, or the active-turn fence |
| A Companion response notifies only its still-authorized durable author | Cross-user preview disclosure, duplicate push, stale-device delivery, or cancelled-turn alert | Contracts + HTTP + worker + PostgreSQL + iOS | Skip claim-time ACL revalidation or event uniqueness |
| The API persists runtime intent but never contacts Box/Pi | Lost work after `202`, request-held lifecycle, or duplicate executor | HTTP + provider spy + PostgreSQL | Construct the Box adapter in an API route |
| Only one attempt runs per Companion while later turns stay ordered | Concurrent prompts or queue reordering | Runtime unit + PostgreSQL + simulator | Remove running-attempt uniqueness or queue ordering |
| Runtime lease epoch fences stale writers | A dead replica checkpoints or settles after takeover | Two runtime replicas + PostgreSQL | Remove epoch from checkpoint/settle predicate |
| Runtime images have one durable builder and never publish an unready snapshot | Concurrent or stale builders publish conflicting state, retry too early, or exhaust permanently | Runtime unit + PostgreSQL + simulator | Remove the image claim fence or treat a non-ready bake as ready |
| Ambiguous prompt dispatch is never auto-replayed | Duplicate external side effects after missing ACK | Broker + runtime + fault injection | Drop ACK after prompt write and permit retry |
| Every active turn reaches a bounded visible state | Forever-replying turn after Pi/provider failure | Runtime + simulator + browser | Suppress `agent_settled` or correlated activity |
| Viewer and ordinary reads never contact or wake Box | Read causes spend, secret access, or lifecycle mutation | HTTP + browser + provider spy | Instantiate Box before the runner guard |
| Provider/MCP secrets stay write-only and runtime errors stay expurgated | Token, signed URL, provider payload, or Pi line persisted | Core + runtime + HTTP + logs | Return raw adapter error text |
| Permanent legacy purge deletes external ownership before rows | Orphan Box or irrecoverable ownership loss | Command + PostgreSQL + provider contract | Delete the row before provider confirmation |
| API, worker, and runtime database roles stay separated | API/runtime claims the other's work, API bypasses a Companion capability function, or worker reads Companion state | Migrated PostgreSQL | Grant the opposite process function/table or forge the Runtime protocol GUC |
| Billing changes stay outside the runtime overhaul | Undocumented runtime entitlement or Skills access change | Contracts + Core + web | Add a runtime quota or bypass an existing skill limit |

## Required suites

- Table-driven RBAC covers membership × role × action, including non-members and cross-tenant
  requests.
- Archive/transfer-ticket and secret-redaction tests accompany every changed binary or sensitive
  flow.
- Schema, forced-RLS, and grant changes run against a disposable fully migrated PostgreSQL database.
- UI, route, auth, style, or browser behavior changes receive browser validation.
- Storage, GitHub, Skill Database, Box, and Pi adapters receive shared contract and idempotency
  coverage at their actual boundary.
- Historical Skills Hub migration replay remains covered independently of the new Companion purge;
  changing Runtime v2 must not weaken old external-resource cleanup guarantees.

## Runtime test layers

Skill synchronization coverage distinguishes publication-only available revisions from required
selection revisions. PostgreSQL tests prove wake and desktop accept `applied >= required` while a
publication is pending. Simulator and fault-injection tests cover `stop Pi -> update Skills ->
start/archive`, safe auto-update failure, first install, corrupt digest, historical version refs,
and takeover around the installed-tree checkpoint.

### Deterministic Box and Pi simulator

- Fake the Box HTTP contract for create, paginated list, state, resume, stop/archive, permanent
  delete and operation polling, commands, files, and desktop minting.
- Keep create faithful to the public API: `202`, provider-generated name, no client name in the
  request. Assert the acknowledged id is checkpointed before the generation-name/six-hour-TTL
  PATCH; a lost create response leaves a five-minute provisional Box and never triggers a second
  POST.
- Run Pi as a real JSONL process with command ACKs, tool calls/results, `ask_user`, provider errors,
  crash loops, malformed/oversized lines, and `agent_settled`.
- Replace `systemctl`, `loginctl`, and `journalctl` with deterministic shims inside a contained test
  environment. A temporary `$HOME` alone is not isolation; no host service manager or destructive
  lifecycle command may run.
- Keep anonymized Box/Pi contract fixtures from real responses and verify the simulator against them
  so fake drift is visible.

### Unit and protocol

- Cover every valid/invalid turn transition, operation precedence, retry/cancel idempotence,
  lifecycle retry classification, both deadlines, LF-strict parsing, event segmentation,
  expurgation, and text/vision model classification.
- Inject unknown events and malformed or oversized lines. They advance the journal, increment
  bounded telemetry, persist no raw content, and do not settle a turn.
- Prove `get_state` idle/no-queue precedes prompt and that omitting Pi `streamingBehavior` prevents a
  hidden follow-up queue.

### Real PostgreSQL integration

- Exercise forced RLS and role grants for API, worker, and runtime, including non-members,
  cross-tenant ids, revoked actors, and no-admin-override personal data.
- Use two real connections to race claim, renew, checkpoint, settlement, lease expiry/takeover, and
  stale epochs.
- For APNs, cover author-only multi-device fan-out, repeated decisions, no cancellation delivery,
  24-hour expiry, claim-time membership/access revocation, SKIP LOCKED concurrency, stale fences,
  bounded previews, and strict API/worker/runtime role separation.
- Race image-build claims, prove a worker cannot claim another digest/name, reject stale image
  outcomes and cleanup fences, prove epochs never repeat after settlement, verify
  30/60/120/300-second backoff and the four-attempt cap, and
  prove an expired fourth attempt is cleanup-only while a terminal failure re-arms only after its
  cooldown. Provider-delete failure must retain `build_box_id` for takeover reconciliation.
  An accepted image-builder deletion persists its provider operation id, treats `blocked` as
  incomplete, and resumes polling without a second `DELETE`.
- Cover multiple pending operations but one running operation, one active attempt, ordered turns,
  idempotent `client_message_id`, unique `retry_id`, configuration revision ordering, and kill-switch
  claims.
- Replay migrations from an historical snapshot and test legacy purge report, dry-run, confirmation,
  advisory lock, Box `404`, provider error, resume after partial progress, and preservation of
  provider/MCP encrypted rows.

### End-to-end topology

Run API + worker + runtime + web + migrated PostgreSQL + Box/Pi simulator and prove:

- cold first send reaches a reply with HTTP `202` under one second;
- closing the browser and killing API after `202` does not affect completion;
- killing the runtime after each checkpoint causes takeover within 45 seconds without duplicate
  prompt or Box;
- two concurrent sends execute in order, one Pi attempt at a time;
- `ask_user` persists a decision and resumes the same attempt;
- a pending `ask_user` or `propose_*` remains actionable without an inactivity stall for up to the
  two-hour absolute deadline;
- a follow-up sent while a warm Pi is busy stays queued without a cold-start deadline, then is
  re-evaluated only after it reaches the head;
- a success and each new pending decision fan out once to the author's active devices, while a
  queued cancellation creates no delivery;
- `propose_routine` projects a card, approve creates the row, and deny/expiry leave none;
- provider failure, Pi silence, crash loop, unknown event, and oversized line end visibly;
- a vision model reads the checked-in image fixture and a text-only model fails explicitly;
- stop then send, explicit Pi restart, explicit Full Box restart, and deletion during a queue obey
  precedence;
- accepted permanent deletion sends `DELETE` exactly once, performs one operation GET per claim,
  leaves no runtime slot occupied during 5/15/30/60-second PostgreSQL backoff, survives runtime
  takeover with the same provider operation id, and removes the aggregate once on `completed` or
  provider `404` without an Owner clicking Retry;
- a prompt response lost after Pi ACK is recovered from the fsynced ledger with the same
  `command_id`, including after executor takeover, and produces exactly one Pi prompt; missing,
  conflicting, or invocation-mismatched ledger proof yields `interrupted`, blocks later turns, and
  proves the replacement Pi received no prompt before that mismatch was classified;
  Retry/Cancel each release it by their documented path;
- Viewer, list, thread, and cross-tenant requests produce zero Box calls.

Inject failure before and after create, Box ready, Pi ready, prompt write, ACK, event projection,
turn settlement, provider stop, and permanent delete. Every scenario must assert final database
state, external call count, and user-visible outcome.

Real-PostgreSQL deletion coverage must additionally prove the defer-and-release CAS is atomic, a
stale fence cannot defer, the pre-migration claim signature returns no work, the versioned signature
does, only the runtime role can invoke the defer function, and migration backfill selects only the
newest eligible failed delete with a retained provider operation id.

## Time and health acceptance

- Runtime sweep interval: two seconds; normal claim under five seconds.
- A completed lifecycle operation wakes the next claim immediately; test the two-second sweep only
  as recovery.
- Lease: 30 seconds, renewed every ten seconds; takeover under 45 seconds.
- Cold start: terminal success or explicit failure under three minutes.
- Human decision window: ten minutes; a newer member message ends it sooner. Both paths deliver a
  fail-closed cancellation to Pi, pause inactivity throughout `needs_input`, and never grant an
  approval.
- Inactivity stall: ten minutes plus one sweep while running; absolute deadline: two hours plus one
  sweep.
- `/healthz` fails when PostgreSQL, the claim loop, or the most recent sweep is unhealthy.

Deterministic fault tests cover every boundary around list, create, resume, bundle upload/apply,
pre-execution cleanup, activation, durable checkpoint, direct prompt write, ledger fsync, HTTP
response loss, dispatch-status resolution, raw attachment/outbox transfer, and ACK. Regression coverage
also proves pre-ACK events remain visible, known Box ids are identity-checked without listing, a
stale broker is recycled after the disk-marker crash gap, and a bundled-skill checksum change
defeats tree reuse. Runtime-image warmup succeeds only when resume has produced a non-empty
provider `.ascii/playbook.json`; broker and bundled-Skill files alone are insufficient.

## Frontend gate

Run the application, then:

```bash
APP_URL=http://127.0.0.1:<port> pnpm browser:smoke
```

Changed Companion paths need focused manual `agent-browser` checks. Verify truthful status,
PostgreSQL-only Viewer reads, queue count, input-needed cards, interrupted Retry/Cancel copy, explicit
Full Box confirmation, attachment chips and inline images inside the message they belong to, a
routine fire that shows `Routine: <name>` with the prompt hidden in the thread and on the list row,
a context-panel routine create,
and no excluded voice, multi-Bot, harness, deployment, or file-library chrome.

## Change verification

Every required CI test must protect an identifiable product promise and run at the lowest layer
that proves it. Apple Quality has a hard five-minute budget: its iOS path runs only the
`CompanionKit` behavior tests and compiles the complete app for a generic iOS Simulator destination
without booting one. Its conditional skill path retains the Darwin-only private-transport guard.
XCUITests and rendered UI checks stay local and manual unless the repository owner explicitly
approves a separate CI job.

Run targeted affected-package tests first, followed by:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
pnpm verify:change
```

The anti-slop gate is incremental while the existing codebase is brought into compliance. It lints
added, copied, modified, renamed, and untracked JavaScript/TypeScript files against their entire
contents; deletions and agent-tooling directories are ignored. The default comparison base is
`origin/main`. Override it with `pnpm lint:anti-slop -- --base <ref>`. Touching a legacy source file
therefore requires resolving all anti-slop findings in that file rather than only findings on the
changed lines.

Every pull request with non-documentation changes runs the full Node lint, typecheck, and test
suite. `main` must not be the first place an unrelated workspace failure can surface; affected-only
quality selection is reserved for local iteration, not the required GitHub gate.

`verify:change` exit code 2 means its selected checks passed but the printed database, browser,
container, or dependency gates remain mandatory. Report exact commands and outcomes; static
inspection is not a passing test.
