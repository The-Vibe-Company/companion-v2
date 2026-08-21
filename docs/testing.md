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
| The API persists runtime intent but never contacts Box/Pi | Lost work after `202`, request-held lifecycle, or duplicate executor | HTTP + provider spy + PostgreSQL | Construct the Box adapter in an API route |
| Only one attempt runs per Companion while later turns stay ordered | Concurrent prompts or queue reordering | Runtime unit + PostgreSQL + simulator | Remove running-attempt uniqueness or queue ordering |
| Runtime lease epoch fences stale writers | A dead replica checkpoints or settles after takeover | Two runtime replicas + PostgreSQL | Remove epoch from checkpoint/settle predicate |
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
- `propose_routine` projects a card, approve creates the row, and deny/expiry leave none;
- provider failure, Pi silence, crash loop, unknown event, and oversized line end visibly;
- a vision model reads the checked-in image fixture and a text-only model fails explicitly;
- stop then send, explicit Pi restart, explicit Full Box restart, and deletion during a queue obey
  precedence;
- missing prompt ACK yields `interrupted`, blocks later turns, and Retry/Cancel each release it by
  their documented path;
- Viewer, list, thread, and cross-tenant requests produce zero Box calls.

Inject failure before and after create, Box ready, Pi ready, prompt write, ACK, event projection,
turn settlement, provider stop, and permanent delete. Every scenario must assert final database
state, external call count, and user-visible outcome.

## Time and health acceptance

- Runtime sweep interval: two seconds; normal claim under five seconds.
- A completed lifecycle operation wakes the next claim immediately; test the two-second sweep only
  as recovery.
- Lease: 30 seconds, renewed every ten seconds; takeover under 45 seconds.
- Cold start: terminal success or explicit failure under three minutes.
- Inactivity stall: ten minutes plus one sweep; absolute deadline: two hours plus one sweep.
- `/healthz` fails when PostgreSQL, the claim loop, or the most recent sweep is unhealthy.

The daily real-provider canary creates a disposable Companion, requires a reply, reads the checked-in
image fixture, stops it, wakes it by sending, requires a second reply, and permanently deletes it.
Missing secrets report `not configured`, never success. Keep the canary separate from merge-blocking
simulator tests; legacy removal requires seven consecutive green days and no remaining purge-owned
resources.

The nightly performance probe runs ten disposable
`create → prompt ACK → stop → resume → prompt ACK → delete` cycles. It reports provider-start and
Box-ready-to-prompt-ACK P50/P95 separately, provider call counts, staging mode, and transferred Skill
bytes. Deployment requires P95 ready-to-ACK at or below five seconds for unchanged text
configuration; pull requests require one cleanup-safe cycle without an absolute latency threshold.
Fault tests cover every boundary around list, create, resume, bundle upload/apply and pre-execution
cleanup, activation, durable checkpoint, prompt write, and ACK. Regression coverage also proves
pre-ACK events remain visible, known Box ids are identity-checked without listing, a stale broker is
recycled after the disk-marker crash gap, and a bundled-skill checksum change defeats tree reuse.

The development-only startup autoresearch harness is launched explicitly with:

```bash
pnpm research:box-startup -- --overnight
```

It requires a clean checkout exactly at `origin/main`, Conductor CLI authentication, and Box/z.ai
research credentials in `BOX_API_KEY` and `ZAI_API_KEY` (the existing E2E variable names are also
accepted). The 72-cycle maximum is six baseline cycles, 36 quick candidate cycles, 20 finalist
cycles, and ten Sol-integration cycles. Three Luna workspaces explore concurrently, but provider
concurrency is one. A lease is not released until Box `404` and named-snapshot absence prove cleanup;
timeout recovery derives all disposable identities from run/candidate/phase/cycle and the controller
cleans them directly before the campaign can continue. Failed proof persists `blocked-cleanup` and
the active lease, so `--resume` retries cleanup before any provider work.

The evaluator checksum is fixed at campaign creation and rechecked in every controller-owned
candidate checkout before Box contact. The controller binds results to the exact run, candidate,
phase, tree, prefix, and cycle count; candidate messages cannot attest benchmark or cleanup output.
Candidate checkouts run under a separate unprivileged OS identity with an isolated home and receive
a random loopback proxy token, never the real Box or model credentials.
The proxy allowlists the exact deterministic Box and snapshot identities, records provider-ready and
correlated broker prompt-ACK timestamps, rejects reported metrics that outrun that evidence, and
checks provider `404` directly after cleanup. Before allowing candidate commands or file writes, it
captures Node and Pi digests directly from the pristine ready baker Box. Its prompt probe requires
the live systemd main process to run the byte-pinned generated broker with those exact executables
and to own the exact Unix socket before and after the ACK. The captured command UID must be non-root;
the proxy rejects the campaign before candidate writes if that trust assumption changes. A pipe-bound kernel advisory lock rejects a concurrent
controller for the same run and releases automatically when a crashed controller closes its pipe.
Campaign state, Conductor links, the lease journal, cleanup proofs, and
deduplicated metrics JSONL live under `.context/autoresearch/box-startup/<run-id>/`;
`--resume <run-id>` reconciles exact workspace names and deterministic message ids rather than creating a
second experiment. A bake Box receives its own deterministic generation identity, so crash cleanup
can find both the snapshot and the otherwise-temporary baker.

The quick score is the worse creation/resume median ready-to-ACK. Promotion requires at least a
one-second or ten-percent gain, bounded per-leg/provider regressions, unchanged protected tests, and
complete cleanup. Final promotion uses nearest-rank P95 and requires both creation and resume at or
below five seconds. Stop/archive latency is recorded separately so experiments may deliberately
move safe deterministic work out of wake, but it must remain within the lifecycle deadline. Unit
tests use a fake Conductor client and cover idempotent messages, workspace reconciliation, invalid
responses, contract rejection, path/secret policy, credential shadowing, controller-owned result
binding, lease serialization, timeout cleanup, required Box `404`, and resume checkpoints without
contacting Conductor or Box. Secondary distributions include send-to-ACK,
Pi/socket activation, broker preflight, provider calls, Skill bytes, staging modes, bake duration,
snapshot size, and Stop/archive latency.

The Box provider lifecycle job uses only the `COMPANION_BOX_E2E_API_KEY` repository secret. It
creates a five-minute disposable Box, exercises file reads, metadata, hashing, and execution,
archives and resumes the Box, proves those files remain usable, archives it again, and permanently
deletes the exact provider resource in `finally`. Cleanup requires the provider's irrevocable
deletion operation plus an immediate `404` for that Box; physical data removal may finish later in
the provider's background operation. It runs only on a daily schedule or manual dispatch, never on
pull requests. The optional `COMPANION_BOX_E2E_IMAGE` repository variable makes it clone a named runtime
snapshot; without it, the test uses a base Box and still covers the provider restore/syscall path.

Every commit pushed to an internal pull request also creates a disposable Box from the configured
runtime image, then stages the exact checkout's Pi layout and broker with the dedicated z.ai canary
credential. The job starts Pi, dispatches a unique first message, requires both the correlated
assistant marker and `agent_settled`, then requests irrevocable deletion in `finally` and confirms
the Box is no longer readable. Only a same-repository PR authored and triggered by the repository's
`COMPANION_BOX_E2E_TRUSTED_LOGIN` receives the dedicated canary credentials; forks and other
contributors skip this real-provider job and retain the mandatory deterministic simulator gates.
Before deletion the probe expunges persisted provider authentication, and a failed deletion is
retried and reports only the safe disposable Box id needed for operator cleanup.

The real Box/Pi delivery test runs for every commit pushed to an internal pull request. After the
Box is deleted, CI replaces a marked performance block at the very end of the pull request
description with the tested commit, result, phase timings, total duration, and workflow link. A run
for an older head SHA never overwrites the report for a newer commit. GitHub does not support an
`If-Match` precondition on pull-request updates, so the globally serialized reporter re-reads both
the head SHA and description immediately before writing and retries a concurrent edit from its fresh
body. Test failures still publish the timings collected before failure and only a stable error code;
credentials, provider payloads, and raw Pi output are never copied into the description.

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

Run targeted affected-package tests first, followed by:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
pnpm verify:change
```

`verify:change` exit code 2 means its selected checks passed but the printed database, browser,
container, or dependency gates remain mandatory. Report exact commands and outcomes; static
inspection is not a passing test.
