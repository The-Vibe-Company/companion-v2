-- Provider-side trigger targets and on-demand webhook registration. The Companion may wire a
-- github trigger into a repository (repo + events) whenever it decides to, through the
-- registration service; approval of the trigger itself never registers anything. Notion has no
-- outbound webhooks, so it never carries a target and is never proposed one.

ALTER TABLE public.companion_triggers
  ADD COLUMN target jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  ADD CONSTRAINT companion_triggers_target_shape_check
    CHECK (jsonb_typeof(target) = 'object');
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  ADD COLUMN remote_hook_id text;
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  ADD COLUMN remote_hook_account_id uuid
    REFERENCES public.companion_mcp_accounts(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  ADD COLUMN registration_status text NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  ADD COLUMN last_registration_error text;
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  ADD CONSTRAINT companion_triggers_registration_status_check
    CHECK (registration_status IN ('manual', 'registered', 'failed'));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_trigger_json(
  p_org_id uuid,
  p_companion_id uuid,
  p_trigger_id uuid,
  p_include_secret boolean
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT jsonb_build_object(
    'id', trigger_row.id,
    'companion_id', trigger_row.companion_id,
    'name', trigger_row.name,
    'prompt', trigger_row.prompt,
    'provider', trigger_row.provider,
    'target', NULLIF(trigger_row.target, '{}'::jsonb),
    'registration_status', trigger_row.registration_status,
    'enabled', trigger_row.enabled,
    'secret', CASE WHEN p_include_secret THEN trigger_row.secret ELSE NULL END,
    'last_fired_at', CASE WHEN trigger_row.last_fired_at IS NULL THEN NULL ELSE to_char(
      trigger_row.last_fired_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) END,
    'last_error_code', trigger_row.last_error_code,
    'last_error_message', trigger_row.last_error_message,
    'last_error_at', CASE WHEN trigger_row.last_error_at IS NULL THEN NULL ELSE to_char(
      trigger_row.last_error_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) END,
    'consecutive_failures', trigger_row.consecutive_failures,
    'created_at', to_char(
      trigger_row.created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'updated_at', to_char(
      trigger_row.updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  )
  FROM public.companion_triggers trigger_row
  WHERE trigger_row.org_id = p_org_id
    AND trigger_row.companion_id = p_companion_id
    AND trigger_row.id = p_trigger_id
$$;
--> statement-breakpoint

-- Target-aware overload of create. The old signature stays for the replay/idempotence surface the
-- decision path used before targets existed; new callers always carry the target.
CREATE FUNCTION public.companion_api_create_trigger(
  p_org_id uuid,
  p_companion_id uuid,
  p_id uuid,
  p_name text,
  p_prompt text,
  p_provider text,
  p_target jsonb,
  p_secret text,
  p_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_name text := btrim(p_name);
  v_prompt text := btrim(p_prompt);
  v_now timestamp with time zone := clock_timestamp();
  v_existing public.companion_triggers%ROWTYPE;
  v_companion public.companions%ROWTYPE;
  v_target jsonb;
  v_count integer;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_id IS NULL
     OR v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name ~ E'[\n\r]'
     OR v_prompt IS NULL OR char_length(v_prompt) NOT BETWEEN 1 AND 16384
     OR p_provider IS NULL OR p_provider NOT IN ('linear', 'github', 'custom')
     OR p_secret IS NULL OR p_secret !~ '^[0-9a-f]{32,128}$'
     OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid Companion trigger' USING ERRCODE = '22023';
  END IF;

  IF p_target IS NULL OR jsonb_typeof(p_target) <> 'object' THEN
    RAISE EXCEPTION 'invalid Companion trigger target' USING ERRCODE = '22023';
  END IF;
  IF p_provider = 'github' THEN
    IF p_target ->> 'repo' IS NULL
       OR char_length(p_target ->> 'repo') > 200
       OR (p_target ->> 'repo') !~ '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+$'
       OR jsonb_typeof(COALESCE(p_target -> 'events', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(p_target -> 'events', '[]'::jsonb)) NOT BETWEEN 1 AND 30
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(COALESCE(p_target -> 'events', '[]'::jsonb)) event
         WHERE event NOT LIKE '\*'
           AND event !~ '^[a-z_]{1,64}$'
       ) THEN
      RAISE EXCEPTION 'invalid Companion trigger target' USING ERRCODE = '22023';
    END IF;
    v_target := p_target;
  ELSIF p_target <> '{}'::jsonb THEN
    RAISE EXCEPTION 'a % trigger does not support a target yet', p_provider USING ERRCODE = '22023';
  ELSE
    v_target := '{}'::jsonb;
  END IF;

  SELECT companion.* INTO v_companion
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion not found' USING ERRCODE = 'P0002';
  END IF;

  -- Plugin-backed providers still require the matching plugin attached.
  IF p_provider IN ('linear', 'github') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.companion_mcp_accounts account
      WHERE account.org_id = p_org_id
        AND account.provider = p_provider
        AND COALESCE(v_companion.selected_mcp_account_ids, '[]'::jsonb) ? account.id::text
    ) THEN
      RAISE EXCEPTION 'a % trigger requires the % plugin attached to the Companion', p_provider, p_provider
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT trigger_row.* INTO v_existing
  FROM public.companion_triggers trigger_row
  WHERE trigger_row.id = p_id
  FOR UPDATE;
  IF FOUND THEN
    -- The secret is deliberately outside the intent compare: a retried create carries a freshly
    -- generated secret, and the replay must return the stored one instead of conflicting on it.
    IF v_existing.org_id IS DISTINCT FROM p_org_id
       OR v_existing.companion_id IS DISTINCT FROM p_companion_id
       OR v_existing.name IS DISTINCT FROM v_name
       OR v_existing.prompt IS DISTINCT FROM v_prompt
       OR v_existing.provider IS DISTINCT FROM p_provider
       OR v_existing.target IS DISTINCT FROM v_target
       OR v_existing.enabled IS DISTINCT FROM p_enabled THEN
      RAISE EXCEPTION 'trigger id was reused with different trigger intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.companion_api_trigger_json(p_org_id, p_companion_id, p_id, true);
  END IF;

  SELECT count(*)::integer INTO v_count
  FROM public.companion_triggers trigger_row
  WHERE trigger_row.org_id = p_org_id AND trigger_row.companion_id = p_companion_id;
  IF v_count >= 10 THEN
    RAISE EXCEPTION 'Companion trigger limit reached' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.companion_triggers(
    id, org_id, companion_id, name, prompt, provider, target, secret, enabled,
    created_by, created_at, updated_at
  ) VALUES (
    p_id, p_org_id, p_companion_id, v_name, v_prompt, p_provider, v_target, p_secret, p_enabled,
    v_actor_id, v_now, v_now
  );

  RETURN public.companion_api_trigger_json(p_org_id, p_companion_id, p_id, true);
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_update_trigger(
  p_org_id uuid,
  p_companion_id uuid,
  p_trigger_id uuid,
  p_name text,
  p_prompt text,
  p_provider text,
  p_target jsonb,
  p_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_name text := btrim(p_name);
  v_prompt text := btrim(p_prompt);
  v_now timestamp with time zone := clock_timestamp();
  v_trigger public.companion_triggers%ROWTYPE;
  v_companion public.companions%ROWTYPE;
  v_target jsonb;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_trigger_id IS NULL
     OR v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name ~ E'[\n\r]'
     OR v_prompt IS NULL OR char_length(v_prompt) NOT BETWEEN 1 AND 16384
     OR p_provider IS NULL OR p_provider NOT IN ('linear', 'github', 'custom')
     OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid Companion trigger' USING ERRCODE = '22023';
  END IF;

  IF p_target IS NULL OR jsonb_typeof(p_target) <> 'object' THEN
    RAISE EXCEPTION 'invalid Companion trigger target' USING ERRCODE = '22023';
  END IF;
  IF p_provider = 'github' THEN
    IF p_target ->> 'repo' IS NULL
       OR char_length(p_target ->> 'repo') > 200
       OR (p_target ->> 'repo') !~ '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+$'
       OR jsonb_typeof(COALESCE(p_target -> 'events', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(p_target -> 'events', '[]'::jsonb)) NOT BETWEEN 1 AND 30
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(COALESCE(p_target -> 'events', '[]'::jsonb)) event
         WHERE event NOT LIKE '\*'
           AND event !~ '^[a-z_]{1,64}$'
       ) THEN
      RAISE EXCEPTION 'invalid Companion trigger target' USING ERRCODE = '22023';
    END IF;
    v_target := p_target;
  ELSIF p_target <> '{}'::jsonb THEN
    RAISE EXCEPTION 'a % trigger does not support a target yet', p_provider USING ERRCODE = '22023';
  ELSE
    v_target := '{}'::jsonb;
  END IF;

  SELECT companion.* INTO v_companion
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_provider IN ('linear', 'github') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.companion_mcp_accounts account
      WHERE account.org_id = p_org_id
        AND account.provider = p_provider
        AND COALESCE(v_companion.selected_mcp_account_ids, '[]'::jsonb) ? account.id::text
    ) THEN
      RAISE EXCEPTION 'a % trigger requires the % plugin attached to the Companion', p_provider, p_provider
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT trigger_row.* INTO v_trigger
  FROM public.companion_triggers trigger_row
  WHERE trigger_row.org_id = p_org_id
    AND trigger_row.companion_id = p_companion_id
    AND trigger_row.id = p_trigger_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion trigger not found' USING ERRCODE = 'P0002';
  END IF;

  -- Changing the target or provider invalidates any provider-side wiring; re-registration is
  -- explicit. An ordinary edit keeps the existing registration.
  UPDATE public.companion_triggers trigger_row
  SET name = v_name,
      prompt = v_prompt,
      provider = p_provider,
      target = v_target,
      enabled = p_enabled,
      remote_hook_id = CASE
        WHEN trigger_row.target IS DISTINCT FROM v_target
          OR trigger_row.provider IS DISTINCT FROM p_provider
        THEN NULL ELSE trigger_row.remote_hook_id END,
      remote_hook_account_id = CASE
        WHEN trigger_row.target IS DISTINCT FROM v_target
          OR trigger_row.provider IS DISTINCT FROM p_provider
        THEN NULL ELSE trigger_row.remote_hook_account_id END,
      registration_status = CASE
        WHEN trigger_row.target IS DISTINCT FROM v_target
          OR trigger_row.provider IS DISTINCT FROM p_provider
        THEN 'manual' ELSE trigger_row.registration_status END,
      last_registration_error = CASE
        WHEN trigger_row.target IS DISTINCT FROM v_target
          OR trigger_row.provider IS DISTINCT FROM p_provider
        THEN NULL ELSE trigger_row.last_registration_error END,
      last_error_code = NULL,
      last_error_message = NULL,
      last_error_at = NULL,
      consecutive_failures = 0,
      updated_at = v_now
  WHERE trigger_row.id = p_trigger_id
    AND trigger_row.org_id = p_org_id
    AND trigger_row.companion_id = p_companion_id;

  RETURN public.companion_api_trigger_json(p_org_id, p_companion_id, p_trigger_id, true);
END
$$;
--> statement-breakpoint

-- Record the outcome of an on-demand provider registration. Editor-gated like every other write;
-- only this narrow function touches the remote-hook columns.
CREATE FUNCTION public.companion_api_set_trigger_registration(
  p_org_id uuid,
  p_companion_id uuid,
  p_trigger_id uuid,
  p_remote_hook_account_id uuid,
  p_remote_hook_id text,
  p_registration_status text,
  p_last_registration_error text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_trigger public.companion_triggers%ROWTYPE;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_trigger_id IS NULL
     OR p_registration_status NOT IN ('manual', 'registered', 'failed')
     OR (p_registration_status = 'registered' AND (p_remote_hook_id IS NULL OR p_remote_hook_account_id IS NULL))
     OR char_length(COALESCE(p_last_registration_error, '')) > 500 THEN
    RAISE EXCEPTION 'invalid Companion trigger registration' USING ERRCODE = '22023';
  END IF;

  SELECT trigger_row.* INTO v_trigger
  FROM public.companion_triggers trigger_row
  WHERE trigger_row.org_id = p_org_id
    AND trigger_row.companion_id = p_companion_id
    AND trigger_row.id = p_trigger_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion trigger not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.companion_triggers trigger_row
  SET remote_hook_id = p_remote_hook_id,
      remote_hook_account_id = p_remote_hook_account_id,
      registration_status = p_registration_status,
      last_registration_error = p_last_registration_error,
      updated_at = clock_timestamp()
  WHERE trigger_row.id = p_trigger_id
    AND trigger_row.org_id = p_org_id
    AND trigger_row.companion_id = p_companion_id;

  RETURN public.companion_api_trigger_json(p_org_id, p_companion_id, p_trigger_id, true);
END
$$;
--> statement-breakpoint

-- Approved proposals may now carry a github target. Same signature, so the existing grants hold.
CREATE OR REPLACE FUNCTION public.companion_api_answer_trigger_decision(
  p_org_id uuid,
  p_companion_id uuid,
  p_request_key text,
  p_action text,
  p_trigger_id uuid,
  p_secret text
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
  v_event_id text;
  v_now timestamp with time zone := clock_timestamp();
  v_proposal jsonb;
  v_name text;
  v_prompt text;
  v_provider text;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
     OR p_request_key ~ E'[\n\r]' OR p_action NOT IN ('allow', 'deny') THEN
    RAISE EXCEPTION 'invalid Companion decision response' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'allow' AND (
    p_trigger_id IS NULL
    OR p_secret IS NULL
    OR p_secret !~ '^[0-9a-f]{32,128}$'
  ) THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE = '22023';
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
       OR v_delivery.request_kind <> 'trigger_proposal'
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

  IF v_delivery.request_kind <> 'trigger_proposal' THEN
    RAISE EXCEPTION 'Companion trigger proposals cannot be answered here' USING ERRCODE = '22023';
  END IF;
  IF v_delivery.expires_at <= v_now THEN
    RAISE EXCEPTION 'Companion decision has expired' USING ERRCODE = '55000';
  END IF;

  v_proposal := v_delivery.proposal;
  IF v_proposal IS NULL OR jsonb_typeof(v_proposal) <> 'object'
     OR v_proposal ->> 'kind' <> 'trigger'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(v_proposal) patch_key
       WHERE patch_key NOT IN ('kind', 'name', 'prompt', 'provider', 'target')
     ) THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE = '22023';
  END IF;

  v_name := btrim(v_proposal ->> 'name');
  v_prompt := btrim(v_proposal ->> 'prompt');
  v_provider := v_proposal ->> 'provider';
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name ~ E'[\n\r]'
     OR v_prompt IS NULL OR char_length(v_prompt) NOT BETWEEN 1 AND 16384
     OR v_provider IS NULL OR v_provider NOT IN ('linear', 'github', 'custom') THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'allow' THEN
    PERFORM public.companion_api_create_trigger(
      p_org_id,
      p_companion_id,
      p_trigger_id,
      v_name,
      v_prompt,
      v_provider,
      COALESCE(v_proposal -> 'target', '{}'::jsonb),
      p_secret,
      true
    );
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

-- Editor-gated raw read for the on-demand registration service: it needs the webhook URL and the
-- raw secret (which doubles as the provider HMAC key) without exposing either through the
-- ordinary list projection.
CREATE FUNCTION public.companion_api_get_trigger_for_registration(
  p_org_id uuid,
  p_companion_id uuid,
  p_trigger_id uuid,
  p_webhook_base_url text
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
  v_trigger public.companion_triggers%ROWTYPE;
BEGIN
  IF v_access NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'editor access is required' USING ERRCODE = '42501';
  END IF;
  SELECT trigger_row.* INTO v_trigger
  FROM public.companion_triggers trigger_row
  WHERE trigger_row.org_id = p_org_id
    AND trigger_row.companion_id = p_companion_id
    AND trigger_row.id = p_trigger_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion trigger not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN public.companion_api_trigger_json(p_org_id, p_companion_id, p_trigger_id, true)
    || jsonb_build_object(
      'webhook_url', p_webhook_base_url
        || '/v1/hooks/triggers/' || v_trigger.id::text || '/' || v_trigger.secret,
      'remote_hook_id', v_trigger.remote_hook_id
    );
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_create_trigger(
  uuid, uuid, uuid, text, text, text, jsonb, text, boolean
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_update_trigger(
  uuid, uuid, uuid, text, text, text, jsonb, boolean
) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_set_trigger_registration(
  uuid, uuid, uuid, uuid, text, text, text
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_get_trigger_for_registration(
  uuid, uuid, uuid, text
) FROM PUBLIC;
--> statement-breakpoint

DO $companion_trigger_registration_acl$
DECLARE
  v_sources oid[] := array[
    pg_catalog.to_regprocedure('public.companion_api_set_trigger_registration(uuid,uuid,uuid,uuid,text,text,text)'),
    pg_catalog.to_regprocedure('public.companion_api_get_trigger_for_registration(uuid,uuid,uuid,text)')
  ];
  v_source oid;
  v_grantees oid[];
  v_role name;
BEGIN
  FOREACH v_source IN ARRAY v_sources LOOP
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Companion trigger registration surface is missing' USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT acl.grantee), ARRAY[]::oid[])
    INTO v_grantees
    FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
    ) acl
    WHERE source_proc.oid = (
        pg_catalog.to_regprocedure('public.companion_api_rotate_trigger_secret(uuid,uuid,uuid,text)')
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
$companion_trigger_registration_acl$;

DO $companion_trigger_target_acl$
DECLARE
  v_sources oid[] := array[
    pg_catalog.to_regprocedure('public.companion_api_create_trigger(uuid,uuid,uuid,text,text,text,text,boolean)'),
    pg_catalog.to_regprocedure('public.companion_api_update_trigger(uuid,uuid,uuid,text,text,text,boolean)')
  ];
  v_source oid;
  v_grantees oid[];
  v_role name;
BEGIN
  FOREACH v_source IN ARRAY v_sources LOOP
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Companion trigger surface is missing' USING ERRCODE = '55000';
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
      CONTINUE;
    END IF;
    IF cardinality(v_grantees) > 1 THEN
      RAISE EXCEPTION 'Companion API ACL must name exactly one login role' USING ERRCODE = '55000';
    END IF;
    SELECT api_role.rolname INTO STRICT v_role
    FROM pg_catalog.pg_roles api_role WHERE api_role.oid = v_grantees[1];
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.companion_api_%s TO %I',
      CASE WHEN v_source = pg_catalog.to_regprocedure('public.companion_api_create_trigger(uuid,uuid,uuid,text,text,text,text,boolean)')
        THEN 'create_trigger(uuid,uuid,uuid,text,text,text,jsonb,text,boolean)'
        ELSE 'update_trigger(uuid,uuid,uuid,text,text,text,jsonb,boolean)' END,
      v_role
    );
  END LOOP;
END
$companion_trigger_target_acl$;
