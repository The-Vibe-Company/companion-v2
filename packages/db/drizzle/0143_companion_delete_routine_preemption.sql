-- Permanent deletion is the one main-lane operation that may preempt an isolated routine. Keep
-- every other main-lane lifecycle/settings/health predicate behind routine quiescence, but let the
-- delete claim reach the atomic fencing block below.
DO $companion_delete_claim_guard$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text;
  v_old text := $r$      AND v_lane = 'main'
      AND public.companion_runtime_routine_lane_quiescent(v_org_id, v_companion_id)
      AND o.kind = 'delete' AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$;
  v_new text := $r$      AND v_lane = 'main'
      AND o.kind = 'delete' AND o.status IN ('pending', 'running') AND o.available_at <= v_now$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'delete claim guard rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_delete_claim_guard$;
--> statement-breakpoint

-- Capture and fence the exact isolated run while both lane leases and the instance mutex are held.
-- The operation's existing source_turn_id is deliberately reused as a short-lived capture pointer;
-- successful delete settlement clears it immediately before removing the Companion aggregate.
DO $companion_delete_routine_preemption$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text;
  v_old_declaration text := $r$  v_lane text;$r$;
  v_new_declaration text := $r$  v_lane text;
  v_routine_turn_id uuid;
  v_routine_attempt_id uuid;$r$;
  v_old_instance_lock text := $r$    -- Instance and work locks always follow the lease mutex. Recheck retirement after waiting for
    -- an API-side instance update; no work is selected from the optimistic candidate snapshot.
    SELECT i.generation$r$;
  v_new_instance_lock text := $r$    -- Delete is the only main-lane claim that also owns routine-lane shutdown. Acquire that lease
    -- before the shared instance mutex, matching renewal/checkpoint order. SKIP LOCKED makes a
    -- concurrent routine transaction defer this claim instead of forming routine-lease -> instance
    -- versus instance -> routine-lease deadlock.
    IF v_lane = 'main' AND EXISTS (
      SELECT 1
      FROM public.companion_operations delete_operation
      WHERE delete_operation.org_id = v_org_id
        AND delete_operation.companion_id = v_companion_id
        AND delete_operation.kind = 'delete'
        AND delete_operation.status IN ('pending', 'running')
        AND delete_operation.available_at <= v_now
    ) THEN
      PERFORM 1
      FROM public.companion_runtime_leases routine_lease
      WHERE routine_lease.org_id = v_org_id
        AND routine_lease.companion_id = v_companion_id
        AND routine_lease.lane = 'routine'
      FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN CONTINUE; END IF;
    END IF;

    -- Instance and work locks always follow every lease mutex needed by this claim. Recheck
    -- retirement after waiting for an API-side instance update; no work is selected from the
    -- optimistic candidate snapshot.
    SELECT i.generation$r$;
  v_old_block text := $r$      IF v_lane = 'main'
         AND v_operation_kind IN ('delete', 'stop', 'restart_pi', 'restart_box') THEN$r$;
  v_new_block text := $r$      IF v_lane = 'main'
         AND v_operation_kind IN ('delete', 'stop', 'restart_pi', 'restart_box') THEN
        IF v_operation_kind = 'delete' THEN
          -- Prefer an active run, then the oldest interrupted run. The routine attempt identity is
          -- locked with its turn so a concurrent routine checkpoint cannot change the invocation
          -- after this claim has captured it.
          v_routine_turn_id := NULL;
          v_routine_attempt_id := NULL;
          SELECT routine_turn.id, routine_attempt.id
          INTO v_routine_turn_id, v_routine_attempt_id
          FROM public.companion_turns routine_turn
          JOIN LATERAL (
            SELECT attempt.id
            FROM public.companion_turn_attempts attempt
            WHERE attempt.org_id = v_org_id
              AND attempt.companion_id = v_companion_id
              AND attempt.turn_id = routine_turn.id
              AND attempt.execution_lane = 'routine'
              AND attempt.pi_invocation_id IS NOT NULL
              AND attempt.status IN (
                'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
              )
            ORDER BY attempt.attempt_number DESC, attempt.id DESC
            LIMIT 1
          ) routine_attempt ON true
          WHERE routine_turn.org_id = v_org_id
            AND routine_turn.companion_id = v_companion_id
            AND routine_turn.routine_snapshot_id IS NOT NULL
            AND routine_turn.status IN (
              'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
            )
          ORDER BY CASE
            WHEN routine_turn.status IN ('starting', 'dispatching', 'running', 'needs_input') THEN 0
            ELSE 1
          END, routine_turn.queue_sequence, routine_turn.id
          LIMIT 1
          FOR UPDATE OF routine_turn;

          IF v_routine_attempt_id IS NOT NULL THEN
            PERFORM 1
            FROM public.companion_turn_attempts routine_attempt
            WHERE routine_attempt.org_id = v_org_id
              AND routine_attempt.companion_id = v_companion_id
              AND routine_attempt.id = v_routine_attempt_id
            FOR UPDATE;

            UPDATE public.companion_operations operation_row
            SET source_turn_id = v_routine_turn_id,
                updated_at = v_now
            WHERE operation_row.org_id = v_org_id
              AND operation_row.companion_id = v_companion_id
              AND operation_row.id = v_work_id
              AND operation_row.kind = 'delete'
              AND operation_row.status IN ('pending', 'running');
          END IF;

          -- This row was locked before the instance mutex. v_claim_epoch was allocated from the
          -- shared instance write epoch and every lease epoch, so retaining it on the cleared
          -- routine row fences every stale routine checkpoint.
          UPDATE public.companion_runtime_leases routine_lease
          SET claim_token = NULL,
              claim_epoch = GREATEST(routine_lease.claim_epoch, v_claim_epoch),
              gate_epoch = NULL,
              executor_id = NULL,
              work_kind = NULL,
              work_id = NULL,
              claimed_at = NULL,
              renewed_at = NULL,
              expires_at = NULL,
              updated_at = v_now
          WHERE routine_lease.org_id = v_org_id
            AND routine_lease.companion_id = v_companion_id
            AND routine_lease.lane = 'routine';
        END IF;$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old_declaration, ''))
  ) / char_length(v_old_declaration);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'delete routine declaration rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old_declaration, v_new_declaration);

  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old_instance_lock, ''))
  ) / char_length(v_old_instance_lock);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'delete routine lease-order rewrite matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old_instance_lock, v_new_instance_lock);

  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old_block, ''))
  ) / char_length(v_old_block);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'delete routine preemption rewrite matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old_block, v_new_block);
END
$companion_delete_routine_preemption$;
--> statement-breakpoint

-- Runtime already has a private command_pi_invocation_id field. For a delete operation, resolve
-- that field from the source routine captured by the claim; no table grant or broad routine query
-- is exposed to the executor.
DO $companion_delete_routine_identity$
DECLARE
  v_signature text :=
    'public.companion_runtime_renew_and_authorize_v2(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)';
  v_definition text;
  v_old text := $r$      WHEN authorization_row.authorized
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
  v_new text := $r$      WHEN authorization_row.authorized
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
      WHEN authorization_row.authorized
        AND p_work_kind = 'operation'
        AND authorization_row.operation_kind = 'delete'
        AND authorization_row.turn_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.companion_turns routine_turn
          WHERE routine_turn.org_id = p_org_id
            AND routine_turn.companion_id = p_companion_id
            AND routine_turn.id = authorization_row.turn_id
            AND routine_turn.routine_snapshot_id IS NOT NULL
        ) THEN (
        SELECT attempt.pi_invocation_id
        FROM public.companion_turn_attempts attempt
        WHERE attempt.org_id = p_org_id
          AND attempt.companion_id = p_companion_id
          AND attempt.turn_id = authorization_row.turn_id
          AND attempt.execution_lane = 'routine'
          AND attempt.pi_invocation_id IS NOT NULL
          AND attempt.status IN (
            'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
          )
        ORDER BY attempt.attempt_number DESC, attempt.id DESC
        LIMIT 1
      )
      ELSE NULL::text$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'delete routine identity rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_delete_routine_identity$;
