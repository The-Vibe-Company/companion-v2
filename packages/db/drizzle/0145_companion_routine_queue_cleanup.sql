-- Queued routine turns are durable history, but they must never remain executable after their
-- definition is disabled/deleted or after they have waited beyond the missed-fire grace. Keep the
-- internal skip proof on the turn row while preserving the public cancelled turn state.

ALTER TABLE public.companion_turns
  DROP CONSTRAINT companion_turns_error_check,
  ADD CONSTRAINT companion_turns_error_check CHECK (
    (last_error_code IS NULL) = (last_error_message IS NULL)
    AND (
      (last_error_code IS NULL) = (last_error_action IS NULL)
      OR (
        status = 'cancelled'
        AND routine_name IS NOT NULL
        AND last_error_code IS NOT NULL
        AND last_error_action = 'none'
      )
    )
    AND (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$')
    AND (
      last_error_message IS NULL
      OR (
        char_length(last_error_message) <= 500
        AND last_error_message !~ E'[\n\r]'
      )
    )
    AND (status NOT IN ('failed', 'interrupted') OR last_error_code IS NOT NULL)
    AND (
      status NOT IN ('succeeded', 'cancelled')
      OR last_error_code IS NULL
      OR (
        status = 'cancelled'
        AND routine_name IS NOT NULL
        AND last_error_action = 'none'
      )
    )
  );
--> statement-breakpoint

-- The expiry sweep is global rather than Companion-scoped, so its leading columns must match the
-- age/order predicate. Without this partial index every runtime claim would scan the entire queued
-- turn set just to discover whether a scheduled run crossed its grace window.
CREATE INDEX companion_turns_queued_routine_expiry_idx
  ON public.companion_turns (created_at, queue_sequence, id)
  WHERE status = 'queued' AND (routine_snapshot_id IS NOT NULL OR routine_name IS NOT NULL);
--> statement-breakpoint

-- A routine definition owns all queued turns for its exact generation. The snapshot timestamp is
-- part of the match so deleting and recreating a UUID cannot let the new definition cancel or
-- otherwise account for an old run. NULL generation stamps are retained for pre-0144 rows; they
-- are safe to cancel, and their missing generation already prevents terminal accounting from
-- touching a replacement definition.
CREATE FUNCTION public.companion_cancel_queued_routine_turns(
  p_org_id uuid,
  p_companion_id uuid,
  p_routine_id uuid,
  p_routine_created_at timestamp with time zone,
  p_reason_code text,
  p_reason_message text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_count integer;
BEGIN
  -- A cold scheduled send may have created a main-lane Start operation. Cancel that unclaimed
  -- derivative before settling its source turn, matching Runtime's operation -> turn lock order.
  -- A running operation has already crossed the claim boundary and is left to the fenced runtime;
  -- the claim predicate installed below independently prevents any stale pending derivative.
  UPDATE public.companion_operations operation_row
  SET status = 'cancelled',
      settled_at = v_now,
      updated_at = v_now
  WHERE operation_row.org_id = p_org_id
    AND operation_row.companion_id = p_companion_id
    AND operation_row.kind = 'start'
    AND operation_row.trigger = 'turn'
    AND operation_row.status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM public.companion_turns source_turn
      WHERE source_turn.org_id = operation_row.org_id
        AND source_turn.companion_id = operation_row.companion_id
        AND source_turn.id = operation_row.source_turn_id
        AND source_turn.status = 'queued'
        AND (
          (
            source_turn.routine_snapshot_id = p_routine_id
            AND (
              source_turn.routine_snapshot_created_at IS NULL
              OR source_turn.routine_snapshot_created_at = p_routine_created_at
            )
          )
          OR (
            source_turn.routine_snapshot_id IS NULL
            AND source_turn.routine_id = p_routine_id
          )
        )
    );

  UPDATE public.companion_turns turn_row
  SET status = 'cancelled',
      settled_at = v_now,
      state_changed_at = v_now,
      last_error_code = p_reason_code,
      last_error_message = p_reason_message,
      last_error_action = 'none',
      updated_at = v_now
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.status = 'queued'
    AND (
      (
        turn_row.routine_snapshot_id = p_routine_id
        AND (
          turn_row.routine_snapshot_created_at IS NULL
          OR turn_row.routine_snapshot_created_at = p_routine_created_at
        )
      )
      OR (
        turn_row.routine_snapshot_id IS NULL
        AND turn_row.routine_id = p_routine_id
      )
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_cancel_queued_routine_turns(
  uuid, uuid, uuid, timestamp with time zone, text, text
) FROM PUBLIC;
--> statement-breakpoint

-- The trigger is deliberately on the routine table: manual disable, five-failure auto-disable,
-- and permanent deletion all share the same atomic queued-turn invariant. The trigger runs before
-- the row mutation/FK action, so the routine generation is still available on DELETE.
CREATE FUNCTION public.companion_cancel_queued_routine_on_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.companion_cancel_queued_routine_turns(
      OLD.org_id,
      OLD.companion_id,
      OLD.id,
      OLD.created_at,
      'routine_deleted',
      'This scheduled run was skipped because the routine was deleted.'
    );
    RETURN OLD;
  END IF;

  IF OLD.enabled AND NOT NEW.enabled THEN
    PERFORM public.companion_cancel_queued_routine_turns(
      OLD.org_id,
      OLD.companion_id,
      OLD.id,
      OLD.created_at,
      'routine_disabled',
      'This scheduled run was skipped because the routine was disabled.'
    );
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_cancel_queued_routine_on_change() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_routines_cancel_queued_turns_on_disable
BEFORE UPDATE OF enabled ON public.companion_routines
FOR EACH ROW
WHEN (OLD.enabled AND NOT NEW.enabled)
EXECUTE FUNCTION public.companion_cancel_queued_routine_on_change();
--> statement-breakpoint

CREATE TRIGGER companion_routines_cancel_queued_turns_on_delete
BEFORE DELETE ON public.companion_routines
FOR EACH ROW
EXECUTE FUNCTION public.companion_cancel_queued_routine_on_change();
--> statement-breakpoint

-- Runtime invokes this bounded sweep before the existing lane-aware claim. It does not acquire a
-- Companion lease or instance lock. It cancels turn-derived Start work before settling the source
-- rows, matching Runtime's lock order. A caller processes at most 100 rows; later sweeps drain the
-- remainder.
CREATE FUNCTION public.companion_runtime_expire_queued_routine_turns(
  p_limit integer DEFAULT 100,
  p_gate_epoch bigint DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_enabled boolean;
  v_actual_gate_epoch bigint;
  v_turn_ids uuid[];
  v_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid routine queue cleanup limit' USING ERRCODE = '22023';
  END IF;

  IF p_gate_epoch IS NULL OR p_gate_epoch < 1 THEN
    RAISE EXCEPTION 'invalid routine queue cleanup gate epoch' USING ERRCODE = '22023';
  END IF;

  -- Hold a share lock through the cleanup transaction. Runtime disable takes the same control
  -- row exclusively before fencing leases, so cleanup either observes the exact live epoch or
  -- waits and becomes a no-op after the gate closes.
  SELECT control_row.enabled, control_row.gate_epoch
  INTO v_enabled, v_actual_gate_epoch
  FROM public.companion_runtime_control control_row
  WHERE control_row.id = 'runtime-v2'
  FOR SHARE;
  IF NOT COALESCE(v_enabled, false) OR v_actual_gate_epoch <> p_gate_epoch THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(array_agg(expired.id), ARRAY[]::uuid[])
  INTO v_turn_ids
  FROM (
    SELECT turn_row.id
    FROM public.companion_turns turn_row
    WHERE turn_row.status = 'queued'
      AND (turn_row.routine_snapshot_id IS NOT NULL OR turn_row.routine_name IS NOT NULL)
      AND turn_row.created_at < v_now - interval '10 minutes'
    ORDER BY turn_row.created_at, turn_row.queue_sequence, turn_row.id
    LIMIT p_limit
  ) expired;

  IF cardinality(v_turn_ids) = 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.companion_operations operation_row
  SET status = 'cancelled',
      settled_at = v_now,
      updated_at = v_now
  WHERE operation_row.kind = 'start'
    AND operation_row.trigger = 'turn'
    AND operation_row.status = 'pending'
    AND operation_row.source_turn_id = ANY(v_turn_ids);

  UPDATE public.companion_turns turn_row
  SET status = 'cancelled',
      settled_at = v_now,
      state_changed_at = v_now,
      last_error_code = 'routine_queue_expired',
      last_error_message = 'This scheduled run expired while waiting in the queue.',
      last_error_action = 'none',
      updated_at = v_now
  WHERE turn_row.id = ANY(v_turn_ids)
    AND turn_row.status = 'queued';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_expire_queued_routine_turns(integer, bigint) FROM PUBLIC;
--> statement-breakpoint

-- A routine can be disabled after its cold-start operation has already been claimed but before
-- the Box is ready. Authorization below makes the live executor release that now-invalid work at
-- its next checkpoint. If the executor died first, reconcile the orphan after its main-lane lease
-- expires so the one-running-operation invariant cannot strand a later user Start forever.
CREATE FUNCTION public.companion_runtime_reconcile_settled_turn_starts(
  p_limit integer DEFAULT 100,
  p_gate_epoch bigint DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_enabled boolean;
  v_actual_gate_epoch bigint;
  v_org_id uuid;
  v_companion_id uuid;
  v_operation_id uuid;
  v_checkpoint text;
  v_claim_epoch bigint;
  v_count integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid settled Start cleanup limit' USING ERRCODE = '22023';
  END IF;
  IF p_gate_epoch IS NULL OR p_gate_epoch < 1 THEN
    RAISE EXCEPTION 'invalid settled Start cleanup gate epoch' USING ERRCODE = '22023';
  END IF;

  SELECT control_row.enabled, control_row.gate_epoch
  INTO v_enabled, v_actual_gate_epoch
  FROM public.companion_runtime_control control_row
  WHERE control_row.id = 'runtime-v2'
  FOR SHARE;
  IF NOT COALESCE(v_enabled, false) OR v_actual_gate_epoch <> p_gate_epoch THEN
    RETURN 0;
  END IF;

  WHILE v_count < p_limit LOOP
    v_now := clock_timestamp();
    v_org_id := NULL;
    v_companion_id := NULL;
    v_operation_id := NULL;
    v_checkpoint := NULL;

    -- Runtime's lock order is lease -> instance -> work row. Only take a free/expired main lease;
    -- an active executor must observe the authorization denial and release its own fence.
    SELECT lease_row.org_id, lease_row.companion_id
    INTO v_org_id, v_companion_id
    FROM public.companion_runtime_leases lease_row
    WHERE lease_row.lane = 'main'
      AND (lease_row.claim_token IS NULL OR lease_row.expires_at <= v_now)
      AND EXISTS (
        SELECT 1
        FROM public.companion_operations operation_row
        JOIN public.companion_turns source_turn
          ON source_turn.org_id = operation_row.org_id
         AND source_turn.companion_id = operation_row.companion_id
         AND source_turn.id = operation_row.source_turn_id
        WHERE operation_row.org_id = lease_row.org_id
          AND operation_row.companion_id = lease_row.companion_id
          AND operation_row.kind = 'start'
          AND operation_row.trigger = 'turn'
          AND operation_row.status = 'running'
          AND source_turn.status <> 'queued'
      )
    ORDER BY lease_row.companion_id
    FOR UPDATE OF lease_row SKIP LOCKED
    LIMIT 1;
    IF NOT FOUND THEN EXIT; END IF;

    PERFORM 1
    FROM public.companion_runtime_instances instance_row
    WHERE instance_row.org_id = v_org_id
      AND instance_row.companion_id = v_companion_id
    FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT operation_row.id, operation_row.checkpoint
    INTO v_operation_id, v_checkpoint
    FROM public.companion_operations operation_row
    JOIN public.companion_turns source_turn
      ON source_turn.org_id = operation_row.org_id
     AND source_turn.companion_id = operation_row.companion_id
     AND source_turn.id = operation_row.source_turn_id
    WHERE operation_row.org_id = v_org_id
      AND operation_row.companion_id = v_companion_id
      AND operation_row.kind = 'start'
      AND operation_row.trigger = 'turn'
      AND operation_row.status = 'running'
      AND source_turn.status <> 'queued'
    ORDER BY operation_row.queue_sequence, operation_row.id
    FOR UPDATE OF operation_row;
    IF NOT FOUND THEN CONTINUE; END IF;

    UPDATE public.companion_operations operation_row
    SET status = CASE
          WHEN v_checkpoint = 'creating_box'
            THEN 'interrupted'::public.companion_operation_status
          ELSE 'cancelled'::public.companion_operation_status
        END,
        settled_at = v_now,
        last_error_code = CASE
          WHEN v_checkpoint = 'creating_box' THEN 'box_create_outcome_unknown'
          ELSE NULL
        END,
        last_error_message = CASE
          WHEN v_checkpoint = 'creating_box'
            THEN 'Box creation outcome is unknown after the lifecycle lease was lost.'
          ELSE NULL
        END,
        last_error_action = CASE
          WHEN v_checkpoint = 'creating_box'
            THEN 'none'::public.companion_runtime_error_action
          ELSE NULL
        END,
        updated_at = v_now
    WHERE operation_row.org_id = v_org_id
      AND operation_row.companion_id = v_companion_id
      AND operation_row.id = v_operation_id
      AND operation_row.status = 'running';
    IF NOT FOUND THEN CONTINUE; END IF;

    UPDATE public.companion_runtime_leases lease_row
    SET claim_token = NULL,
        claim_epoch = lease_row.claim_epoch + 1,
        gate_epoch = NULL,
        executor_id = NULL,
        work_kind = NULL,
        work_id = NULL,
        claimed_at = NULL,
        renewed_at = NULL,
        expires_at = NULL,
        updated_at = v_now
    WHERE lease_row.org_id = v_org_id
      AND lease_row.companion_id = v_companion_id
      AND lease_row.lane = 'main'
      AND lease_row.claim_token IS NOT NULL
      AND lease_row.expires_at <= v_now
    RETURNING lease_row.claim_epoch INTO v_claim_epoch;

    IF FOUND THEN
      UPDATE public.companion_runtime_instances instance_row
      SET last_write_epoch = GREATEST(instance_row.last_write_epoch, v_claim_epoch),
          updated_at = v_now
      WHERE instance_row.org_id = v_org_id
        AND instance_row.companion_id = v_companion_id;
    END IF;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_reconcile_settled_turn_starts(integer, bigint)
  FROM PUBLIC;
--> statement-breakpoint

-- When both lanes have ordinary queued work, prefer the main lane only at the existing global
-- priority tie. This protects a later user message from an older routine row without changing
-- lifecycle priority or making the routine lane globally subordinate: once the main lane is
-- occupied, the next claim still independently considers routine work.
DO $companion_main_queue_tie_break$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text;
  v_old text := $r$      i.health_due_at,
      i.companion_id$r$;
  v_new text := $r$      CASE WHEN l.lane = 'main' THEN 0 ELSE 1 END,
      i.health_due_at,
      i.companion_id$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'main queue tie-break rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_main_queue_tie_break$;
--> statement-breakpoint

-- Queued-turn cancellation already settles user-triggered Retry operations. A cold send owns a
-- turn-triggered Start instead; cancel that still-pending derivative in the same transaction so a
-- settled source can never leave higher-priority lifecycle work behind.
DO $companion_cancel_pending_turn_start$
DECLARE
  v_signature text := 'public.companion_api_cancel_turn(uuid,uuid,uuid)';
  v_definition text;
  v_old text := $r$    AND retry_operation.kind IN ('start', 'restart_pi')
    AND retry_operation.trigger = 'user'
    AND retry_operation.status = 'pending';$r$;
  v_new text := $r$    AND (
      (
        retry_operation.kind IN ('start', 'restart_pi')
        AND retry_operation.trigger = 'user'
      )
      OR (
        retry_operation.kind = 'start'
        AND retry_operation.trigger = 'turn'
      )
    )
    AND retry_operation.status = 'pending';$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'pending turn Start cancellation rewrite matched %, expected 1',
      COALESCE(v_count, 0) USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_cancel_pending_turn_start$;
--> statement-breakpoint

-- Defense in depth for turn-derived lifecycle work: a Start whose source has already settled is
-- not executable. This also protects rows written by an older API during a rolling deployment and
-- makes the purge invariant independent of trigger timing.
DO $companion_live_start_source_guard$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text;
  v_old text := $r$        AND o.kind = 'start'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$;
  v_new text := $r$        AND o.kind = 'start'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        AND (
          o.trigger <> 'turn'
          OR EXISTS (
            SELECT 1
            FROM public.companion_turns source_turn
            WHERE source_turn.org_id = o.org_id
              AND source_turn.companion_id = o.companion_id
              AND source_turn.id = o.source_turn_id
              AND source_turn.status = 'queued'
          )
        )$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'live Start source guard rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_live_start_source_guard$;
--> statement-breakpoint

-- A Start claim remains fenced while its lease is live, but its source turn can be atomically
-- settled by user cancellation or routine disable/delete in another transaction. Refuse any later
-- Box contact for that claim. Runtime treats this denial as a handoff: it releases the lease, after
-- which the bounded reconciliation above terminalizes the orphan before another claim is selected.
DO $companion_live_start_authorization_guard$
DECLARE
  v_signature text :=
    'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)';
  v_definition text;
  v_old text := $r$    IF NOT FOUND THEN RETURN; END IF;
    v_requires_resources := v_operation_kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings');$r$;
  v_new text := $r$    IF NOT FOUND THEN RETURN; END IF;
    IF v_operation_kind = 'start'
       AND v_turn_id IS NOT NULL
       AND v_turn_status IS DISTINCT FROM 'queued' THEN
      v_denial_code := 'source_turn_settled';
    END IF;
    v_requires_resources := v_operation_kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings');$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'live Start authorization guard rewrite matched %, expected 1',
      COALESCE(v_count, 0) USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_live_start_authorization_guard$;
--> statement-breakpoint

-- Immediately repair rows stranded by an older executor or by a definition disabled/deleted
-- before this migration. Exact live generations are preserved while enabled and inside the TTL;
-- a missing generation is a deleted definition, including the legacy shape whose FK was SET NULL.
-- routine_name remains the compatibility marker for those pre-snapshot rows.
WITH stranded AS (
  SELECT
    turn_row.id,
    CASE
      WHEN routine_row.id IS NOT NULL AND NOT routine_row.enabled THEN 'routine_disabled'
      WHEN routine_row.id IS NULL THEN 'routine_deleted'
      ELSE 'routine_queue_expired'
    END AS reason_code,
    CASE
      WHEN routine_row.id IS NOT NULL AND NOT routine_row.enabled
        THEN 'This scheduled run was skipped because the routine was disabled.'
      WHEN routine_row.id IS NULL
        THEN 'This scheduled run was skipped because the routine was deleted.'
      ELSE 'This scheduled run expired while waiting in the queue.'
    END AS reason_message
  FROM public.companion_turns turn_row
  LEFT JOIN public.companion_routines routine_row
    ON routine_row.org_id = turn_row.org_id
   AND routine_row.companion_id = turn_row.companion_id
   AND (
     (
       turn_row.routine_snapshot_created_at IS NOT NULL
       AND routine_row.id = turn_row.routine_snapshot_id
       AND routine_row.created_at = turn_row.routine_snapshot_created_at
     )
     OR (
       turn_row.routine_snapshot_created_at IS NULL
       AND turn_row.routine_id IS NOT NULL
       AND routine_row.id = turn_row.routine_id
     )
   )
  WHERE turn_row.status = 'queued'
    AND (turn_row.routine_snapshot_id IS NOT NULL OR turn_row.routine_name IS NOT NULL)
    AND (
      routine_row.id IS NULL
      OR NOT routine_row.enabled
      OR turn_row.created_at < statement_timestamp() - interval '10 minutes'
    )
  FOR UPDATE OF turn_row SKIP LOCKED
)
UPDATE public.companion_turns turn_row
SET status = 'cancelled',
    settled_at = statement_timestamp(),
    state_changed_at = statement_timestamp(),
    last_error_code = stranded.reason_code,
    last_error_message = stranded.reason_message,
    last_error_action = 'none',
    updated_at = statement_timestamp()
FROM stranded
WHERE turn_row.id = stranded.id
  AND turn_row.status = 'queued';
--> statement-breakpoint

-- The backfill above and older API releases may have left an unclaimed cold-start derivative behind
-- any already-settled source. Remove every such pending turn Start before the source guard becomes
-- authoritative so neither routine nor ordinary cancellation can retain lifecycle priority.
UPDATE public.companion_operations operation_row
SET status = 'cancelled',
    settled_at = statement_timestamp(),
    updated_at = statement_timestamp()
WHERE operation_row.kind = 'start'
  AND operation_row.trigger = 'turn'
  AND operation_row.status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM public.companion_turns source_turn
    WHERE source_turn.org_id = operation_row.org_id
      AND source_turn.companion_id = operation_row.companion_id
      AND source_turn.id = operation_row.source_turn_id
      AND source_turn.status <> 'queued'
  );
--> statement-breakpoint

-- Keep the existing claim state machine and 0139 main/routine lane predicates intact. The wrapper
-- is the only new boundary: cleanup happens once before the material claimer starts and remains
-- bounded independently of the number of lane candidates.
CREATE OR REPLACE FUNCTION public.companion_runtime_claim_work(
  p_executor_id text,
  p_limit integer,
  p_lease_seconds integer,
  p_gate_epoch bigint,
  p_material_protocol integer,
  p_delete_resume_protocol integer
)
RETURNS TABLE(
  org_id uuid, companion_id uuid, claim_token uuid, claim_epoch bigint, gate_epoch bigint,
  work_kind public.companion_runtime_work_kind, work_id uuid, actor_id text,
  client_surface public.companion_client_surface, runtime_generation bigint, checkpoint text,
  checkpoint_sequence bigint, turn_id uuid, turn_status public.companion_turn_status,
  attempt_status public.companion_attempt_status, dispatch_state public.companion_dispatch_state,
  event_cursor bigint, unknown_event_count integer, malformed_event_count integer,
  oversized_event_count integer, cold_start_deadline_at timestamp with time zone,
  inactivity_deadline_at timestamp with time zone, absolute_deadline_at timestamp with time zone,
  operation_kind public.companion_operation_kind, operation_started_at timestamp with time zone,
  operation_attempt_count integer, provider_operation_id text, target_settings_revision bigint,
  target_skills_revision integer, decision_status public.companion_decision_status,
  decision_delivery_state public.companion_decision_delivery_state
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
BEGIN
  IF p_material_protocol IS DISTINCT FROM 4 THEN RETURN; END IF;
  PERFORM public.companion_runtime_expire_queued_routine_turns(
    greatest(1, least(COALESCE(p_limit, 1), 100)),
    p_gate_epoch
  );
  PERFORM public.companion_runtime_reconcile_settled_turn_starts(
    greatest(1, least(COALESCE(p_limit, 1), 100)),
    p_gate_epoch
  );
  RETURN QUERY SELECT * FROM public.companion_runtime_claim_work_material_v1(
    p_executor_id, p_limit, p_lease_seconds, p_gate_epoch, 1, p_delete_resume_protocol
  );
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(
  text, integer, integer, bigint, integer, integer
) FROM PUBLIC;
