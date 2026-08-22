-- Runtime-vended MCP OAuth access. Refresh credentials remain encrypted in PostgreSQL/API memory;
-- the Box receives only a six-hour, account-bound capability and short-lived access tokens.

ALTER TABLE public.companion_mcp_accounts
  ADD COLUMN credential_version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT companion_mcp_accounts_credential_version_check CHECK (credential_version >= 1);
--> statement-breakpoint

CREATE TABLE public.companion_mcp_broker_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  actor_id text NOT NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  account_refs jsonb NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_mcp_broker_tokens_companion_fk
    FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_mcp_broker_tokens_actor_membership_fk
    FOREIGN KEY (org_id, actor_id)
    REFERENCES public.memberships(org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT companion_mcp_broker_tokens_account_refs_check CHECK (
    jsonb_typeof(account_refs) = 'array'
    AND jsonb_array_length(account_refs) BETWEEN 1 AND 50
  )
);
--> statement-breakpoint

CREATE INDEX companion_mcp_broker_tokens_expiry_idx
  ON public.companion_mcp_broker_tokens(expires_at);
--> statement-breakpoint

ALTER TABLE public.companion_mcp_broker_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_mcp_broker_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE public.companion_runtime_instances
  ADD COLUMN mcp_broker_token_id uuid
  REFERENCES public.companion_mcp_broker_tokens(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE FUNCTION public.companion_revoke_inactive_mcp_broker_token()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF OLD.mcp_broker_token_id IS NOT NULL AND (
    NEW.mcp_broker_token_id IS DISTINCT FROM OLD.mcp_broker_token_id
    OR NEW.retirement_state <> 'active'
    OR NEW.box_state IN ('archived', 'absent')
  ) THEN
    UPDATE public.companion_mcp_broker_tokens
    SET revoked_at = COALESCE(revoked_at, clock_timestamp())
    WHERE id = OLD.mcp_broker_token_id;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_revoke_inactive_mcp_broker_token() FROM PUBLIC;
CREATE TRIGGER companion_runtime_instances_revoke_mcp_broker_token
AFTER UPDATE OF mcp_broker_token_id, retirement_state, box_state
ON public.companion_runtime_instances
FOR EACH ROW EXECUTE FUNCTION public.companion_revoke_inactive_mcp_broker_token();
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_mint_mcp_broker_token(
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
RETURNS TABLE (token text, expires_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_authorization record;
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_previous uuid;
  v_token_id uuid := gen_random_uuid();
  v_secret text;
  v_token text;
  v_now timestamp with time zone := clock_timestamp();
  v_expires_at timestamp with time zone := v_now + interval '6 hours';
BEGIN
  IF p_work_kind NOT IN ('operation', 'settings') THEN
    RAISE EXCEPTION 'MCP broker mint requires staging work' USING ERRCODE = '22023';
  END IF;
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN RETURN; END IF;

  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;
  v_previous := v_instance.mcp_broker_token_id;

  IF v_authorization.authorization_actor_id IS NULL
     OR v_authorization.client_surface = 'native_mobile'
     OR jsonb_array_length(v_authorization.mcp_refs) = 0 THEN
    UPDATE public.companion_runtime_instances
    SET mcp_broker_token_id = NULL, updated_at = v_now
    WHERE org_id = p_org_id AND companion_id = p_companion_id;
    IF v_previous IS NOT NULL THEN
      UPDATE public.companion_mcp_broker_tokens
      SET revoked_at = v_now WHERE id = v_previous AND revoked_at IS NULL;
    END IF;
    RETURN;
  END IF;

  v_secret := left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 48);
  v_token := 'cmp_mcp_' || v_secret;
  INSERT INTO public.companion_mcp_broker_tokens(
    id, org_id, companion_id, actor_id, token_prefix, token_hash, account_refs, expires_at
  ) VALUES (
    v_token_id, p_org_id, p_companion_id, v_authorization.authorization_actor_id,
    left(v_token, 14), encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    v_authorization.mcp_refs, v_expires_at
  );
  UPDATE public.companion_runtime_instances
  SET mcp_broker_token_id = v_token_id,
      material_client_surface = NULL,
      material_pi_invocation_id = NULL,
      material_expires_at = NULL,
      updated_at = v_now
  WHERE org_id = p_org_id AND companion_id = p_companion_id;
  IF v_previous IS NOT NULL THEN
    UPDATE public.companion_mcp_broker_tokens
    SET revoked_at = v_now WHERE id = v_previous AND revoked_at IS NULL;
  END IF;
  RETURN QUERY SELECT v_token, v_expires_at;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_mint_mcp_broker_token(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_resolve_mcp_broker_token(p_token_hash text)
RETURNS TABLE (
  org_id uuid,
  companion_id uuid,
  actor_id text,
  account_refs jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  RETURN QUERY
  UPDATE public.companion_mcp_broker_tokens token
  SET last_used_at = v_now
  FROM public.companion_runtime_instances instance,
       public.companions companion,
       public.memberships membership
  WHERE token.token_hash = p_token_hash
    AND token.revoked_at IS NULL
    AND token.expires_at > v_now
    AND instance.org_id = token.org_id
    AND instance.companion_id = token.companion_id
    AND instance.mcp_broker_token_id = token.id
    AND instance.retirement_state = 'active'
    AND companion.org_id = token.org_id
    AND companion.id = token.companion_id
    AND membership.org_id = token.org_id
    AND membership.user_id = token.actor_id
  RETURNING token.org_id, token.companion_id, token.actor_id, token.account_refs;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_resolve_mcp_broker_token(text) FROM PUBLIC;
--> statement-breakpoint

-- All broker-token access stays behind the narrow SECURITY DEFINER entry points above. FORCE RLS
-- still applies to their owner, so explicitly admit only that shared function owner.
CREATE POLICY "companion_mcp_broker_tokens_function_owner_rls"
  ON public.companion_mcp_broker_tokens FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_resolve_mcp_broker_token(text)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_resolve_mcp_broker_token(text)'::regprocedure
  )));
--> statement-breakpoint

-- Quarantine material-protocol-1 replicas. Already-held leases may settle, but only protocol 2
-- can claim new work after the gateway schema is available.
ALTER FUNCTION public.companion_runtime_claim_work(text, integer, integer, bigint, integer)
  RENAME TO companion_runtime_claim_work_material_v1;
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
  IF p_material_protocol IS DISTINCT FROM 2 THEN RETURN; END IF;
  RETURN QUERY SELECT * FROM public.companion_runtime_claim_work_material_v1(
    p_executor_id, p_limit, p_lease_seconds, p_gate_epoch, 1
  );
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(
  text, integer, integer, bigint, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_claim_work_material_v1(
  text, integer, integer, bigint, integer
) FROM PUBLIC;
--> statement-breakpoint

DO $companion_mcp_broker_acl$
DECLARE
  v_runtime oid := pg_catalog.to_regprocedure(
    'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)'
  );
  v_api oid := pg_catalog.to_regprocedure('public.companion_resolve_api_token(text,text)');
  v_runtime_grantees oid[];
  v_api_grantees oid[];
  v_role name;
BEGIN
  IF v_runtime IS NULL OR v_api IS NULL THEN
    RAISE EXCEPTION 'Companion MCP broker ACL sources are missing' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT acl.grantee), ARRAY[]::oid[])
  INTO v_runtime_grantees
  FROM pg_catalog.pg_proc source_proc
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
  ) acl
  WHERE source_proc.oid = v_runtime AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee NOT IN (source_proc.proowner, 0);
  IF cardinality(v_runtime_grantees) > 1 THEN
    RAISE EXCEPTION 'Companion runtime ACL must name exactly one executor' USING ERRCODE = '55000';
  END IF;
  IF cardinality(v_runtime_grantees) = 1 THEN
    SELECT rolname INTO STRICT v_role FROM pg_catalog.pg_roles WHERE oid = v_runtime_grantees[1];
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_mint_mcp_broker_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_claim_work(text,integer,integer,bigint,integer) TO %I', v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_runtime_cas_mcp_oauth(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text) FROM %I', v_role);
  END IF;

  SELECT COALESCE(array_agg(DISTINCT acl.grantee), ARRAY[]::oid[])
  INTO v_api_grantees
  FROM pg_catalog.pg_proc source_proc
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
  ) acl
  WHERE source_proc.oid = v_api AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee NOT IN (source_proc.proowner, 0);
  IF cardinality(v_api_grantees) > 1 THEN
    RAISE EXCEPTION 'Companion API ACL must name exactly one executor' USING ERRCODE = '55000';
  END IF;
  IF cardinality(v_api_grantees) = 1 THEN
    SELECT rolname INTO STRICT v_role FROM pg_catalog.pg_roles WHERE oid = v_api_grantees[1];
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_resolve_mcp_broker_token(text) TO %I', v_role);
  END IF;
END
$companion_mcp_broker_acl$;
