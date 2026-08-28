# Routine isolation production cutover and recovery

Use this runbook to deploy or recover the run-scoped Pi execution path for scheduled Companion
routines. It supplements [the Runtime v2 runbook](./companions-runtime.md) and
[the Railway deployment guide](../../deploy/railway/README.md). It does not authorize direct
production database writes or Box deletion/restart.

## Current contract and deploy gates

There is no routine-isolation rollout environment variable in the merged implementation. The
temporary `COMPANION_ROUTINE_ISOLATION_ENABLED` variable existed during development of #466, but
`refactor(runtime): make routine isolation unconditional` removed its config and application
plumbing before #466 merged. Setting it on a current runtime has no effect.

The current runtime always passes `true` to `companion_runtime_prepare_routine_run` from
`CompanionRuntimeStore.prepareRoutineRun`. Migration
`0137_companion_routine_isolation.sql` preserves an already-pinned isolated run and pins a new
routine run to isolation when that argument is true. The worker does not choose the execution
mode; it only persists the routine-origin turn.

The actual product gate remains:

```dotenv
COMPANION_COMPANIONS_ENABLED=true
COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=the-real-production-allowlist
```

Set both consistently on web, API, worker, and runtime. An absent, blank, or non-true
`COMPANION_COMPANIONS_ENABLED` value disables Companions. An empty allowlist also disables them.
The worker then stops claiming routine work, and the runtime stops claiming Companion work. These
variables are a product kill switch, not an isolation/legacy selector.

### Version and flag matrix

| Runtime binary | Database | Isolation variable | Result |
| --- | --- | --- | --- |
| Current, at or after final #466 | Includes migration 0137 | Any value or absent | Variable is ignored. Every new routine run is prepared as isolated. |
| Intermediate, unmerged #466 build | Includes migration 0137 | Absent or `false` | New, unpinned runs use the legacy ordinary-turn path. An already-isolated run remains isolated because the SQL checks its durable pin before the flag argument. |
| Intermediate, unmerged #466 build | Includes migration 0137 | `true` | New runs are pinned to isolation. The variable was read by runtime only, not worker. |
| Pre-#466 runtime | Includes migration 0137 | Any value | The old runtime ignores the variable and never calls the preparation function, so it executes the legacy path. The migration is additive for that binary. |
| Current runtime | Missing migration 0137 | Any value | Runtime readiness fails on the missing required function/grants and must not claim work. Run the release service; there is no supported legacy fallback. |

On the intermediate build only, the exact variable was
`COMPANION_ROUTINE_ISOLATION_ENABLED=true` on the runtime service. Its parser treated absent or
blank as false, accepted `true`/`1` and `false`/`0`, and rejected other values. Do not use that
variable to operate current production. Deploy one immutable current SHA instead.

The legacy path shares the persistent main Pi session, transcript, and context. It therefore does
not provide the privacy or execution isolation required by the redesigned chat. It does not,
however, intentionally run concurrently with an active main-Pi turn: the durable queue permits one
active attempt per Companion, and dispatch requires Pi to be idle with no queued messages. A
legacy attempt that loses the main Pi reports `Pi restarted while the turn was active`.

The distinct error `The routine Pi session changed while the run was active` is emitted only by
the isolated consumer. Seeing it while an intermediate runtime's isolation variable is off means
the run was already durably pinned to isolation, or the deployed runtime is the current
unconditional implementation. It is not evidence that a new legacy fire interrupted an active
main-Pi turn.

## Known prepare recovery failure

The run-scoped prepare script reads the routine PID file and only emits
`routine-pi-session-already-running <invocation>` after proving that:

- the PID is alive;
- `/proc/<pid>/environ` contains the exact run root as `COMPANION_PI_ROOT`;
- the process command line names the expected routine broker script; and
- the invocation file contains a valid invocation for that run.

This is process ownership validation, not a shared main-daemon lock. The invocation includes a
fresh UUID and the routine root includes the run ID, so separate runs do not collide.

The Box command transport can nevertheless return `success: false`, exit 1 when the detached
broker intentionally remains alive after the shell exits. Before the recovery fix,
`AsciiBoxCompanionRuntime.startRoutineSession` checked that envelope before parsing the
already-running marker. A retry or executor takeover therefore terminated the valid session and
persisted `box_provider_error`, even though prepare had recovered the exact session it needed.

The fix treats the ownership-proven marker as authoritative before the transport envelope, just
as launch readiness already does. Its regression test simulates exit 1 plus the marker and proves
that start returns the existing invocation without restaging or terminating it. Routine attempt
settlement still terminates and removes the run root; executor takeover may safely adopt the
existing broker before settlement.

PR #472 does not contain this fix. It makes routine context multiline-safe and uses the durable
turn ID as the isolated run ID; it does not change `packages/box-runtime`, prepare recovery, or
teardown.

## Ordered Railway cutover

1. Record the exact target Git SHA and confirm that it includes migration 0137, the final #466
   isolation implementation, #472, and the already-running prepare recovery. Do not deploy a
   moving branch independently to each service.
2. Disable the target routine in the product so its cron cannot enqueue more validation turns.
   For a full runtime cutover, set `COMPANION_COMPANIONS_ENABLED=false` on web, API, worker, and
   runtime, deploy all four, and wait for active work to reach its safe interrupted checkpoint.
3. Take the normal production backup. Deploy the Railway `release` service at the exact target
   SHA. Require a `Completed` result before deploying application services; this applies migration
   0137 and its role grants.
4. Confirm the default branch has not advanced past the recorded SHA. Configure
   `COMPANION_COMPANIONS_ENABLED=true` and the same non-empty
   `COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS` on web, API, worker, and runtime. Do not add
   `COMPANION_ROUTINE_ISOLATION_ENABLED`.
5. Deploy runtime first at the recorded SHA, then API, worker, and web/iOS-facing API at that same
   SHA. Verify each deployment's release ID and health check. The runtime must report its required
   SQL functions and grants ready before the worker is allowed to create new fires.
6. If the Runtime v2 database gate was disabled for the cutover, the migration owner—not the
   runtime role—must re-enable it with the observed epoch using the compare-and-swap procedure in
   the Runtime v2 runbook.
7. Clean the old validation turns using the procedure below. Re-enable the routine only after the
   queue is clear and all services report the same release.

The redacted diagnostic helpers may be used to confirm Railway deployment status, Runtime health,
the database gate, and routine projections:

```bash
python3 .claude/skills/debug-companions-prod/scripts/railway_status.py
python3 .claude/skills/debug-companions-prod/scripts/db_query.py health
python3 .claude/skills/debug-companions-prod/scripts/db_query.py gate
python3 .claude/skills/debug-companions-prod/scripts/db_query.py routines --companion <companion-uuid>
```

Use only the named read-only helpers. Do not run an ad hoc production query.

## End-to-end validation

Create or re-enable one five-minute routine with a prompt that ends by calling `surface_to_main`
with this accepted payload:

```json
{"mode":"notify","message":"Hello World"}
```

After one fire, verify:

- the run reaches `succeeded`, with outcome `surfaced` and surface mode `notify`;
- `main_entry_event_id` is present and `relay_turn_id` is absent;
- iOS Routine History shows **Completed** and **Notified in main chat**;
- the private routine transcript contains the isolated task and tool call; and
- the main thread gains one ordinary assistant entry containing `Hello World` at its next durable
  ordinal, and the notification is emitted. Notify does not wake or dispatch the main Pi.

To validate silent completion separately, use a routine prompt that finishes without calling
`surface_to_main`. Expect `succeeded` with outcome `no_output`, no surface mode, no main entry, and
no relay turn. iOS shows **Completed silently**. The private run transcript remains available,
while the main thread gains nothing. `no_output` is a settlement outcome, not a
`surface_to_main` payload mode.

Do not accept `failed`, `interrupted`, a duplicate main entry, or a main-Pi dispatch for the notify
case. Keep the routine disabled while investigating any of those results.

## Clean interrupted and queued validation turns

1. Disable the `Hello World` routine first to stop new cron fires.
2. In the Companion chat, use **Cancel turn** on the interrupted queue-head notice. Do not choose
   Retry until the prepare recovery is deployed.
3. Expand the queued-messages card and use **Remove from queue** for each queued `Hello World`
   message. Preserve unrelated owner messages.
4. If the client action is unavailable, an authorized Owner/Editor may call
   `POST /v1/companions/<companion-id>/turns/<turn-id>/cancel` with `{}` once per exact queued or
   interrupted turn. Cancellation is durable and idempotent. Do not edit leases, attempts, or
   routine rows directly.
5. Confirm the ordered queue is clear before re-enabling the routine.

## Rollback and containment

If isolated routine execution fails after cutover:

1. Disable the affected routine immediately. If failures are systemic, set
   `COMPANION_COMPANIONS_ENABLED=false` consistently on worker and runtime—preferably all four
   product services—and deploy so new work stops and active work reaches the safe interrupted
   checkpoint.
2. Cancel only the affected interrupted and queued turns through the product/API procedure above.
3. Preserve migration 0137 and every durable `routine_isolated` pin. Do not down-migrate, force a
   run onto the legacy main Pi, delete the Box, or use a full Box restart as automatic repair.
4. Roll forward to a compatible fixed Runtime v2 SHA. Re-run release first if that SHA contains a
   migration, deploy runtime before the producers, verify health and grants, then restore the
   master feature gate and database gate using their documented procedures.

Setting the historical isolation variable to false is not a supported rollback: current code
ignores it, and the legacy shared-main-Pi behavior violates the routine isolation contract.
