-- Track the credential snapshot actually activated by a fresh Pi invocation. A staged snapshot is
-- durable on its operation/settings work so takeover can finish publication, but it is not warm-
-- dispatch eligible until the new invocation has been observed and the narrow publisher runs.

ALTER TABLE public.companion_runtime_instances
  ADD COLUMN material_client_surface public.companion_client_surface,
  ADD COLUMN material_pi_invocation_id text,
  ADD COLUMN material_expires_at timestamp with time zone,
  ADD COLUMN settings_claim_material_client_surface public.companion_client_surface,
  ADD COLUMN settings_claim_material_staged_at timestamp with time zone,
  ADD COLUMN settings_claim_material_expires_at timestamp with time zone,
  ADD CONSTRAINT companion_runtime_instances_material_snapshot_check CHECK (
    ((material_client_surface IS NULL) = (material_pi_invocation_id IS NULL))
    AND (material_client_surface IS NOT NULL OR material_expires_at IS NULL)
    AND (material_pi_invocation_id IS NULL OR (
      char_length(material_pi_invocation_id) BETWEEN 1 AND 200
      AND material_pi_invocation_id !~ E'[\n\r]'
    ))
    AND (
      material_client_surface IS NULL
      OR material_client_surface = 'native_mobile' AND material_expires_at IS NULL
      OR material_client_surface IN ('web', 'mobile_web') AND material_expires_at IS NOT NULL
    )
    AND ((settings_claim_material_client_surface IS NULL) =
      (settings_claim_material_staged_at IS NULL))
    AND (
      settings_claim_material_staged_at IS NULL
      OR settings_claim_material_client_surface = 'native_mobile'
        AND settings_claim_material_expires_at IS NULL
      OR settings_claim_material_client_surface IN ('web', 'mobile_web')
        AND settings_claim_material_expires_at IS NOT NULL
    )
  );
--> statement-breakpoint

ALTER TABLE public.companion_operations
  ADD COLUMN material_staged_at timestamp with time zone,
  ADD COLUMN material_expires_at timestamp with time zone,
  ADD CONSTRAINT companion_operations_material_snapshot_check CHECK (
    (material_staged_at IS NOT NULL OR material_expires_at IS NULL)
    AND (
      material_staged_at IS NULL
      OR client_surface = 'native_mobile' AND material_expires_at IS NULL
      OR client_surface IN ('web', 'mobile_web') AND material_expires_at IS NOT NULL
    )
  );
--> statement-breakpoint

-- A settings takeover changes the claim epoch while keeping the same durable work and must retain
-- its staged snapshot. Crossing the unclaimed boundary, however, means the old work settled or a
-- genuinely new claim started, so no snapshot from that work may be published by the next one.
CREATE FUNCTION public.companion_runtime_reset_settings_material_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (OLD.settings_claim_epoch IS NULL) <> (NEW.settings_claim_epoch IS NULL) THEN
    NEW.settings_claim_material_client_surface := NULL;
    NEW.settings_claim_material_staged_at := NULL;
    NEW.settings_claim_material_expires_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Mixed-version runtimes do not know how to publish a material snapshot. If one of them observes a
-- different Pi invocation during a rolling deploy, invalidate the old proof atomically so neither
-- web nor native-mobile can inherit credentials from a Pi the snapshot never described.
CREATE FUNCTION public.companion_runtime_reset_material_on_pi_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.pi_invocation_id IS DISTINCT FROM NEW.pi_invocation_id THEN
    NEW.material_client_surface := NULL;
    NEW.material_pi_invocation_id := NULL;
    NEW.material_expires_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER companion_runtime_reset_material_on_pi_change
BEFORE UPDATE OF pi_invocation_id ON public.companion_runtime_instances
FOR EACH ROW
EXECUTE FUNCTION public.companion_runtime_reset_material_on_pi_change();
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_reset_material_on_pi_change() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_runtime_reset_settings_material_snapshot
BEFORE UPDATE OF settings_claim_epoch ON public.companion_runtime_instances
FOR EACH ROW
EXECUTE FUNCTION public.companion_runtime_reset_settings_material_snapshot();
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_reset_settings_material_snapshot() FROM PUBLIC;
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
  p_material_expires_at timestamp with time zone
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
      updated_at = v_now
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_publish_material_snapshot(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_pi_invocation_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_surface public.companion_client_surface;
  v_staged_at timestamp with time zone;
  v_expires_at timestamp with time zone;
BEGIN
  IF p_pi_invocation_id IS NULL
     OR char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200
     OR p_pi_invocation_id ~ E'[\n\r]'
     OR p_work_kind NOT IN ('operation', 'settings') THEN
    RAISE EXCEPTION 'invalid Companion material activation proof' USING ERRCODE = '22023';
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
    SELECT operation.client_surface, operation.material_staged_at,
           operation.material_expires_at
    INTO v_surface, v_staged_at, v_expires_at
    FROM public.companion_operations operation
    WHERE operation.org_id = p_org_id
      AND operation.companion_id = p_companion_id
      AND operation.id = p_work_id
      AND operation.status = 'running'
      AND operation.claim_epoch = p_claim_epoch
      AND (
        operation.kind IN ('start', 'restart_pi', 'restart_box')
          AND operation.checkpoint IN ('pi_observed', 'pi_ready')
        OR operation.kind = 'apply_settings' AND operation.checkpoint = 'settings_applied'
      )
    FOR UPDATE;
  ELSE
    SELECT instance.settings_claim_material_client_surface,
           instance.settings_claim_material_staged_at,
           instance.settings_claim_material_expires_at
    INTO v_surface, v_staged_at, v_expires_at
    FROM public.companion_runtime_instances instance
    WHERE instance.org_id = p_org_id
      AND instance.companion_id = p_companion_id
      AND p_work_id = instance.companion_id
      AND instance.settings_claim_epoch = p_claim_epoch
      AND instance.settings_checkpoint = 'applied'
    FOR UPDATE;
  END IF;
  IF NOT FOUND OR v_staged_at IS NULL THEN RETURN false; END IF;

  UPDATE public.companion_runtime_instances instance
  SET material_client_surface = v_surface,
      material_pi_invocation_id = p_pi_invocation_id,
      material_expires_at = v_expires_at,
      last_write_epoch = GREATEST(instance.last_write_epoch, p_claim_epoch),
      updated_at = v_now
  WHERE instance.org_id = p_org_id
    AND instance.companion_id = p_companion_id
    AND instance.pi_state = 'idle'
    AND instance.pi_invocation_id = p_pi_invocation_id;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN true;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_record_material_snapshot(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  public.companion_client_surface, timestamp with time zone
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_publish_material_snapshot(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, text
) FROM PUBLIC;
--> statement-breakpoint

-- Return the database-authored expiry next to the one-time plaintext token. The refresh token of
-- every MCP OAuth grant remains encrypted in the control plane and is never part of this result.
DROP FUNCTION public.companion_runtime_mint_hub_token(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
);
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
RETURNS TABLE (token text, expires_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_authorization record;
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_actor_id text;
  v_surface public.companion_client_surface;
  v_scopes jsonb;
  v_previous uuid;
  v_token_id uuid := gen_random_uuid();
  v_secret text;
  v_token text;
  v_now timestamp with time zone := clock_timestamp();
  v_expires_at timestamp with time zone := v_now + interval '6 hours';
BEGIN
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
  -- The currently fenced work is authoritative. An expired settings lease may leave its claim
  -- fields populated while a higher-priority Start is claimed, so consulting those fields first
  -- could mint (or suppress) credentials for the wrong actor/surface. Settings work already
  -- exposes its own claim actor and surface through renew_and_authorize.
  v_actor_id := v_authorization.authorization_actor_id;
  v_surface := v_authorization.client_surface;
  v_previous := v_instance.hub_token_id;

  IF v_actor_id IS NULL
     OR v_surface = 'native_mobile'
     OR NOT EXISTS (
       SELECT 1 FROM public.memberships membership
       WHERE membership.org_id = p_org_id AND membership.user_id = v_actor_id
     ) THEN
    IF v_previous IS NOT NULL THEN
      UPDATE public.companion_runtime_instances
      SET hub_token_id = NULL,
          material_client_surface = NULL,
          material_pi_invocation_id = NULL,
          material_expires_at = NULL,
          updated_at = v_now
      WHERE org_id = p_org_id AND companion_id = p_companion_id;
      UPDATE public.api_tokens SET revoked_at = v_now
      WHERE id = v_previous AND revoked_at IS NULL;
    END IF;
    RETURN;
  END IF;

  v_scopes := jsonb_build_array(
    'skills:read', 'skills:write', 'secrets:read', 'database:read', 'database:write'
  );
  v_secret := left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 48);
  v_token := 'cmp_pat_' || v_secret;

  INSERT INTO public.api_tokens(
    id, org_id, user_id, name, token_prefix, token_hash, scopes,
    source_type, source_agent_id, target_workspace_id, expires_at
  ) VALUES (
    v_token_id, p_org_id, v_actor_id, 'Companion Skills Hub', left(v_token, 14),
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_scopes,
    'companion', p_companion_id::text, NULL, v_expires_at
  );
  UPDATE public.companion_runtime_instances
  SET hub_token_id = v_token_id,
      material_client_surface = NULL,
      material_pi_invocation_id = NULL,
      material_expires_at = NULL,
      updated_at = v_now
  WHERE org_id = p_org_id AND companion_id = p_companion_id;
  IF v_previous IS NOT NULL THEN
    UPDATE public.api_tokens SET revoked_at = v_now
    WHERE id = v_previous AND revoked_at IS NULL;
  END IF;
  INSERT INTO public.audit_log(org_id, actor_id, action, target_type, target_id, metadata)
  VALUES (
    p_org_id, v_actor_id, 'api_token.issue_companion_write', 'api_token', v_token_id::text,
    jsonb_build_object(
      'sourceType', 'companion', 'sourceAgentId', p_companion_id,
      'scopes', v_scopes, 'expiresAt', v_expires_at
    )
  );
  RETURN QUERY SELECT v_token, v_expires_at;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_mint_hub_token(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_enqueue_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_client_message_id uuid,
  p_content text,
  p_client_surface public.companion_client_surface,
  p_attachments jsonb DEFAULT '[]'::jsonb,
  p_routine_id uuid DEFAULT NULL,
  p_routine_name text DEFAULT NULL
)
RETURNS TABLE (turn jsonb, operation jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_turn_id uuid;
  v_operation_id uuid;
  v_existing_actor_id text;
  v_existing_surface public.companion_client_surface;
  v_existing_content text;
  v_existing_author_id text;
  v_existing_routine_id uuid;
  v_existing_routine_name text;
  v_message_found boolean := false;
  v_message_ordinal integer;
  v_message_event_id text := 'msg:' || p_client_message_id::text;
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
  v_now timestamp with time zone := clock_timestamp();
  v_replayed boolean := false;
  v_needs_start boolean;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_client_message_id IS NULL OR p_client_surface IS NULL
     OR p_content IS NULL OR char_length(btrim(p_content)) NOT BETWEEN 1 AND 16384 THEN
    RAISE EXCEPTION 'invalid Companion message' USING ERRCODE = '22023';
  END IF;
  IF (p_routine_id IS NULL) <> (p_routine_name IS NULL)
     OR (p_routine_name IS NOT NULL AND (
       char_length(p_routine_name) NOT BETWEEN 1 AND 80 OR p_routine_name ~ E'[\n\r]'
     )) THEN
    RAISE EXCEPTION 'invalid Companion routine origin' USING ERRCODE = '22023';
  END IF;
  PERFORM public.companion_api_assert_message_attachments(
    p_org_id, p_companion_id, v_attachments
  );

  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;
  IF v_instance.retirement_state <> 'active' THEN
    RAISE EXCEPTION 'retired Companion cannot accept messages' USING ERRCODE = '55000';
  END IF;

  -- A direct warm dispatch is safe only when the observed Box/Pi pair is recent and the material
  -- activated in that Pi can outlive the full turn deadline plus its five-minute reserve. Surface
  -- class is part of the proof so native mobile can never inherit web-only Hub/plugin credentials.
  v_needs_start := NOT COALESCE((
    v_instance.box_state IN ('ready', 'idle', 'running')
    AND v_instance.pi_state = 'idle'
    AND v_instance.last_observed_at >= v_now - interval '2 minutes'
    AND v_instance.material_pi_invocation_id = v_instance.pi_invocation_id
    AND (
      p_client_surface = 'native_mobile'
        AND v_instance.material_client_surface = 'native_mobile'
      OR p_client_surface IN ('web', 'mobile_web')
        AND v_instance.material_client_surface IN ('web', 'mobile_web')
        AND v_instance.material_expires_at > v_now + interval '2 hours 5 minutes'
    )
  ), false);

  SELECT queued_turn.id, queued_turn.actor_id, queued_turn.client_surface,
    queued_turn.routine_id, queued_turn.routine_name
  INTO v_turn_id, v_existing_actor_id, v_existing_surface,
    v_existing_routine_id, v_existing_routine_name
  FROM public.companion_turns queued_turn
  WHERE queued_turn.org_id = p_org_id
    AND queued_turn.companion_id = p_companion_id
    AND queued_turn.client_message_id = p_client_message_id;

  IF FOUND THEN
    v_replayed := true;
    SELECT entry.content, entry.author_id
    INTO v_existing_content, v_existing_author_id
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
      AND entry.event_id = v_message_event_id AND entry.role = 'user';
    v_message_found := FOUND;
    SELECT start_operation.id INTO v_operation_id
    FROM public.companion_operations start_operation
    WHERE start_operation.org_id = p_org_id
      AND start_operation.companion_id = p_companion_id
      AND start_operation.source_turn_id = v_turn_id
      AND start_operation.kind = 'start'
    ORDER BY start_operation.queue_sequence, start_operation.id
    LIMIT 1;
    IF NOT v_message_found THEN
      RAISE EXCEPTION 'idempotent Companion turn is incomplete' USING ERRCODE = '55000';
    END IF;
    IF v_existing_actor_id IS DISTINCT FROM v_actor_id
       OR v_existing_author_id IS DISTINCT FROM v_actor_id
       OR v_existing_surface IS DISTINCT FROM p_client_surface
       OR v_existing_content IS DISTINCT FROM btrim(p_content)
       OR v_existing_routine_id IS DISTINCT FROM p_routine_id
       OR v_existing_routine_name IS DISTINCT FROM p_routine_name
       OR public.companion_api_stored_attachment_intent(
            p_org_id, p_companion_id, v_message_event_id
          ) IS DISTINCT FROM public.companion_api_message_attachment_intent(v_attachments) THEN
      RAISE EXCEPTION 'client_message_id was reused with different message intent'
        USING ERRCODE = '23505', CONSTRAINT = 'companion_turns_client_message_uq';
    END IF;
  ELSE
    INSERT INTO public.companion_threads(
      org_id, companion_id, next_ordinal, last_message_at, created_at, updated_at
    ) VALUES (p_org_id, p_companion_id, 1, v_now, v_now, v_now)
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
      org_id, companion_id, event_id, ordinal, role, content, author_id, routine_name, created_at
    ) VALUES (
      p_org_id, p_companion_id, v_message_event_id, v_message_ordinal,
      'user', btrim(p_content), v_actor_id, p_routine_name, v_now
    );
    INSERT INTO public.companion_message_attachments(
      org_id, companion_id, entry_event_id, kind, storage_key,
      content_type, byte_size, sha256, filename, position, created_at
    )
    SELECT p_org_id, p_companion_id, v_message_event_id, 'user_upload',
      part.value ->> 'storage_key', part.value ->> 'content_type',
      (part.value ->> 'byte_size')::integer, part.value ->> 'sha256',
      part.value ->> 'filename', (part.ordinality - 1)::integer, v_now
    FROM jsonb_array_elements(v_attachments) WITH ORDINALITY AS part(value, ordinality);

    INSERT INTO public.companion_turns(
      org_id, companion_id, client_message_id, message_event_id, queue_sequence,
      actor_id, client_surface, status, created_at, updated_at, routine_id, routine_name
    ) VALUES (
      p_org_id, p_companion_id, p_client_message_id, v_message_event_id, 0,
      v_actor_id, p_client_surface, 'queued', v_now, v_now, p_routine_id, p_routine_name
    ) RETURNING companion_turns.id INTO v_turn_id;

    IF v_needs_start THEN
      INSERT INTO public.companion_operations(
        org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
        queue_sequence, turn_queue_cutoff, runtime_generation, status, created_at, updated_at
      ) VALUES (
        p_org_id, p_companion_id, p_client_message_id, 'start', 'turn', v_actor_id,
        v_turn_id, 0, 0, v_instance.generation, 'pending', v_now, v_now
      ) RETURNING companion_operations.id INTO v_operation_id;
    END IF;

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
$function$;
--> statement-breakpoint

-- A warm turn can wait behind another turn long enough for a previously valid snapshot to cross the
-- two-hour reserve. Material eligibility therefore has to be rechecked under the runtime lease
-- mutex immediately before claim, not only when the API accepted the message.
CREATE UNIQUE INDEX companion_operations_one_active_material_start_uq
  ON public.companion_operations (companion_id, source_turn_id)
  WHERE kind = 'start' AND status IN ('pending', 'running') AND source_turn_id IS NOT NULL;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_prepare_queued_turn_material(p_gate_epoch bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_org_id uuid;
  v_companion_id uuid;
  v_turn_id uuid;
  v_actor_id text;
BEGIN
  -- Preserve Runtime v2's lease -> instance -> work lock order. The helper locks only one invalid
  -- candidate; the guarded claim wrapper repeats this before every row it asks the original claimer
  -- to return.
  SELECT lease.org_id, lease.companion_id
  INTO v_org_id, v_companion_id
  FROM public.companion_runtime_leases lease
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  JOIN public.companion_runtime_instances instance
    ON instance.org_id = lease.org_id AND instance.companion_id = lease.companion_id
  WHERE control.enabled
    AND control.gate_epoch = p_gate_epoch
    AND (lease.claim_token IS NULL OR lease.expires_at <= v_now)
    AND instance.retirement_state <> 'retired'
    AND EXISTS (
      SELECT 1
      FROM public.companion_turns queued_turn
      JOIN public.companions queued_companion
        ON queued_companion.org_id = queued_turn.org_id
       AND queued_companion.id = queued_turn.companion_id
      WHERE queued_turn.org_id = instance.org_id
        AND queued_turn.companion_id = instance.companion_id
        AND queued_turn.status = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns earlier_turn
          WHERE earlier_turn.org_id = queued_turn.org_id
            AND earlier_turn.companion_id = queued_turn.companion_id
            AND earlier_turn.status = 'queued'
            AND earlier_turn.queue_sequence < queued_turn.queue_sequence
        )
        AND instance.desired_settings_revision = instance.applied_settings_revision
        AND (
          queued_turn.client_surface = 'native_mobile'
            AND instance.applied_client_surface = 'native_mobile'
          OR queued_turn.client_surface IN ('web', 'mobile_web')
            AND instance.applied_client_surface IN ('web', 'mobile_web')
            AND queued_companion.skills_revision = instance.applied_skills_revision
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns active_turn
          WHERE active_turn.org_id = instance.org_id
            AND active_turn.companion_id = instance.companion_id
            AND active_turn.status IN (
              'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
            )
        )
        AND NOT COALESCE((
          instance.box_state IN ('ready', 'idle', 'running')
          AND instance.pi_state = 'idle'
          AND instance.last_observed_at >= v_now - interval '2 minutes'
          AND instance.material_pi_invocation_id = instance.pi_invocation_id
          AND (
            queued_turn.client_surface = 'native_mobile'
              AND instance.material_client_surface = 'native_mobile'
            OR queued_turn.client_surface IN ('web', 'mobile_web')
              AND instance.material_client_surface IN ('web', 'mobile_web')
              AND instance.material_expires_at > v_now + interval '2 hours 5 minutes'
          )
        ), false)
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_operations active_start
          WHERE active_start.org_id = queued_turn.org_id
            AND active_start.companion_id = queued_turn.companion_id
            AND active_start.source_turn_id = queued_turn.id
            AND active_start.kind = 'start'
            AND active_start.status IN ('pending', 'running')
        )
    )
  ORDER BY instance.health_due_at, instance.companion_id
  FOR UPDATE OF lease SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT queued_turn.id, queued_turn.actor_id
  INTO v_turn_id, v_actor_id
  FROM public.companion_runtime_instances instance
  JOIN public.companions queued_companion
    ON queued_companion.org_id = instance.org_id
   AND queued_companion.id = instance.companion_id
  JOIN public.companion_turns queued_turn
    ON queued_turn.org_id = instance.org_id
   AND queued_turn.companion_id = instance.companion_id
  WHERE instance.org_id = v_org_id
    AND instance.companion_id = v_companion_id
    AND instance.retirement_state <> 'retired'
    AND queued_turn.status = 'queued'
    AND NOT EXISTS (
      SELECT 1 FROM public.companion_turns earlier_turn
      WHERE earlier_turn.org_id = queued_turn.org_id
        AND earlier_turn.companion_id = queued_turn.companion_id
        AND earlier_turn.status = 'queued'
        AND earlier_turn.queue_sequence < queued_turn.queue_sequence
    )
    AND instance.desired_settings_revision = instance.applied_settings_revision
    AND (
      queued_turn.client_surface = 'native_mobile'
        AND instance.applied_client_surface = 'native_mobile'
      OR queued_turn.client_surface IN ('web', 'mobile_web')
        AND instance.applied_client_surface IN ('web', 'mobile_web')
        AND queued_companion.skills_revision = instance.applied_skills_revision
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.companion_turns active_turn
      WHERE active_turn.org_id = instance.org_id
        AND active_turn.companion_id = instance.companion_id
        AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
    )
    AND NOT COALESCE((
      instance.box_state IN ('ready', 'idle', 'running')
      AND instance.pi_state = 'idle'
      AND instance.last_observed_at >= v_now - interval '2 minutes'
      AND instance.material_pi_invocation_id = instance.pi_invocation_id
      AND (
        queued_turn.client_surface = 'native_mobile'
          AND instance.material_client_surface = 'native_mobile'
        OR queued_turn.client_surface IN ('web', 'mobile_web')
          AND instance.material_client_surface IN ('web', 'mobile_web')
          AND instance.material_expires_at > v_now + interval '2 hours 5 minutes'
      )
    ), false)
    AND NOT EXISTS (
      SELECT 1 FROM public.companion_operations active_start
      WHERE active_start.org_id = queued_turn.org_id
        AND active_start.companion_id = queued_turn.companion_id
        AND active_start.source_turn_id = queued_turn.id
        AND active_start.kind = 'start'
        AND active_start.status IN ('pending', 'running')
    )
  ORDER BY queued_turn.queue_sequence, queued_turn.id
  LIMIT 1
  FOR UPDATE OF instance, queued_turn;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.companion_turns
  SET cold_start_deadline_at = v_now + interval '3 minutes', updated_at = v_now
  WHERE org_id = v_org_id AND companion_id = v_companion_id AND id = v_turn_id;

  INSERT INTO public.companion_operations(
    org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
    queue_sequence, turn_queue_cutoff, runtime_generation, status, created_at, updated_at
  ) VALUES (
    v_org_id, v_companion_id, gen_random_uuid(), 'start', 'turn', v_actor_id, v_turn_id,
    0, 0,
    (SELECT generation FROM public.companion_runtime_instances
     WHERE org_id = v_org_id AND companion_id = v_companion_id),
    'pending', v_now, v_now
  )
  ON CONFLICT (companion_id, source_turn_id)
    WHERE kind = 'start' AND status IN ('pending', 'running') AND source_turn_id IS NOT NULL
  DO NOTHING;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_prepare_queued_turn_material(bigint) FROM PUBLIC;
--> statement-breakpoint

-- The release migration lands before every Runtime replica has necessarily restarted. The old
-- executor can finish a lease it already owns, but it cannot write the 0109 staged-material ledger.
-- Before a new executor takes over such work, rewind every checkpoint past the staging boundary
-- that would otherwise start or publish Pi with a ledger the old binary never recorded.
CREATE FUNCTION public.companion_runtime_repair_legacy_material_work(p_gate_epoch bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_org_id uuid;
  v_companion_id uuid;
  v_work_kind public.companion_runtime_work_kind;
  v_work_id uuid;
BEGIN
  SELECT lease.org_id, lease.companion_id, lease.work_kind, lease.work_id
  INTO v_org_id, v_companion_id, v_work_kind, v_work_id
  FROM public.companion_runtime_leases lease
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  JOIN public.companion_runtime_instances instance
    ON instance.org_id = lease.org_id AND instance.companion_id = lease.companion_id
  WHERE control.enabled
    AND control.gate_epoch = p_gate_epoch
    AND lease.work_kind IN ('operation', 'settings')
    AND lease.work_id IS NOT NULL
    AND lease.expires_at <= v_now
    AND (
      lease.work_kind = 'operation' AND EXISTS (
        SELECT 1 FROM public.companion_operations operation
        WHERE operation.org_id = lease.org_id
          AND operation.companion_id = lease.companion_id
          AND operation.id = lease.work_id
          AND operation.status = 'running'
          AND operation.material_staged_at IS NULL
          AND (
            operation.kind IN ('start', 'restart_box')
              AND operation.checkpoint IN ('starting_pi', 'pi_observed', 'pi_ready')
            OR operation.kind = 'restart_pi'
              AND operation.checkpoint IN ('restarting_pi', 'starting_pi', 'pi_observed', 'pi_ready')
            OR operation.kind = 'apply_settings' AND operation.checkpoint = 'settings_applied'
          )
      )
      OR lease.work_kind = 'settings'
        AND instance.settings_claim_epoch IS NOT NULL
        AND instance.settings_checkpoint = 'applied'
        AND instance.settings_claim_material_staged_at IS NULL
    )
  ORDER BY instance.health_due_at, lease.companion_id
  FOR UPDATE OF lease SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM 1
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = v_org_id AND instance.companion_id = v_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_work_kind = 'operation' THEN
    UPDATE public.companion_operations operation
    SET checkpoint = CASE operation.kind
          WHEN 'restart_pi' THEN 'pending'
          WHEN 'apply_settings' THEN 'applying_settings'
          ELSE 'installing_layout'
        END,
        checkpoint_sequence = operation.checkpoint_sequence + 1,
        updated_at = v_now
    WHERE operation.org_id = v_org_id
      AND operation.companion_id = v_companion_id
      AND operation.id = v_work_id
      AND operation.status = 'running'
      AND operation.material_staged_at IS NULL
      AND (
        operation.kind IN ('start', 'restart_box')
          AND operation.checkpoint IN ('starting_pi', 'pi_observed', 'pi_ready')
        OR operation.kind = 'restart_pi'
          AND operation.checkpoint IN ('restarting_pi', 'starting_pi', 'pi_observed', 'pi_ready')
        OR operation.kind = 'apply_settings' AND operation.checkpoint = 'settings_applied'
      );
  ELSE
    UPDATE public.companion_runtime_instances instance
    SET settings_checkpoint = 'applying',
        settings_checkpoint_sequence = instance.settings_checkpoint_sequence + 1,
        updated_at = v_now
    WHERE instance.org_id = v_org_id
      AND instance.companion_id = v_companion_id
      AND v_work_id = instance.companion_id
      AND instance.settings_claim_epoch IS NOT NULL
      AND instance.settings_checkpoint = 'applied'
      AND instance.settings_claim_material_staged_at IS NULL;
  END IF;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_repair_legacy_material_work(bigint) FROM PUBLIC;
--> statement-breakpoint

ALTER FUNCTION public.companion_runtime_claim_work(text, integer, integer, bigint)
  RENAME TO companion_runtime_claim_work_without_material_guard;
--> statement-breakpoint

-- Pre-0109 executors keep calling this exact signature. Quarantine them after migration so they
-- cannot repeatedly complete proof-less Starts during the rolling deploy. Already-held leases are
-- unaffected and can reach a normal checkpoint or expiry for the versioned claimer to recover.
CREATE FUNCTION public.companion_runtime_claim_work(
  p_executor_id text,
  p_limit integer,
  p_lease_seconds integer,
  p_gate_epoch bigint
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
  RETURN;
END
$$;
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
DECLARE
  v_returned integer;
BEGIN
  IF p_gate_epoch IS NULL OR p_gate_epoch < 1
     OR p_executor_id IS NULL OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
     OR p_executor_id ~ E'[\n\r]'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300
     OR p_material_protocol IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'invalid Runtime v2 claim arguments' USING ERRCODE = '22023';
  END IF;

  FOR claim_index IN 1..p_limit LOOP
    PERFORM public.companion_runtime_repair_legacy_material_work(p_gate_epoch);
    PERFORM public.companion_runtime_prepare_queued_turn_material(p_gate_epoch);
    RETURN QUERY
      SELECT guarded.*
      FROM public.companion_runtime_claim_work_without_material_guard(
        p_executor_id, 1, p_lease_seconds, p_gate_epoch
      ) guarded;
    GET DIAGNOSTICS v_returned = ROW_COUNT;
    EXIT WHEN v_returned = 0;
  END LOOP;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(text, integer, integer, bigint)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(
  text, integer, integer, bigint, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_claim_work_without_material_guard(
  text, integer, integer, bigint
) FROM PUBLIC;
--> statement-breakpoint

-- Mirror the runtime executor already trusted by the fenced material reader. The migration never
-- grants either function to API/worker roles and fails closed if the split-role ACL is ambiguous.
DO $companion_material_snapshot_acl$
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
    || 'public.companion_client_surface,timestamp with time zone) TO %I', v_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_publish_material_snapshot('
    || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text) TO %I',
    v_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_mint_hub_token('
    || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',
    v_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_claim_work('
    || 'text,integer,integer,bigint) TO %I', v_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_claim_work('
    || 'text,integer,integer,bigint,integer) TO %I', v_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION public.companion_runtime_claim_work_without_material_guard('
    || 'text,integer,integer,bigint) FROM %I', v_role
  );
END
$companion_material_snapshot_acl$;
