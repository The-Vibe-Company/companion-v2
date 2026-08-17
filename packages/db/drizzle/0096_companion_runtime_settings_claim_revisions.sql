-- Settings claims must return the frozen revision snapshot. claim_work captured
-- settings_claim_revision on the instance but left target_settings_revision /
-- target_skills_revision null on the returned row, so the JS decoder rejected
-- every settings claim. Layout 14 never installed and Pi never started.

CREATE OR REPLACE FUNCTION public.companion_runtime_claim_work(p_executor_id text, p_limit integer, p_lease_seconds integer, p_gate_epoch bigint)
 RETURNS TABLE(org_id uuid, companion_id uuid, claim_token uuid, claim_epoch bigint, gate_epoch bigint, work_kind companion_runtime_work_kind, work_id uuid, actor_id text, client_surface companion_client_surface, runtime_generation bigint, checkpoint text, checkpoint_sequence bigint, turn_id uuid, turn_status companion_turn_status, attempt_status companion_attempt_status, dispatch_state companion_dispatch_state, event_cursor bigint, unknown_event_count integer, malformed_event_count integer, oversized_event_count integer, cold_start_deadline_at timestamp with time zone, inactivity_deadline_at timestamp with time zone, absolute_deadline_at timestamp with time zone, operation_kind companion_operation_kind, operation_started_at timestamp with time zone, operation_attempt_count integer, provider_operation_id text, target_settings_revision bigint, target_skills_revision integer, decision_status companion_decision_status, decision_delivery_state companion_decision_delivery_state)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_enabled boolean;
  v_actual_gate_epoch bigint;
  v_org_id uuid;
  v_companion_id uuid;
  v_generation bigint;
  v_work_kind public.companion_runtime_work_kind;
  v_work_id uuid;
  v_actor_id text;
  v_client_surface public.companion_client_surface;
  v_checkpoint text;
  v_checkpoint_sequence bigint;
  v_claim_token uuid;
  v_claim_epoch bigint;
  v_turn_id uuid;
  v_decision_attempt_id uuid;
  v_attempt_number integer;
  v_operation_kind public.companion_operation_kind;
  v_operation_started_at timestamp with time zone;
  v_operation_attempt_count integer;
  v_operation_queue_sequence bigint;
  v_operation_turn_queue_cutoff bigint;
  v_companion_owner_id text;
  v_operation_actor_authorized boolean;
  v_provider_operation_id text;
  v_target_settings_revision bigint;
  v_target_skills_revision integer;
  v_model_id text;
  v_provider_ids jsonb;
  v_selected_skill_ids jsonb;
  v_selected_mcp_account_ids jsonb;
  v_skills_revision integer;
  v_turn_status public.companion_turn_status;
  v_attempt_status public.companion_attempt_status;
  v_dispatch_state public.companion_dispatch_state;
  v_event_cursor bigint;
  v_unknown_event_count integer;
  v_malformed_event_count integer;
  v_oversized_event_count integer;
  v_cold_start_deadline_at timestamp with time zone;
  v_inactivity_deadline_at timestamp with time zone;
  v_absolute_deadline_at timestamp with time zone;
  v_decision_status public.companion_decision_status;
  v_decision_delivery_state public.companion_decision_delivery_state;
  v_now timestamp with time zone;
  v_claimed integer := 0;
  v_examined_companion_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_gate_epoch IS NULL
     OR p_gate_epoch < 1
     OR p_executor_id IS NULL
     OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
     OR p_executor_id ~ E'[\n\r]'
     OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v2 claim arguments' USING ERRCODE = '22023';
  END IF;

  SELECT c.enabled, c.gate_epoch
  INTO v_enabled, v_actual_gate_epoch
  FROM public.companion_runtime_control c
  WHERE c.id = 'runtime-v2';

  IF NOT COALESCE(v_enabled, false) OR v_actual_gate_epoch <> p_gate_epoch THEN
    RETURN;
  END IF;

  WHILE v_claimed < p_limit LOOP
    v_now := clock_timestamp();
    v_org_id := NULL;
    v_companion_id := NULL;
    v_generation := NULL;
    v_client_surface := NULL;

    -- The durable lease row is the first mutex. SKIP LOCKED keeps bulk/multi-replica claims from
    -- ever waiting on another lease while already holding earlier leases in this transaction.
    SELECT i.org_id, i.companion_id
    INTO v_org_id, v_companion_id
    FROM public.companion_runtime_instances i
    JOIN public.companion_runtime_leases l
      ON l.org_id = i.org_id AND l.companion_id = i.companion_id
    WHERE i.retirement_state <> 'retired'
      AND (l.claim_token IS NULL OR l.expires_at <= v_now)
      AND NOT (i.companion_id = ANY(v_examined_companion_ids))
      AND (
        EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.status IN ('pending', 'running') AND o.available_at <= v_now
            AND (
              o.kind <> 'apply_settings'
              OR i.box_state IN ('ready', 'idle', 'running')
              OR EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
              )
            )
        )
        OR EXISTS (
          SELECT 1 FROM public.companion_decision_deliveries d
          WHERE d.org_id = i.org_id AND d.companion_id = i.companion_id
            AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
            AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
            AND EXISTS (
              SELECT 1 FROM public.companion_turn_attempts decision_attempt
              WHERE decision_attempt.org_id = d.org_id
                AND decision_attempt.companion_id = d.companion_id
                AND decision_attempt.turn_id = d.turn_id
                AND decision_attempt.id = d.attempt_id
                AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
            )
        )
        OR EXISTS (
          SELECT 1 FROM public.companion_turn_attempts a
          WHERE a.org_id = i.org_id AND a.companion_id = i.companion_id
            AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
        )
        OR (
          (
            i.desired_settings_revision > i.applied_settings_revision
            OR EXISTS (
              SELECT 1 FROM public.companion_turns profile_turn
              WHERE profile_turn.org_id = i.org_id
                AND profile_turn.companion_id = i.companion_id
                AND profile_turn.status = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM public.companion_turns earlier_turn
                  WHERE earlier_turn.org_id = profile_turn.org_id
                    AND earlier_turn.companion_id = profile_turn.companion_id
                    AND earlier_turn.status = 'queued'
                    AND earlier_turn.queue_sequence < profile_turn.queue_sequence
                )
                AND (
                  (profile_turn.client_surface = 'native_mobile'
                    AND i.applied_client_surface IS DISTINCT FROM 'native_mobile')
                  OR (profile_turn.client_surface <> 'native_mobile'
                    AND (i.applied_client_surface IS NULL
                      OR i.applied_client_surface = 'native_mobile'))
                )
            )
            OR (
              EXISTS (
                SELECT 1 FROM public.companions settings_companion
                WHERE settings_companion.org_id = i.org_id
                  AND settings_companion.id = i.companion_id
                  AND settings_companion.skills_revision > i.applied_skills_revision
              )
              AND EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
                  AND settings_turn.client_surface <> 'native_mobile'
                  AND NOT EXISTS (
                    SELECT 1 FROM public.companion_turns earlier_turn
                    WHERE earlier_turn.org_id = settings_turn.org_id
                      AND earlier_turn.companion_id = settings_turn.companion_id
                      AND earlier_turn.status = 'queued'
                      AND earlier_turn.queue_sequence < settings_turn.queue_sequence
                  )
              )
            )
          )
          AND i.settings_actor_id IS NOT NULL
          AND i.settings_available_at <= v_now
          AND (
            i.box_state IN ('ready', 'idle', 'running')
            OR EXISTS (
              SELECT 1 FROM public.companion_turns settings_turn
              WHERE settings_turn.org_id = i.org_id
                AND settings_turn.companion_id = i.companion_id
                AND settings_turn.status = 'queued'
            )
          )
        )
        OR (
          EXISTS (
            SELECT 1 FROM public.companion_turns t
            WHERE t.org_id = i.org_id AND t.companion_id = i.companion_id
              AND t.status = 'queued'
              AND (
                (t.client_surface = 'native_mobile'
                  AND i.applied_client_surface = 'native_mobile')
                OR (t.client_surface <> 'native_mobile'
                  AND i.applied_client_surface IS NOT NULL
                  AND i.applied_client_surface <> 'native_mobile'
                  AND EXISTS (
                  SELECT 1 FROM public.companions queued_companion
                  WHERE queued_companion.org_id = i.org_id
                    AND queued_companion.id = i.companion_id
                    AND queued_companion.skills_revision = i.applied_skills_revision
                  ))
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.companion_turns earlier_turn
                WHERE earlier_turn.org_id = t.org_id
                  AND earlier_turn.companion_id = t.companion_id
                  AND earlier_turn.status = 'queued'
                  AND earlier_turn.queue_sequence < t.queue_sequence
              )
          )
          AND i.desired_settings_revision = i.applied_settings_revision
          AND NOT EXISTS (
            SELECT 1 FROM public.companion_turns active_turn
            WHERE active_turn.org_id = i.org_id
              AND active_turn.companion_id = i.companion_id
              AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
          )
        )
        OR (i.health_due_at <= v_now AND i.retirement_state <> 'retired')
      )
    ORDER BY
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind = 'delete' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        ) THEN 10
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind IN ('stop', 'restart_pi', 'restart_box')
            AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        ) THEN 20
        WHEN EXISTS (
          SELECT 1 FROM public.companion_decision_deliveries d
          WHERE d.org_id = i.org_id AND d.companion_id = i.companion_id
            AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
            AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
            AND EXISTS (
              SELECT 1 FROM public.companion_turn_attempts decision_attempt
              WHERE decision_attempt.org_id = d.org_id
                AND decision_attempt.companion_id = d.companion_id
                AND decision_attempt.turn_id = d.turn_id
                AND decision_attempt.id = d.attempt_id
                AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
            )
        ) THEN 30
        WHEN EXISTS (
          SELECT 1 FROM public.companion_turn_attempts a
          WHERE a.org_id = i.org_id AND a.companion_id = i.companion_id
            AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
        ) THEN 40
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind = 'start' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        ) THEN 45
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind = 'apply_settings' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
            AND (
              i.box_state IN ('ready', 'idle', 'running')
              OR EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
              )
            )
        ) OR (
          (
            i.desired_settings_revision > i.applied_settings_revision
            OR EXISTS (
              SELECT 1 FROM public.companion_turns profile_turn
              WHERE profile_turn.org_id = i.org_id
                AND profile_turn.companion_id = i.companion_id
                AND profile_turn.status = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM public.companion_turns earlier_turn
                  WHERE earlier_turn.org_id = profile_turn.org_id
                    AND earlier_turn.companion_id = profile_turn.companion_id
                    AND earlier_turn.status = 'queued'
                    AND earlier_turn.queue_sequence < profile_turn.queue_sequence
                )
                AND (
                  (profile_turn.client_surface = 'native_mobile'
                    AND i.applied_client_surface IS DISTINCT FROM 'native_mobile')
                  OR (profile_turn.client_surface <> 'native_mobile'
                    AND (i.applied_client_surface IS NULL
                      OR i.applied_client_surface = 'native_mobile'))
                )
            )
            OR (
              EXISTS (
                SELECT 1 FROM public.companions settings_companion
                WHERE settings_companion.org_id = i.org_id
                  AND settings_companion.id = i.companion_id
                  AND settings_companion.skills_revision > i.applied_skills_revision
              )
              AND EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
                  AND settings_turn.client_surface <> 'native_mobile'
                  AND NOT EXISTS (
                    SELECT 1 FROM public.companion_turns earlier_turn
                    WHERE earlier_turn.org_id = settings_turn.org_id
                      AND earlier_turn.companion_id = settings_turn.companion_id
                      AND earlier_turn.status = 'queued'
                      AND earlier_turn.queue_sequence < settings_turn.queue_sequence
                  )
              )
            )
          )
          AND i.settings_actor_id IS NOT NULL
          AND i.settings_available_at <= v_now
          AND (
            i.box_state IN ('ready', 'idle', 'running')
            OR EXISTS (
              SELECT 1 FROM public.companion_turns settings_turn
              WHERE settings_turn.org_id = i.org_id
                AND settings_turn.companion_id = i.companion_id
                AND settings_turn.status = 'queued'
            )
          )
        ) THEN 50
        WHEN EXISTS (
          SELECT 1 FROM public.companion_turns t
          WHERE t.org_id = i.org_id AND t.companion_id = i.companion_id AND t.status = 'queued'
            AND (
              (t.client_surface = 'native_mobile'
                AND i.applied_client_surface = 'native_mobile')
              OR (t.client_surface <> 'native_mobile'
                AND i.applied_client_surface IS NOT NULL
                AND i.applied_client_surface <> 'native_mobile'
                AND EXISTS (
                SELECT 1 FROM public.companions queued_companion
                WHERE queued_companion.org_id = i.org_id
                  AND queued_companion.id = i.companion_id
                  AND queued_companion.skills_revision = i.applied_skills_revision
                ))
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.companion_turns earlier_turn
              WHERE earlier_turn.org_id = t.org_id
                AND earlier_turn.companion_id = t.companion_id
                AND earlier_turn.status = 'queued'
                AND earlier_turn.queue_sequence < t.queue_sequence
            )
        ) AND i.desired_settings_revision = i.applied_settings_revision
          AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns blocking_turn
          WHERE blocking_turn.org_id = i.org_id
            AND blocking_turn.companion_id = i.companion_id
            AND blocking_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
        ) THEN 60
        ELSE 70
      END,
      i.health_due_at,
      i.companion_id
    FOR UPDATE OF l SKIP LOCKED
    LIMIT 1;

    EXIT WHEN v_companion_id IS NULL;
    v_examined_companion_ids := array_append(v_examined_companion_ids, v_companion_id);

    -- Revalidate after winning the lease mutex. If disable committed between the optimistic read
    -- above and this lock, no old-epoch claim is materialized. If disable is still in flight, it
    -- waits on this lease and clears the completed claim before publishing the disabled gate.
    SELECT c.enabled, c.gate_epoch
    INTO v_enabled, v_actual_gate_epoch
    FROM public.companion_runtime_control c
    WHERE c.id = 'runtime-v2';
    IF NOT COALESCE(v_enabled, false) OR v_actual_gate_epoch <> p_gate_epoch THEN
      RETURN;
    END IF;

    -- Instance and work locks always follow the lease mutex. Recheck retirement after waiting for
    -- an API-side instance update; no work is selected from the optimistic candidate snapshot.
    SELECT i.generation
    INTO v_generation
    FROM public.companion_runtime_instances i
    WHERE i.org_id = v_org_id
      AND i.companion_id = v_companion_id
      AND i.retirement_state <> 'retired'
    FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_work_kind := NULL;
    v_work_id := NULL;
    v_actor_id := NULL;
    v_checkpoint := NULL;
    v_checkpoint_sequence := 0;
    v_turn_id := NULL;
    v_decision_attempt_id := NULL;
    v_operation_kind := NULL;
    v_operation_started_at := NULL;
    v_operation_attempt_count := NULL;
    v_operation_queue_sequence := NULL;
    v_operation_turn_queue_cutoff := NULL;
    v_provider_operation_id := NULL;
    v_target_settings_revision := NULL;
    v_target_skills_revision := NULL;

    SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
           o.queue_sequence, o.turn_queue_cutoff
    INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
         v_operation_queue_sequence, v_operation_turn_queue_cutoff
    FROM public.companion_operations o
    WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
      AND o.kind = 'delete' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
    ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
      v_work_kind := 'operation';
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
             o.queue_sequence, o.turn_queue_cutoff
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
           v_operation_queue_sequence, v_operation_turn_queue_cutoff
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind IN ('stop', 'restart_pi', 'restart_box')
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'operation'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT d.id, d.actor_id, d.delivery_checkpoint, d.delivery_checkpoint_sequence,
             d.attempt_id
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence,
           v_decision_attempt_id
      FROM public.companion_decision_deliveries d
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id
        AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
        AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
        AND EXISTS (
          SELECT 1 FROM public.companion_turn_attempts decision_attempt
          WHERE decision_attempt.org_id = d.org_id
            AND decision_attempt.companion_id = d.companion_id
            AND decision_attempt.turn_id = d.turn_id
            AND decision_attempt.id = d.attempt_id
            AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
        )
      ORDER BY d.created_at, d.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'decision'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT a.id, a.actor_id, a.checkpoint, a.checkpoint_sequence
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence
      FROM public.companion_turn_attempts a
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
      ORDER BY a.created_at, a.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'attempt'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
             o.queue_sequence, o.turn_queue_cutoff
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
           v_operation_queue_sequence, v_operation_turn_queue_cutoff
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind = 'start'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'operation'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
             o.queue_sequence, o.turn_queue_cutoff
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
           v_operation_queue_sequence, v_operation_turn_queue_cutoff
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind = 'apply_settings'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        AND (
          EXISTS (
            SELECT 1 FROM public.companion_runtime_instances warm_instance
            WHERE warm_instance.org_id = o.org_id
              AND warm_instance.companion_id = o.companion_id
              AND warm_instance.box_state IN ('ready', 'idle', 'running')
          )
          OR EXISTS (
            SELECT 1 FROM public.companion_turns settings_turn
            WHERE settings_turn.org_id = o.org_id
              AND settings_turn.companion_id = o.companion_id
              AND settings_turn.status = 'queued'
          )
        )
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'operation'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT i.settings_actor_id, i.settings_checkpoint, i.settings_checkpoint_sequence
      INTO v_actor_id, v_checkpoint, v_checkpoint_sequence
      FROM public.companion_runtime_instances i
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND (
          i.desired_settings_revision > i.applied_settings_revision
          OR EXISTS (
            SELECT 1 FROM public.companion_turns profile_turn
            WHERE profile_turn.org_id = i.org_id
              AND profile_turn.companion_id = i.companion_id
              AND profile_turn.status = 'queued'
              AND NOT EXISTS (
                SELECT 1 FROM public.companion_turns earlier_turn
                WHERE earlier_turn.org_id = profile_turn.org_id
                  AND earlier_turn.companion_id = profile_turn.companion_id
                  AND earlier_turn.status = 'queued'
                  AND earlier_turn.queue_sequence < profile_turn.queue_sequence
              )
              AND (
                (profile_turn.client_surface = 'native_mobile'
                  AND i.applied_client_surface IS DISTINCT FROM 'native_mobile')
                OR (profile_turn.client_surface <> 'native_mobile'
                  AND (i.applied_client_surface IS NULL
                    OR i.applied_client_surface = 'native_mobile'))
              )
          )
          OR (
            EXISTS (
              SELECT 1 FROM public.companions settings_companion
              WHERE settings_companion.org_id = i.org_id
                AND settings_companion.id = i.companion_id
                AND settings_companion.skills_revision > i.applied_skills_revision
            )
            AND EXISTS (
              SELECT 1 FROM public.companion_turns settings_turn
              WHERE settings_turn.org_id = i.org_id
                AND settings_turn.companion_id = i.companion_id
                AND settings_turn.status = 'queued'
                AND settings_turn.client_surface <> 'native_mobile'
                AND NOT EXISTS (
                  SELECT 1 FROM public.companion_turns earlier_turn
                  WHERE earlier_turn.org_id = settings_turn.org_id
                    AND earlier_turn.companion_id = settings_turn.companion_id
                    AND earlier_turn.status = 'queued'
                    AND earlier_turn.queue_sequence < settings_turn.queue_sequence
                )
            )
          )
        )
        AND i.settings_actor_id IS NOT NULL AND i.settings_available_at <= v_now
        AND (
          i.box_state IN ('ready', 'idle', 'running')
          OR EXISTS (
            SELECT 1 FROM public.companion_turns settings_turn
            WHERE settings_turn.org_id = i.org_id
              AND settings_turn.companion_id = i.companion_id
              AND settings_turn.status = 'queued'
          )
        );
      IF FOUND THEN
        v_work_kind := 'settings';
        v_work_id := v_companion_id;
      END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT t.id, t.actor_id
      INTO v_turn_id, v_actor_id
      FROM public.companion_turns t
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id AND t.status = 'queued'
        AND EXISTS (
          SELECT 1
          FROM public.companion_runtime_instances queue_instance
          JOIN public.companions queue_companion
            ON queue_companion.org_id = queue_instance.org_id
           AND queue_companion.id = queue_instance.companion_id
          WHERE queue_instance.org_id = t.org_id
            AND queue_instance.companion_id = t.companion_id
            AND queue_instance.desired_settings_revision = queue_instance.applied_settings_revision
            AND (
              (t.client_surface = 'native_mobile'
                AND queue_instance.applied_client_surface = 'native_mobile')
              OR (t.client_surface <> 'native_mobile'
                AND queue_instance.applied_client_surface IS NOT NULL
                AND queue_instance.applied_client_surface <> 'native_mobile'
                AND queue_companion.skills_revision = queue_instance.applied_skills_revision)
            )
        )
        AND NOT EXISTS (
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
        )
      ORDER BY t.queue_sequence, t.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN
        v_work_kind := 'attempt';
        v_work_id := gen_random_uuid();
        v_checkpoint := 'starting';
        v_checkpoint_sequence := 0;
        SELECT COALESCE(MAX(a.attempt_number), 0) + 1
        INTO v_attempt_number
        FROM public.companion_turn_attempts a
        WHERE a.turn_id = v_turn_id;
        SELECT c.model_id, c.provider_ids, c.selected_skill_ids,
               c.selected_mcp_account_ids, c.skills_revision
        INTO v_model_id, v_provider_ids, v_selected_skill_ids,
             v_selected_mcp_account_ids, v_skills_revision
        FROM public.companions c
        WHERE c.org_id = v_org_id AND c.id = v_companion_id;
      END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT 'health'::public.companion_runtime_work_kind, i.companion_id,
             i.health_checkpoint, i.health_checkpoint_sequence
      INTO v_work_kind, v_work_id, v_checkpoint, v_checkpoint_sequence
      FROM public.companion_runtime_instances i
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND i.health_due_at <= v_now AND i.retirement_state <> 'retired';
    END IF;

    -- A concurrent insert can make the selected instance no longer eligible. Continue rather than
    -- inventing work; the next sweep will see the new authoritative priority.
    IF v_work_kind IS NULL OR v_work_id IS NULL THEN
      CONTINUE;
    END IF;

    -- A persisted Box/Pi write intent whose lease is no longer current is ambiguous evidence. The
    -- old executor may have reached the provider even though its ACK never became durable, so
    -- takeover must not turn that intent into a success or replay it. Fence the expired epoch and
    -- interrupt the parent atomically before considering any other work for this Companion.
    IF v_work_kind = 'operation'
       AND v_operation_kind = 'start'
       AND v_checkpoint = 'creating_box' THEN
      SELECT o.source_turn_id INTO v_turn_id
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id AND o.id = v_work_id;

      UPDATE public.companion_operations o
      SET status = 'interrupted', settled_at = v_now,
          last_error_code = 'box_create_outcome_unknown',
          last_error_message = 'Box creation outcome is unknown after the lifecycle lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.id = v_work_id AND o.status = 'running' AND o.checkpoint = 'creating_box';
      IF v_turn_id IS NOT NULL THEN
        UPDATE public.companion_turns t
        SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
            absolute_deadline_at = COALESCE(t.absolute_deadline_at, v_now),
            last_error_code = 'box_create_outcome_unknown',
            last_error_message = 'Box creation outcome is unknown after the lifecycle lease was lost.',
            last_error_action = 'retry', updated_at = v_now
        WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
          AND t.id = v_turn_id
          AND t.status IN ('queued', 'starting', 'dispatching', 'running', 'needs_input');
      END IF;

      UPDATE public.companion_runtime_leases l
      SET claim_token = NULL, claim_epoch = l.claim_epoch + 1, gate_epoch = NULL,
          executor_id = NULL, work_kind = NULL, work_id = NULL,
          claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
      WHERE l.org_id = v_org_id AND l.companion_id = v_companion_id
      RETURNING l.claim_epoch INTO v_claim_epoch;
      UPDATE public.companion_runtime_instances i
      SET last_write_epoch = GREATEST(i.last_write_epoch, v_claim_epoch), updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      CONTINUE;
    END IF;

    IF v_work_kind = 'attempt'
       AND v_turn_id IS NULL
       AND v_checkpoint IN ('dispatch_write_intent', 'dispatch_ambiguous') THEN
      SELECT a.turn_id INTO v_turn_id
      FROM public.companion_turn_attempts a
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id AND a.id = v_work_id;

      PERFORM public.companion_runtime_close_attempt_decisions(
        v_org_id, v_companion_id, v_work_id,
        'dispatch_ack_unknown',
        'Pi prompt acceptance is unknown after the dispatch lease was lost.',
        'retry'::public.companion_runtime_error_action,
        NULL
      );
      UPDATE public.companion_turn_attempts a
      SET status = 'interrupted', dispatch_state = 'ambiguous',
          checkpoint = 'dispatch_ambiguous',
          checkpoint_sequence = a.checkpoint_sequence
            + CASE WHEN a.checkpoint = 'dispatch_ambiguous' THEN 0 ELSE 1 END,
          settled_at = v_now,
          last_error_code = 'dispatch_ack_unknown',
          last_error_message = 'Pi prompt acceptance is unknown after the dispatch lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.id = v_work_id
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
        AND a.dispatch_state IN ('write_intent', 'ambiguous');
      UPDATE public.companion_turns t
      SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
          last_error_code = 'dispatch_ack_unknown',
          last_error_message = 'Pi prompt acceptance is unknown after the dispatch lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
        AND t.id = v_turn_id
        AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');

      UPDATE public.companion_runtime_leases l
      SET claim_token = NULL, claim_epoch = l.claim_epoch + 1, gate_epoch = NULL,
          executor_id = NULL, work_kind = NULL, work_id = NULL,
          claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
      WHERE l.org_id = v_org_id AND l.companion_id = v_companion_id
      RETURNING l.claim_epoch INTO v_claim_epoch;
      UPDATE public.companion_runtime_instances i
      SET last_write_epoch = GREATEST(i.last_write_epoch, v_claim_epoch), updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      CONTINUE;
    END IF;

    IF v_work_kind = 'decision'
       AND v_checkpoint IN ('write_intent', 'ambiguous') THEN
      SELECT d.turn_id, d.attempt_id INTO v_turn_id, v_decision_attempt_id
      FROM public.companion_decision_deliveries d
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id AND d.id = v_work_id;

      PERFORM public.companion_runtime_close_attempt_decisions(
        v_org_id, v_companion_id, v_decision_attempt_id,
        'decision_ack_unknown',
        'Pi decision acceptance is unknown after the delivery lease was lost.',
        'retry'::public.companion_runtime_error_action,
        NULL
      );
      UPDATE public.companion_turn_attempts a
      SET status = 'interrupted', settled_at = v_now,
          last_error_code = 'decision_ack_unknown',
          last_error_message = 'Pi decision acceptance is unknown after the delivery lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.id = v_decision_attempt_id
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
      UPDATE public.companion_turns t
      SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
          last_error_code = 'decision_ack_unknown',
          last_error_message = 'Pi decision acceptance is unknown after the delivery lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
        AND t.id = v_turn_id
        AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');

      UPDATE public.companion_runtime_leases l
      SET claim_token = NULL, claim_epoch = l.claim_epoch + 1, gate_epoch = NULL,
          executor_id = NULL, work_kind = NULL, work_id = NULL,
          claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
      WHERE l.org_id = v_org_id AND l.companion_id = v_companion_id
      RETURNING l.claim_epoch INTO v_claim_epoch;
      UPDATE public.companion_runtime_instances i
      SET last_write_epoch = GREATEST(i.last_write_epoch, v_claim_epoch), updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      CONTINUE;
    END IF;

    -- Basic lifecycle authority is locked and revalidated before claim performs any destructive
    -- precedence mutation. Full resource authorization is repeated by renew immediately before
    -- Box/Pi contact, but a revoked actor can never use an old operation row to interrupt work.
    IF v_work_kind = 'operation' THEN
      v_companion_owner_id := NULL;
      v_operation_actor_authorized := false;
      SELECT c.owner_id
      INTO v_companion_owner_id
      FROM public.companions c
      JOIN public.memberships m
        ON m.org_id = c.org_id AND m.user_id = v_actor_id
      WHERE c.org_id = v_org_id AND c.id = v_companion_id
      FOR NO KEY UPDATE OF c, m;

      IF FOUND AND v_companion_owner_id = v_actor_id THEN
        v_operation_actor_authorized := true;
      ELSIF FOUND AND v_operation_kind <> 'delete' THEN
        PERFORM 1
        FROM public.companion_workspace_access a
        WHERE a.org_id = v_org_id
          AND a.companion_id = v_companion_id
          AND a.role = 'editor'
        FOR NO KEY UPDATE;
        v_operation_actor_authorized := FOUND;
      END IF;

      IF NOT v_operation_actor_authorized THEN
        UPDATE public.companion_operations o
        SET status = 'failed', settled_at = v_now,
            last_error_code = 'actor_access_revoked',
            last_error_message = 'Runtime access was revoked before this operation began.',
            last_error_action = 'none', updated_at = v_now
        WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
          AND o.id = v_work_id AND o.status IN ('pending', 'running');

        IF v_operation_kind = 'start' THEN
          UPDATE public.companion_turns t
          SET status = 'failed', settled_at = v_now, state_changed_at = v_now,
              absolute_deadline_at = COALESCE(t.absolute_deadline_at, v_now),
              last_error_code = 'actor_access_revoked',
              last_error_message = 'Runtime access was revoked before this turn began.',
              last_error_action = 'none', updated_at = v_now
          WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
            AND t.id = (
              SELECT source.source_turn_id
              FROM public.companion_operations source
              WHERE source.org_id = v_org_id
                AND source.companion_id = v_companion_id
                AND source.id = v_work_id
            )
            AND t.status = 'queued';
        END IF;
        CONTINUE;
      END IF;

      IF v_operation_kind = 'apply_settings' THEN
        -- Only an operation whose actor was just revalidated may become a prerequisite for a
        -- queued Send. A stale pending binding is replaced; a running operation keeps its active
        -- binding so takeover observes the same deadline and source.
        UPDATE public.companion_operations selected_operation
        SET source_turn_id = (
          SELECT queued_turn.id
          FROM public.companion_turns queued_turn
          WHERE queued_turn.org_id = v_org_id
            AND queued_turn.companion_id = v_companion_id
            AND queued_turn.status = 'queued'
          ORDER BY queued_turn.queue_sequence, queued_turn.id
          LIMIT 1
        ),
            updated_at = v_now
        WHERE selected_operation.org_id = v_org_id
          AND selected_operation.companion_id = v_companion_id
          AND selected_operation.id = v_work_id
          AND (
            selected_operation.source_turn_id IS NULL
            OR (
              selected_operation.status = 'pending'
              AND NOT EXISTS (
                SELECT 1
                FROM public.companion_turns bound_turn
                WHERE bound_turn.org_id = selected_operation.org_id
                  AND bound_turn.companion_id = selected_operation.companion_id
                  AND bound_turn.id = selected_operation.source_turn_id
                  AND bound_turn.status = 'queued'
              )
            )
          )
          AND EXISTS (
            SELECT 1
            FROM public.companion_turns queued_turn
            WHERE queued_turn.org_id = v_org_id
              AND queued_turn.companion_id = v_companion_id
              AND queued_turn.status = 'queued'
          );
      END IF;
    END IF;

    -- Work selection and ACL locks may have waited. Lease lifetime starts from the actual claim
    -- publication time, never from the beginning of the SQL statement.
    v_now := clock_timestamp();
    v_claim_token := gen_random_uuid();
    v_claim_epoch := NULL;
    UPDATE public.companion_runtime_leases l
    SET claim_token = v_claim_token,
        claim_epoch = l.claim_epoch + 1,
        gate_epoch = p_gate_epoch,
        executor_id = p_executor_id,
        work_kind = v_work_kind,
        work_id = v_work_id,
        claimed_at = v_now,
        renewed_at = v_now,
        expires_at = v_now + make_interval(secs => p_lease_seconds),
        updated_at = v_now
    WHERE l.org_id = v_org_id
      AND l.companion_id = v_companion_id
      AND (l.claim_token IS NULL OR l.expires_at <= v_now)
    RETURNING l.claim_epoch INTO v_claim_epoch;

    IF v_claim_epoch IS NULL THEN
      CONTINUE;
    END IF;

    IF v_work_kind = 'operation' THEN
      -- A newly selected higher-priority operation atomically terminalizes a lower running one
      -- before acquiring the one-running slot. Explicit lifecycle is also an ordering barrier:
      -- pending Starts serialized before it are superseded, while Starts from later Sends survive.
      WITH superseded AS (
        UPDATE public.companion_operations o
        SET status = 'interrupted', settled_at = v_now,
            last_error_code = 'superseded_by_higher_priority',
            last_error_message = 'A higher-priority runtime operation superseded this operation.',
            last_error_action = 'none', updated_at = v_now
        WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
          AND o.id <> v_work_id
          AND (
            (
              o.status = 'running'
              AND CASE
                WHEN o.kind = 'delete' THEN 10
                WHEN o.kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
                WHEN o.kind = 'start' THEN 45
                ELSE 50
              END > CASE
                WHEN v_operation_kind = 'delete' THEN 10
                WHEN v_operation_kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
                WHEN v_operation_kind = 'start' THEN 45
                ELSE 50
              END
            )
            OR (
              v_operation_kind IN ('stop', 'restart_pi', 'restart_box')
              AND o.status = 'pending'
              AND o.kind = 'start'
              AND o.queue_sequence < v_operation_queue_sequence
            )
          )
        RETURNING o.kind, o.source_turn_id
      )
      UPDATE public.companion_turns t
      SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
          absolute_deadline_at = COALESCE(t.absolute_deadline_at, v_now),
          last_error_code = 'runtime_lifecycle_preempted',
          last_error_message = CASE
            WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
            ELSE 'The Companion runtime restarted before this turn completed.'
          END,
          last_error_action = 'retry', updated_at = v_now
      WHERE v_operation_kind IN ('stop', 'restart_pi', 'restart_box')
        AND t.org_id = v_org_id AND t.companion_id = v_companion_id
        AND t.status = 'queued'
        AND t.queue_sequence <= v_operation_turn_queue_cutoff
        -- Referencing the DML CTE makes the operation/turn barrier visibly one SQL statement.
        AND (SELECT count(*) FROM superseded) >= 0;

      IF v_operation_kind IN ('delete', 'stop', 'restart_pi', 'restart_box') THEN
        -- Close decision outboxes before making their attempts terminal. A start never enters this
        -- branch: turn-triggered wake remains below an already-active attempt and cannot kill it.
        PERFORM public.companion_runtime_close_attempt_decisions(
          a.org_id, a.companion_id, a.id,
          'runtime_lifecycle_preempted',
          CASE
            WHEN v_operation_kind = 'delete' THEN 'The Companion was deleted before this turn completed.'
            WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
            ELSE 'The Companion runtime restarted before this turn completed.'
          END,
          CASE WHEN v_operation_kind = 'delete'
            THEN 'none'::public.companion_runtime_error_action
            ELSE 'retry'::public.companion_runtime_error_action
          END,
          NULL
        )
        FROM public.companion_turn_attempts a
        WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');

        UPDATE public.companion_turn_attempts a
        SET status = 'interrupted', settled_at = v_now,
            last_error_code = 'runtime_lifecycle_preempted',
            last_error_message = CASE
              WHEN v_operation_kind = 'delete' THEN 'The Companion was deleted before this turn completed.'
              WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
              ELSE 'The Companion runtime restarted before this turn completed.'
            END,
            last_error_action = CASE WHEN v_operation_kind = 'delete'
              THEN 'none'::public.companion_runtime_error_action
              ELSE 'retry'::public.companion_runtime_error_action
            END,
            updated_at = v_now
        WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');

        UPDATE public.companion_turns t
        SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
            last_error_code = 'runtime_lifecycle_preempted',
            last_error_message = CASE
              WHEN v_operation_kind = 'delete' THEN 'The Companion was deleted before this turn completed.'
              WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
              ELSE 'The Companion runtime restarted before this turn completed.'
            END,
            last_error_action = CASE WHEN v_operation_kind = 'delete'
              THEN 'none'::public.companion_runtime_error_action
              ELSE 'retry'::public.companion_runtime_error_action
            END,
            updated_at = v_now
        WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
          AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');

        IF v_operation_kind = 'delete' THEN
          UPDATE public.companion_turns t
          SET status = 'cancelled', settled_at = v_now, state_changed_at = v_now,
              last_error_code = NULL, last_error_message = NULL, last_error_action = NULL,
              updated_at = v_now
          WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
            AND t.status = 'queued';

          -- Delete is terminal for this generation. Cancel every queued operation while the
          -- instance mutex is held, so no start/settings/lifecycle intent can recreate a Box after
          -- provider deletion succeeds and the instance becomes retired.
          UPDATE public.companion_operations o
          SET status = 'cancelled',
              settled_at = v_now,
              last_error_code = NULL,
              last_error_message = NULL,
              last_error_action = NULL,
              updated_at = v_now
          WHERE o.org_id = v_org_id
            AND o.companion_id = v_companion_id
            AND o.id <> v_work_id
            AND o.status = 'pending';
        END IF;
      END IF;
      UPDATE public.companion_operations o
      SET status = 'running', claim_epoch = v_claim_epoch,
          attempt_count = o.attempt_count + 1,
          started_at = COALESCE(o.started_at, v_now), updated_at = v_now
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id AND o.id = v_work_id;
    ELSIF v_work_kind = 'decision' THEN
      UPDATE public.companion_decision_deliveries d
      SET decision_status = CASE
            WHEN d.decision_status = 'pending' AND d.expires_at <= v_now
              THEN 'expired'::public.companion_decision_status
            ELSE d.decision_status
          END,
          responded_at = CASE
            WHEN d.decision_status = 'pending' AND d.expires_at <= v_now THEN v_now
            ELSE d.responded_at
          END,
          claim_epoch = v_claim_epoch,
          delivery_attempt_count = d.delivery_attempt_count + 1,
          updated_at = v_now
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id AND d.id = v_work_id;
    ELSIF v_work_kind = 'attempt' AND v_turn_id IS NOT NULL THEN
      INSERT INTO public.companion_turn_attempts (
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, selected_skill_ids, selected_mcp_account_ids,
        claim_epoch, status, checkpoint, checkpoint_sequence,
        dispatch_state, started_at, updated_at
      ) VALUES (
        v_work_id, v_org_id, v_companion_id, v_turn_id, v_attempt_number, v_actor_id,
        v_generation,
        (SELECT i.applied_settings_revision FROM public.companion_runtime_instances i
         WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id),
        v_skills_revision, v_model_id, v_provider_ids, v_selected_skill_ids,
        v_selected_mcp_account_ids, v_claim_epoch, 'starting', 'starting', 0,
        'pending', v_now, v_now
      );
      UPDATE public.companion_turns t
      SET status = 'starting', inactivity_deadline_at = NULL,
          absolute_deadline_at = v_now + interval '2 hours',
          state_changed_at = v_now, updated_at = v_now
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id AND t.id = v_turn_id;
    ELSIF v_work_kind = 'attempt' THEN
      UPDATE public.companion_turn_attempts a
      SET claim_epoch = v_claim_epoch, updated_at = v_now
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id AND a.id = v_work_id;
    ELSIF v_work_kind = 'settings' THEN
      v_turn_id := NULL;
      v_cold_start_deadline_at := NULL;
      SELECT t.id, t.client_surface, t.cold_start_deadline_at
      INTO v_turn_id, v_client_surface, v_cold_start_deadline_at
      FROM public.companion_turns t
      WHERE t.org_id = v_org_id
        AND t.companion_id = v_companion_id
        AND t.status = 'queued'
      ORDER BY t.queue_sequence, t.id
      LIMIT 1
      FOR UPDATE;
      IF NOT FOUND THEN
        v_client_surface := 'web';
      END IF;

      UPDATE public.companion_runtime_instances i
      SET settings_claim_epoch = v_claim_epoch,
          settings_claim_actor_id = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN i.settings_actor_id ELSE i.settings_claim_actor_id END,
          settings_claim_client_surface = v_client_surface,
          settings_claim_turn_id = v_turn_id,
          settings_claim_cold_start_deadline_at = v_cold_start_deadline_at,
          settings_claim_revision = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN i.desired_settings_revision ELSE i.settings_claim_revision END,
          settings_claim_skills_revision = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN CASE WHEN v_client_surface = 'native_mobile'
              THEN i.applied_skills_revision ELSE c.skills_revision END
            ELSE i.settings_claim_skills_revision END,
          settings_claim_model_id = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN c.model_id ELSE i.settings_claim_model_id END,
          settings_claim_persona = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN c.persona ELSE i.settings_claim_persona END,
          settings_claim_can_write_skills = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN CASE WHEN v_client_surface = 'native_mobile' THEN false ELSE c.can_write_skills END
            ELSE i.settings_claim_can_write_skills END,
          settings_claim_provider_ids = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN c.provider_ids ELSE i.settings_claim_provider_ids END,
          settings_claim_selected_skill_ids = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN CASE WHEN v_client_surface = 'native_mobile' THEN '[]'::jsonb ELSE c.selected_skill_ids END
            ELSE i.settings_claim_selected_skill_ids END,
          settings_claim_skill_refs = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision) THEN
            CASE WHEN v_client_surface = 'native_mobile' THEN '[]'::jsonb ELSE (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'skill_id', s.id,
              'current_version_id', s.current_version_id
            ) ORDER BY s.id), '[]'::jsonb)
            FROM public.skills s
            WHERE s.org_id = i.org_id
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(c.selected_skill_ids) selected(skill_id)
                WHERE selected.skill_id = s.id::text
              )
          ) END ELSE i.settings_claim_skill_refs END,
          settings_claim_selected_mcp_account_ids = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN CASE WHEN v_client_surface = 'native_mobile' THEN '[]'::jsonb
              ELSE c.selected_mcp_account_ids END
            ELSE i.settings_claim_selected_mcp_account_ids END,
          settings_checkpoint = 'applying',
          settings_checkpoint_sequence = i.settings_checkpoint_sequence + 1,
          settings_attempt_count = i.settings_attempt_count + 1,
          updated_at = v_now
      FROM public.companions c
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND c.org_id = i.org_id AND c.id = i.companion_id;
      v_checkpoint := 'applying';
      v_checkpoint_sequence := v_checkpoint_sequence + 1;
    ELSIF v_work_kind = 'health' THEN
      UPDATE public.companion_runtime_instances i
      SET health_claim_epoch = v_claim_epoch,
          health_checkpoint = 'observing',
          health_checkpoint_sequence = i.health_checkpoint_sequence + 1,
          updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      v_checkpoint := 'observing';
      v_checkpoint_sequence := v_checkpoint_sequence + 1;
    END IF;

    IF v_work_kind = 'operation' THEN
      SELECT o.started_at, o.attempt_count, o.provider_operation_id, o.source_turn_id,
             o.client_surface,
             o.target_settings_revision, o.target_skills_revision
      INTO v_operation_started_at, v_operation_attempt_count, v_provider_operation_id, v_turn_id,
           v_client_surface,
           v_target_settings_revision, v_target_skills_revision
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id AND o.id = v_work_id;
    END IF;

    v_claimed := v_claimed + 1;
    v_turn_status := NULL;
    v_attempt_status := NULL;
    v_dispatch_state := NULL;
    v_event_cursor := NULL;
    v_unknown_event_count := NULL;
    v_malformed_event_count := NULL;
    v_oversized_event_count := NULL;
    v_cold_start_deadline_at := NULL;
    v_inactivity_deadline_at := NULL;
    v_absolute_deadline_at := NULL;
    v_decision_status := NULL;
    v_decision_delivery_state := NULL;
    IF v_work_kind = 'operation' AND v_turn_id IS NOT NULL THEN
      SELECT t.status, t.cold_start_deadline_at,
             t.inactivity_deadline_at, t.absolute_deadline_at
      INTO v_turn_status, v_cold_start_deadline_at,
           v_inactivity_deadline_at, v_absolute_deadline_at
      FROM public.companion_turns t
      WHERE t.org_id = v_org_id
        AND t.companion_id = v_companion_id
        AND t.id = v_turn_id;
    ELSIF v_work_kind = 'attempt' THEN
      SELECT a.turn_id, t.client_surface, t.status, a.status, a.dispatch_state, a.event_cursor,
             a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
             t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at
      INTO v_turn_id, v_client_surface, v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
           v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
           v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at
      FROM public.companion_turn_attempts a
      JOIN public.companion_turns t
        ON t.org_id = a.org_id AND t.companion_id = a.companion_id AND t.id = a.turn_id
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id AND a.id = v_work_id;
    ELSIF v_work_kind = 'decision' THEN
      SELECT d.turn_id, t.client_surface, t.status, a.status, a.dispatch_state, a.event_cursor,
             a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
             t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at,
             d.decision_status, d.delivery_state
      INTO v_turn_id, v_client_surface, v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
           v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
           v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
           v_decision_status, v_decision_delivery_state
      FROM public.companion_decision_deliveries d
      JOIN public.companion_turn_attempts a
        ON a.org_id = d.org_id AND a.companion_id = d.companion_id
       AND a.turn_id = d.turn_id AND a.id = d.attempt_id
      JOIN public.companion_turns t
        ON t.org_id = d.org_id AND t.companion_id = d.companion_id AND t.id = d.turn_id
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id AND d.id = v_work_id;
    ELSIF v_work_kind = 'settings' THEN
      SELECT i.settings_claim_turn_id, i.settings_claim_cold_start_deadline_at,
             i.settings_claim_revision, i.settings_claim_skills_revision
      INTO v_turn_id, v_cold_start_deadline_at,
           v_target_settings_revision, v_target_skills_revision
      FROM public.companion_runtime_instances i
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND i.settings_claim_epoch = v_claim_epoch;
    END IF;
    RETURN QUERY SELECT
      v_org_id, v_companion_id, v_claim_token, v_claim_epoch, p_gate_epoch,
      v_work_kind, v_work_id, v_actor_id, v_client_surface, v_generation,
      v_checkpoint, v_checkpoint_sequence,
      v_turn_id, v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
      v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
      v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
      v_operation_kind, v_operation_started_at, v_operation_attempt_count,
      v_provider_operation_id,
      v_target_settings_revision, v_target_skills_revision,
      v_decision_status, v_decision_delivery_state;
  END LOOP;
END
$function$

--> statement-breakpoint
