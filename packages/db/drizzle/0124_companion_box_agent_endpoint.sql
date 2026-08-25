-- Phase 2.0 direct transport (dark ship): persist the hosted endpoint of the on-box Companion
-- agent. The endpoint is registered through the provider's `host <port>` proxy at staging and is
-- written only under the same fenced lease proof as the material snapshot. `agent_hosted_url` is a
-- token-free locator; every credential (the provider proxy token and the per-staging agent bearer)
-- lives exclusively in `agent_token_ciphertext`, masterKey-encrypted by apps/runtime. Nothing
-- consumes these columns yet.
ALTER TABLE "companion_runtime_instances"
  ADD COLUMN "agent_hosted_url" text,
  ADD COLUMN "agent_token_ciphertext" text,
  ADD COLUMN "agent_observed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "companion_runtime_instances"
  ADD CONSTRAINT "companion_runtime_instances_agent_endpoint_check" CHECK (
    ("agent_hosted_url" IS NULL) = ("agent_token_ciphertext" IS NULL)
    AND ("agent_hosted_url" IS NULL) = ("agent_observed_at" IS NULL)
  );
--> statement-breakpoint

-- Adding parameters changes the function identity, so the previous signature is dropped rather
-- than left behind as a privileged overload. Grants are re-applied below because DROP discards
-- them (latest-wins re-CREATE convention; body copied from 0110 with only the agent additions —
-- the interval literals must stay exactly as registered in COMPANION_SQL_BUDGET_CONTRACT).
DROP FUNCTION public.companion_runtime_record_material_snapshot(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  public.companion_client_surface, timestamp with time zone
);
--> statement-breakpoint
CREATE FUNCTION public.companion_runtime_record_material_snapshot(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_client_surface public.companion_client_surface,
  p_material_expires_at timestamp with time zone,
  p_agent_hosted_url text,
  p_agent_token_ciphertext text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_updated integer;
BEGIN
  IF p_client_surface IS NULL
     OR (p_client_surface = 'native_mobile' AND p_material_expires_at IS NOT NULL)
     OR (p_client_surface <> 'native_mobile' AND (
       p_material_expires_at IS NULL
       OR p_material_expires_at <= v_now + interval '2 hours 5 minutes'
       OR p_material_expires_at > v_now + interval '7 days'
     ))
     OR p_work_kind NOT IN ('operation', 'settings') THEN
    RAISE EXCEPTION 'invalid staged Companion material snapshot' USING ERRCODE = '22023';
  END IF;

  -- The hosted URL and its encrypted tokens are one endpoint: half an endpoint is a bug, and an
  -- oversized value is never a URL the provider minted or a ciphertext the runtime produced.
  IF (p_agent_hosted_url IS NULL) <> (p_agent_token_ciphertext IS NULL)
     OR length(p_agent_hosted_url) > 2048
     OR length(p_agent_token_ciphertext) > 8192 THEN
    RAISE EXCEPTION 'invalid staged Companion agent endpoint' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.companion_runtime_leases lease
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  WHERE lease.org_id = p_org_id
    AND lease.companion_id = p_companion_id
    AND lease.claim_token = p_claim_token
    AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch
    AND lease.executor_id = p_executor_id
    AND lease.work_kind = p_work_kind
    AND lease.work_id = p_work_id
    AND lease.expires_at > v_now
    AND control.enabled
    AND control.gate_epoch = p_gate_epoch
  FOR UPDATE OF lease;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_work_kind = 'operation' THEN
    UPDATE public.companion_operations operation
    SET material_staged_at = v_now,
        material_expires_at = p_material_expires_at,
        updated_at = v_now
    WHERE operation.org_id = p_org_id
      AND operation.companion_id = p_companion_id
      AND operation.id = p_work_id
      AND operation.status = 'running'
      AND operation.claim_epoch = p_claim_epoch
      AND operation.client_surface = p_client_surface
      AND (
        operation.kind IN ('start', 'restart_box') AND operation.checkpoint = 'installing_layout'
        OR operation.kind = 'restart_pi' AND operation.checkpoint = 'pending'
        OR operation.kind = 'apply_settings' AND operation.checkpoint = 'applying_settings'
      );
  ELSE
    UPDATE public.companion_runtime_instances instance
    SET settings_claim_material_client_surface = p_client_surface,
        settings_claim_material_staged_at = v_now,
        settings_claim_material_expires_at = p_material_expires_at,
        updated_at = v_now
    WHERE instance.org_id = p_org_id
      AND instance.companion_id = p_companion_id
      AND p_work_id = instance.companion_id
      AND instance.settings_claim_epoch = p_claim_epoch
      AND instance.settings_claim_client_surface = p_client_surface
      AND instance.settings_checkpoint = 'applying';
  END IF;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RETURN false; END IF;

  UPDATE public.companion_runtime_instances instance
  SET last_write_epoch = GREATEST(instance.last_write_epoch, p_claim_epoch),
      -- Endpoint registration is per-Box, not per-Pi-invocation: a staging without registration
      -- (gate off) keeps the last observed endpoint rather than erasing it, and `agent_observed_at`
      -- carries the freshness a future consumer must judge before trusting the URL.
      agent_hosted_url = COALESCE(p_agent_hosted_url, instance.agent_hosted_url),
      agent_token_ciphertext = COALESCE(p_agent_token_ciphertext, instance.agent_token_ciphertext),
      agent_observed_at = CASE
        WHEN p_agent_hosted_url IS NULL THEN instance.agent_observed_at
        ELSE v_now
      END,
      updated_at = v_now
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
  RETURN true;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_record_material_snapshot(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  public.companion_client_surface, timestamp with time zone, text, text
) FROM PUBLIC;
--> statement-breakpoint

-- Mirror the runtime executor already trusted by the fenced material reader, exactly as 0110 did
-- for the previous signature. The migration never grants the function to API/worker roles and
-- fails closed if the split-role ACL is ambiguous.
DO $companion_agent_endpoint_acl$
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
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_record_material_snapshot('
    || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,'
    || 'public.companion_client_surface,timestamp with time zone,text,text) TO %I', v_role
  );
END
$companion_agent_endpoint_acl$;
