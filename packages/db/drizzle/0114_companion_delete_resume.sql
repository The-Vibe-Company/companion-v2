-- An accepted Box deletion is durable provider work. Defer one non-terminal poll without settling
-- the operation, release the lease atomically, and let PostgreSQL schedule the next observation.
CREATE FUNCTION public.companion_runtime_defer_delete(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  UPDATE public.companion_operations operation
  SET status = 'pending',
      claim_epoch = NULL,
      available_at = v_now + CASE
        WHEN operation.attempt_count <= 1 THEN interval '5 seconds'
        WHEN operation.attempt_count = 2 THEN interval '15 seconds'
        WHEN operation.attempt_count = 3 THEN interval '30 seconds'
        ELSE interval '60 seconds'
      END,
      updated_at = v_now
  FROM public.companion_runtime_control control
  WHERE control.id = 'runtime-v2'
    AND control.enabled
    AND control.gate_epoch = p_gate_epoch
    AND p_work_kind = 'operation'
    AND operation.org_id = p_org_id
    AND operation.companion_id = p_companion_id
    AND operation.id = p_work_id
    AND operation.kind = 'delete'
    AND operation.status = 'running'
    AND operation.claim_epoch = p_claim_epoch
    AND operation.checkpoint = 'waiting_deleted'
    AND operation.provider_operation_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.companion_runtime_leases lease
      WHERE lease.org_id = p_org_id
        AND lease.companion_id = p_companion_id
        AND lease.claim_token = p_claim_token
        AND lease.claim_epoch = p_claim_epoch
        AND lease.gate_epoch = p_gate_epoch
        AND lease.executor_id = p_executor_id
        AND lease.work_kind = p_work_kind
        AND lease.work_id = p_work_id
        AND lease.expires_at > v_now
    );
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.companion_runtime_leases lease
  SET claim_token = NULL,
      gate_epoch = NULL,
      executor_id = NULL,
      work_kind = NULL,
      work_id = NULL,
      claimed_at = NULL,
      renewed_at = NULL,
      expires_at = NULL,
      updated_at = v_now
  WHERE lease.org_id = p_org_id
    AND lease.companion_id = p_companion_id
    AND lease.claim_token = p_claim_token
    AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch
    AND lease.executor_id = p_executor_id
    AND lease.work_kind = p_work_kind
    AND lease.work_id = p_work_id
    AND lease.expires_at > v_now;
  IF NOT FOUND THEN
    -- Raising rolls back the operation update. A partial defer must never become visible.
    RAISE EXCEPTION 'Companion delete defer fence changed during mutation' USING ERRCODE = '40001';
  END IF;
  RETURN true;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_defer_delete(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid
) FROM PUBLIC;
--> statement-breakpoint

-- Runtime binaries before 0114 call the five-argument material-protocol signature. Preserve that
-- signature as a no-op while the six-argument delete-resume protocol owns all new claims.
ALTER FUNCTION public.companion_runtime_claim_work(text, integer, integer, bigint, integer)
  RENAME TO companion_runtime_claim_work_without_delete_resume_guard;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_claim_work(
  p_executor_id text,
  p_limit integer,
  p_lease_seconds integer,
  p_gate_epoch bigint,
  p_material_protocol integer
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
AS $$
BEGIN
  RETURN;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_claim_work(
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
AS $$
BEGIN
  IF p_delete_resume_protocol IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'invalid Runtime v2 delete-resume protocol' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT guarded.*
    FROM public.companion_runtime_claim_work_without_delete_resume_guard(
      p_executor_id, p_limit, p_lease_seconds, p_gate_epoch, p_material_protocol
    ) guarded;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(
  text, integer, integer, bigint, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(
  text, integer, integer, bigint, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_claim_work_without_delete_resume_guard(
  text, integer, integer, bigint, integer
) FROM PUBLIC;
--> statement-breakpoint

-- Mirror the one runtime executor trusted by the existing fenced material reader. API and worker
-- roles never receive either the new claimer or the delete-defer mutation.
DO $companion_delete_resume_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure(
    'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)'
  );
  v_grantees oid[];
  v_role name;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Companion runtime material surface is missing' USING ERRCODE = '55000';
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
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_claim_work('
    || 'text,integer,integer,bigint,integer) TO %I', v_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_claim_work('
    || 'text,integer,integer,bigint,integer,integer) TO %I', v_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_defer_delete('
    || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid) TO %I', v_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION public.companion_runtime_claim_work_without_delete_resume_guard('
    || 'text,integer,integer,bigint,integer) FROM %I', v_role
  );
END
$companion_delete_resume_acl$;
--> statement-breakpoint

-- Resume only the newest eligible failed delete per Companion. A retained provider operation id
-- proves DELETE was already accepted, so recovery polls it and never submits another deletion.
WITH eligible AS (
  SELECT operation.id,
         row_number() OVER (
           PARTITION BY operation.org_id, operation.companion_id
           ORDER BY operation.queue_sequence DESC, operation.id DESC
         ) AS delete_rank
  FROM public.companion_operations operation
  WHERE operation.kind = 'delete'
    AND operation.status = 'failed'
    AND operation.checkpoint IN ('provider_delete_requested', 'waiting_deleted')
    AND operation.provider_operation_id IS NOT NULL
    AND operation.last_error_code IN ('box_delete_blocked', 'box_delete_deadline_exceeded')
    AND NOT EXISTS (
      SELECT 1
      FROM public.companion_operations active
      WHERE active.org_id = operation.org_id
        AND active.companion_id = operation.companion_id
        AND active.kind = 'delete'
        AND active.status IN ('pending', 'running')
    )
)
UPDATE public.companion_operations operation
SET status = 'pending',
    claim_epoch = NULL,
    available_at = clock_timestamp(),
    settled_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    last_error_action = NULL,
    updated_at = clock_timestamp()
FROM eligible
WHERE operation.id = eligible.id
  AND eligible.delete_rank = 1;
