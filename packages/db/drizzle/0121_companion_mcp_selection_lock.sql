-- The MCP token broker runs as the restricted API role. Lock the current selection behind a
-- tenant- and actor-scoped capability instead of requiring ambient UPDATE privilege on companions.

CREATE FUNCTION public.companion_api_lock_selected_mcp_account(
  p_org_id uuid,
  p_companion_id uuid,
  p_account_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := NULLIF(current_setting('app.user_id', true), '');
  v_context_org_id text := NULLIF(current_setting('app.org_id', true), '');
  v_owner_id text;
  v_selected_mcp_account_ids jsonb;
  v_workspace_role public.companion_share_role;
BEGIN
  IF p_org_id IS NULL OR v_actor_id IS NULL
     OR p_org_id::text IS DISTINCT FROM v_context_org_id THEN
    RETURN false;
  END IF;

  -- Keep membership and Editor authority stable until the caller's transaction has finished
  -- issuing the access token. A concurrent revocation waits, then the next request fails closed.
  PERFORM 1
  FROM public.memberships membership
  WHERE membership.org_id = p_org_id AND membership.user_id = v_actor_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT companion.owner_id, companion.selected_mcp_account_ids
  INTO v_owner_id, v_selected_mcp_account_ids
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_owner_id <> v_actor_id THEN
    SELECT access.role INTO v_workspace_role
    FROM public.companion_workspace_access access
    WHERE access.org_id = p_org_id
      AND access.companion_id = p_companion_id
      AND access.owner_id = v_owner_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    IF v_workspace_role <> 'editor' THEN
      RETURN false;
    END IF;
  END IF;

  RETURN COALESCE(v_selected_mcp_account_ids ? p_account_id::text, false);
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_lock_selected_mcp_account(
  uuid, uuid, uuid
) FROM PUBLIC;
--> statement-breakpoint

-- Preserve split-role installs that apply migrations after the grants hook. Fresh databases grant
-- the complete surface when runtime-role-grants.sql runs after migration replay.
DO $companion_mcp_selection_lock_acl$
DECLARE
  v_api_source oid := pg_catalog.to_regprocedure(
    'public.companion_resolve_mcp_broker_token(text)'
  );
  v_api_grantees oid[];
  v_role name;
BEGIN
  IF v_api_source IS NULL THEN
    RAISE EXCEPTION 'Companion API ACL source is missing' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT acl.grantee), ARRAY[]::oid[])
  INTO v_api_grantees
  FROM pg_catalog.pg_proc source_proc
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
  ) acl
  WHERE source_proc.oid = v_api_source AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee NOT IN (source_proc.proowner, 0);
  IF cardinality(v_api_grantees) > 1 THEN
    RAISE EXCEPTION 'Companion API ACL must name exactly one executor' USING ERRCODE = '55000';
  END IF;
  IF cardinality(v_api_grantees) = 1 THEN
    SELECT rolname INTO STRICT v_role FROM pg_catalog.pg_roles WHERE oid = v_api_grantees[1];
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.companion_api_lock_selected_mcp_account(uuid,uuid,uuid) TO %I',
      v_role
    );
  END IF;
END
$companion_mcp_selection_lock_acl$;
