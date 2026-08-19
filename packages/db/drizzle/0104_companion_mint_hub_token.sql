-- Ephemeral Skills Hub token minted under a live Runtime claim. Skills Hub access is
-- unconditional, so the scope set is fixed: skills read/write, secret reads, and Skill Database
-- read/write. Actor = settings_actor_id, TTL = Box lifetime (6h). The previous token id lives on
-- companion_runtime_instances.hub_token_id and is revoked on rotate. The plaintext is returned once
-- and never stored.

ALTER TABLE public.companion_runtime_instances
  ADD COLUMN hub_token_id uuid REFERENCES public.api_tokens(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_mint_hub_token(
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
  token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_authorization record;
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_companion public.companions%ROWTYPE;
  v_actor_id text;
  v_surface public.companion_client_surface;
  v_scopes jsonb;
  v_previous uuid;
  v_token_id uuid := gen_random_uuid();
  v_secret text;
  v_token text;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN
    RETURN;
  END IF;

  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;

  SELECT companion.* INTO STRICT v_companion
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;

  v_actor_id := COALESCE(v_instance.settings_actor_id, v_authorization.authorization_actor_id);
  v_surface := COALESCE(
    v_instance.settings_claim_client_surface, v_instance.applied_client_surface
  );
  v_previous := v_instance.hub_token_id;

  IF v_actor_id IS NULL
     OR v_surface = 'native_mobile'
     OR NOT EXISTS (
       SELECT 1 FROM public.memberships membership
       WHERE membership.org_id = p_org_id AND membership.user_id = v_actor_id
     ) THEN
    IF v_previous IS NOT NULL THEN
      UPDATE public.companion_runtime_instances
      SET hub_token_id = NULL, updated_at = v_now
      WHERE org_id = p_org_id AND companion_id = p_companion_id;
      UPDATE public.api_tokens
      SET revoked_at = v_now
      WHERE id = v_previous AND revoked_at IS NULL;
    END IF;
    RETURN;
  END IF;

  -- Fixed set, mirrored by COMPANION_HUB_TOKEN_SCOPES in the contracts package. It deliberately
  -- excludes secrets:write and public-skills:install: a Box may read secret material it is trusted
  -- with, never rewrite the workspace's secrets or install public packages on its own authority.
  v_scopes := jsonb_build_array(
    'skills:read', 'skills:write', 'secrets:read', 'database:read', 'database:write'
  );

  v_secret := left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 48);
  v_token := 'cmp_pat_' || v_secret;

  INSERT INTO public.api_tokens(
    id, org_id, user_id, name, token_prefix, token_hash, scopes,
    source_type, source_agent_id, target_workspace_id, expires_at
  ) VALUES (
    v_token_id, p_org_id, v_actor_id, 'Companion Skills Hub',
    left(v_token, 14),
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    v_scopes, 'companion', p_companion_id::text, NULL,
    v_now + interval '6 hours'
  );

  UPDATE public.companion_runtime_instances
  SET hub_token_id = v_token_id, updated_at = v_now
  WHERE org_id = p_org_id AND companion_id = p_companion_id;

  IF v_previous IS NOT NULL THEN
    UPDATE public.api_tokens
    SET revoked_at = v_now
    WHERE id = v_previous AND revoked_at IS NULL;
  END IF;

  INSERT INTO public.audit_log(
    org_id, actor_id, action, target_type, target_id, metadata
  ) VALUES (
    p_org_id, v_actor_id, 'api_token.issue_companion_write', 'api_token', v_token_id::text,
    jsonb_build_object(
      'sourceType', 'companion',
      'sourceAgentId', p_companion_id,
      'scopes', v_scopes,
      'expiresAt', (v_now + interval '6 hours')
    )
  );

  RETURN QUERY SELECT v_token;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_mint_hub_token(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;

--> statement-breakpoint

-- Same post-cutover ACL handoff as 0100: the split-role grant script has already run, so the mint
-- function grants itself to the executor the claim-fenced material reader names.
DO $companion_runtime_mint_hub_token_acl$
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
  IF cardinality(v_grantees) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(v_grantees) > 1 THEN
    RAISE EXCEPTION 'Companion runtime ACL must name exactly one executor' USING ERRCODE = '55000';
  END IF;
  SELECT executor_role.rolname INTO STRICT v_role
  FROM pg_catalog.pg_roles executor_role WHERE executor_role.oid = v_grantees[1];
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_mint_hub_token('
    || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',
    v_role
  );
END
$companion_runtime_mint_hub_token_acl$;
