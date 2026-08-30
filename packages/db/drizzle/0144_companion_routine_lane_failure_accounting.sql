-- A routine run's terminal result, not successful enqueue, owns consecutive-failure accounting.
-- Interruptions and cancellations are operational/ambiguous outcomes and never auto-disable a
-- schedule. The pre-fix cross-lane cancellation code is also excluded because it was produced by
-- the scheduler rather than by the routine task.

ALTER TABLE public.companion_turns
ADD COLUMN routine_snapshot_created_at timestamp with time zone;
--> statement-breakpoint

-- Existing run snapshots predate the generation stamp. Attribute only turns created during the
-- currently-live definition; snapshots from a deleted/recreated UUID remain deliberately
-- unattributed and therefore cannot mutate the replacement schedule.
UPDATE public.companion_turns turn_row
SET routine_snapshot_created_at = routine.created_at
FROM public.companion_routines routine
WHERE turn_row.org_id = routine.org_id
  AND turn_row.companion_id = routine.companion_id
  AND turn_row.routine_snapshot_id = routine.id
  AND turn_row.created_at >= routine.created_at;
--> statement-breakpoint

CREATE FUNCTION public.companion_record_routine_run_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := COALESCE(NEW.settled_at, clock_timestamp());
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status
     OR NEW.routine_snapshot_id IS NULL
     OR NEW.status NOT IN ('succeeded', 'failed', 'interrupted', 'cancelled') THEN
    RETURN NULL;
  END IF;

  IF NEW.status = 'succeeded' THEN
    UPDATE public.companion_routines routine
    SET consecutive_failures = 0,
        last_error_code = NULL,
        last_error_message = NULL,
        last_error_at = NULL,
        updated_at = v_now
    WHERE routine.org_id = NEW.org_id
      AND routine.companion_id = NEW.companion_id
      AND routine.id = NEW.routine_snapshot_id
      AND routine.created_at = NEW.routine_snapshot_created_at;
  ELSIF NEW.status = 'failed'
        AND NEW.last_error_code IS DISTINCT FROM 'routine_session_cancelled' THEN
    UPDATE public.companion_routines routine
    SET consecutive_failures = routine.consecutive_failures + 1,
        last_error_code = NEW.last_error_code,
        last_error_message = NEW.last_error_message,
        last_error_at = v_now,
        enabled = CASE
          WHEN routine.consecutive_failures + 1 >= 5 THEN false
          ELSE routine.enabled
        END,
        next_fire_at = CASE
          WHEN routine.consecutive_failures + 1 >= 5 THEN NULL
          ELSE routine.next_fire_at
        END,
        updated_at = v_now
    WHERE routine.org_id = NEW.org_id
      AND routine.companion_id = NEW.companion_id
      AND routine.id = NEW.routine_snapshot_id
      AND routine.created_at = NEW.routine_snapshot_created_at;
  END IF;

  RETURN NULL;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_record_routine_run_outcome() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_turns_record_routine_run_outcome
AFTER UPDATE OF status ON public.companion_turns
FOR EACH ROW EXECUTE FUNCTION public.companion_record_routine_run_outcome();
--> statement-breakpoint

-- Enqueue success proves only that the durable turn exists. Preserve the current failure streak
-- until that run itself succeeds; fire failures and runtime failures therefore share one streak.
DO $companion_routine_fire_result_accounting$
DECLARE
  v_signature text :=
    'public.companion_fire_routine(text,uuid,uuid,uuid,timestamptz,timestamptz)';
  v_definition text;
  v_old text := $r$      last_error_code = NULL,
      last_error_message = NULL,
      last_error_at = NULL,
      consecutive_failures = 0,
      claimed_by = NULL,$r$;
  v_new text := $r$      claimed_by = NULL,$r$;
  v_enqueue_old text := $r$  ) queued;

  UPDATE public.companion_routines routine$r$;
  v_enqueue_new text := $r$  ) queued;

  UPDATE public.companion_turns turn_row
  SET routine_snapshot_created_at = v_routine.created_at
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = v_routine.companion_id
    AND turn_row.client_message_id = p_client_message_id
    AND turn_row.routine_snapshot_id = v_routine.id
    AND turn_row.routine_snapshot_created_at IS NULL
    AND turn_row.created_at >= v_routine.created_at;

  UPDATE public.companion_routines routine$r$;
  v_count integer;
  v_enqueue_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'routine fire accounting rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_enqueue_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_enqueue_old, ''))
  ) / char_length(v_enqueue_old);
  IF v_enqueue_count <> 1 THEN
    RAISE EXCEPTION 'routine generation rewrite matched %, expected 1', v_enqueue_count
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_enqueue_old, v_enqueue_new);
END
$companion_routine_fire_result_accounting$;
--> statement-breakpoint

-- One-time owner-approved repair. Re-enable only rows with both the old five-failure disable marker
-- and five most-recent run outcomes that all carry the exact scheduler-cascade evidence. Setting
-- next_fire_at to the migration instant makes one ordinary due claim; the worker then computes the
-- next cron instant in TypeScript through the normal fenced fire path.
WITH affected AS (
  SELECT routine.id
  FROM public.companion_routines routine
  CROSS JOIN LATERAL (
    SELECT count(*) AS run_count,
      bool_and(
        recent.status IN ('failed', 'interrupted')
        AND (
          recent.last_error_code IN (
            'routine_session_cancelled',
            'pi_invocation_changed',
            'runtime_lifecycle_preempted'
          )
          OR (
            recent.last_error_code = 'pi_event_stream_interrupted'
            AND recent.last_error_message =
              'The routine Pi session changed while the run was active.'
          )
        )
      ) AS scheduler_cascade
    FROM (
      SELECT turn_row.status, turn_row.last_error_code, turn_row.last_error_message
      FROM public.companion_turns turn_row
      WHERE turn_row.org_id = routine.org_id
        AND turn_row.companion_id = routine.companion_id
        AND turn_row.routine_snapshot_id = routine.id
        AND turn_row.routine_snapshot_created_at = routine.created_at
      ORDER BY turn_row.created_at DESC, turn_row.id DESC
      LIMIT 5
    ) recent
  ) proof
  WHERE NOT routine.enabled
    AND routine.consecutive_failures >= 5
    AND proof.run_count = 5
    AND proof.scheduler_cascade
)
UPDATE public.companion_routines routine
SET enabled = true,
    next_fire_at = date_trunc('milliseconds', statement_timestamp()),
    consecutive_failures = 0,
    last_error_code = NULL,
    last_error_message = NULL,
    last_error_at = NULL,
    claimed_by = NULL,
    lease_expires_at = NULL,
    updated_at = statement_timestamp()
FROM affected
WHERE routine.id = affected.id;
