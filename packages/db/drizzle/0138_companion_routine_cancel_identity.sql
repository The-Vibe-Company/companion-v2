-- Reserve routine dispatch identity before Box start. A protocol-2 executor does not understand
-- that ordering and could reclaim the write intent with a different Pi invocation, so quarantine
-- it from new claims during rollout. CREATE OR REPLACE preserves this function's OID, owner, and
-- runtime-only EXECUTE ACL; already-held leases continue through the unchanged fenced functions.
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
  IF p_material_protocol IS DISTINCT FROM 3 THEN RETURN; END IF;
  RETURN QUERY SELECT * FROM public.companion_runtime_claim_work_material_v1(
    p_executor_id, p_limit, p_lease_seconds, p_gate_epoch, 1, p_delete_resume_protocol
  );
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(
  text, integer, integer, bigint, integer, integer
) FROM PUBLIC;
--> statement-breakpoint

-- A cancellation denial deliberately keeps the canonical Box identity available so runtime can
-- stop external work before settling the turn. Preserve the attempt-bound Pi identity for that
-- same narrow denial as well: isolated routines must terminate their run-scoped Pi, never send an
-- abort to the idle main Companion Pi. The command id remains hidden on every denied row.
CREATE OR REPLACE FUNCTION public.companion_runtime_renew_and_authorize_v2(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  authorized boolean,
  denial_code text,
  lease_expires_at timestamp with time zone,
  authorization_actor_id text,
  decision_actor_id text,
  client_surface public.companion_client_surface,
  runtime_generation bigint,
  box_id text,
  box_state public.companion_box_observed_state,
  pi_state public.companion_pi_observed_state,
  pi_invocation_id text,
  disk_layout_version integer,
  applied_settings_revision bigint,
  applied_skills_revision integer,
  model_id text,
  persona text,
  can_write_skills boolean,
  provider_refs jsonb,
  skill_refs jsonb,
  mcp_refs jsonb,
  desired_settings_revision bigint,
  skills_revision integer,
  work_checkpoint text,
  work_checkpoint_sequence bigint,
  turn_id uuid,
  turn_status public.companion_turn_status,
  attempt_status public.companion_attempt_status,
  dispatch_state public.companion_dispatch_state,
  event_cursor bigint,
  unknown_event_count integer,
  malformed_event_count integer,
  oversized_event_count integer,
  cold_start_deadline_at timestamp with time zone,
  inactivity_deadline_at timestamp with time zone,
  absolute_deadline_at timestamp with time zone,
  operation_kind public.companion_operation_kind,
  operation_started_at timestamp with time zone,
  operation_attempt_count integer,
  provider_operation_id text,
  target_settings_revision bigint,
  target_skills_revision integer,
  decision_status public.companion_decision_status,
  decision_delivery_state public.companion_decision_delivery_state,
  decision_request_key text,
  decision_response_text text,
  command_id uuid,
  command_pi_invocation_id text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
  SELECT authorization_row.*,
    CASE
      WHEN authorization_row.authorized AND p_work_kind = 'attempt' THEN (
        SELECT attempt.command_id
        FROM public.companion_turn_attempts attempt
        WHERE attempt.org_id = p_org_id
          AND attempt.companion_id = p_companion_id
          AND attempt.id = p_work_id
          AND attempt.claim_epoch = p_claim_epoch
      )
      WHEN authorization_row.authorized AND p_work_kind = 'decision' THEN (
        SELECT delivery.command_id
        FROM public.companion_decision_deliveries delivery
        WHERE delivery.org_id = p_org_id
          AND delivery.companion_id = p_companion_id
          AND delivery.id = p_work_id
          AND delivery.claim_epoch = p_claim_epoch
      )
      ELSE NULL::uuid
    END AS command_id,
    CASE
      WHEN (
        authorization_row.authorized
        OR authorization_row.denial_code = 'turn_cancel_requested'
      ) AND p_work_kind = 'attempt' THEN (
        SELECT attempt.pi_invocation_id
        FROM public.companion_turn_attempts attempt
        WHERE attempt.org_id = p_org_id
          AND attempt.companion_id = p_companion_id
          AND attempt.id = p_work_id
          AND attempt.claim_epoch = p_claim_epoch
      )
      ELSE NULL::text
    END AS command_pi_invocation_id
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorization_row
$function$;
--> statement-breakpoint
