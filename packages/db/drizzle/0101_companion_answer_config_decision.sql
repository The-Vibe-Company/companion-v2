-- Apply an approved config_proposal under the approver's authority. The generic
-- companion_api_answer_decision path stays fail-closed for this kind. Validation
-- failure rolls the whole transaction back so the delivery stays pending.

CREATE FUNCTION public.companion_api_config_merge_ids(
  p_current jsonb,
  p_add jsonb,
  p_remove jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(skill_id) ORDER BY skill_id)
      FROM (
        SELECT DISTINCT skill_id
        FROM (
          SELECT jsonb_array_elements_text(COALESCE(p_current, '[]'::jsonb)) AS skill_id
          UNION
          SELECT jsonb_array_elements_text(COALESCE(p_add, '[]'::jsonb))
        ) combined
        WHERE skill_id NOT IN (
          SELECT jsonb_array_elements_text(COALESCE(p_remove, '[]'::jsonb))
        )
      ) kept
    ),
    '[]'::jsonb
  );
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_get_decision(
  p_org_id uuid,
  p_companion_id uuid,
  p_request_key text
)
RETURNS TABLE (
  request_key text,
  request_kind public.companion_decision_request_kind,
  decision_status public.companion_decision_status,
  proposal jsonb,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_delivery public.companion_decision_deliveries%ROWTYPE;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
     OR p_request_key ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Companion decision response' USING ERRCODE = '22023';
  END IF;

  SELECT delivery.* INTO v_delivery
  FROM public.companion_decision_deliveries delivery
  JOIN public.companion_turn_attempts attempt
    ON attempt.org_id = delivery.org_id
   AND attempt.companion_id = delivery.companion_id
   AND attempt.id = delivery.attempt_id
  WHERE delivery.org_id = p_org_id
    AND delivery.companion_id = p_companion_id
    AND delivery.request_key = p_request_key
    AND delivery.decision_status = 'pending'
    AND attempt.status = 'needs_input'
  ORDER BY delivery.created_at DESC, delivery.id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT delivery.* INTO v_delivery
    FROM public.companion_decision_deliveries delivery
    WHERE delivery.org_id = p_org_id
      AND delivery.companion_id = p_companion_id
      AND delivery.request_key = p_request_key
    ORDER BY delivery.created_at DESC, delivery.id DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion decision not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY SELECT v_delivery.request_key, v_delivery.request_kind,
    v_delivery.decision_status, v_delivery.proposal, v_delivery.expires_at;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_answer_config_decision(
  p_org_id uuid,
  p_companion_id uuid,
  p_request_key text,
  p_action text
)
RETURNS TABLE (
  delivery_id uuid,
  turn_id uuid,
  decision_status public.companion_decision_status,
  delivery_state public.companion_decision_delivery_state,
  responded_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_actor_name text;
  v_delivery public.companion_decision_deliveries%ROWTYPE;
  v_companion public.companions%ROWTYPE;
  v_status public.companion_decision_status;
  v_event_id text;
  v_list_key text;
  v_now timestamp with time zone := clock_timestamp();
  v_proposal jsonb;
  v_patch jsonb := '{}'::jsonb;
  v_has_connect boolean;
  v_has_mutation boolean;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
     OR p_request_key ~ E'[\n\r]' OR p_action NOT IN ('allow', 'deny') THEN
    RAISE EXCEPTION 'invalid Companion decision response' USING ERRCODE = '22023';
  END IF;

  SELECT delivery.* INTO v_delivery
  FROM public.companion_decision_deliveries delivery
  JOIN public.companion_turn_attempts attempt
    ON attempt.org_id = delivery.org_id
   AND attempt.companion_id = delivery.companion_id
   AND attempt.id = delivery.attempt_id
  WHERE delivery.org_id = p_org_id
    AND delivery.companion_id = p_companion_id
    AND delivery.request_key = p_request_key
    AND delivery.decision_status = 'pending'
    AND attempt.status = 'needs_input'
  ORDER BY delivery.created_at DESC, delivery.id DESC
  LIMIT 1
  FOR UPDATE OF delivery;

  IF NOT FOUND THEN
    SELECT delivery.* INTO v_delivery
    FROM public.companion_decision_deliveries delivery
    WHERE delivery.org_id = p_org_id
      AND delivery.companion_id = p_companion_id
      AND delivery.request_key = p_request_key
      AND delivery.actor_id = v_actor_id
    ORDER BY delivery.created_at DESC, delivery.id DESC
    LIMIT 1;
    IF NOT FOUND
       OR v_delivery.request_kind <> 'config_proposal'
       OR NOT (
         (p_action = 'allow' AND v_delivery.decision_status = 'allowed')
         OR (p_action = 'deny' AND v_delivery.decision_status = 'denied')
       ) THEN
      RAISE EXCEPTION 'Companion decision is not pending' USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT v_delivery.id, v_delivery.turn_id, v_delivery.decision_status,
      v_delivery.delivery_state, v_delivery.responded_at;
    RETURN;
  END IF;

  IF v_delivery.request_kind <> 'config_proposal' THEN
    RAISE EXCEPTION 'Companion config proposals cannot be answered here' USING ERRCODE = '22023';
  END IF;
  IF v_delivery.expires_at <= v_now THEN
    RAISE EXCEPTION 'Companion decision has expired' USING ERRCODE = '55000';
  END IF;

  v_proposal := v_delivery.proposal;
  IF v_proposal IS NULL OR jsonb_typeof(v_proposal) <> 'object'
     OR v_proposal ->> 'kind' <> 'config'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(v_proposal) patch_key
       WHERE patch_key NOT IN (
         'kind', 'add_skill_ids', 'remove_skill_ids', 'attach_plugin_ids',
         'detach_plugin_ids', 'model_id', 'persona', 'connect_plugin'
       )
     ) THEN
    RAISE EXCEPTION 'invalid Companion config proposal' USING ERRCODE = '22023';
  END IF;

  FOREACH v_list_key IN ARRAY ARRAY[
    'add_skill_ids', 'remove_skill_ids', 'attach_plugin_ids', 'detach_plugin_ids'
  ]
  LOOP
    IF v_proposal ? v_list_key AND (
      jsonb_typeof(v_proposal -> v_list_key) <> 'array'
      OR jsonb_array_length(v_proposal -> v_list_key) > 20
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_proposal -> v_list_key) item
        WHERE jsonb_typeof(item) <> 'string'
           OR (item #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    ) THEN
      RAISE EXCEPTION 'invalid Companion config proposal' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF v_proposal ? 'model_id' AND (
    jsonb_typeof(v_proposal -> 'model_id') <> 'string'
    OR char_length(v_proposal ->> 'model_id') NOT BETWEEN 1 AND 200
    OR (v_proposal ->> 'model_id') ~ E'[\n\r]'
  ) THEN
    RAISE EXCEPTION 'invalid Companion model' USING ERRCODE = '22023';
  END IF;
  IF v_proposal ? 'persona' AND NOT (
    jsonb_typeof(v_proposal -> 'persona') = 'null'
    OR (
      jsonb_typeof(v_proposal -> 'persona') = 'string'
      AND char_length(v_proposal ->> 'persona') <= 280
    )
  ) THEN
    RAISE EXCEPTION 'invalid Companion persona' USING ERRCODE = '22023';
  END IF;
  IF v_proposal ? 'connect_plugin' AND (
    jsonb_typeof(v_proposal -> 'connect_plugin') <> 'object'
    OR jsonb_typeof(v_proposal -> 'connect_plugin' -> 'server_name') <> 'string'
    OR (v_proposal -> 'connect_plugin' ->> 'server_name') NOT IN ('linear', 'github', 'notion')
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_proposal -> 'connect_plugin') connect_key
      WHERE connect_key NOT IN ('server_name', 'reason')
    )
  ) THEN
    RAISE EXCEPTION 'invalid Companion config proposal' USING ERRCODE = '22023';
  END IF;

  v_has_connect := v_proposal ? 'connect_plugin';
  v_has_mutation := v_proposal ? 'add_skill_ids'
    OR v_proposal ? 'remove_skill_ids'
    OR v_proposal ? 'attach_plugin_ids'
    OR v_proposal ? 'detach_plugin_ids'
    OR v_proposal ? 'model_id'
    OR v_proposal ? 'persona';
  IF v_has_connect AND v_has_mutation THEN
    RAISE EXCEPTION 'invalid Companion config proposal' USING ERRCODE = '22023';
  END IF;
  IF NOT v_has_connect AND NOT v_has_mutation THEN
    RAISE EXCEPTION 'invalid Companion config proposal' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'allow' AND v_has_mutation THEN
    SELECT companion.* INTO STRICT v_companion
    FROM public.companions companion
    WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
    FOR UPDATE;

    IF v_proposal ? 'add_skill_ids' OR v_proposal ? 'remove_skill_ids' THEN
      v_patch := v_patch || jsonb_build_object(
        'selected_skill_ids',
        public.companion_api_config_merge_ids(
          v_companion.selected_skill_ids,
          v_proposal -> 'add_skill_ids',
          v_proposal -> 'remove_skill_ids'
        )
      );
    END IF;
    IF v_proposal ? 'attach_plugin_ids' OR v_proposal ? 'detach_plugin_ids' THEN
      v_patch := v_patch || jsonb_build_object(
        'selected_mcp_account_ids',
        public.companion_api_config_merge_ids(
          v_companion.selected_mcp_account_ids,
          v_proposal -> 'attach_plugin_ids',
          v_proposal -> 'detach_plugin_ids'
        )
      );
    END IF;
    IF v_proposal ? 'model_id' THEN
      v_patch := v_patch || jsonb_build_object('model_id', v_proposal ->> 'model_id');
    END IF;
    IF v_proposal ? 'persona' THEN
      v_patch := v_patch || jsonb_build_object('persona', v_proposal -> 'persona');
    END IF;

    IF v_patch <> '{}'::jsonb THEN
      PERFORM public.companion_api_update_companion(p_org_id, p_companion_id, v_patch);
    END IF;
  END IF;

  v_status := CASE p_action
    WHEN 'allow' THEN 'allowed'::public.companion_decision_status
    ELSE 'denied'::public.companion_decision_status
  END;
  UPDATE public.companion_decision_deliveries delivery
  SET decision_status = v_status,
      actor_id = v_actor_id,
      response_text = NULL,
      responded_at = v_now,
      updated_at = v_now
  WHERE delivery.id = v_delivery.id
    AND delivery.org_id = p_org_id
    AND delivery.companion_id = p_companion_id
    AND delivery.decision_status = 'pending'
  RETURNING delivery.* INTO v_delivery;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion decision changed concurrently' USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(profile.name, app_user.name, app_user.email)
  INTO v_actor_name
  FROM public."user" app_user
  LEFT JOIN public.profiles profile ON profile.id = app_user.id
  WHERE app_user.id = v_actor_id;
  SELECT entry.event_id INTO v_event_id
  FROM public.companion_transcript_entries entry
  WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
    AND entry.role = 'decision'
    AND entry.decision ->> 'request_id' = p_request_key
    AND entry.decision ->> 'status' = 'pending'
  ORDER BY entry.ordinal DESC
  LIMIT 1
  FOR UPDATE;
  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'Companion decision transcript projection is missing' USING ERRCODE = '55000';
  END IF;
  UPDATE public.companion_transcript_entries entry
  SET decision = entry.decision || jsonb_build_object(
    'status', v_status,
    'answer', NULL,
    'decided_by_id', v_actor_id,
    'decided_by_name', v_actor_name,
    'decided_at', to_char(
      v_now AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  )
  WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
    AND entry.event_id = v_event_id;

  RETURN QUERY SELECT v_delivery.id, v_delivery.turn_id, v_delivery.decision_status,
    v_delivery.delivery_state, v_delivery.responded_at;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_config_merge_ids(jsonb, jsonb, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_get_decision(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_answer_config_decision(uuid, uuid, text, text) FROM PUBLIC;

--> statement-breakpoint

-- The split-role grant script runs before this migration (it is applied at the 0093 compatibility
-- checkpoint), so a post-cutover function must hand itself to the API login. The peer answer path
-- already names exactly that role, and no split roles at all means nothing to grant.
DO $companion_api_config_decision_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure(
    'public.companion_api_answer_decision(uuid,uuid,text,text,text)'
  );
  v_grantees oid[];
  v_role name;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Companion API decision surface is missing' USING ERRCODE = '55000';
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
    RAISE EXCEPTION 'Companion API ACL must name exactly one login role' USING ERRCODE = '55000';
  END IF;
  SELECT api_role.rolname INTO STRICT v_role
  FROM pg_catalog.pg_roles api_role WHERE api_role.oid = v_grantees[1];
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_api_get_decision(uuid,uuid,text) TO %I',
    v_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION '
    || 'public.companion_api_answer_config_decision(uuid,uuid,text,text) TO %I',
    v_role
  );
END
$companion_api_config_decision_acl$;
