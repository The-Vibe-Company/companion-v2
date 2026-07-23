# Sandbox lifecycle Railway alerts

Worker lifecycle logs are one-line JSON with `subsystem=sandbox_lifecycle`. They contain run and
activation identifiers, never prompts, secrets, provider response bodies, or user contact data.

Create Railway log searches/alerts with these event fields:

| Alert | Filter | Threshold |
| --- | --- | --- |
| Provider extension failure | `subsystem:sandbox_lifecycle event:extension_failed` | 3 events for the same `runId` within 5 minutes |
| Recorder degraded | `event:recorder_degraded_over_60s` | Any event |
| Runtime deadline exceeded | `event:runtime_deadline_overrun` | Any event |
| Recorder retry storm | `event:recorder_retry_storm` | Any event |
| Reconciler provider failure | `event:reconcile_provider_failed` | 3 events for the same `runId` within 5 minutes |

For an incident, correlate `recorder_degraded`, `provider_observed`, `run_interrupted`, and
`reconcile_completed` by `runId` and `activationRevision`. Do not add prompt text to an investigation
query or log annotation.

## Rollback

Disable `COMPANION_SANDBOX_LIFECYCLE_V2`, drain the worker, and run this transaction before deploying
code that predates the `interrupted` contract:

```sql
begin;
update skill_runs
set status = case
      when sandbox_cleaned_at is null and reactivatable_until > clock_timestamp()
        then 'frozen'::skill_run_status
      else 'error'::skill_run_status
    end,
    runtime_state = 'healthy',
    runtime_degraded_at = null,
    runtime_reconcile_lease_owner = null,
    runtime_reconcile_lease_expires_at = null,
    updated_at = clock_timestamp()
where status = 'interrupted';

update skill_runs
set runtime_state = 'healthy',
    runtime_degraded_at = null,
    runtime_reconcile_lease_owner = null,
    runtime_reconcile_lease_expires_at = null,
    updated_at = clock_timestamp()
where runtime_state = 'degraded';
commit;
```

The additive enum and columns remain in PostgreSQL; old application replicas can ignore them.
