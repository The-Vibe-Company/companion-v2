-- Isolated routine sessions have their own broker and Pi process. Give that physical isolation a
-- matching PostgreSQL scheduling lane: one main attempt and one routine attempt may execute for a
-- Companion, while each lane remains FIFO and independently takeover-safe.

ALTER TABLE public.companion_runtime_leases
  ADD COLUMN lane text NOT NULL DEFAULT 'main';
--> statement-breakpoint

ALTER TABLE public.companion_runtime_leases
  DROP CONSTRAINT companion_runtime_leases_pkey,
  DROP CONSTRAINT companion_runtime_leases_org_companion_uq,
  ADD CONSTRAINT companion_runtime_leases_lane_check CHECK (lane IN ('main', 'routine')),
  ADD CONSTRAINT companion_runtime_leases_pkey PRIMARY KEY (companion_id, lane),
  ADD CONSTRAINT companion_runtime_leases_org_companion_lane_uq
    UNIQUE (org_id, companion_id, lane);
--> statement-breakpoint

INSERT INTO public.companion_runtime_leases(org_id, companion_id, lane)
SELECT instance.org_id, instance.companion_id, 'routine'
FROM public.companion_runtime_instances instance
ON CONFLICT ON CONSTRAINT companion_runtime_leases_pkey DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_create_lease_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  -- Disable closes the materialized lease set while holding this row exclusively. Keep instance
  -- creation behind that boundary so it cannot add either lane after disable scans the leases but
  -- before the new gate becomes visible.
  PERFORM 1
  FROM public.companion_runtime_control control_row
  WHERE control_row.id = 'runtime-v2'
  FOR SHARE;

  INSERT INTO public.companion_runtime_leases(org_id, companion_id, lane)
  VALUES (NEW.org_id, NEW.companion_id, 'main'), (NEW.org_id, NEW.companion_id, 'routine')
  ON CONFLICT ON CONSTRAINT companion_runtime_leases_pkey DO NOTHING;
  RETURN NEW;
END
$$;
--> statement-breakpoint

ALTER TABLE public.companion_turn_attempts
  ADD COLUMN execution_lane text NOT NULL DEFAULT 'main';
--> statement-breakpoint

UPDATE public.companion_turn_attempts attempt
SET execution_lane = 'routine'
FROM public.companion_turns turn_row
WHERE turn_row.org_id = attempt.org_id
  AND turn_row.companion_id = attempt.companion_id
  AND turn_row.id = attempt.turn_id
  AND turn_row.routine_snapshot_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.companion_turn_attempts
  ADD CONSTRAINT companion_turn_attempts_execution_lane_check
    CHECK (execution_lane IN ('main', 'routine'));
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_assign_attempt_lane()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  SELECT CASE WHEN turn_row.routine_snapshot_id IS NULL THEN 'main' ELSE 'routine' END
  INTO STRICT NEW.execution_lane
  FROM public.companion_turns turn_row
  WHERE turn_row.org_id = NEW.org_id
    AND turn_row.companion_id = NEW.companion_id
    AND turn_row.id = NEW.turn_id;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_assign_attempt_lane() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_turn_attempts_00_assign_execution_lane
BEFORE INSERT ON public.companion_turn_attempts
FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_assign_attempt_lane();
--> statement-breakpoint

DROP INDEX public.companion_turns_one_active_uq;
DROP INDEX public.companion_turn_attempts_one_active_uq;
--> statement-breakpoint

CREATE UNIQUE INDEX companion_turns_one_active_main_uq
  ON public.companion_turns(companion_id)
  WHERE status IN ('starting', 'dispatching', 'running', 'needs_input')
    AND routine_snapshot_id IS NULL;
CREATE UNIQUE INDEX companion_turns_one_active_routine_uq
  ON public.companion_turns(companion_id)
  WHERE status IN ('starting', 'dispatching', 'running', 'needs_input')
    AND routine_snapshot_id IS NOT NULL;
CREATE UNIQUE INDEX companion_turn_attempts_one_active_lane_uq
  ON public.companion_turn_attempts(companion_id, execution_lane)
  WHERE status IN ('starting', 'dispatching', 'running', 'needs_input');
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_turn_lane(
  p_org_id uuid,
  p_companion_id uuid,
  p_turn_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT CASE WHEN turn_row.routine_snapshot_id IS NULL THEN 'main' ELSE 'routine' END
  FROM public.companion_turns turn_row
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_operation_lane(
  p_org_id uuid,
  p_companion_id uuid,
  p_operation_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT CASE
    WHEN operation.kind = 'restart_pi'
      AND operation.trigger = 'user'
      AND source_turn.routine_snapshot_id IS NOT NULL
      THEN 'routine'
    ELSE 'main'
  END
  FROM public.companion_operations operation
  LEFT JOIN public.companion_turns source_turn
    ON source_turn.org_id = operation.org_id
   AND source_turn.companion_id = operation.companion_id
   AND source_turn.id = operation.source_turn_id
  WHERE operation.org_id = p_org_id
    AND operation.companion_id = p_companion_id
    AND operation.id = p_operation_id
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_turn_lane(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_operation_lane(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- Shared Box lifecycle and staging work may not overlap a routine process. An interrupted routine
-- remains non-quiescent until its explicit Retry or Cancel resolves the possibly-live run root.
CREATE FUNCTION public.companion_runtime_routine_lane_quiescent(
  p_org_id uuid,
  p_companion_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.companion_turns turn_row
    WHERE turn_row.org_id = p_org_id
      AND turn_row.companion_id = p_companion_id
      AND turn_row.routine_snapshot_id IS NOT NULL
      AND turn_row.status IN (
        'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
      )
  )
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_routine_lane_quiescent(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- Preserve the mature claim state machine and rewrite only its scheduling predicates. The exact
-- match assertions are a rolling-deploy guard: if an earlier migration changes the claimer, this
-- migration fails instead of silently installing a partially lane-aware scheduler.
DO $companion_parallel_claim$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text;
  v_old text[] := ARRAY[
$r$  v_examined_companion_ids uuid[] := ARRAY[]::uuid[];$r$,
$r$    v_client_surface := NULL;$r$,
$r$    SELECT i.org_id, i.companion_id
    INTO v_org_id, v_companion_id
    FROM public.companion_runtime_instances i
    JOIN public.companion_runtime_leases l
      ON l.org_id = i.org_id AND l.companion_id = i.companion_id$r$,
$r$      AND NOT (i.companion_id = ANY(v_examined_companion_ids))$r$,
$r$    v_examined_companion_ids := array_append(v_examined_companion_ids, v_companion_id);$r$,
$r$    WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
      AND o.kind = 'delete' AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$,
$r$      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind IN ('stop', 'restart_pi', 'restart_box')
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$,
$r$      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id
        AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')$r$,
$r$      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')$r$,
$r$      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind = 'start'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$,
$r$      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind = 'apply_settings'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$,
$r$      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND ($r$,
$r$      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id AND t.status = 'queued'
        AND EXISTS ($r$,
$r$        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns earlier_turn
          WHERE earlier_turn.org_id = t.org_id
            AND earlier_turn.companion_id = t.companion_id
            AND earlier_turn.status = 'queued'
            AND earlier_turn.queue_sequence < t.queue_sequence
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns active_turn
          WHERE active_turn.org_id = v_org_id
            AND active_turn.companion_id = v_companion_id
            AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
        )$r$,
$r$      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND i.health_due_at <= v_now AND i.retirement_state <> 'retired';$r$,
$r$      WHERE l.org_id = v_org_id AND l.companion_id = v_companion_id
      RETURNING l.claim_epoch INTO v_claim_epoch;$r$,
$r$    v_claim_token := gen_random_uuid();
    v_claim_epoch := NULL;
    UPDATE public.companion_runtime_leases l
    SET claim_token = v_claim_token,
        claim_epoch = l.claim_epoch + 1,$r$,
$r$    WHERE l.org_id = v_org_id
      AND l.companion_id = v_companion_id
      AND (l.claim_token IS NULL OR l.expires_at <= v_now)$r$,
$r$      IF v_operation_kind IN ('delete', 'stop', 'restart_pi', 'restart_box') THEN$r$
  ];
  v_new text[] := ARRAY[
$r$  v_examined_lease_keys text[] := ARRAY[]::text[];
  v_lane text;$r$,
$r$    v_client_surface := NULL;
    v_lane := NULL;$r$,
$r$    SELECT i.org_id, i.companion_id, l.lane
    INTO v_org_id, v_companion_id, v_lane
    FROM public.companion_runtime_instances i
    JOIN public.companion_runtime_leases l
      ON l.org_id = i.org_id AND l.companion_id = i.companion_id$r$,
$r$      AND NOT ((i.companion_id::text || ':' || l.lane) = ANY(v_examined_lease_keys))$r$,
$r$    v_examined_lease_keys := array_append(
      v_examined_lease_keys, v_companion_id::text || ':' || v_lane
    );$r$,
$r$    WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
      AND v_lane = 'main'
      AND public.companion_runtime_routine_lane_quiescent(v_org_id, v_companion_id)
      AND o.kind = 'delete' AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$,
$r$      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND public.companion_runtime_operation_lane(o.org_id, o.companion_id, o.id) = v_lane
        AND (
          v_lane = 'routine'
          OR public.companion_runtime_routine_lane_quiescent(v_org_id, v_companion_id)
        )
        AND o.kind IN ('stop', 'restart_pi', 'restart_box')
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$,
$r$      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id
        AND public.companion_runtime_turn_lane(d.org_id, d.companion_id, d.turn_id) = v_lane
        AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')$r$,
$r$      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.execution_lane = v_lane
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')$r$,
$r$      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND v_lane = 'main'
        AND public.companion_runtime_routine_lane_quiescent(v_org_id, v_companion_id)
        AND o.kind = 'start'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$,
$r$      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND v_lane = 'main'
        AND public.companion_runtime_routine_lane_quiescent(v_org_id, v_companion_id)
        AND o.kind = 'apply_settings'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$,
$r$      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND v_lane = 'main'
        AND public.companion_runtime_routine_lane_quiescent(v_org_id, v_companion_id)
        AND ($r$,
$r$      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id AND t.status = 'queued'
        AND public.companion_runtime_turn_lane(t.org_id, t.companion_id, t.id) = v_lane
        AND (
          v_lane = 'main'
          OR NOT EXISTS (
            SELECT 1 FROM public.companion_operations lane_operation
            WHERE lane_operation.org_id = t.org_id
              AND lane_operation.companion_id = t.companion_id
              AND lane_operation.status IN ('pending', 'running')
              AND public.companion_runtime_operation_lane(
                lane_operation.org_id, lane_operation.companion_id, lane_operation.id
              ) = 'main'
          )
        )
        AND EXISTS ($r$,
$r$        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns earlier_turn
          WHERE earlier_turn.org_id = t.org_id
            AND earlier_turn.companion_id = t.companion_id
            AND earlier_turn.status = 'queued'
            AND public.companion_runtime_turn_lane(
              earlier_turn.org_id, earlier_turn.companion_id, earlier_turn.id
            ) = v_lane
            AND earlier_turn.queue_sequence < t.queue_sequence
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns active_turn
          WHERE active_turn.org_id = v_org_id
            AND active_turn.companion_id = v_companion_id
            AND public.companion_runtime_turn_lane(
              active_turn.org_id, active_turn.companion_id, active_turn.id
            ) = v_lane
            AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
        )$r$,
$r$      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND v_lane = 'main'
        AND public.companion_runtime_routine_lane_quiescent(v_org_id, v_companion_id)
        AND i.health_due_at <= v_now AND i.retirement_state <> 'retired';$r$,
$r$      WHERE l.org_id = v_org_id AND l.companion_id = v_companion_id
        AND l.lane = v_lane
      RETURNING l.claim_epoch INTO v_claim_epoch;$r$,
$r$    v_claim_token := gen_random_uuid();
    UPDATE public.companion_runtime_instances claim_instance
    SET last_write_epoch = GREATEST(
          claim_instance.last_write_epoch,
          COALESCE((
            SELECT max(epoch_source.claim_epoch)
            FROM public.companion_runtime_leases epoch_source
            WHERE epoch_source.org_id = v_org_id
              AND epoch_source.companion_id = v_companion_id
          ), 0)
        ) + 1,
        updated_at = v_now
    WHERE claim_instance.org_id = v_org_id
      AND claim_instance.companion_id = v_companion_id
    RETURNING claim_instance.last_write_epoch INTO v_claim_epoch;
    UPDATE public.companion_runtime_leases l
    SET claim_token = v_claim_token,
        claim_epoch = v_claim_epoch,$r$,
$r$    WHERE l.org_id = v_org_id
      AND l.companion_id = v_companion_id
      AND l.lane = v_lane
      AND (l.claim_token IS NULL OR l.expires_at <= v_now)$r$,
$r$      IF v_lane = 'main'
         AND v_operation_kind IN ('delete', 'stop', 'restart_pi', 'restart_box') THEN$r$
  ];
  v_expected integer[] := ARRAY[
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 3, 1, 1, 1
  ];
  v_count integer;
  v_index integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Companion runtime claim implementation is missing' USING ERRCODE = '55000';
  END IF;
  IF cardinality(v_old) <> cardinality(v_new)
     OR cardinality(v_old) <> cardinality(v_expected) THEN
    RAISE EXCEPTION 'parallel claim rewrite table is malformed' USING ERRCODE = '55000';
  END IF;
  FOR v_index IN 1..cardinality(v_old) LOOP
    v_count := (
      char_length(v_definition) - char_length(replace(v_definition, v_old[v_index], ''))
    ) / char_length(v_old[v_index]);
    IF v_count <> v_expected[v_index] THEN
      RAISE EXCEPTION 'parallel claim rewrite % matched %, expected %',
        v_index, v_count, v_expected[v_index] USING ERRCODE = '55000';
    END IF;
    v_definition := replace(v_definition, v_old[v_index], v_new[v_index]);
  END LOOP;
  EXECUTE v_definition;
END
$companion_parallel_claim$;
--> statement-breakpoint

DO $companion_parallel_material_guard$
DECLARE
  v_signature text := 'public.companion_runtime_prepare_queued_turn_material(bigint)';
  v_definition text;
  v_old text[] := ARRAY[
$r$  WHERE control.enabled
    AND control.gate_epoch = p_gate_epoch$r$,
$r$            AND earlier_turn.status = 'queued'
            AND earlier_turn.queue_sequence < queued_turn.queue_sequence$r$,
$r$        AND earlier_turn.status = 'queued'
        AND earlier_turn.queue_sequence < queued_turn.queue_sequence$r$,
$r$            AND active_turn.companion_id = instance.companion_id
            AND active_turn.status IN (
              'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
            )$r$,
$r$        AND active_turn.companion_id = instance.companion_id
        AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')$r$,
$r$          AND instance.pi_state = 'idle'$r$,
$r$      AND instance.pi_state = 'idle'$r$
  ];
  v_new text[] := ARRAY[
$r$  WHERE control.enabled
    AND lease.lane = 'main'
    AND control.gate_epoch = p_gate_epoch$r$,
$r$            AND earlier_turn.status = 'queued'
            AND public.companion_runtime_turn_lane(
              earlier_turn.org_id, earlier_turn.companion_id, earlier_turn.id
            ) = public.companion_runtime_turn_lane(
              queued_turn.org_id, queued_turn.companion_id, queued_turn.id
            )
            AND earlier_turn.queue_sequence < queued_turn.queue_sequence$r$,
$r$        AND earlier_turn.status = 'queued'
        AND public.companion_runtime_turn_lane(
          earlier_turn.org_id, earlier_turn.companion_id, earlier_turn.id
        ) = public.companion_runtime_turn_lane(
          queued_turn.org_id, queued_turn.companion_id, queued_turn.id
        )
        AND earlier_turn.queue_sequence < queued_turn.queue_sequence$r$,
$r$            AND active_turn.companion_id = instance.companion_id
            AND public.companion_runtime_turn_lane(
              active_turn.org_id, active_turn.companion_id, active_turn.id
            ) = public.companion_runtime_turn_lane(
              queued_turn.org_id, queued_turn.companion_id, queued_turn.id
            )
            AND active_turn.status IN (
              'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
            )$r$,
$r$        AND active_turn.companion_id = instance.companion_id
        AND public.companion_runtime_turn_lane(
          active_turn.org_id, active_turn.companion_id, active_turn.id
        ) = public.companion_runtime_turn_lane(
          queued_turn.org_id, queued_turn.companion_id, queued_turn.id
        )
        AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')$r$,
$r$          AND (queued_turn.routine_snapshot_id IS NOT NULL OR instance.pi_state = 'idle')$r$,
$r$      AND (queued_turn.routine_snapshot_id IS NOT NULL OR instance.pi_state = 'idle')$r$
  ];
  v_index integer;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'queued material guard is missing' USING ERRCODE = '55000';
  END IF;
  FOR v_index IN 1..cardinality(v_old) LOOP
    v_count := (
      char_length(v_definition) - char_length(replace(v_definition, v_old[v_index], ''))
    ) / char_length(v_old[v_index]);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'parallel material rewrite % matched %, expected 1', v_index, v_count
        USING ERRCODE = '55000';
    END IF;
    v_definition := replace(v_definition, v_old[v_index], v_new[v_index]);
  END LOOP;
  EXECUTE v_definition;
END
$companion_parallel_material_guard$;
--> statement-breakpoint

DO $companion_parallel_renewal$
DECLARE
  v_signature text :=
    'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)';
  v_definition text;
  v_old text[] := ARRAY[
$r$  v_higher_priority_pending boolean := false;$r$,
$r$  v_work_priority := CASE$r$,
$r$      AND (p_work_kind <> 'operation' OR o.id <> p_work_id)
      -- A stale lifecycle intent$r$,
$r$      AND CASE
        WHEN o.kind = 'delete' THEN 10$r$,
$r$      AND d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')$r$
  ];
  v_new text[] := ARRAY[
$r$  v_higher_priority_pending boolean := false;
  v_work_lane text;$r$,
$r$  v_work_lane := CASE
    WHEN p_work_kind = 'operation' THEN public.companion_runtime_operation_lane(
      p_org_id, p_companion_id, p_work_id
    )
    WHEN p_work_kind IN ('attempt', 'decision') THEN public.companion_runtime_turn_lane(
      p_org_id, p_companion_id, v_turn_id
    )
    ELSE 'main'
  END;
  IF v_work_lane IS NULL THEN RETURN; END IF;
  v_work_priority := CASE$r$,
$r$      AND (p_work_kind <> 'operation' OR o.id <> p_work_id)
      AND public.companion_runtime_operation_lane(
        o.org_id, o.companion_id, o.id
      ) = v_work_lane
      -- A stale lifecycle intent$r$,
$r$      AND CASE
        WHEN o.kind = 'delete' THEN 10$r$,
$r$      AND d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND public.companion_runtime_turn_lane(d.org_id, d.companion_id, d.turn_id) = v_work_lane
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')$r$
  ];
  v_index integer;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'runtime renewal implementation is missing' USING ERRCODE = '55000';
  END IF;
  FOR v_index IN 1..cardinality(v_old) LOOP
    v_count := (
      char_length(v_definition) - char_length(replace(v_definition, v_old[v_index], ''))
    ) / char_length(v_old[v_index]);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'parallel renewal rewrite % matched %, expected 1', v_index, v_count
        USING ERRCODE = '55000';
    END IF;
    v_definition := replace(v_definition, v_old[v_index], v_new[v_index]);
  END LOOP;
  EXECUTE v_definition;
END
$companion_parallel_renewal$;
--> statement-breakpoint

-- A routine Retry is represented by the existing restart_pi operation contract, but its only
-- external effect is terminating that run's old isolated invocation. Expose the exact invocation
-- through the already-private authorization row so apps/runtime never guesses or touches main Pi.
DO $companion_routine_retry_identity$
DECLARE
  v_signature text :=
    'public.companion_runtime_renew_and_authorize_v2(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)';
  v_old text :=
$r$      ) AND p_work_kind = 'attempt' THEN (
        SELECT attempt.pi_invocation_id
        FROM public.companion_turn_attempts attempt
        WHERE attempt.org_id = p_org_id
          AND attempt.companion_id = p_companion_id
          AND attempt.id = p_work_id
          AND attempt.claim_epoch = p_claim_epoch
      )
      ELSE NULL::text$r$;
  v_new text :=
$r$      ) AND p_work_kind = 'attempt' THEN (
        SELECT attempt.pi_invocation_id
        FROM public.companion_turn_attempts attempt
        WHERE attempt.org_id = p_org_id
          AND attempt.companion_id = p_companion_id
          AND attempt.id = p_work_id
          AND attempt.claim_epoch = p_claim_epoch
      )
      WHEN authorization_row.authorized
        AND p_work_kind = 'operation'
        AND public.companion_runtime_operation_lane(
          p_org_id, p_companion_id, p_work_id
        ) = 'routine' THEN (
        SELECT attempt.pi_invocation_id
        FROM public.companion_turn_attempts attempt
        WHERE attempt.org_id = p_org_id
          AND attempt.companion_id = p_companion_id
          AND attempt.turn_id = authorization_row.turn_id
          AND attempt.pi_invocation_id IS NOT NULL
        ORDER BY attempt.attempt_number DESC, attempt.id DESC
        LIMIT 1
      )
      ELSE NULL::text$r$;
  v_definition text;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'routine retry identity rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_routine_retry_identity$;
--> statement-breakpoint

DO $companion_routine_retry_preemption$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text;
  v_old text[] := ARRAY[
$r$        WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
          AND o.id <> v_work_id$r$,
$r$      WHERE v_operation_kind IN ('stop', 'restart_pi', 'restart_box')
        AND t.org_id = v_org_id AND t.companion_id = v_companion_id$r$
  ];
  v_new text[] := ARRAY[
$r$        WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
          AND v_lane = 'main'
          AND o.id <> v_work_id$r$,
$r$      WHERE v_lane = 'main'
        AND v_operation_kind IN ('stop', 'restart_pi', 'restart_box')
        AND t.org_id = v_org_id AND t.companion_id = v_companion_id$r$
  ];
  v_index integer;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  FOR v_index IN 1..cardinality(v_old) LOOP
    v_count := (
      char_length(v_definition) - char_length(replace(v_definition, v_old[v_index], ''))
    ) / char_length(v_old[v_index]);
    IF v_definition IS NULL OR v_count <> 1 THEN
      RAISE EXCEPTION 'routine retry preemption rewrite % matched %, expected 1',
        v_index, COALESCE(v_count, 0) USING ERRCODE = '55000';
    END IF;
    v_definition := replace(v_definition, v_old[v_index], v_new[v_index]);
  END LOOP;
  EXECUTE v_definition;
END
$companion_routine_retry_preemption$;
--> statement-breakpoint

-- The routine lane reuses restart_pi as its public retry operation, but its terminal proof is that
-- the exact isolated invocation was terminated; it does not restart or replace the main Pi.
DO $companion_routine_retry_checkpoint$
DECLARE
  v_signature text :=
    'public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,'
    || 'timestamptz,integer,integer,integer)';
  v_old text := $r$      OR (v_operation_kind = 'restart_pi' AND (
        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'restarting_pi')$r$;
  v_new text := $r$      OR (v_operation_kind = 'restart_pi' AND (
        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'pi_ready'
          AND public.companion_runtime_operation_lane(
            p_org_id, p_companion_id, p_work_id
          ) = 'routine')
        OR (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'restarting_pi')$r$;
  v_definition text;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'routine retry checkpoint rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_routine_retry_checkpoint$;
--> statement-breakpoint

-- Protocol 4 is the lane-aware claim boundary. Protocol-3 replicas may finish leases they already
-- hold through the unchanged token/work fences, but cannot claim a second lane accidentally.
DO $companion_parallel_claim_protocol$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work(text,integer,integer,bigint,integer,integer)';
  v_old text := 'IF p_material_protocol IS DISTINCT FROM 3 THEN RETURN; END IF;';
  v_new text := 'IF p_material_protocol IS DISTINCT FROM 4 THEN RETURN; END IF;';
  v_definition text;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'parallel claim protocol rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_parallel_claim_protocol$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(
  text, integer, integer, bigint, integer, integer
) FROM PUBLIC;
--> statement-breakpoint

DO $companion_main_thread_runtime_projection$
DECLARE
  v_signatures text[] := ARRAY[
    'public.companion_api_read_thread(uuid,uuid)',
    'public.companion_api_read_runtime(uuid,uuid)',
    'public.companion_api_list_runtime(uuid)'
  ];
  v_definition text;
  v_signature text;
  v_old text[] := ARRAY[
$r$      AND active.status IN ('starting', 'dispatching', 'running', 'needs_input')$r$,
$r$        AND queued.status = 'queued'$r$,
$r$AND interrupted.status = 'interrupted'$r$
  ];
  v_new text[] := ARRAY[
$r$      AND active.routine_snapshot_id IS NULL
      AND active.status IN ('starting', 'dispatching', 'running', 'needs_input')$r$,
$r$        AND queued.routine_snapshot_id IS NULL
        AND queued.status = 'queued'$r$,
$r$AND interrupted.routine_snapshot_id IS NULL
      AND interrupted.status = 'interrupted'$r$
  ];
  v_index integer;
  v_count integer;
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
    IF v_definition IS NULL THEN
      RAISE EXCEPTION 'main-thread projection % is missing', v_signature USING ERRCODE = '55000';
    END IF;
    FOR v_index IN 1..cardinality(v_old) LOOP
      v_count := (
        char_length(v_definition) - char_length(replace(v_definition, v_old[v_index], ''))
      ) / char_length(v_old[v_index]);
      IF v_count <> 1 THEN
        RAISE EXCEPTION 'projection % rewrite % matched %, expected 1',
          v_signature, v_index, v_count USING ERRCODE = '55000';
      END IF;
      v_definition := replace(v_definition, v_old[v_index], v_new[v_index]);
    END LOOP;
    EXECUTE v_definition;
  END LOOP;
END
$companion_main_thread_runtime_projection$;
--> statement-breakpoint

DO $companion_turn_replying_projection$
DECLARE
  v_signature text := 'public.companion_api_turn_json(uuid,uuid,uuid)';
  v_old text := $r$    'replying', turn_row.status = 'running'
      AND COALESCE($r$;
  v_new text := $r$    'replying', turn_row.routine_snapshot_id IS NULL
      AND turn_row.status = 'running'
      AND COALESCE($r$;
  v_definition text;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'turn replying projection rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_turn_replying_projection$;
--> statement-breakpoint

-- A message in the main conversation may supersede a main-Pi question, but it is unrelated to a
-- private routine decision running concurrently in the isolated lane.
DO $companion_parallel_decision_waits$
DECLARE
  v_signatures text[] := ARRAY[
    'public.companion_runtime_supersede_decision_on_member_turn()',
    'public.companion_runtime_reconcile_projected_decision_with_member_turn()'
  ];
  v_old text := $r$AND decision_turn.id = delivery.turn_id$r$;
  v_new text := $r$AND decision_turn.id = delivery.turn_id
      AND decision_turn.routine_snapshot_id IS NULL$r$;
  v_definition text;
  v_signature text;
  v_count integer;
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
    v_count := (
      char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
    ) / char_length(v_old);
    IF v_definition IS NULL OR v_count <> 1 THEN
      RAISE EXCEPTION 'parallel decision rewrite % matched %, expected 1',
        v_signature, COALESCE(v_count, 0) USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(v_definition, v_old, v_new);
  END LOOP;
END
$companion_parallel_decision_waits$;
--> statement-breakpoint
