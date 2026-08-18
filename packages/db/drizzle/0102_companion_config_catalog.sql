-- Read-only Companion config catalog for Pi staging. Names and ids only; never credentials.
-- Claim-fenced like get_material. Accessibility matches validate_resource_selection scoped to
-- the Companion's settings_actor.

CREATE FUNCTION public.companion_runtime_get_config_catalog(
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
  catalog jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_authorization record;
  v_companion public.companions%ROWTYPE;
  v_actor_id text;
  v_skills jsonb;
  v_plugins jsonb;
  v_catalog jsonb;
BEGIN
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN
    RETURN;
  END IF;

  SELECT companion.* INTO STRICT v_companion
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;

  SELECT instance.settings_actor_id INTO v_actor_id
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
  v_actor_id := COALESCE(v_actor_id, v_authorization.authorization_actor_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', listed.id,
      'slug', listed.slug,
      'name', listed.name,
      'description', listed.description,
      'selected', listed.selected
    ) ORDER BY listed.selected DESC, listed.slug), '[]'::jsonb)
  INTO v_skills
  FROM (
    SELECT skill.id, skill.slug,
      COALESCE(NULLIF(btrim(skill.display_name), ''), skill.slug) AS name,
      left(skill.description, 200) AS description,
      COALESCE(v_companion.selected_skill_ids, '[]'::jsonb) ? skill.id::text AS selected
    FROM public.skills skill
    WHERE skill.org_id = p_org_id
      AND skill.archived_at IS NULL
      AND skill.validation = 'valid'
      AND skill.current_version_id IS NOT NULL
      AND (
        COALESCE(v_companion.selected_skill_ids, '[]'::jsonb) ? skill.id::text
        OR skill.scope = 'org'
        OR skill.creator_id = v_actor_id
      )
    ORDER BY (COALESCE(v_companion.selected_skill_ids, '[]'::jsonb) ? skill.id::text) DESC,
      skill.slug
    LIMIT 100
  ) listed;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', listed.id,
      'label', listed.label,
      'provider', listed.provider,
      'transport', listed.transport,
      'selected', listed.selected
    ) ORDER BY listed.selected DESC, listed.provider, listed.label), '[]'::jsonb)
  INTO v_plugins
  FROM (
    SELECT account.id, account.label, account.provider, account.transport,
      COALESCE(v_companion.selected_mcp_account_ids, '[]'::jsonb) ? account.id::text AS selected
    FROM public.companion_mcp_accounts account
    WHERE account.org_id = p_org_id
      AND (
        COALESCE(v_companion.selected_mcp_account_ids, '[]'::jsonb) ? account.id::text
        OR account.owner_id = v_actor_id
      )
    ORDER BY (COALESCE(v_companion.selected_mcp_account_ids, '[]'::jsonb) ? account.id::text) DESC,
      account.provider, account.label
    LIMIT 100
  ) listed;

  v_catalog := jsonb_build_object(
    'companion', jsonb_build_object(
      'model_id', v_companion.model_id,
      'provider_id', v_companion.provider_ids ->> 0,
      'persona', v_companion.persona
    ),
    'skills', v_skills,
    'plugins', v_plugins,
    'note', 'Propose changes with propose_config. Approval applies after the current turn; do not claim a change is active until then.'
  );
  IF octet_length(v_catalog::text) > 262144 THEN
    RAISE EXCEPTION 'config catalog exceeds the bounded executor contract' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY SELECT v_catalog;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_get_config_catalog(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;

--> statement-breakpoint

-- Post-cutover migrations run after the split-role grant script, so this function hands itself to
-- the runtime executor named by the existing claim-fenced material reader. No split roles at all
-- means there is nothing to grant.
DO $companion_runtime_config_catalog_acl$
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
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_get_config_catalog('
    || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',
    v_role
  );
END
$companion_runtime_config_catalog_acl$;
