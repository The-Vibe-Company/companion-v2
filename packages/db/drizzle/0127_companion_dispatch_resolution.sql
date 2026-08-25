-- Phase 2.2 direct dispatch resolution. Keep the established authorization function intact for
-- rolling deploys and expose its result through a versioned wrapper that adds the durable command
-- id and the Pi invocation pinned with its write intent. A takeover can now ask the on-box broker
-- ledger about the exact dispatch instead of interrupting merely because the previous executor
-- disappeared after dispatch.
CREATE FUNCTION public.companion_runtime_renew_and_authorize_v2(
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
      WHEN authorization_row.authorized AND p_work_kind = 'attempt' THEN (
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

REVOKE ALL ON FUNCTION public.companion_runtime_renew_and_authorize_v2(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint

-- Mirror the exact runtime executor already trusted by the legacy authorization entrypoint. The
-- wrapper is never granted to API or worker roles, and an ambiguous split-role ACL fails closed.
DO $companion_dispatch_resolution_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure(
    'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)'
  );
  v_grantees oid[];
  v_role name;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Companion runtime authorization surface is missing' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT acl.grantee), ARRAY[]::oid[])
  INTO v_grantees
  FROM pg_catalog.pg_proc source_proc
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
  ) acl
  WHERE source_proc.oid = v_source
    AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee <> source_proc.proowner
    AND acl.grantee <> 0;
  IF cardinality(v_grantees) = 0 THEN RETURN; END IF;
  IF cardinality(v_grantees) > 1 THEN
    RAISE EXCEPTION 'Companion runtime ACL must name exactly one executor' USING ERRCODE = '55000';
  END IF;
  SELECT executor_role.rolname INTO STRICT v_role
  FROM pg_catalog.pg_roles executor_role WHERE executor_role.oid = v_grantees[1];
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_renew_and_authorize_v2('
    || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',
    v_role
  );
END
$companion_dispatch_resolution_acl$;
