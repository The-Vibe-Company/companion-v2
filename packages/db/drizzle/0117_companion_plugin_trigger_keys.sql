-- Per-plugin trigger credentials: a second authentication a provider needs for webhook
-- registration when its MCP OAuth token cannot manage webhooks (Linear today). Envelope-encrypted
-- like every other control-plane credential and never returned to any client.

CREATE TABLE public.companion_plugin_trigger_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.companion_mcp_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  credential_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  wrapped_dek text NOT NULL,
  wrap_iv text NOT NULL,
  wrap_auth_tag text NOT NULL,
  key_id text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_plugin_trigger_keys_org_provider_uq UNIQUE (org_id, provider),
  CONSTRAINT companion_plugin_trigger_keys_provider_check CHECK (provider IN ('linear'))
);
--> statement-breakpoint

CREATE FUNCTION public.companion_api_set_plugin_trigger_key(
  p_org_id uuid,
  p_account_id uuid,
  p_provider text,
  p_generation uuid,
  p_ciphertext text,
  p_iv text,
  p_auth_tag text,
  p_wrapped_dek text,
  p_wrap_iv text,
  p_wrap_auth_tag text,
  p_key_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
BEGIN
  IF p_account_id IS NULL OR p_provider IS DISTINCT FROM 'linear'
     OR p_generation IS NULL OR p_ciphertext IS NULL OR p_iv IS NULL OR p_auth_tag IS NULL
     OR p_wrapped_dek IS NULL OR p_wrap_iv IS NULL OR p_wrap_auth_tag IS NULL OR p_key_id IS NULL THEN
    RAISE EXCEPTION 'invalid Companion plugin trigger key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.companion_mcp_accounts account
    WHERE account.org_id = p_org_id AND account.id = p_account_id AND account.provider = p_provider
      AND account.owner_id = v_actor_id
  ) THEN
    RAISE EXCEPTION 'plugin account not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.companion_plugin_trigger_keys(
    org_id, account_id, provider, credential_generation,
    ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
  ) VALUES (
    p_org_id, p_account_id, p_provider, p_generation,
    p_ciphertext, p_iv, p_auth_tag, p_wrapped_dek, p_wrap_iv, p_wrap_auth_tag, p_key_id
  )
  ON CONFLICT (org_id, provider) DO UPDATE SET
    account_id = EXCLUDED.account_id,
    credential_generation = EXCLUDED.credential_generation,
    ciphertext = EXCLUDED.ciphertext,
    iv = EXCLUDED.iv,
    auth_tag = EXCLUDED.auth_tag,
    wrapped_dek = EXCLUDED.wrapped_dek,
    wrap_iv = EXCLUDED.wrap_iv,
    wrap_auth_tag = EXCLUDED.wrap_auth_tag,
    key_id = EXCLUDED.key_id,
    updated_at = clock_timestamp();
END
$$;
--> statement-breakpoint

-- Registration-path read. Returns the raw envelope so the TypeScript layer can decrypt it; the
-- editor gate matches the trigger registration surface it serves.
CREATE FUNCTION public.companion_api_get_plugin_trigger_key(
  p_org_id uuid,
  p_companion_id uuid,
  p_provider text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_access text := public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  v_row public.companion_plugin_trigger_keys%ROWTYPE;
BEGIN
  IF v_access NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'editor access is required' USING ERRCODE = '42501';
  END IF;
  SELECT key_row.* INTO v_row
  FROM public.companion_plugin_trigger_keys key_row
  WHERE key_row.org_id = p_org_id AND key_row.provider = p_provider;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'account_id', v_row.account_id,
    'credential_generation', v_row.credential_generation,
    'ciphertext', v_row.ciphertext,
    'iv', v_row.iv,
    'auth_tag', v_row.auth_tag,
    'wrapped_dek', v_row.wrapped_dek,
    'wrap_iv', v_row.wrap_iv,
    'wrap_auth_tag', v_row.wrap_auth_tag,
    'key_id', v_row.key_id
  );
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_set_plugin_trigger_key(
  uuid, uuid, text, uuid, text, text, text, text, text, text, text
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_get_plugin_trigger_key(
  uuid, uuid, text
) FROM PUBLIC;
--> statement-breakpoint

DO $companion_plugin_trigger_key_acl$
DECLARE
  v_role_sources oid[] := array[
    pg_catalog.to_regprocedure('public.companion_api_set_plugin_trigger_key(uuid,uuid,text,uuid,text,text,text,text,text,text,text)'),
    pg_catalog.to_regprocedure('public.companion_api_get_plugin_trigger_key(uuid,uuid,text)')
  ];
  v_source oid;
  v_grantees oid[];
  v_role name;
BEGIN
  FOREACH v_source IN ARRAY v_role_sources LOOP
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Companion plugin trigger key surface is missing' USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT acl.grantee), ARRAY[]::oid[])
    INTO v_grantees
    FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
    ) acl
    WHERE source_proc.oid = pg_catalog.to_regprocedure(
        'public.companion_api_rotate_trigger_secret(uuid,uuid,uuid,text)'
      )
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> source_proc.proowner
      AND acl.grantee <> 0;
    IF cardinality(v_grantees) = 0 THEN
      CONTINUE;
    END IF;
    IF cardinality(v_grantees) > 1 THEN
      RAISE EXCEPTION 'Companion API ACL must name exactly one login role' USING ERRCODE = '55000';
    END IF;
    SELECT api_role.rolname INTO STRICT v_role
    FROM pg_catalog.pg_roles api_role WHERE api_role.oid = v_grantees[1];
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_source::regprocedure::text, v_role);
  END LOOP;
END
$companion_plugin_trigger_key_acl$;
