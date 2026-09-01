-- An interrupted turn is terminal evidence, not durable queue ownership. Runtime attempts clean up
-- their exact Pi invocation before settlement, and later work must remain claimable even when that
-- cleanup could not be confirmed. The next main attempt's idle preflight recycles stale Pi state;
-- isolated routines start in a distinct run root.
CREATE OR REPLACE FUNCTION public.companion_runtime_routine_lane_quiescent(
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
      AND turn_row.status IN ('starting', 'dispatching', 'running', 'needs_input')
  )
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_routine_lane_quiescent(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- Remove the terminal `interrupted` state from the same-lane active-work guard. Keep this as a
-- narrow guarded rewrite so drift in the mature claim state machine fails the migration loudly.
DO $companion_interrupt_claim_guard$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text;
  v_old text := $r$            AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')$r$;
  v_new text := $r$            AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input')$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count NOT IN (1, 2) THEN
    RAISE EXCEPTION 'interruption claim guard rewrite matched %, expected 1 or 2', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_interrupt_claim_guard$;
--> statement-breakpoint

-- Queue release requires the runtime-side exact cleanup added with this migration. Bump the
-- material protocol so protocol-4 replicas cannot claim newly eligible work during a rolling
-- deployment; already-held leases may still checkpoint or settle normally.
DO $companion_interrupt_material_protocol$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work(text,integer,integer,bigint,integer,integer)';
  v_definition text;
  v_old text := 'IF p_material_protocol IS DISTINCT FROM 4 THEN RETURN; END IF;';
  v_new text := 'IF p_material_protocol IS DISTINCT FROM 5 THEN RETURN; END IF;';
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'interruption material protocol rewrite matched %, expected 1',
      COALESCE(v_count, 0) USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_interrupt_material_protocol$;
--> statement-breakpoint

-- Material preparation applies the same non-blocking rule. For a main turn queued behind an
-- interruption, preparation is also allowed when the durable Pi observation is still non-idle;
-- the attempt preflight owns the exact Pi-only recycle before sending the new prompt.
DO $companion_interrupt_material_guard$
DECLARE
  v_signature text := 'public.companion_runtime_prepare_queued_turn_material(bigint)';
  v_definition text;
  v_old_multiline text := $r$            AND active_turn.status IN (
              'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
            )$r$;
  v_new_multiline text := $r$            AND active_turn.status IN (
              'starting', 'dispatching', 'running', 'needs_input'
            )$r$;
  v_old_inline text := $r$        AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')$r$;
  v_new_inline text := $r$        AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input')$r$;
  v_old_idle text := $r$AND (queued_turn.routine_snapshot_id IS NOT NULL OR instance.pi_state = 'idle')$r$;
  v_new_idle text := $r$AND (
        queued_turn.routine_snapshot_id IS NOT NULL
        OR instance.pi_state = 'idle'
        OR EXISTS (
          SELECT 1
          FROM public.companion_turns interrupted_predecessor
          WHERE interrupted_predecessor.org_id = queued_turn.org_id
            AND interrupted_predecessor.companion_id = queued_turn.companion_id
            AND interrupted_predecessor.routine_snapshot_id IS NULL
            AND interrupted_predecessor.status = 'interrupted'
            AND interrupted_predecessor.queue_sequence < queued_turn.queue_sequence
        )
      )$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old_multiline, ''))
  ) / char_length(v_old_multiline);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'interruption material multiline guard rewrite matched %, expected 1',
      COALESCE(v_count, 0) USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old_multiline, v_new_multiline);

  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old_inline, ''))
  ) / char_length(v_old_inline);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'interruption material inline guard rewrite matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old_inline, v_new_inline);

  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old_idle, ''))
  ) / char_length(v_old_idle);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'interruption material idle guard rewrite matched %, expected 2', v_count
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old_idle, v_new_idle);
END
$companion_interrupt_material_guard$;
--> statement-breakpoint

-- Multiple terminal interruptions may now coexist. Every singular API projection must return the
-- latest one so clients show the current warning and target Retry/Cancel at the right turn.
DO $companion_latest_interruption_projection$
DECLARE
  v_signature text;
  v_definition text;
  v_old text := 'ORDER BY interrupted.queue_sequence, interrupted.id LIMIT 1';
  v_new text := 'ORDER BY interrupted.queue_sequence DESC, interrupted.id DESC LIMIT 1';
  v_count integer;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.companion_api_read_runtime(uuid,uuid)',
    'public.companion_api_list_runtime(uuid)',
    'public.companion_api_read_thread(uuid,uuid)'
  ] LOOP
    v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
    v_count := (
      char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
    ) / char_length(v_old);
    IF v_definition IS NULL OR v_count <> 1 THEN
      RAISE EXCEPTION 'latest interruption projection rewrite for % matched %, expected 1',
        v_signature, COALESCE(v_count, 0) USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(v_definition, v_old, v_new);
  END LOOP;
END
$companion_latest_interruption_projection$;
--> statement-breakpoint

-- Push notifications must describe the same non-blocking contract as the thread and routine
-- history. Preserve the safe persisted error while making automatic continuation explicit.
DO $companion_interrupt_notification_copy$
DECLARE
  v_signature text := 'public.companion_notification_terminal_turn()';
  v_definition text;
  v_old text := $r$    v_body := COALESCE(NEW.last_error_message, 'Open the conversation to retry or cancel.');$r$;
  v_new text := $r$    v_body := left(
      COALESCE(NEW.last_error_message, 'This turn ended without a confirmed outcome.'),
      180 - char_length(' Later messages continue automatically.')
    ) || ' Later messages continue automatically.';$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'interruption notification rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_interrupt_notification_copy$;
