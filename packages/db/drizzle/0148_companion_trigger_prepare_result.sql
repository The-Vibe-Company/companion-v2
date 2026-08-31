-- Migration 0147 wrapped the routine context builder so webhook-trigger runs can reuse the same
-- isolated-session preparation. Its composite null check accidentally discarded the ordinary
-- main-turn result `(false, NULL, NULL, NULL)`: PostgreSQL's row `IS NOT NULL` is true only when
-- every field is non-null. Runtime therefore received no row, treated the live lease as lost, and
-- reclaimed the same accepted message every lease TTL until the cold-start deadline expired.
--
-- Preserve the wrapper and its exact runtime-only ACL, but remember whether SELECT found a row
-- before restoring the temporary trigger label. Field nullability is payload, not row existence.
CREATE OR REPLACE FUNCTION public.companion_runtime_prepare_routine_run(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_enable_new_isolation boolean
)
RETURNS TABLE (
  isolated boolean,
  context_id uuid,
  context_sha256 text,
  context_content text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_turn_id uuid;
  v_trigger_name text;
  v_row record;
  v_row_found boolean := false;
BEGIN
  IF p_work_kind = 'attempt' THEN
    SELECT turn_row.id, turn_row.trigger_name
    INTO v_turn_id, v_trigger_name
    FROM public.companion_runtime_leases lease
    JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
    JOIN public.companion_turn_attempts attempt
      ON attempt.org_id = lease.org_id
     AND attempt.companion_id = lease.companion_id
     AND attempt.id = p_work_id
    JOIN public.companion_turns turn_row
      ON turn_row.org_id = attempt.org_id
     AND turn_row.companion_id = attempt.companion_id
     AND turn_row.id = attempt.turn_id
    WHERE lease.org_id = p_org_id
      AND lease.companion_id = p_companion_id
      AND lease.claim_token = p_claim_token
      AND lease.claim_epoch = p_claim_epoch
      AND lease.gate_epoch = p_gate_epoch
      AND lease.executor_id = p_executor_id
      AND lease.work_kind = p_work_kind
      AND lease.work_id = p_work_id
      AND lease.expires_at > clock_timestamp()
      AND control.enabled
      AND control.gate_epoch = p_gate_epoch
      AND attempt.claim_epoch = p_claim_epoch
      AND attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
    FOR UPDATE OF lease, attempt, turn_row;

    IF v_trigger_name IS NOT NULL THEN
      UPDATE public.companion_turns
      SET routine_name = v_trigger_name
      WHERE id = v_turn_id
        AND org_id = p_org_id
        AND companion_id = p_companion_id
        AND routine_name IS NULL;
    END IF;
  END IF;

  SELECT *
  INTO v_row
  FROM public.companion_runtime_prepare_isolated_run_internal(
    p_org_id,
    p_companion_id,
    p_claim_token,
    p_claim_epoch,
    p_gate_epoch,
    p_executor_id,
    p_work_kind,
    p_work_id,
    p_enable_new_isolation
  );
  v_row_found := FOUND;

  IF v_trigger_name IS NOT NULL THEN
    UPDATE public.companion_turns
    SET routine_name = NULL
    WHERE id = v_turn_id
      AND org_id = p_org_id
      AND companion_id = p_companion_id
      AND trigger_name IS NOT NULL;
  END IF;

  IF v_row_found THEN
    RETURN QUERY
    SELECT v_row.isolated, v_row.context_id, v_row.context_sha256, v_row.context_content;
  END IF;
END
$$;
--> statement-breakpoint
