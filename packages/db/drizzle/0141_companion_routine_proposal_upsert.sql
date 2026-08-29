-- An approved routine proposal is a desired definition, not necessarily a new row. Serialize
-- routine creation and proposal approval on the Companion row, then update a case-insensitive
-- name match before applying the ten-routine cap. The input signature stays unchanged. The return
-- table gains the resulting routine as a nullable trailing column; replacing the function therefore
-- requires an explicit drop/recreate and grant repair below.
DROP FUNCTION public.companion_api_answer_routine_decision(
  uuid, uuid, text, text, uuid, timestamp with time zone
);
--> statement-breakpoint

CREATE FUNCTION public.companion_api_answer_routine_decision(
  p_org_id uuid,
  p_companion_id uuid,
  p_request_key text,
  p_action text,
  p_routine_id uuid,
  p_next_fire_at timestamp with time zone
)
RETURNS TABLE (
  delivery_id uuid,
  turn_id uuid,
  decision_status public.companion_decision_status,
  delivery_state public.companion_decision_delivery_state,
  responded_at timestamp with time zone,
  routine jsonb
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
  v_cron text;
  v_timezone text;
  v_routine public.companion_routines%ROWTYPE;
  v_routine_id uuid;
  v_routine_json jsonb;
  v_upsert_mode text;
  v_count integer;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
     OR p_request_key ~ E'[\n\r]' OR p_action NOT IN ('allow', 'deny') THEN
    RAISE EXCEPTION 'invalid Companion decision response' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'allow' AND (
    p_routine_id IS NULL
    OR p_next_fire_at IS NULL
    OR p_next_fire_at <= v_now
  ) THEN
    RAISE EXCEPTION 'invalid Companion routine proposal' USING ERRCODE = '22023';
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
      AND (delivery.actor_id = v_actor_id OR (
        p_action = 'deny'
        AND delivery.actor_id IS NULL
        AND delivery.decision_status IN ('expired', 'cancelled')
      ))
    ORDER BY delivery.created_at DESC, delivery.id DESC
    LIMIT 1;
    IF NOT FOUND
       OR v_delivery.request_kind <> 'routine_proposal'
       OR NOT (
         (p_action = 'allow' AND v_delivery.decision_status = 'allowed')
         OR (p_action = 'deny' AND v_delivery.decision_status IN ('denied', 'expired', 'cancelled'))
       ) THEN
      RAISE EXCEPTION 'Companion decision is not pending' USING ERRCODE = '55000';
    END IF;
    IF p_action = 'allow' THEN
      SELECT routine.id INTO v_routine_id
      FROM public.companion_routines routine
      WHERE routine.org_id = p_org_id
        AND routine.companion_id = p_companion_id
        AND lower(routine.name) = lower(btrim(v_delivery.proposal ->> 'name'))
      LIMIT 1;
      IF FOUND THEN
        v_routine_json := public.companion_api_routine_json(
          p_org_id, p_companion_id, v_routine_id
        );
      END IF;
    END IF;
    RETURN QUERY SELECT v_delivery.id, v_delivery.turn_id, v_delivery.decision_status,
      v_delivery.delivery_state, v_delivery.responded_at, v_routine_json;
    RETURN;
  END IF;

  IF v_delivery.request_kind <> 'routine_proposal' THEN
    RAISE EXCEPTION 'Companion routine proposals cannot be answered here' USING ERRCODE = '22023';
  END IF;
  IF p_action <> 'deny' AND v_delivery.expires_at <= v_now THEN
    RAISE EXCEPTION 'Companion decision has expired' USING ERRCODE = '55000';
  END IF;

  v_proposal := v_delivery.proposal;
  IF v_proposal IS NULL OR jsonb_typeof(v_proposal) <> 'object'
     OR v_proposal ->> 'kind' <> 'routine'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(v_proposal) patch_key
       WHERE patch_key NOT IN ('kind', 'name', 'prompt', 'cron', 'timezone')
     ) THEN
    RAISE EXCEPTION 'invalid Companion routine proposal' USING ERRCODE = '22023';
  END IF;

  v_name := btrim(v_proposal ->> 'name');
  v_prompt := btrim(v_proposal ->> 'prompt');
  v_cron := btrim(v_proposal ->> 'cron');
  v_timezone := btrim(v_proposal ->> 'timezone');
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name ~ E'[\n\r]'
     OR v_prompt IS NULL OR char_length(v_prompt) NOT BETWEEN 1 AND 16384
     OR v_cron IS NULL OR char_length(v_cron) NOT BETWEEN 1 AND 120 OR v_cron ~ E'[\n\r]'
     OR v_timezone IS NULL OR char_length(v_timezone) NOT BETWEEN 1 AND 64
     OR v_timezone ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Companion routine proposal' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'allow' THEN
    -- Ordinary create and delete functions use the same Companion lock. This makes the name
    -- lookup, cap check, and update/insert one serializable application-level critical section.
    PERFORM 1
    FROM public.companions companion
    WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
    FOR UPDATE;

    SELECT routine.* INTO v_routine
    FROM public.companion_routines routine
    WHERE routine.org_id = p_org_id
      AND routine.companion_id = p_companion_id
      AND lower(routine.name) = lower(v_name)
    FOR UPDATE;

    IF FOUND THEN
      -- Keep the existing row identity (and display spelling) while replacing the mutable
      -- proposal fields. Invalidate any old worker claim so its stale schedule cannot settle over
      -- the newly approved definition.
      UPDATE public.companion_routines routine
      SET prompt = v_prompt,
          cron = v_cron,
          timezone = v_timezone,
          enabled = true,
          next_fire_at = p_next_fire_at,
          last_error_code = NULL,
          last_error_message = NULL,
          last_error_at = NULL,
          consecutive_failures = 0,
          claimed_by = NULL,
          lease_expires_at = NULL,
          updated_at = v_now
      WHERE routine.org_id = p_org_id
        AND routine.companion_id = p_companion_id
        AND routine.id = v_routine.id;
      v_routine_id := v_routine.id;
      v_upsert_mode := 'updated';
    ELSE
      SELECT count(*)::integer INTO v_count
      FROM public.companion_routines routine
      WHERE routine.org_id = p_org_id AND routine.companion_id = p_companion_id;
      IF v_count >= 10 THEN
        RAISE EXCEPTION 'Companion routine limit reached' USING ERRCODE = 'P0001';
      END IF;

      BEGIN
        INSERT INTO public.companion_routines(
          id, org_id, companion_id, name, prompt, cron, timezone, enabled,
          next_fire_at, created_by, created_at, updated_at
        ) VALUES (
          p_routine_id, p_org_id, p_companion_id, v_name, v_prompt, v_cron, v_timezone,
          true, p_next_fire_at, v_actor_id, v_now, v_now
        );
        v_routine_id := p_routine_id;
        v_upsert_mode := 'created';
      EXCEPTION WHEN unique_violation THEN
        -- A legacy ordinary update does not take the Companion lock. If it wins a concurrent
        -- rename to this name, converge on that row instead of leaking a unique-index failure.
        SELECT routine.* INTO v_routine
        FROM public.companion_routines routine
        WHERE routine.org_id = p_org_id
          AND routine.companion_id = p_companion_id
          AND lower(routine.name) = lower(v_name)
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE;
        END IF;
        UPDATE public.companion_routines routine
        SET prompt = v_prompt,
            cron = v_cron,
            timezone = v_timezone,
            enabled = true,
            next_fire_at = p_next_fire_at,
            last_error_code = NULL,
            last_error_message = NULL,
            last_error_at = NULL,
            consecutive_failures = 0,
            claimed_by = NULL,
            lease_expires_at = NULL,
            updated_at = v_now
        WHERE routine.org_id = p_org_id
          AND routine.companion_id = p_companion_id
          AND routine.id = v_routine.id;
        v_routine_id := v_routine.id;
        v_upsert_mode := 'updated';
      END;
    END IF;

    INSERT INTO public.audit_log(org_id, actor_id, action, target_type, target_id, metadata)
    VALUES (
      p_org_id,
      v_actor_id,
      'companion.routine.proposal.approved',
      'companion_routine',
      v_routine_id::text,
      jsonb_build_object('request_key', p_request_key, 'mode', v_upsert_mode)
    );
    v_routine_json := public.companion_api_routine_json(
      p_org_id, p_companion_id, v_routine_id
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
    v_delivery.delivery_state, v_delivery.responded_at, v_routine_json;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_answer_routine_decision(
  uuid, uuid, text, text, uuid, timestamp with time zone
) FROM PUBLIC;
--> statement-breakpoint

DO $companion_api_routine_decision_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure(
    'public.companion_api_answer_config_decision(uuid,uuid,text,text)'
  );
  v_grantees oid[];
  v_owner name;
  v_role name;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Companion API config decision surface is missing' USING ERRCODE = '55000';
  END IF;
  SELECT owner_role.rolname INTO STRICT v_owner
  FROM pg_catalog.pg_proc source_proc
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = source_proc.proowner
  WHERE source_proc.oid = v_source;
  EXECUTE format(
    'ALTER FUNCTION public.companion_api_answer_routine_decision('
    || 'uuid,uuid,text,text,uuid,timestamp with time zone) OWNER TO %I',
    v_owner
  );
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
    'GRANT EXECUTE ON FUNCTION public.companion_api_answer_routine_decision('
    || 'uuid,uuid,text,text,uuid,timestamp with time zone) TO %I',
    v_role
  );
END
$companion_api_routine_decision_acl$;
