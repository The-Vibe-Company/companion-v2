-- Runtime v2 API surfaces. Application callers retain no direct mutation access to the legacy
-- Companion aggregate or any private runtime table: every accepted intent crosses one of these
-- tenant- and actor-scoped SECURITY DEFINER functions and is committed before Box/Pi is contacted.

CREATE FUNCTION public.companion_api_actor(p_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := NULLIF(current_setting('app.user_id', true), '');
  v_context_org_id uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
BEGIN
  -- Function `SET` clauses for custom GUCs require an administrator-level parameter grant at
  -- creation time. Pin the diagnostic protocol at runtime instead; every API helper reaches this
  -- actor boundary before its first legacy aggregate mutation.
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_org_id IS NULL OR v_actor_id IS NULL OR p_org_id IS DISTINCT FROM v_context_org_id THEN
    RAISE EXCEPTION 'Companion API tenant context is missing or mismatched'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships membership
    WHERE membership.org_id = p_org_id AND membership.user_id = v_actor_id
  ) THEN
    RAISE EXCEPTION 'Companion API actor is not a workspace member'
      USING ERRCODE = '42501';
  END IF;
  RETURN v_actor_id;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_set_workspace_access(
  p_org_id uuid,
  p_companion_id uuid,
  p_role public.companion_share_role
)
RETURNS TABLE (
  workspace_role public.companion_share_role,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_owner_id text;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'owner');
  SELECT companion.owner_id INTO STRICT v_owner_id
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;

  IF p_role IS NULL THEN
    DELETE FROM public.companion_workspace_access access
    WHERE access.org_id = p_org_id AND access.companion_id = p_companion_id;
  ELSE
    INSERT INTO public.companion_workspace_access(
      org_id, companion_id, owner_id, role, granted_by, created_at, updated_at
    ) VALUES (
      p_org_id, p_companion_id, v_owner_id, p_role, v_actor_id, v_now, v_now
    )
    ON CONFLICT (companion_id) DO UPDATE
    SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = EXCLUDED.updated_at
    WHERE companion_workspace_access.org_id = EXCLUDED.org_id
      AND companion_workspace_access.owner_id = EXCLUDED.owner_id;
  END IF;
  INSERT INTO public.audit_log(
    org_id, actor_id, action, target_type, target_id, metadata
  ) VALUES (
    p_org_id,
    v_actor_id,
    CASE WHEN p_role IS NULL
      THEN 'companion.share.workspace.revoked'
      ELSE 'companion.share.workspace.updated'
    END,
    'companion',
    p_companion_id::text,
    jsonb_build_object('role', p_role)
  );
  RETURN QUERY SELECT p_role, v_now;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_update_member_state(
  p_org_id uuid,
  p_companion_id uuid,
  p_pinned boolean,
  p_hidden boolean,
  p_unread boolean
)
RETURNS TABLE (
  pinned_at timestamp with time zone,
  hidden boolean,
  last_read_ordinal integer,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_existing public.companion_member_state%ROWTYPE;
  v_highest integer;
  v_pinned_at timestamp with time zone;
  v_hidden boolean;
  v_last_read integer;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'read');
  IF p_pinned IS NULL AND p_hidden IS NULL AND p_unread IS NULL THEN
    RAISE EXCEPTION 'at least one member-state setting is required' USING ERRCODE = '22023';
  END IF;
  SELECT state.* INTO v_existing
  FROM public.companion_member_state state
  WHERE state.org_id = p_org_id AND state.companion_id = p_companion_id
    AND state.user_id = v_actor_id
  FOR UPDATE;
  SELECT max(entry.ordinal) INTO v_highest
  FROM public.companion_transcript_entries entry
  WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id;

  v_pinned_at := CASE
    WHEN p_pinned IS TRUE THEN COALESCE(v_existing.pinned_at, v_now)
    WHEN p_pinned IS FALSE THEN NULL
    ELSE v_existing.pinned_at
  END;
  v_hidden := COALESCE(p_hidden, v_existing.hidden, false);
  v_last_read := CASE
    WHEN p_unread IS TRUE THEN CASE WHEN COALESCE(v_highest, 0) = 0 THEN NULL ELSE v_highest - 1 END
    WHEN p_unread IS FALSE THEN v_highest
    ELSE v_existing.last_read_ordinal
  END;

  INSERT INTO public.companion_member_state(
    org_id, companion_id, user_id, pinned_at, hidden, last_read_ordinal, created_at, updated_at
  ) VALUES (
    p_org_id, p_companion_id, v_actor_id, v_pinned_at, v_hidden, v_last_read, v_now, v_now
  )
  ON CONFLICT (companion_id, user_id) DO UPDATE
  SET pinned_at = EXCLUDED.pinned_at,
      hidden = EXCLUDED.hidden,
      last_read_ordinal = EXCLUDED.last_read_ordinal,
      updated_at = EXCLUDED.updated_at
  WHERE companion_member_state.org_id = EXCLUDED.org_id;

  RETURN QUERY SELECT v_pinned_at, v_hidden, v_last_read, v_now;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_mark_thread_read(
  p_org_id uuid,
  p_companion_id uuid
)
RETURNS TABLE (
  previous_last_read_ordinal integer,
  last_read_ordinal integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_previous integer;
  v_highest integer;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'read');
  SELECT state.last_read_ordinal INTO v_previous
  FROM public.companion_member_state state
  WHERE state.org_id = p_org_id AND state.companion_id = p_companion_id
    AND state.user_id = v_actor_id
  FOR UPDATE;
  SELECT max(entry.ordinal) INTO v_highest
  FROM public.companion_transcript_entries entry
  WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id;
  IF v_highest IS NOT NULL THEN
    INSERT INTO public.companion_member_state(
      org_id, companion_id, user_id, hidden, last_read_ordinal, created_at, updated_at
    ) VALUES (
      p_org_id, p_companion_id, v_actor_id, false, v_highest, v_now, v_now
    )
    ON CONFLICT (companion_id, user_id) DO UPDATE
    SET last_read_ordinal = EXCLUDED.last_read_ordinal, updated_at = EXCLUDED.updated_at
    WHERE companion_member_state.org_id = EXCLUDED.org_id;
  END IF;
  RETURN QUERY SELECT v_previous, v_highest;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_create_companion(
  p_org_id uuid,
  p_name text,
  p_persona text,
  p_provider_id text,
  p_model_id text,
  p_selected_skill_ids jsonb,
  p_can_write_skills boolean,
  p_selected_mcp_account_ids jsonb,
  p_source_companion_id uuid DEFAULT NULL
)
RETURNS TABLE (
  companion_id uuid,
  desired_settings_revision bigint,
  skills_revision integer,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_companion_id uuid := gen_random_uuid();
  v_created_at timestamp with time zone := clock_timestamp();
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 120
     OR p_persona IS NOT NULL AND char_length(p_persona) > 280
     OR p_provider_id IS NOT NULL AND p_provider_id !~ '^[a-z][a-z0-9-]{0,62}$'
     OR p_model_id IS NOT NULL AND (
       char_length(p_model_id) NOT BETWEEN 1 AND 200 OR p_model_id ~ E'[\n\r]'
     )
     OR p_can_write_skills IS NULL THEN
    RAISE EXCEPTION 'invalid Companion create arguments' USING ERRCODE = '22023';
  END IF;
  IF p_provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.companion_provider_connections connection
    WHERE connection.org_id = p_org_id AND connection.provider_id = p_provider_id
  ) THEN
    RAISE EXCEPTION 'Companion provider is not connected' USING ERRCODE = '22023';
  END IF;
  IF p_source_companion_id IS NOT NULL THEN
    PERFORM public.companion_api_require_access(p_org_id, p_source_companion_id, 'owner');
  END IF;
  PERFORM public.companion_api_validate_resource_selection(
    p_org_id,
    COALESCE(p_selected_skill_ids, '[]'::jsonb),
    '[]'::jsonb,
    COALESCE(p_selected_mcp_account_ids, '[]'::jsonb),
    '[]'::jsonb
  );

  INSERT INTO public.companions(
    id, org_id, owner_id, name, persona, model_id, selected_skill_ids,
    can_write_skills, selected_mcp_account_ids, provider_ids, created_at, updated_at
  ) VALUES (
    v_companion_id, p_org_id, v_actor_id, btrim(p_name), NULLIF(btrim(p_persona), ''),
    p_model_id, COALESCE(p_selected_skill_ids, '[]'::jsonb), p_can_write_skills,
    COALESCE(p_selected_mcp_account_ids, '[]'::jsonb),
    CASE WHEN p_provider_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_provider_id) END,
    v_created_at, v_created_at
  );

  INSERT INTO public.companion_runtime_instances(
    org_id, companion_id, settings_actor_id, settings_available_at, created_at, updated_at
  ) VALUES (
    p_org_id, v_companion_id, v_actor_id, v_created_at, v_created_at, v_created_at
  );

  IF p_source_companion_id IS NOT NULL THEN
    INSERT INTO public.audit_log(
      org_id, actor_id, action, target_type, target_id, metadata
    ) VALUES (
      p_org_id,
      v_actor_id,
      'companion.duplicated',
      'companion',
      v_companion_id::text,
      jsonb_build_object('source_companion_id', p_source_companion_id)
    );
  END IF;

  RETURN QUERY SELECT v_companion_id, 1::bigint, 1, v_created_at;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_update_companion(
  p_org_id uuid,
  p_companion_id uuid,
  p_patch jsonb
)
RETURNS TABLE (
  companion_id uuid,
  desired_settings_revision bigint,
  skills_revision integer,
  settings_changed boolean,
  skills_changed boolean,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_access text;
  v_companion public.companions%ROWTYPE;
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_name text;
  v_persona text;
  v_provider_id text;
  v_model_id text;
  v_selected_skill_ids jsonb;
  v_can_write_skills boolean;
  v_selected_mcp_account_ids jsonb;
  v_settings_changed boolean;
  v_skills_changed boolean;
  v_updated_at timestamp with time zone := clock_timestamp();
BEGIN
  v_access := public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_patch) patch_key
       WHERE patch_key NOT IN (
         'name', 'persona', 'provider_id', 'model_id', 'selected_skill_ids',
         'can_write_skills', 'selected_mcp_account_ids'
       )
     ) THEN
    RAISE EXCEPTION 'invalid Companion settings patch' USING ERRCODE = '22023';
  END IF;

  -- Runtime claims lock lease -> instance -> work -> ACL rows. API mutations never touch the
  -- lease, so taking the instance before the Companion keeps the two processes on one lock order.
  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;
  IF v_instance.retirement_state <> 'active' THEN
    RAISE EXCEPTION 'retired Companion settings cannot change' USING ERRCODE = '55000';
  END IF;
  SELECT companion.* INTO STRICT v_companion
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
  FOR UPDATE;

  IF p_patch ? 'name' AND (
    jsonb_typeof(p_patch -> 'name') <> 'string'
    OR char_length(btrim(p_patch ->> 'name')) NOT BETWEEN 1 AND 120
  ) THEN
    RAISE EXCEPTION 'invalid Companion name' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'persona' AND NOT (
    jsonb_typeof(p_patch -> 'persona') = 'null'
    OR jsonb_typeof(p_patch -> 'persona') = 'string'
      AND char_length(p_patch ->> 'persona') <= 280
  ) THEN
    RAISE EXCEPTION 'invalid Companion persona' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'provider_id' AND (
    jsonb_typeof(p_patch -> 'provider_id') <> 'string'
    OR (p_patch ->> 'provider_id') !~ '^[a-z][a-z0-9-]{0,62}$'
  ) THEN
    RAISE EXCEPTION 'invalid Companion provider' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'model_id' AND (
    jsonb_typeof(p_patch -> 'model_id') <> 'string'
    OR char_length(p_patch ->> 'model_id') NOT BETWEEN 1 AND 200
    OR (p_patch ->> 'model_id') ~ E'[\n\r]'
  ) THEN
    RAISE EXCEPTION 'invalid Companion model' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'selected_skill_ids'
     AND jsonb_typeof(p_patch -> 'selected_skill_ids') <> 'array' THEN
    RAISE EXCEPTION 'invalid Companion Skill selection' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'selected_mcp_account_ids'
     AND jsonb_typeof(p_patch -> 'selected_mcp_account_ids') <> 'array' THEN
    RAISE EXCEPTION 'invalid Companion MCP selection' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'can_write_skills'
     AND jsonb_typeof(p_patch -> 'can_write_skills') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid Companion Skills write setting' USING ERRCODE = '22023';
  END IF;

  v_name := CASE WHEN p_patch ? 'name' THEN btrim(p_patch ->> 'name') ELSE v_companion.name END;
  v_persona := CASE WHEN p_patch ? 'persona'
    THEN NULLIF(btrim(p_patch ->> 'persona'), '') ELSE v_companion.persona END;
  v_provider_id := CASE WHEN p_patch ? 'provider_id'
    THEN p_patch ->> 'provider_id' ELSE v_companion.provider_ids ->> 0 END;
  v_model_id := CASE WHEN p_patch ? 'model_id'
    THEN p_patch ->> 'model_id' ELSE v_companion.model_id END;
  v_selected_skill_ids := CASE WHEN p_patch ? 'selected_skill_ids'
    THEN p_patch -> 'selected_skill_ids' ELSE v_companion.selected_skill_ids END;
  v_can_write_skills := CASE WHEN p_patch ? 'can_write_skills'
    THEN (p_patch ->> 'can_write_skills')::boolean ELSE v_companion.can_write_skills END;
  v_selected_mcp_account_ids := CASE WHEN p_patch ? 'selected_mcp_account_ids'
    THEN p_patch -> 'selected_mcp_account_ids' ELSE v_companion.selected_mcp_account_ids END;

  IF v_provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.companion_provider_connections connection
    WHERE connection.org_id = p_org_id AND connection.provider_id = v_provider_id
  ) THEN
    RAISE EXCEPTION 'Companion provider is not connected' USING ERRCODE = '22023';
  END IF;
  PERFORM public.companion_api_validate_resource_selection(
    p_org_id, v_selected_skill_ids, v_companion.selected_skill_ids,
    v_selected_mcp_account_ids, v_companion.selected_mcp_account_ids
  );

  v_skills_changed := v_selected_skill_ids IS DISTINCT FROM v_companion.selected_skill_ids;
  v_settings_changed := v_persona IS DISTINCT FROM v_companion.persona
    OR v_provider_id IS DISTINCT FROM v_companion.provider_ids ->> 0
    OR v_model_id IS DISTINCT FROM v_companion.model_id
    OR v_skills_changed
    OR v_can_write_skills IS DISTINCT FROM v_companion.can_write_skills
    OR v_selected_mcp_account_ids IS DISTINCT FROM v_companion.selected_mcp_account_ids;

  UPDATE public.companions companion
  SET name = v_name,
      persona = v_persona,
      provider_ids = CASE WHEN v_provider_id IS NULL
        THEN '[]'::jsonb ELSE jsonb_build_array(v_provider_id) END,
      model_id = v_model_id,
      selected_skill_ids = v_selected_skill_ids,
      can_write_skills = v_can_write_skills,
      selected_mcp_account_ids = v_selected_mcp_account_ids,
      provider_credential_generation = CASE
        WHEN v_provider_id IS DISTINCT FROM v_companion.provider_ids ->> 0 THEN NULL
        ELSE companion.provider_credential_generation
      END,
      skills_revision = companion.skills_revision + CASE WHEN v_skills_changed THEN 1 ELSE 0 END,
      skills_last_error = CASE WHEN v_skills_changed THEN NULL ELSE companion.skills_last_error END,
      updated_at = v_updated_at
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
  RETURNING companion.skills_revision INTO v_companion.skills_revision;

  UPDATE public.companion_runtime_instances instance
  SET desired_settings_revision = instance.desired_settings_revision
        + CASE WHEN v_settings_changed THEN 1 ELSE 0 END,
      settings_actor_id = CASE WHEN v_settings_changed THEN v_actor_id ELSE instance.settings_actor_id END,
      settings_checkpoint = CASE WHEN v_settings_changed THEN 'pending' ELSE instance.settings_checkpoint END,
      settings_available_at = CASE WHEN v_settings_changed THEN v_updated_at ELSE instance.settings_available_at END,
      last_error_code = CASE WHEN v_settings_changed THEN NULL ELSE instance.last_error_code END,
      last_error_message = CASE WHEN v_settings_changed THEN NULL ELSE instance.last_error_message END,
      last_error_action = CASE WHEN v_settings_changed THEN NULL ELSE instance.last_error_action END,
      updated_at = v_updated_at
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  RETURNING instance.desired_settings_revision INTO v_instance.desired_settings_revision;

  INSERT INTO public.audit_log(
    org_id, actor_id, action, target_type, target_id, metadata
  ) VALUES (
    p_org_id,
    v_actor_id,
    'companion.settings.updated',
    'companion',
    p_companion_id::text,
    jsonb_build_object(
      'name', p_patch ? 'name',
      'persona', p_patch ? 'persona',
      'provider', p_patch ? 'provider_id',
      'model', p_patch ? 'model_id' OR p_patch ? 'provider_id',
      'selected_skills', p_patch ? 'selected_skill_ids',
      'can_write_skills', p_patch ? 'can_write_skills',
      'selected_mcp_accounts', p_patch ? 'selected_mcp_account_ids'
    )
  );

  RETURN QUERY SELECT p_companion_id, v_instance.desired_settings_revision,
    v_companion.skills_revision, v_settings_changed, v_skills_changed, v_updated_at;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_require_access(
  p_org_id uuid,
  p_companion_id uuid,
  p_required text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_owner_id text;
  v_workspace_role public.companion_share_role;
  v_access text;
BEGIN
  IF p_required NOT IN ('read', 'editor', 'owner') THEN
    RAISE EXCEPTION 'invalid Companion API access requirement' USING ERRCODE = '22023';
  END IF;

  SELECT companion.owner_id, workspace_access.role
  INTO v_owner_id, v_workspace_role
  FROM public.companions companion
  LEFT JOIN public.companion_workspace_access workspace_access
    ON workspace_access.org_id = companion.org_id
   AND workspace_access.companion_id = companion.id
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;

  IF NOT FOUND OR (v_owner_id <> v_actor_id AND v_workspace_role IS NULL) THEN
    -- Inaccessible and absent Companions are intentionally indistinguishable.
    RAISE EXCEPTION 'Companion not found' USING ERRCODE = 'P0002';
  END IF;
  v_access := CASE WHEN v_owner_id = v_actor_id THEN 'owner' ELSE v_workspace_role::text END;
  IF p_required = 'owner' AND v_access <> 'owner' THEN
    RAISE EXCEPTION 'Companion owner access is required' USING ERRCODE = '42501';
  END IF;
  IF p_required = 'editor' AND v_access NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'Companion editor access is required' USING ERRCODE = '42501';
  END IF;
  RETURN v_access;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_safe_error(
  p_code text,
  p_message text,
  p_action public.companion_runtime_error_action
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN p_code IS NULL THEN NULL ELSE jsonb_build_object(
    'code', p_code,
    'message', p_message,
    'action', p_action
  ) END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_turn_json(
  p_org_id uuid,
  p_companion_id uuid,
  p_turn_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT jsonb_build_object(
    'id', turn_row.id,
    'companion_id', turn_row.companion_id,
    'client_message_id', turn_row.client_message_id,
    'status', turn_row.status,
    'queue_sequence', turn_row.queue_sequence,
    'latest_attempt', latest_attempt.value,
    'replying', turn_row.status = 'running'
      AND COALESCE(latest_attempt.status = 'running'
        AND latest_attempt.dispatch_state = 'accepted'
        AND latest_attempt.dispatch_accepted_at IS NOT NULL, false),
    'error', public.companion_api_safe_error(
      turn_row.last_error_code, turn_row.last_error_message, turn_row.last_error_action
    ),
    'state_changed_at', turn_row.state_changed_at,
    'settled_at', turn_row.settled_at,
    'created_at', turn_row.created_at,
    'updated_at', turn_row.updated_at
  )
  FROM public.companion_turns turn_row
  LEFT JOIN LATERAL (
    SELECT attempt.status, attempt.dispatch_state, attempt.dispatch_accepted_at,
      jsonb_build_object(
        'id', attempt.id,
        'turn_id', attempt.turn_id,
        'attempt_number', attempt.attempt_number,
        'retry_id', attempt.retry_id,
        'status', attempt.status,
        'dispatch_state', attempt.dispatch_state,
        'pi_invocation_id', attempt.pi_invocation_id,
        'dispatch_accepted_at', attempt.dispatch_accepted_at,
        'error', public.companion_api_safe_error(
          attempt.last_error_code, attempt.last_error_message, attempt.last_error_action
        ),
        'started_at', attempt.started_at,
        'settled_at', attempt.settled_at
      ) AS value
    FROM public.companion_turn_attempts attempt
    WHERE attempt.org_id = turn_row.org_id
      AND attempt.companion_id = turn_row.companion_id
      AND attempt.turn_id = turn_row.id
    ORDER BY attempt.attempt_number DESC, attempt.id DESC
    LIMIT 1
  ) latest_attempt ON true
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_operation_json(
  p_org_id uuid,
  p_companion_id uuid,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT jsonb_build_object(
    'id', operation.id,
    'companion_id', operation.companion_id,
    'request_id', operation.request_id,
    'source_turn_id', operation.source_turn_id,
    'kind', operation.kind,
    'trigger', operation.trigger,
    'status', operation.status,
    'queue_sequence', operation.queue_sequence,
    'checkpoint', operation.checkpoint,
    'attempt_count', operation.attempt_count,
    'error', public.companion_api_safe_error(
      operation.last_error_code, operation.last_error_message, operation.last_error_action
    ),
    'created_at', operation.created_at,
    'started_at', operation.started_at,
    'settled_at', operation.settled_at
  )
  FROM public.companion_operations operation
  WHERE operation.org_id = p_org_id
    AND operation.companion_id = p_companion_id
    AND operation.id = p_operation_id
$$;
--> statement-breakpoint

-- Array validation stays inside the capability boundary. Existing selections may be preserved by
-- an Editor who cannot see their Owner's personal Skill or MCP account, but newly added ids must
-- be visible to the current actor.
CREATE FUNCTION public.companion_api_validate_resource_selection(
  p_org_id uuid,
  p_selected_skill_ids jsonb,
  p_previous_skill_ids jsonb,
  p_selected_mcp_account_ids jsonb,
  p_previous_mcp_account_ids jsonb
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
  IF p_selected_skill_ids IS NULL OR jsonb_typeof(p_selected_skill_ids) <> 'array'
     OR p_selected_mcp_account_ids IS NULL OR jsonb_typeof(p_selected_mcp_account_ids) <> 'array'
     OR jsonb_array_length(p_selected_skill_ids) > 100
     OR jsonb_array_length(p_selected_mcp_account_ids) > 100
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_selected_skill_ids) item WHERE jsonb_typeof(item) <> 'string')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_selected_mcp_account_ids) item WHERE jsonb_typeof(item) <> 'string')
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_selected_skill_ids) item(value)
       GROUP BY item.value HAVING count(*) > 1
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_selected_mcp_account_ids) item(value)
       GROUP BY item.value HAVING count(*) > 1
     ) THEN
    RAISE EXCEPTION 'invalid Companion resource selection' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(p_selected_skill_ids) selected(skill_id)
    WHERE selected.skill_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR NOT (
         COALESCE(p_previous_skill_ids, '[]'::jsonb) ? selected.skill_id
         OR EXISTS (
           SELECT 1 FROM public.skills skill
           WHERE skill.org_id = p_org_id
             AND skill.id::text = selected.skill_id
             AND skill.archived_at IS NULL
             AND skill.validation = 'valid'
             AND skill.current_version_id IS NOT NULL
             AND (skill.scope = 'org' OR skill.creator_id = v_actor_id)
         )
       )
  ) THEN
    RAISE EXCEPTION 'selected Companion Skill is unavailable' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(p_selected_mcp_account_ids) selected(account_id)
    WHERE selected.account_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR NOT (
         COALESCE(p_previous_mcp_account_ids, '[]'::jsonb) ? selected.account_id
         OR EXISTS (
           SELECT 1 FROM public.companion_mcp_accounts account
           WHERE account.org_id = p_org_id
             AND account.id::text = selected.account_id
             AND account.owner_id = v_actor_id
         )
       )
  ) THEN
    RAISE EXCEPTION 'selected Companion MCP account is unavailable' USING ERRCODE = '22023';
  END IF;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_enqueue_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_client_message_id uuid,
  p_content text,
  p_client_surface public.companion_client_surface
)
RETURNS TABLE (
  turn jsonb,
  operation jsonb,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_turn_id uuid;
  v_operation_id uuid;
  v_message_ordinal integer;
  v_now timestamp with time zone := clock_timestamp();
  v_replayed boolean := false;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_client_message_id IS NULL OR p_client_surface IS NULL
     OR p_content IS NULL OR char_length(btrim(p_content)) NOT BETWEEN 1 AND 16384 THEN
    RAISE EXCEPTION 'invalid Companion message' USING ERRCODE = '22023';
  END IF;

  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;
  IF v_instance.retirement_state <> 'active' THEN
    RAISE EXCEPTION 'retired Companion cannot accept messages' USING ERRCODE = '55000';
  END IF;

  SELECT queued_turn.id INTO v_turn_id
  FROM public.companion_turns queued_turn
  WHERE queued_turn.org_id = p_org_id
    AND queued_turn.companion_id = p_companion_id
    AND queued_turn.client_message_id = p_client_message_id;

  IF FOUND THEN
    v_replayed := true;
    SELECT start_operation.id INTO v_operation_id
    FROM public.companion_operations start_operation
    WHERE start_operation.org_id = p_org_id
      AND start_operation.companion_id = p_companion_id
      AND start_operation.source_turn_id = v_turn_id
      AND start_operation.kind = 'start'
    ORDER BY start_operation.queue_sequence, start_operation.id
    LIMIT 1;
    IF v_operation_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.companion_transcript_entries entry
      WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
        AND entry.event_id = 'msg:' || p_client_message_id::text
        AND entry.role = 'user'
    ) THEN
      RAISE EXCEPTION 'idempotent Companion turn is incomplete' USING ERRCODE = '55000';
    END IF;
  ELSE
    INSERT INTO public.companion_threads(
      org_id, companion_id, next_ordinal, last_message_at, created_at, updated_at
    ) VALUES (
      p_org_id, p_companion_id, 1, v_now, v_now, v_now
    )
    ON CONFLICT (companion_id) DO UPDATE
    SET next_ordinal = companion_threads.next_ordinal + 1,
        last_message_at = EXCLUDED.last_message_at,
        updated_at = EXCLUDED.updated_at
    WHERE companion_threads.org_id = EXCLUDED.org_id
    RETURNING companion_threads.next_ordinal - 1 INTO v_message_ordinal;
    IF v_message_ordinal IS NULL THEN
      RAISE EXCEPTION 'Companion thread allocation failed' USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.companion_transcript_entries(
      org_id, companion_id, event_id, ordinal, role, content, author_id, created_at
    ) VALUES (
      p_org_id, p_companion_id, 'msg:' || p_client_message_id::text,
      v_message_ordinal, 'user', btrim(p_content), v_actor_id, v_now
    );

    INSERT INTO public.companion_turns(
      org_id, companion_id, client_message_id, message_event_id, queue_sequence,
      actor_id, client_surface, status, created_at, updated_at
    ) VALUES (
      p_org_id, p_companion_id, p_client_message_id,
      'msg:' || p_client_message_id::text, 0, v_actor_id, p_client_surface,
      'queued', v_now, v_now
    ) RETURNING companion_turns.id INTO v_turn_id;

    INSERT INTO public.companion_operations(
      org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
      queue_sequence, turn_queue_cutoff, runtime_generation, status, created_at, updated_at
    ) VALUES (
      p_org_id, p_companion_id, p_client_message_id, 'start', 'turn', v_actor_id,
      v_turn_id, 0, 0, v_instance.generation, 'pending', v_now, v_now
    ) RETURNING companion_operations.id INTO v_operation_id;

    -- A Send is the only normal wake. It also lends its freshly authorized actor to any initial or
    -- pending settings apply; the runtime revalidates that authority before Box contact.
    UPDATE public.companion_runtime_instances instance
    SET settings_actor_id = v_actor_id,
        settings_available_at = LEAST(instance.settings_available_at, v_now),
        updated_at = v_now
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
  END IF;

  RETURN QUERY SELECT
    public.companion_api_turn_json(p_org_id, p_companion_id, v_turn_id),
    public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id),
    v_replayed;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_read_runtime(
  p_org_id uuid,
  p_companion_id uuid
)
RETURNS TABLE (
  access_role text,
  generation bigint,
  box_id text,
  box_state public.companion_box_observed_state,
  pi_state public.companion_pi_observed_state,
  pi_invocation_id text,
  disk_layout_version integer,
  desired_settings_revision bigint,
  applied_settings_revision bigint,
  applied_skills_revision integer,
  retirement_state public.companion_runtime_retirement_state,
  last_observed_at timestamp with time zone,
  last_error_code text,
  last_error_message text,
  last_error_action public.companion_runtime_error_action,
  active_turn jsonb,
  queued_count integer,
  interrupted_turn jsonb,
  latest_operation jsonb,
  is_replying boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_access text := public.companion_api_require_access(p_org_id, p_companion_id, 'read');
BEGIN
  RETURN QUERY
  SELECT v_access,
    instance.generation,
    CASE WHEN v_access = 'viewer' THEN NULL ELSE instance.box_id END,
    instance.box_state, instance.pi_state,
    instance.pi_invocation_id, instance.disk_layout_version,
    instance.desired_settings_revision, instance.applied_settings_revision,
    instance.applied_skills_revision, instance.retirement_state, instance.last_observed_at,
    instance.last_error_code,
    CASE WHEN v_access = 'viewer' AND instance.last_error_message IS NOT NULL
      THEN 'The Companion runtime needs attention.' ELSE instance.last_error_message END,
    instance.last_error_action,
    active_turn.value,
    (SELECT count(*)::integer FROM public.companion_turns queued
      WHERE queued.org_id = instance.org_id AND queued.companion_id = instance.companion_id
        AND queued.status = 'queued'),
    interrupted_turn.value,
    latest_operation.value,
    COALESCE((active_turn.value ->> 'replying')::boolean, false)
  FROM public.companion_runtime_instances instance
  LEFT JOIN LATERAL (
    SELECT public.companion_api_turn_json(
      active.org_id, active.companion_id, active.id
    ) AS value
    FROM public.companion_turns active
    WHERE active.org_id = instance.org_id AND active.companion_id = instance.companion_id
      AND active.status IN ('starting', 'dispatching', 'running', 'needs_input')
    ORDER BY active.queue_sequence, active.id LIMIT 1
  ) active_turn ON true
  LEFT JOIN LATERAL (
    SELECT public.companion_api_turn_json(
      interrupted.org_id, interrupted.companion_id, interrupted.id
    ) AS value
    FROM public.companion_turns interrupted
    WHERE interrupted.org_id = instance.org_id
      AND interrupted.companion_id = instance.companion_id
      AND interrupted.status = 'interrupted'
    ORDER BY interrupted.queue_sequence, interrupted.id LIMIT 1
  ) interrupted_turn ON true
  LEFT JOIN LATERAL (
    SELECT public.companion_api_operation_json(
      lifecycle.org_id, lifecycle.companion_id, lifecycle.id
    ) AS value
    FROM public.companion_operations lifecycle
    WHERE lifecycle.org_id = instance.org_id
      AND lifecycle.companion_id = instance.companion_id
    ORDER BY lifecycle.queue_sequence DESC, lifecycle.id DESC LIMIT 1
  ) latest_operation ON true
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_list_runtime(p_org_id uuid)
RETURNS TABLE (
  companion_id uuid,
  access_role text,
  generation bigint,
  box_id text,
  box_state public.companion_box_observed_state,
  pi_state public.companion_pi_observed_state,
  pi_invocation_id text,
  disk_layout_version integer,
  desired_settings_revision bigint,
  applied_settings_revision bigint,
  applied_skills_revision integer,
  retirement_state public.companion_runtime_retirement_state,
  last_observed_at timestamp with time zone,
  last_error_code text,
  last_error_message text,
  last_error_action public.companion_runtime_error_action,
  active_turn jsonb,
  queued_count integer,
  interrupted_turn jsonb,
  latest_operation jsonb,
  is_replying boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
BEGIN
  RETURN QUERY
  SELECT instance.companion_id,
    CASE WHEN companion.owner_id = v_actor_id THEN 'owner' ELSE access.role::text END,
    instance.generation,
    CASE WHEN companion.owner_id <> v_actor_id AND access.role = 'viewer'
      THEN NULL ELSE instance.box_id END,
    instance.box_state, instance.pi_state,
    instance.pi_invocation_id, instance.disk_layout_version,
    instance.desired_settings_revision, instance.applied_settings_revision,
    instance.applied_skills_revision, instance.retirement_state, instance.last_observed_at,
    instance.last_error_code,
    CASE WHEN companion.owner_id <> v_actor_id AND access.role = 'viewer'
           AND instance.last_error_message IS NOT NULL
      THEN 'The Companion runtime needs attention.' ELSE instance.last_error_message END,
    instance.last_error_action,
    active_turn.value,
    (SELECT count(*)::integer FROM public.companion_turns queued
      WHERE queued.org_id = instance.org_id AND queued.companion_id = instance.companion_id
        AND queued.status = 'queued'),
    interrupted_turn.value,
    latest_operation.value,
    COALESCE((active_turn.value ->> 'replying')::boolean, false)
  FROM public.companion_runtime_instances instance
  JOIN public.companions companion
    ON companion.org_id = instance.org_id AND companion.id = instance.companion_id
  LEFT JOIN public.companion_workspace_access access
    ON access.org_id = companion.org_id AND access.companion_id = companion.id
  LEFT JOIN LATERAL (
    SELECT public.companion_api_turn_json(active.org_id, active.companion_id, active.id) AS value
    FROM public.companion_turns active
    WHERE active.org_id = instance.org_id AND active.companion_id = instance.companion_id
      AND active.status IN ('starting', 'dispatching', 'running', 'needs_input')
    ORDER BY active.queue_sequence, active.id LIMIT 1
  ) active_turn ON true
  LEFT JOIN LATERAL (
    SELECT public.companion_api_turn_json(
      interrupted.org_id, interrupted.companion_id, interrupted.id
    ) AS value
    FROM public.companion_turns interrupted
    WHERE interrupted.org_id = instance.org_id
      AND interrupted.companion_id = instance.companion_id
      AND interrupted.status = 'interrupted'
    ORDER BY interrupted.queue_sequence, interrupted.id LIMIT 1
  ) interrupted_turn ON true
  LEFT JOIN LATERAL (
    SELECT public.companion_api_operation_json(
      lifecycle.org_id, lifecycle.companion_id, lifecycle.id
    ) AS value
    FROM public.companion_operations lifecycle
    WHERE lifecycle.org_id = instance.org_id AND lifecycle.companion_id = instance.companion_id
    ORDER BY lifecycle.queue_sequence DESC, lifecycle.id DESC LIMIT 1
  ) latest_operation ON true
  WHERE instance.org_id = p_org_id
    AND instance.retirement_state <> 'retired'
    AND (companion.owner_id = v_actor_id OR access.role IS NOT NULL)
  ORDER BY companion.updated_at DESC, companion.id;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_read_thread(
  p_org_id uuid,
  p_companion_id uuid
)
RETURNS TABLE (
  access_role text,
  entries jsonb,
  active_turn jsonb,
  queued_count integer,
  interrupted_turn jsonb,
  last_message_at timestamp with time zone,
  previous_last_read_ordinal integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_access text := public.companion_api_require_access(p_org_id, p_companion_id, 'read');
  v_previous integer;
  v_marked integer;
BEGIN
  SELECT marked.previous_last_read_ordinal, marked.last_read_ordinal
  INTO v_previous, v_marked
  FROM public.companion_api_mark_thread_read(p_org_id, p_companion_id) marked;

  RETURN QUERY
  SELECT v_access,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'event_id', entry.event_id,
        'ordinal', entry.ordinal,
        'role', entry.role,
        'content', entry.content,
        'reasoning', entry.reasoning,
        'author_id', entry.author_id,
        'author_name', author.name,
        'tool', entry.tool,
        'decision', entry.decision,
        -- The transcript contract predates Runtime v2 and requires the canonical `Z` spelling;
        -- PostgreSQL's native jsonb timestamptz encoder emits `+00:00` instead.
        'created_at', to_char(
          entry.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      ) ORDER BY entry.ordinal)
      FROM public.companion_transcript_entries entry
      LEFT JOIN public.profiles author ON author.id = entry.author_id
      WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
    ), '[]'::jsonb),
    (
      SELECT public.companion_api_turn_json(active.org_id, active.companion_id, active.id)
      FROM public.companion_turns active
      WHERE active.org_id = p_org_id AND active.companion_id = p_companion_id
        AND active.status IN ('starting', 'dispatching', 'running', 'needs_input')
      ORDER BY active.queue_sequence, active.id LIMIT 1
    ),
    (SELECT count(*)::integer FROM public.companion_turns queued
      WHERE queued.org_id = p_org_id AND queued.companion_id = p_companion_id
        AND queued.status = 'queued'),
    (
      SELECT public.companion_api_turn_json(
        interrupted.org_id, interrupted.companion_id, interrupted.id
      )
      FROM public.companion_turns interrupted
      WHERE interrupted.org_id = p_org_id AND interrupted.companion_id = p_companion_id
        AND interrupted.status = 'interrupted'
      ORDER BY interrupted.queue_sequence, interrupted.id LIMIT 1
    ),
    (SELECT thread.last_message_at FROM public.companion_threads thread
      WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id),
    v_previous;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_enqueue_operation(
  p_org_id uuid,
  p_companion_id uuid,
  p_request_id uuid,
  p_kind public.companion_operation_kind,
  p_client_surface public.companion_client_surface
)
RETURNS TABLE (
  operation jsonb,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_required text;
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_operation_id uuid;
  v_existing_kind public.companion_operation_kind;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_request_id IS NULL OR p_kind IS NULL
     OR p_kind NOT IN ('delete', 'stop', 'restart_pi', 'restart_box', 'start')
     OR p_kind IN ('start', 'restart_pi', 'restart_box') AND p_client_surface IS NULL THEN
    RAISE EXCEPTION 'invalid Companion operation request' USING ERRCODE = '22023';
  END IF;
  v_required := CASE WHEN p_kind = 'delete' THEN 'owner' ELSE 'editor' END;
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, v_required);
  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;

  SELECT existing.id, existing.kind INTO v_operation_id, v_existing_kind
  FROM public.companion_operations existing
  WHERE existing.org_id = p_org_id AND existing.companion_id = p_companion_id
    AND existing.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing_kind <> p_kind THEN
      RAISE EXCEPTION 'operation request id was reused for another kind' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT
      public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), true;
    RETURN;
  END IF;
  IF v_instance.retirement_state <> 'active' THEN
    RAISE EXCEPTION 'retired Companion cannot accept lifecycle operations' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.companion_operations(
    org_id, companion_id, request_id, kind, trigger, actor_id,
    queue_sequence, turn_queue_cutoff, runtime_generation, client_surface,
    status, created_at, updated_at
  ) VALUES (
    p_org_id, p_companion_id, p_request_id, p_kind, 'user', v_actor_id,
    0, 0, v_instance.generation, p_client_surface, 'pending', v_now, v_now
  ) RETURNING companion_operations.id INTO v_operation_id;

  IF p_kind = 'delete' THEN
    UPDATE public.companion_runtime_instances instance
    SET retirement_state = 'requested', retirement_requested_at = v_now, updated_at = v_now
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
    INSERT INTO public.audit_log(
      org_id, actor_id, action, target_type, target_id, metadata
    ) VALUES (
      p_org_id,
      v_actor_id,
      'companion.delete.requested',
      'companion',
      p_companion_id::text,
      jsonb_build_object('operation_id', v_operation_id)
    );
  END IF;
  RETURN QUERY SELECT
    public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), false;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_retry_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_turn_id uuid,
  p_retry_id uuid,
  p_client_surface public.companion_client_surface
)
RETURNS TABLE (
  operation jsonb,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_turn public.companion_turns%ROWTYPE;
  v_operation_id uuid;
  v_operation_turn_id uuid;
  v_operation_kind public.companion_operation_kind;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_turn_id IS NULL OR p_retry_id IS NULL OR p_client_surface IS NULL THEN
    RAISE EXCEPTION 'invalid Companion retry request' USING ERRCODE = '22023';
  END IF;
  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;

  SELECT existing.id, existing.source_turn_id, existing.kind
  INTO v_operation_id, v_operation_turn_id, v_operation_kind
  FROM public.companion_operations existing
  WHERE existing.org_id = p_org_id AND existing.companion_id = p_companion_id
    AND existing.request_id = p_retry_id;
  IF FOUND THEN
    IF v_operation_turn_id IS DISTINCT FROM p_turn_id OR v_operation_kind <> 'restart_pi' THEN
      RAISE EXCEPTION 'retry id was reused for another turn' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT
      public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), true;
    RETURN;
  END IF;
  IF v_instance.retirement_state <> 'active' THEN
    RAISE EXCEPTION 'retired Companion turn cannot be retried' USING ERRCODE = '55000';
  END IF;
  SELECT source_turn.* INTO STRICT v_turn
  FROM public.companion_turns source_turn
  WHERE source_turn.org_id = p_org_id AND source_turn.companion_id = p_companion_id
    AND source_turn.id = p_turn_id
  FOR UPDATE;
  IF v_turn.status <> 'interrupted' THEN
    RAISE EXCEPTION 'only an interrupted Companion turn can be retried' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.companion_operations retry_operation
    WHERE retry_operation.org_id = p_org_id
      AND retry_operation.companion_id = p_companion_id
      AND retry_operation.source_turn_id = p_turn_id
      AND retry_operation.kind = 'restart_pi'
      AND retry_operation.status IN ('pending', 'running')
  ) THEN
    RAISE EXCEPTION 'a retry is already pending for this Companion turn' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.companion_operations(
    org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
    queue_sequence, turn_queue_cutoff, runtime_generation, client_surface,
    status, created_at, updated_at
  ) VALUES (
    p_org_id, p_companion_id, p_retry_id, 'restart_pi', 'user', v_actor_id,
    p_turn_id, 0, 0, v_instance.generation, p_client_surface, 'pending', v_now, v_now
  ) RETURNING companion_operations.id INTO v_operation_id;

  RETURN QUERY SELECT
    public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), false;
END
$$;
--> statement-breakpoint

-- A retry operation is deliberately two-phase. Claiming its Pi recycle must not convert the later
-- ordered queue into collateral interruptions, and only a successful recycle may reopen the source
-- turn. A failed recycle leaves that source visibly interrupted and retryable.
CREATE FUNCTION public.companion_api_retry_operation_handoff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF NEW.kind <> 'restart_pi' OR NEW.trigger <> 'user'
     OR NEW.source_turn_id IS NULL OR NEW.request_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'running' AND OLD.status = 'pending' THEN
    UPDATE public.companion_turns queued
    SET status = 'queued',
        inactivity_deadline_at = NULL,
        absolute_deadline_at = NULL,
        state_changed_at = v_now,
        settled_at = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        last_error_action = NULL,
        updated_at = v_now
    WHERE queued.org_id = NEW.org_id
      AND queued.companion_id = NEW.companion_id
      AND queued.id <> NEW.source_turn_id
      AND queued.queue_sequence <= NEW.turn_queue_cutoff
      AND queued.status = 'interrupted'
      AND queued.last_error_code = 'runtime_lifecycle_preempted'
      AND queued.state_changed_at = NEW.started_at;
  ELSIF NEW.status = 'succeeded' AND OLD.status = 'running' THEN
    UPDATE public.companion_turns source_turn
    SET status = 'queued',
        cold_start_deadline_at = NULL,
        inactivity_deadline_at = NULL,
        absolute_deadline_at = NULL,
        state_changed_at = v_now,
        settled_at = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        last_error_action = NULL,
        updated_at = v_now
    WHERE source_turn.org_id = NEW.org_id
      AND source_turn.companion_id = NEW.companion_id
      AND source_turn.id = NEW.source_turn_id
      AND source_turn.status = 'interrupted';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'successful retry has no interrupted source turn' USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER companion_operations_retry_handoff
  AFTER UPDATE OF status ON public.companion_operations
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.companion_api_retry_operation_handoff();
--> statement-breakpoint

CREATE FUNCTION public.companion_api_assign_attempt_retry_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF NEW.retry_id IS NULL THEN
    SELECT retry_operation.request_id INTO NEW.retry_id
    FROM public.companion_operations retry_operation
    WHERE retry_operation.org_id = NEW.org_id
      AND retry_operation.companion_id = NEW.companion_id
      AND retry_operation.source_turn_id = NEW.turn_id
      AND retry_operation.kind = 'restart_pi'
      AND retry_operation.trigger = 'user'
      AND retry_operation.status = 'succeeded'
      AND retry_operation.request_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.companion_turn_attempts prior_attempt
        WHERE prior_attempt.org_id = NEW.org_id
          AND prior_attempt.companion_id = NEW.companion_id
          AND prior_attempt.turn_id = NEW.turn_id
          AND prior_attempt.retry_id = retry_operation.request_id
      )
    ORDER BY retry_operation.queue_sequence DESC, retry_operation.id DESC
    LIMIT 1;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER companion_turn_attempts_assign_retry_id
  BEFORE INSERT ON public.companion_turn_attempts
  FOR EACH ROW EXECUTE FUNCTION public.companion_api_assign_attempt_retry_id();
--> statement-breakpoint

CREATE FUNCTION public.companion_api_cancel_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_turn_id uuid
)
RETURNS TABLE (turn jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  PERFORM 1 FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.companion_operations retry_operation
    WHERE retry_operation.org_id = p_org_id
      AND retry_operation.companion_id = p_companion_id
      AND retry_operation.source_turn_id = p_turn_id
      AND retry_operation.kind = 'restart_pi'
      AND retry_operation.status = 'running'
  ) THEN
    RAISE EXCEPTION 'Companion turn retry is already running' USING ERRCODE = '55000';
  END IF;
  UPDATE public.companion_operations retry_operation
  SET status = 'cancelled', settled_at = v_now, updated_at = v_now
  WHERE retry_operation.org_id = p_org_id
    AND retry_operation.companion_id = p_companion_id
    AND retry_operation.source_turn_id = p_turn_id
    AND retry_operation.kind = 'restart_pi'
    AND retry_operation.status = 'pending';

  UPDATE public.companion_turns source_turn
  SET status = 'cancelled',
      cold_start_deadline_at = NULL,
      inactivity_deadline_at = NULL,
      absolute_deadline_at = NULL,
      state_changed_at = v_now,
      settled_at = v_now,
      last_error_code = NULL,
      last_error_message = NULL,
      last_error_action = NULL,
      updated_at = v_now
  WHERE source_turn.org_id = p_org_id
    AND source_turn.companion_id = p_companion_id
    AND source_turn.id = p_turn_id
    AND source_turn.status = 'interrupted';
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.companion_turns already_cancelled
      WHERE already_cancelled.org_id = p_org_id
        AND already_cancelled.companion_id = p_companion_id
        AND already_cancelled.id = p_turn_id
        AND already_cancelled.status = 'cancelled'
    ) THEN
      RETURN QUERY SELECT public.companion_api_turn_json(p_org_id, p_companion_id, p_turn_id);
      RETURN;
    END IF;
    RAISE EXCEPTION 'only an interrupted Companion turn can be cancelled' USING ERRCODE = '55000';
  END IF;

  UPDATE public.companion_decision_deliveries delivery
  SET decision_status = CASE WHEN delivery.decision_status = 'pending'
        THEN 'cancelled'::public.companion_decision_status ELSE delivery.decision_status END,
      responded_at = CASE WHEN delivery.decision_status = 'pending' THEN v_now ELSE delivery.responded_at END,
      delivery_state = CASE WHEN delivery.command_id IS NULL
        THEN 'cancelled'::public.companion_decision_delivery_state
        ELSE 'ambiguous'::public.companion_decision_delivery_state END,
      delivery_checkpoint = CASE WHEN delivery.command_id IS NULL THEN 'cancelled' ELSE 'ambiguous' END,
      delivery_checkpoint_sequence = delivery.delivery_checkpoint_sequence + 1,
      last_error_code = CASE WHEN delivery.command_id IS NULL THEN NULL ELSE 'turn_cancelled_after_delivery_intent' END,
      last_error_message = CASE WHEN delivery.command_id IS NULL THEN NULL
        ELSE 'The turn was cancelled after a decision response may have reached Pi.' END,
      last_error_action = CASE WHEN delivery.command_id IS NULL THEN NULL
        ELSE 'none'::public.companion_runtime_error_action END,
      updated_at = v_now
  WHERE delivery.org_id = p_org_id AND delivery.companion_id = p_companion_id
    AND delivery.turn_id = p_turn_id
    AND delivery.delivery_state NOT IN ('delivered', 'cancelled');

  RETURN QUERY SELECT public.companion_api_turn_json(p_org_id, p_companion_id, p_turn_id);
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_answer_decision(
  p_org_id uuid,
  p_companion_id uuid,
  p_request_key text,
  p_action text,
  p_answer text
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
  v_status public.companion_decision_status;
  v_response text;
  v_event_id text;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
     OR p_request_key ~ E'[\n\r]' OR p_action NOT IN ('allow', 'deny', 'answer') THEN
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
    -- A browser replay of the same durable answer is idempotent; a conflicting second answer is not.
    SELECT delivery.* INTO v_delivery
    FROM public.companion_decision_deliveries delivery
    WHERE delivery.org_id = p_org_id
      AND delivery.companion_id = p_companion_id
      AND delivery.request_key = p_request_key
      AND delivery.actor_id = v_actor_id
    ORDER BY delivery.created_at DESC, delivery.id DESC
    LIMIT 1;
    IF NOT FOUND OR NOT (
      (p_action = 'allow' AND v_delivery.decision_status = 'allowed')
      OR (p_action = 'deny' AND v_delivery.decision_status = 'denied')
      OR (
        p_action = 'answer'
        AND v_delivery.decision_status = 'answered'
        AND v_delivery.response_text = btrim(p_answer)
      )
    ) THEN
      RAISE EXCEPTION 'Companion decision is not pending' USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT v_delivery.id, v_delivery.turn_id, v_delivery.decision_status,
      v_delivery.delivery_state, v_delivery.responded_at;
    RETURN;
  END IF;

  IF (v_delivery.request_kind = 'question' AND p_action = 'allow')
     OR (v_delivery.request_kind = 'confirmation' AND p_action = 'answer') THEN
    RAISE EXCEPTION 'decision action does not match request kind' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'answer' AND (
    p_answer IS NULL OR char_length(btrim(p_answer)) NOT BETWEEN 1 AND 8000
  ) THEN
    RAISE EXCEPTION 'invalid Companion decision answer' USING ERRCODE = '22023';
  END IF;
  IF p_action <> 'answer' AND p_answer IS NOT NULL THEN
    RAISE EXCEPTION 'only an answer action may carry response text' USING ERRCODE = '22023';
  END IF;
  IF v_delivery.expires_at <= v_now THEN
    RAISE EXCEPTION 'Companion decision has expired' USING ERRCODE = '55000';
  END IF;

  v_status := CASE p_action
    WHEN 'allow' THEN 'allowed'::public.companion_decision_status
    WHEN 'deny' THEN 'denied'::public.companion_decision_status
    ELSE 'answered'::public.companion_decision_status
  END;
  v_response := CASE WHEN p_action = 'answer' THEN btrim(p_answer) ELSE NULL END;
  UPDATE public.companion_decision_deliveries delivery
  SET decision_status = v_status,
      actor_id = v_actor_id,
      response_text = v_response,
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
    'answer', v_response,
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

CREATE FUNCTION public.companion_api_bump_skill_revision(
  p_org_id uuid,
  p_skill_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_count integer := 0;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_skill_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.skills skill
    WHERE skill.org_id = p_org_id AND skill.id = p_skill_id
      AND (skill.scope = 'org' OR skill.creator_id = v_actor_id)
  ) THEN
    RAISE EXCEPTION 'Skill not found' USING ERRCODE = 'P0002';
  END IF;

  -- A workspace Skill publisher is not necessarily allowed to operate every private Companion
  -- selecting it. Preserve each instance's last authorized settings actor; the next Send replaces
  -- it with its freshly authorized actor. Lock instances before Companions to match Runtime claims.
  WITH targets AS MATERIALIZED (
    SELECT companion.id
    FROM public.companions companion
    WHERE companion.org_id = p_org_id
      AND companion.selected_skill_ids @> jsonb_build_array(p_skill_id::text)
  ), marked AS (
    UPDATE public.companion_runtime_instances instance
    SET settings_checkpoint = 'pending',
        settings_available_at = v_now,
        last_error_code = NULL,
        last_error_message = NULL,
        last_error_action = NULL,
        updated_at = v_now
    WHERE instance.org_id = p_org_id
      AND instance.companion_id IN (SELECT targets.id FROM targets)
    RETURNING instance.companion_id
  ), bumped AS (
    UPDATE public.companions companion
    SET skills_revision = companion.skills_revision + 1,
        skills_last_error = NULL
    WHERE companion.org_id = p_org_id
      AND companion.id IN (SELECT marked.companion_id FROM marked)
    RETURNING companion.id
  )
  SELECT count(*)::integer INTO v_count FROM bumped;
  RETURN v_count;
END
$$;
--> statement-breakpoint

-- Fail closed immediately. The grants hook below is the only place application roles receive
-- EXECUTE, and helper/trigger functions remain migration-owner-only.
REVOKE ALL ON FUNCTION public.companion_api_actor(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_require_access(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_safe_error(text,text,public.companion_runtime_error_action) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_turn_json(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_operation_json(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_validate_resource_selection(uuid,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_retry_operation_handoff() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_assign_attempt_retry_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_create_companion(uuid,text,text,text,text,jsonb,boolean,jsonb,uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_update_companion(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_set_workspace_access(uuid,uuid,public.companion_share_role) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_update_member_state(uuid,uuid,boolean,boolean,boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_mark_thread_read(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_read_runtime(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_list_runtime(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_read_thread(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_enqueue_operation(uuid,uuid,uuid,public.companion_operation_kind,public.companion_client_surface) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_retry_turn(uuid,uuid,uuid,uuid,public.companion_client_surface) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_cancel_turn(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_answer_decision(uuid,uuid,text,text,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_bump_skill_revision(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
