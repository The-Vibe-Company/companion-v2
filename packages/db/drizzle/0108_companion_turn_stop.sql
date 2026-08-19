-- Owner/Editor stop and queued-message dequeue. A follow-up send is already a durable queued
-- turn; this migration makes that waiting state visible on the transcript and lets a runner
-- cancel queued or active work. Active work that may already be on Pi is requested here and
-- aborted by the executor that holds the lease — the API still never contacts Box. Settle of
-- that stop is cancelled even for unacknowledged dispatch, so later queued turns can run.

ALTER TABLE "companion_turns"
  ADD COLUMN "cancel_requested_at" timestamp with time zone;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_cancel_turn(
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
  v_status public.companion_turn_status;
  v_dispatch public.companion_dispatch_state;
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

  SELECT source_turn.status INTO v_status
  FROM public.companion_turns source_turn
  WHERE source_turn.org_id = p_org_id
    AND source_turn.companion_id = p_companion_id
    AND source_turn.id = p_turn_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion turn not found' USING ERRCODE = '22023';
  END IF;

  IF v_status = 'cancelled' THEN
    RETURN QUERY SELECT public.companion_api_turn_json(p_org_id, p_companion_id, p_turn_id);
    RETURN;
  END IF;

  IF v_status IN ('starting', 'dispatching', 'running', 'needs_input') THEN
    SELECT attempt.dispatch_state INTO v_dispatch
    FROM public.companion_turn_attempts attempt
    WHERE attempt.org_id = p_org_id
      AND attempt.companion_id = p_companion_id
      AND attempt.turn_id = p_turn_id
    ORDER BY attempt.attempt_number DESC, attempt.id DESC
    LIMIT 1;
    -- A prompt that may already be on Pi has to be aborted by the executor that holds the lease.
    IF v_dispatch IN ('write_intent', 'accepted', 'ambiguous') THEN
      UPDATE public.companion_turns source_turn
      SET cancel_requested_at = COALESCE(source_turn.cancel_requested_at, v_now),
          updated_at = v_now
      WHERE source_turn.org_id = p_org_id
        AND source_turn.companion_id = p_companion_id
        AND source_turn.id = p_turn_id;
      RETURN QUERY SELECT public.companion_api_turn_json(p_org_id, p_companion_id, p_turn_id);
      RETURN;
    END IF;
  ELSIF v_status NOT IN ('queued', 'interrupted') THEN
    RAISE EXCEPTION 'only a queued, active, or interrupted Companion turn can be cancelled'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.companion_turn_attempts attempt
  SET status = 'cancelled',
      settled_at = COALESCE(attempt.settled_at, v_now),
      last_error_code = NULL,
      last_error_message = NULL,
      last_error_action = NULL,
      updated_at = v_now
  WHERE attempt.org_id = p_org_id
    AND attempt.companion_id = p_companion_id
    AND attempt.turn_id = p_turn_id
    AND attempt.status IN ('starting', 'dispatching', 'running', 'needs_input');

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
    AND source_turn.status IN ('queued', 'starting', 'dispatching', 'running', 'needs_input', 'interrupted');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only a queued, active, or interrupted Companion turn can be cancelled'
      USING ERRCODE = '55000';
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

CREATE OR REPLACE FUNCTION public.companion_api_read_thread(
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
AS $function$
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
        'routine', CASE
          WHEN entry.role = 'user' THEN (
            SELECT CASE
              WHEN origin.routine_name IS NULL THEN NULL
              ELSE jsonb_build_object(
                'id', origin.routine_id,
                'name', origin.routine_name
              )
            END
            FROM public.companion_turns origin
            WHERE origin.org_id = entry.org_id
              AND origin.companion_id = entry.companion_id
              AND origin.message_event_id = entry.event_id
            LIMIT 1
          )
          ELSE NULL
        END,
        'turn_id', CASE
          WHEN entry.role = 'user' THEN (
            SELECT origin.id
            FROM public.companion_turns origin
            WHERE origin.org_id = entry.org_id
              AND origin.companion_id = entry.companion_id
              AND origin.message_event_id = entry.event_id
            LIMIT 1
          )
          ELSE NULL
        END,
        'queued', COALESCE((
          SELECT origin.status = 'queued'
          FROM public.companion_turns origin
          WHERE origin.org_id = entry.org_id
            AND origin.companion_id = entry.companion_id
            AND origin.message_event_id = entry.event_id
            AND entry.role = 'user'
          LIMIT 1
        ), false),
        'attachments', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', attachment.id,
            'kind', attachment.kind,
            'content_type', attachment.content_type,
            'byte_size', attachment.byte_size,
            'filename', attachment.filename,
            'position', attachment.position
          ) ORDER BY attachment.position)
          FROM public.companion_message_attachments attachment
          WHERE attachment.org_id = entry.org_id
            AND attachment.companion_id = entry.companion_id
            AND attachment.entry_event_id = entry.event_id
        ), '[]'::jsonb),
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
        AND NOT (
          entry.role = 'user'
          AND EXISTS (
            SELECT 1
            FROM public.companion_turns origin
            WHERE origin.org_id = entry.org_id
              AND origin.companion_id = entry.companion_id
              AND origin.message_event_id = entry.event_id
              AND origin.status = 'cancelled'
              AND NOT EXISTS (
                SELECT 1
                FROM public.companion_turn_attempts attempt
                WHERE attempt.org_id = origin.org_id
                  AND attempt.companion_id = origin.companion_id
                  AND attempt.turn_id = origin.id
              )
          )
        )
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
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_renew_and_authorize(
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
  authorized boolean,
  denial_code text,
  lease_expires_at timestamp with time zone,
  authorization_actor_id text,
  decision_actor_id text,
  client_surface public.companion_client_surface,
  runtime_generation bigint,
  box_id text,
  box_state public.companion_box_observed_state,
  pi_state public.companion_pi_observed_state,
  pi_invocation_id text,
  disk_layout_version integer,
  applied_settings_revision bigint,
  applied_skills_revision integer,
  model_id text,
  persona text,
  can_write_skills boolean,
  provider_refs jsonb,
  skill_refs jsonb,
  mcp_refs jsonb,
  desired_settings_revision bigint,
  skills_revision integer,
  work_checkpoint text,
  work_checkpoint_sequence bigint,
  turn_id uuid,
  turn_status public.companion_turn_status,
  attempt_status public.companion_attempt_status,
  dispatch_state public.companion_dispatch_state,
  event_cursor bigint,
  unknown_event_count integer,
  malformed_event_count integer,
  oversized_event_count integer,
  cold_start_deadline_at timestamp with time zone,
  inactivity_deadline_at timestamp with time zone,
  absolute_deadline_at timestamp with time zone,
  operation_kind public.companion_operation_kind,
  operation_started_at timestamp with time zone,
  operation_attempt_count integer,
  provider_operation_id text,
  target_settings_revision bigint,
  target_skills_revision integer,
  decision_status public.companion_decision_status,
  decision_delivery_state public.companion_decision_delivery_state,
  decision_request_key text,
  decision_response_text text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_authorization_actor_id text;
  v_decision_actor_id text;
  v_operation_kind public.companion_operation_kind;
  v_operation_started_at timestamp with time zone;
  v_operation_attempt_count integer;
  v_operation_provider_operation_id text;
  v_decision_status public.companion_decision_status;
  v_decision_request_key text;
  v_decision_response_text text;
  v_attempt_id uuid;
  v_generation bigint;
  v_box_id text;
  v_box_state public.companion_box_observed_state;
  v_pi_state public.companion_pi_observed_state;
  v_pi_invocation_id text;
  v_disk_layout_version integer;
  v_applied_settings_revision bigint;
  v_applied_skills_revision integer;
  v_model_id text;
  v_persona text;
  v_can_write_skills boolean;
  v_provider_ids jsonb;
  v_skill_ids jsonb;
  v_mcp_ids jsonb;
  v_desired_settings_revision bigint;
  v_skills_revision integer;
  v_live_desired_settings_revision bigint;
  v_live_skills_revision integer;
  v_operation_target_settings_revision bigint;
  v_operation_target_skills_revision integer;
  v_operation_model_id text;
  v_operation_persona text;
  v_operation_can_write_skills boolean;
  v_operation_provider_ids jsonb;
  v_operation_skill_ids jsonb;
  v_operation_skill_refs jsonb;
  v_operation_mcp_ids jsonb;
  v_settings_claim_revision bigint;
  v_settings_claim_skills_revision integer;
  v_settings_model_id text;
  v_settings_persona text;
  v_settings_can_write_skills boolean;
  v_settings_provider_ids jsonb;
  v_settings_skill_ids jsonb;
  v_settings_skill_refs jsonb;
  v_settings_mcp_ids jsonb;
  v_provider_refs jsonb := '[]'::jsonb;
  v_skill_refs jsonb := '[]'::jsonb;
  v_attempt_skill_refs jsonb := '[]'::jsonb;
  v_has_pinned_resources boolean := false;
  v_mcp_refs jsonb := '[]'::jsonb;
  v_companion_owner_id text;
  v_denial_code text;
  v_requires_resources boolean := false;
  v_requires_skills_mcp boolean := false;
  v_client_surface public.companion_client_surface := 'web';
  v_actor_authorized boolean := false;
  v_responder_authorized boolean := true;
  v_work_priority integer;
  v_higher_priority_pending boolean := false;
  v_work_checkpoint text;
  v_work_checkpoint_sequence bigint;
  v_turn_id uuid;
  v_turn_status public.companion_turn_status;
  v_attempt_status public.companion_attempt_status;
  v_dispatch_state public.companion_dispatch_state;
  v_event_cursor bigint;
  v_unknown_event_count integer;
  v_malformed_event_count integer;
  v_oversized_event_count integer;
  v_cold_start_deadline_at timestamp with time zone;
  v_inactivity_deadline_at timestamp with time zone;
  v_absolute_deadline_at timestamp with time zone;
  v_decision_delivery_state public.companion_decision_delivery_state;
  v_cancel_requested_at timestamp with time zone;
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 300
     OR p_executor_id IS NULL
     OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
     OR p_executor_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Runtime v2 renewal arguments' USING ERRCODE = '22023';
  END IF;

  -- There is intentionally no diagnostic row for a stale lease. Its token/epoch learns nothing and
  -- can perform no mutation, including after expiry but before another executor takes over.
  SELECT l.expires_at INTO v_lease_expires_at
  FROM public.companion_runtime_leases l
  JOIN public.companion_runtime_control c ON c.id = 'runtime-v2'
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
  FOR UPDATE OF l;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM public.companion_runtime_instances i
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_work_kind = 'operation' THEN
    SELECT o.actor_id, o.kind, o.client_surface,
           o.checkpoint, o.checkpoint_sequence, o.source_turn_id,
           o.started_at, o.attempt_count, o.provider_operation_id,
           o.target_settings_revision, o.target_skills_revision,
           o.model_id, o.persona, o.can_write_skills,
           o.provider_ids, o.selected_skill_ids, o.skill_refs,
           o.selected_mcp_account_ids,
           t.status, t.cold_start_deadline_at,
           t.inactivity_deadline_at, t.absolute_deadline_at
    INTO v_authorization_actor_id, v_operation_kind, v_client_surface,
         v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id,
         v_operation_started_at, v_operation_attempt_count, v_operation_provider_operation_id,
         v_operation_target_settings_revision, v_operation_target_skills_revision,
         v_operation_model_id, v_operation_persona, v_operation_can_write_skills,
         v_operation_provider_ids, v_operation_skill_ids, v_operation_skill_refs,
         v_operation_mcp_ids,
         v_turn_status, v_cold_start_deadline_at,
         v_inactivity_deadline_at, v_absolute_deadline_at
    FROM public.companion_operations o
    LEFT JOIN public.companion_turns t
      ON t.org_id = o.org_id AND t.companion_id = o.companion_id AND t.id = o.source_turn_id
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch;
    IF NOT FOUND THEN RETURN; END IF;
    v_requires_resources := v_operation_kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings');
  ELSIF p_work_kind = 'attempt' THEN
    SELECT a.actor_id, t.client_surface, a.checkpoint, a.checkpoint_sequence,
           a.turn_id, t.status, a.status, a.dispatch_state, a.event_cursor,
           a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
           t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at,
           t.cancel_requested_at
    INTO v_authorization_actor_id, v_client_surface, v_work_checkpoint,
         v_work_checkpoint_sequence, v_turn_id, v_turn_status, v_attempt_status,
         v_dispatch_state, v_event_cursor,
         v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
         v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
         v_cancel_requested_at
    FROM public.companion_turn_attempts a
    JOIN public.companion_turns t
      ON t.org_id = a.org_id AND t.companion_id = a.companion_id AND t.id = a.turn_id
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.claim_epoch = p_claim_epoch
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
    IF NOT FOUND THEN RETURN; END IF;
    v_attempt_id := p_work_id;
    v_requires_resources := true;
  ELSIF p_work_kind = 'decision' THEN
    SELECT a.actor_id, d.actor_id, d.decision_status, d.request_key, d.response_text,
           t.client_surface,
           d.delivery_checkpoint, d.delivery_checkpoint_sequence, d.turn_id,
           t.status, a.status, a.dispatch_state, a.event_cursor,
           a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
           t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at,
           t.cancel_requested_at,
           d.delivery_state
    INTO v_authorization_actor_id, v_decision_actor_id, v_decision_status,
         v_decision_request_key, v_decision_response_text, v_client_surface,
         v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id,
         v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
         v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
         v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
         v_cancel_requested_at,
         v_decision_delivery_state
    FROM public.companion_decision_deliveries d
    JOIN public.companion_turn_attempts a
      ON a.org_id = d.org_id AND a.companion_id = d.companion_id
     AND a.turn_id = d.turn_id AND a.id = d.attempt_id
    JOIN public.companion_turns t
      ON t.org_id = d.org_id AND t.companion_id = d.companion_id AND t.id = d.turn_id
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
      AND d.decision_status <> 'pending'
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
    IF NOT FOUND THEN RETURN; END IF;
    SELECT d.attempt_id INTO v_attempt_id
    FROM public.companion_decision_deliveries d
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id AND d.id = p_work_id;
    v_requires_resources := true;
  ELSIF p_work_kind = 'settings' THEN
    SELECT i.settings_claim_actor_id, i.settings_claim_client_surface,
           i.settings_checkpoint, i.settings_checkpoint_sequence,
           i.settings_claim_turn_id, i.settings_claim_cold_start_deadline_at,
           i.settings_claim_revision, i.settings_claim_skills_revision,
           i.settings_claim_model_id, i.settings_claim_persona,
           i.settings_claim_can_write_skills, i.settings_claim_provider_ids,
           i.settings_claim_selected_skill_ids, i.settings_claim_skill_refs,
           i.settings_claim_selected_mcp_account_ids
    INTO v_authorization_actor_id, v_client_surface,
         v_work_checkpoint, v_work_checkpoint_sequence,
         v_turn_id, v_cold_start_deadline_at,
         v_settings_claim_revision, v_settings_claim_skills_revision,
         v_settings_model_id, v_settings_persona, v_settings_can_write_skills,
         v_settings_provider_ids, v_settings_skill_ids, v_settings_skill_refs,
         v_settings_mcp_ids
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id AND i.settings_claim_epoch = p_claim_epoch
      AND i.settings_claim_actor_id IS NOT NULL AND i.settings_claim_revision IS NOT NULL;
    IF NOT FOUND THEN RETURN; END IF;
    v_requires_resources := true;
  ELSIF p_work_kind = 'health' THEN
    IF p_work_id <> p_companion_id OR NOT EXISTS (
      SELECT 1 FROM public.companion_runtime_instances i
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
        AND i.health_claim_epoch = p_claim_epoch
    ) THEN
      RETURN;
    END IF;
    -- Health may observe identifiers already in the runtime projection. It never receives an actor,
    -- model/resource selection, credential reference, or authority to wake/decrypt.
    v_actor_authorized := true;
    v_client_surface := NULL;
    SELECT i.health_checkpoint, i.health_checkpoint_sequence
    INTO v_work_checkpoint, v_work_checkpoint_sequence
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
  ELSE
    RETURN;
  END IF;
  v_work_priority := CASE
    WHEN p_work_kind = 'operation' AND v_operation_kind = 'delete' THEN 10
    WHEN p_work_kind = 'operation' AND v_operation_kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
    WHEN p_work_kind = 'operation' AND v_operation_kind = 'start' THEN 45
    WHEN p_work_kind = 'decision' THEN 30
    WHEN p_work_kind = 'attempt' THEN 40
    WHEN p_work_kind IN ('settings', 'operation') THEN 50
    ELSE 70
  END;

  -- Precedence remains live while a lease is held. Renewal reports a higher-priority durable intent
  -- instead of extending the lease; the executor can interrupt/release at its next safe checkpoint.
  SELECT EXISTS (
    SELECT 1 FROM public.companion_operations o
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.status IN ('pending', 'running') AND o.available_at <= v_now
      AND (p_work_kind <> 'operation' OR o.id <> p_work_id)
      -- A stale lifecycle intent must not preempt authorized work after its actor loses access.
      -- Claim will terminalize that row on the next sweep; until then it is invisible to live
      -- precedence. Delete remains owner-only, matching both claim and the final renew gate.
      AND EXISTS (
        SELECT 1
        FROM public.memberships candidate_membership
        JOIN public.companions candidate_companion
          ON candidate_companion.org_id = candidate_membership.org_id
         AND candidate_companion.id = o.companion_id
        WHERE candidate_membership.org_id = o.org_id
          AND candidate_membership.user_id = o.actor_id
          AND (
            candidate_companion.owner_id = o.actor_id
            OR (
              o.kind <> 'delete'
              AND EXISTS (
                SELECT 1
                FROM public.companion_workspace_access candidate_access
                WHERE candidate_access.org_id = o.org_id
                  AND candidate_access.companion_id = o.companion_id
                  AND candidate_access.role = 'editor'
                FOR NO KEY UPDATE
              )
            )
          )
        FOR NO KEY UPDATE OF candidate_membership, candidate_companion
      )
      AND (
        o.kind <> 'apply_settings'
        OR EXISTS (
          SELECT 1 FROM public.companion_runtime_instances warm_instance
          WHERE warm_instance.org_id = o.org_id
            AND warm_instance.companion_id = o.companion_id
            AND warm_instance.box_state IN ('ready', 'idle', 'running')
        )
        OR EXISTS (
          SELECT 1 FROM public.companion_turns settings_turn
          WHERE settings_turn.org_id = o.org_id
            AND settings_turn.companion_id = o.companion_id
            AND settings_turn.status = 'queued'
        )
      )
      AND CASE
        WHEN o.kind = 'delete' THEN 10
        WHEN o.kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
        WHEN o.kind = 'start' THEN 45
        ELSE 50
      END < v_work_priority
    UNION ALL
    SELECT 1 FROM public.companion_decision_deliveries d
    WHERE v_work_priority > 30
      AND d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
      AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
      AND EXISTS (
        SELECT 1 FROM public.companion_turn_attempts decision_attempt
        WHERE decision_attempt.org_id = d.org_id
          AND decision_attempt.companion_id = d.companion_id
          AND decision_attempt.turn_id = d.turn_id
          AND decision_attempt.id = d.attempt_id
          AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
      )
    UNION ALL
    SELECT 1 FROM public.companion_turn_attempts a
    WHERE v_work_priority > 40
      AND a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
    UNION ALL
    SELECT 1 FROM public.companion_runtime_instances settings_instance
    JOIN public.companions settings_companion
      ON settings_companion.org_id = settings_instance.org_id
     AND settings_companion.id = settings_instance.companion_id
    WHERE v_work_priority > 50
      AND settings_instance.org_id = p_org_id
      AND settings_instance.companion_id = p_companion_id
      AND settings_instance.settings_actor_id IS NOT NULL
      AND settings_instance.settings_available_at <= v_now
      AND (
        settings_instance.desired_settings_revision > settings_instance.applied_settings_revision
        OR EXISTS (
          SELECT 1 FROM public.companion_turns profile_turn
          WHERE profile_turn.org_id = settings_instance.org_id
            AND profile_turn.companion_id = settings_instance.companion_id
            AND profile_turn.status = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM public.companion_turns earlier_turn
              WHERE earlier_turn.org_id = profile_turn.org_id
                AND earlier_turn.companion_id = profile_turn.companion_id
                AND earlier_turn.status = 'queued'
                AND earlier_turn.queue_sequence < profile_turn.queue_sequence
            )
            AND (
              (profile_turn.client_surface = 'native_mobile'
                AND settings_instance.applied_client_surface IS DISTINCT FROM 'native_mobile')
              OR (profile_turn.client_surface <> 'native_mobile'
                AND (settings_instance.applied_client_surface IS NULL
                  OR settings_instance.applied_client_surface = 'native_mobile'))
            )
        )
        OR (
          settings_companion.skills_revision > settings_instance.applied_skills_revision
          AND EXISTS (
            SELECT 1 FROM public.companion_turns settings_turn
            WHERE settings_turn.org_id = settings_instance.org_id
              AND settings_turn.companion_id = settings_instance.companion_id
              AND settings_turn.status = 'queued'
              AND settings_turn.client_surface <> 'native_mobile'
              AND NOT EXISTS (
                SELECT 1 FROM public.companion_turns earlier_turn
                WHERE earlier_turn.org_id = settings_turn.org_id
                  AND earlier_turn.companion_id = settings_turn.companion_id
                  AND earlier_turn.status = 'queued'
                  AND earlier_turn.queue_sequence < settings_turn.queue_sequence
              )
          )
        )
      )
      AND (
        settings_instance.box_state IN ('ready', 'idle', 'running')
        OR EXISTS (
          SELECT 1 FROM public.companion_turns settings_turn
          WHERE settings_turn.org_id = settings_instance.org_id
            AND settings_turn.companion_id = settings_instance.companion_id
            AND settings_turn.status = 'queued'
        )
      )
    UNION ALL
    SELECT 1 FROM public.companion_turns t
    JOIN public.companion_runtime_instances queue_instance
      ON queue_instance.org_id = t.org_id AND queue_instance.companion_id = t.companion_id
    JOIN public.companions queue_companion
      ON queue_companion.org_id = t.org_id AND queue_companion.id = t.companion_id
    WHERE v_work_priority > 60
      AND t.org_id = p_org_id AND t.companion_id = p_companion_id AND t.status = 'queued'
      AND queue_instance.desired_settings_revision = queue_instance.applied_settings_revision
      AND (
        (t.client_surface = 'native_mobile'
          AND queue_instance.applied_client_surface = 'native_mobile')
        OR (t.client_surface <> 'native_mobile'
          AND queue_instance.applied_client_surface IS NOT NULL
          AND queue_instance.applied_client_surface <> 'native_mobile'
          AND queue_companion.skills_revision = queue_instance.applied_skills_revision)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.companion_turns earlier_turn
        WHERE earlier_turn.org_id = t.org_id
          AND earlier_turn.companion_id = t.companion_id
          AND earlier_turn.status = 'queued'
          AND earlier_turn.queue_sequence < t.queue_sequence
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.companion_turns blocking_turn
        WHERE blocking_turn.org_id = t.org_id AND blocking_turn.companion_id = t.companion_id
          AND blocking_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
      )
  ) INTO v_higher_priority_pending;
  IF v_higher_priority_pending THEN
    v_denial_code := 'higher_priority_work_pending';
  END IF;
  v_requires_skills_mcp := v_requires_resources AND v_client_surface <> 'native_mobile';

  SELECT i.generation, i.box_id, i.box_state, i.pi_state, i.pi_invocation_id,
         i.disk_layout_version, i.applied_settings_revision, i.applied_skills_revision,
         c.model_id, c.persona, c.can_write_skills, c.provider_ids,
         c.selected_skill_ids, c.selected_mcp_account_ids,
         i.desired_settings_revision, c.skills_revision, c.owner_id
  INTO v_generation, v_box_id, v_box_state, v_pi_state, v_pi_invocation_id,
       v_disk_layout_version, v_applied_settings_revision, v_applied_skills_revision,
       v_model_id, v_persona, v_can_write_skills, v_provider_ids,
       v_skill_ids, v_mcp_ids, v_live_desired_settings_revision, v_live_skills_revision,
       v_companion_owner_id
  FROM public.companion_runtime_instances i
  JOIN public.companions c
    ON c.org_id = i.org_id AND c.id = i.companion_id
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_desired_settings_revision := v_live_desired_settings_revision;
  v_skills_revision := v_live_skills_revision;

  -- Implicit settings work must apply the latest revision before every Box interaction. If the
  -- control plane changes either revision while this lease is held, deny renewal; release (or an
  -- expired-lease takeover) invalidates the stale snapshot and the next claim captures the latest.
  IF v_denial_code IS NULL
     AND p_work_kind = 'settings'
     AND (
       v_live_desired_settings_revision IS DISTINCT FROM v_settings_claim_revision
       OR (
         v_client_surface <> 'native_mobile'
         AND v_live_skills_revision IS DISTINCT FROM v_settings_claim_skills_revision
       )
     ) THEN
    v_denial_code := 'settings_changed_since_claim';
  END IF;

  -- Active turns use the snapshot captured at promotion. Resource-bearing lifecycle operations use
  -- the snapshot captured with their durable intent. A concurrent edit therefore produces later
  -- settings work instead of changing what a takeover stages or launches midway through a claim.
  IF v_attempt_id IS NOT NULL THEN
    SELECT a.model_id, a.persona, a.can_write_skills,
           a.provider_ids, a.selected_skill_ids, a.skill_refs,
           a.selected_mcp_account_ids, a.settings_revision, a.skills_revision
    INTO v_model_id, v_persona, v_can_write_skills,
         v_provider_ids, v_skill_ids, v_attempt_skill_refs,
         v_mcp_ids, v_desired_settings_revision, v_skills_revision
    FROM public.companion_turn_attempts a
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id AND a.id = v_attempt_id;
    IF NOT FOUND THEN RETURN; END IF;
    v_has_pinned_resources := true;
  ELSIF p_work_kind = 'operation' AND v_requires_resources THEN
    v_model_id := v_operation_model_id;
    v_persona := v_operation_persona;
    v_can_write_skills := v_operation_can_write_skills;
    v_provider_ids := v_operation_provider_ids;
    v_skill_ids := v_operation_skill_ids;
    v_attempt_skill_refs := v_operation_skill_refs;
    v_mcp_ids := v_operation_mcp_ids;
    v_desired_settings_revision := v_operation_target_settings_revision;
    v_skills_revision := v_operation_target_skills_revision;
    v_has_pinned_resources := true;
  ELSIF p_work_kind = 'settings' THEN
    v_model_id := v_settings_model_id;
    v_persona := v_settings_persona;
    v_can_write_skills := v_settings_can_write_skills;
    v_provider_ids := v_settings_provider_ids;
    v_skill_ids := v_settings_skill_ids;
    v_attempt_skill_refs := v_settings_skill_refs;
    v_mcp_ids := v_settings_mcp_ids;
    v_desired_settings_revision := v_settings_claim_revision;
    v_skills_revision := v_settings_claim_skills_revision;
    v_has_pinned_resources := true;
  END IF;

  IF v_client_surface = 'native_mobile' THEN
    v_can_write_skills := false;
  END IF;

  IF v_denial_code IS NULL AND p_work_kind <> 'health' THEN
    -- These locks are part of the authorization result. They conflict with membership removal,
    -- ownership/share changes, and are held through the final lease CAS/transaction commit, so a
    -- concurrent revocation cannot slip between the decision and authorized=true.
    v_actor_authorized := false;
    SELECT c.owner_id
    INTO v_companion_owner_id
    FROM public.memberships m
    JOIN public.companions c ON c.org_id = m.org_id AND c.id = p_companion_id
    WHERE m.org_id = p_org_id AND m.user_id = v_authorization_actor_id
    FOR NO KEY UPDATE OF m, c;
    IF FOUND AND v_companion_owner_id = v_authorization_actor_id THEN
      v_actor_authorized := true;
    ELSIF FOUND AND v_operation_kind IS DISTINCT FROM 'delete' THEN
      PERFORM 1
      FROM public.companion_workspace_access a
      WHERE a.org_id = p_org_id
        AND a.companion_id = p_companion_id
        AND a.role = 'editor'
      FOR NO KEY UPDATE;
      v_actor_authorized := FOUND;
    END IF;

    IF NOT v_actor_authorized THEN
      v_denial_code := 'actor_access_revoked';
    END IF;

    IF v_denial_code IS NULL AND p_work_kind = 'decision' AND v_decision_actor_id IS NOT NULL THEN
      v_responder_authorized := false;
      PERFORM 1
      FROM public.memberships responder_membership
      WHERE responder_membership.org_id = p_org_id
        AND responder_membership.user_id = v_decision_actor_id
      FOR NO KEY UPDATE;
      IF FOUND AND v_companion_owner_id = v_decision_actor_id THEN
        v_responder_authorized := true;
      ELSIF FOUND THEN
        PERFORM 1
        FROM public.companion_workspace_access responder_access
        WHERE responder_access.org_id = p_org_id
          AND responder_access.companion_id = p_companion_id
          AND responder_access.role = 'editor'
        FOR NO KEY UPDATE;
        v_responder_authorized := FOUND;
      END IF;
      IF NOT v_responder_authorized THEN
        v_denial_code := 'decision_actor_access_revoked';
      END IF;
    ELSIF v_denial_code IS NULL AND p_work_kind = 'decision'
          AND v_decision_actor_id IS NULL AND v_decision_status <> 'expired' THEN
      v_denial_code := 'decision_actor_missing';
    END IF;
  END IF;

  IF v_denial_code IS NULL AND v_requires_resources THEN
    IF jsonb_typeof(v_provider_ids) <> 'array'
       OR (v_requires_skills_mcp AND jsonb_typeof(v_skill_ids) <> 'array')
       OR (v_requires_skills_mcp AND v_has_pinned_resources
           AND jsonb_typeof(v_attempt_skill_refs) <> 'array')
       OR (v_requires_skills_mcp AND jsonb_typeof(v_mcp_ids) <> 'array') THEN
      v_denial_code := 'invalid_resource_selection';
    ELSIF jsonb_array_length(v_provider_ids) <> 1
       OR v_model_id IS NULL
       OR char_length(v_model_id) NOT BETWEEN 1 AND 200
       OR v_model_id ~ E'[\n\r]' THEN
      v_denial_code := 'invalid_model_selection';
    ELSIF EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_provider_ids) selected(provider_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.companion_provider_connections p
        WHERE p.org_id = p_org_id AND p.provider_id = selected.provider_id
        FOR NO KEY UPDATE
      )
    ) THEN
      v_denial_code := 'provider_access_revoked';
    ELSIF v_requires_skills_mcp AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.skills s
        WHERE s.org_id = p_org_id
          AND s.id::text = selected.skill_id
          AND s.archived_at IS NULL
          AND (
            s.scope = 'org'
            OR (
              s.creator_id = v_authorization_actor_id
              AND (v_decision_actor_id IS NULL OR s.creator_id = v_decision_actor_id)
            )
          )
        FOR NO KEY UPDATE
      )
    ) THEN
      v_denial_code := 'skill_access_revoked';
    ELSIF v_requires_skills_mcp AND v_has_pinned_resources AND (
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_attempt_skill_refs) pinned(ref)
        WHERE jsonb_typeof(pinned.ref) <> 'object'
           OR COALESCE(jsonb_typeof(pinned.ref -> 'skill_id'), 'missing') <> 'string'
           OR COALESCE(jsonb_typeof(pinned.ref -> 'current_version_id'), 'missing')
                NOT IN ('string', 'null')
           OR NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
             WHERE selected.skill_id = pinned.ref ->> 'skill_id'
           )
           OR (
             pinned.ref ->> 'current_version_id' IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM public.skill_versions pinned_version
               WHERE pinned_version.org_id = p_org_id
                 AND pinned_version.skill_id::text = pinned.ref ->> 'skill_id'
                 AND pinned_version.id::text = pinned.ref ->> 'current_version_id'
               FOR KEY SHARE
             )
           )
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_attempt_skill_refs) pinned(ref)
          WHERE pinned.ref ->> 'skill_id' = selected.skill_id
        )
      )
    ) THEN
      v_denial_code := 'invalid_resource_selection';
    ELSIF v_requires_skills_mcp AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_mcp_ids) selected(account_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.companion_mcp_accounts a
        WHERE a.org_id = p_org_id
          AND a.id::text = selected.account_id
          AND a.owner_id = v_authorization_actor_id
          AND (v_decision_actor_id IS NULL OR a.owner_id = v_decision_actor_id)
        FOR NO KEY UPDATE
      )
    ) THEN
      v_denial_code := 'mcp_access_revoked';
    END IF;
  END IF;

  -- Re-sample after authorization/resource reads: those reads can wait behind concurrent ACL or
  -- configuration writes. Deadlines are authority boundaries, not informational timestamps.
  v_now := clock_timestamp();
  IF p_work_kind IN ('attempt', 'decision')
     AND v_absolute_deadline_at IS NOT NULL
     AND v_now >= v_absolute_deadline_at THEN
    v_denial_code := 'absolute_deadline_exceeded';
  ELSIF p_work_kind IN ('attempt', 'decision')
        AND v_inactivity_deadline_at IS NOT NULL
        AND v_now >= v_inactivity_deadline_at THEN
    v_denial_code := 'inactivity_deadline_exceeded';
  -- The three-minute cold-send budget follows the source turn across Start settlement and the
  -- attempt boundary. Once Pi has acknowledged the prompt, normal attempt deadlines take over.
  ELSIF v_cold_start_deadline_at IS NOT NULL
        AND v_now >= v_cold_start_deadline_at
        AND (
          (p_work_kind = 'operation' AND v_operation_kind IN ('start', 'apply_settings'))
          OR p_work_kind = 'settings'
          OR (p_work_kind = 'attempt' AND v_dispatch_state <> 'accepted')
        ) THEN
    v_denial_code := 'cold_start_deadline_exceeded';
  END IF;

  -- An Owner/Editor stop wins over higher-priority work and deadline denials. The executor must
  -- still see Box identity so it can abort Pi before settling; other denials keep that identity
  -- null.
  IF p_work_kind IN ('attempt', 'decision') AND v_cancel_requested_at IS NOT NULL THEN
    v_denial_code := 'turn_cancel_requested';
  END IF;

  IF v_denial_code IS NOT NULL THEN
    IF v_denial_code = 'turn_cancel_requested' THEN
      RETURN QUERY SELECT
        false, v_denial_code, v_lease_expires_at,
        v_authorization_actor_id, NULL::text, v_client_surface, v_generation, v_box_id,
        v_box_state, v_pi_state, v_pi_invocation_id, v_disk_layout_version,
        v_applied_settings_revision, v_applied_skills_revision, NULL::text,
        NULL::text, NULL::boolean,
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL::bigint, NULL::integer,
        v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id, v_turn_status,
        v_attempt_status, v_dispatch_state, v_event_cursor,
        v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
        v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
        v_operation_kind, v_operation_started_at, v_operation_attempt_count,
        v_operation_provider_operation_id,
        v_operation_target_settings_revision, v_operation_target_skills_revision,
        v_decision_status, v_decision_delivery_state,
        NULL::text, NULL::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT
      false, v_denial_code, v_lease_expires_at,
      NULL::text, NULL::text, v_client_surface, NULL::bigint, NULL::text,
      NULL::public.companion_box_observed_state,
      NULL::public.companion_pi_observed_state,
      NULL::text, NULL::integer, NULL::bigint, NULL::integer, NULL::text,
      NULL::text, NULL::boolean,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL::bigint, NULL::integer,
      v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id, v_turn_status,
      v_attempt_status, v_dispatch_state, v_event_cursor,
      v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
      v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
      v_operation_kind, v_operation_started_at, v_operation_attempt_count,
      v_operation_provider_operation_id,
      v_operation_target_settings_revision, v_operation_target_skills_revision,
      v_decision_status, v_decision_delivery_state,
      NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_requires_resources THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'provider_id', p.provider_id,
      'credential_generation', p.credential_generation,
      'credential_version', p.credential_version
    ) ORDER BY p.provider_id), '[]'::jsonb)
    INTO v_provider_refs
    FROM public.companion_provider_connections p
    WHERE p.org_id = p_org_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(v_provider_ids) selected(provider_id)
        WHERE selected.provider_id = p.provider_id
      );

    IF v_requires_skills_mcp THEN
      IF v_has_pinned_resources THEN
        v_skill_refs := v_attempt_skill_refs;
      ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'skill_id', s.id,
          'current_version_id', s.current_version_id
        ) ORDER BY s.id), '[]'::jsonb)
        INTO v_skill_refs
        FROM public.skills s
        WHERE s.org_id = p_org_id
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
            WHERE selected.skill_id = s.id::text
          );
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'account_id', a.id,
        'credential_generation', a.credential_generation
      ) ORDER BY a.id), '[]'::jsonb)
      INTO v_mcp_refs
      FROM public.companion_mcp_accounts a
      WHERE a.org_id = p_org_id
        AND a.owner_id = v_authorization_actor_id
        AND (v_decision_actor_id IS NULL OR a.owner_id = v_decision_actor_id)
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(v_mcp_ids) selected(account_id)
          WHERE selected.account_id = a.id::text
        );
    END IF;
  END IF;

  -- Authorization may have waited on instance or ACL row locks. Re-sample wall time at the final
  -- fence so a call that began before expiry can never return authority after expiry or publish an
  -- already-dead renewal. Holding the lease-row lock prevents takeover between this CAS and return.
  v_now := clock_timestamp();
  UPDATE public.companion_runtime_leases l
  SET renewed_at = v_now,
      expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND NOT (
      p_work_kind IN ('attempt', 'decision')
      AND (
        (v_absolute_deadline_at IS NOT NULL AND v_now >= v_absolute_deadline_at)
        OR (v_inactivity_deadline_at IS NOT NULL AND v_now >= v_inactivity_deadline_at)
      )
    )
    AND NOT (
      v_cold_start_deadline_at IS NOT NULL
      AND v_now >= v_cold_start_deadline_at
      AND (
        (p_work_kind = 'operation' AND v_operation_kind IN ('start', 'apply_settings'))
        OR p_work_kind = 'settings'
        OR (p_work_kind = 'attempt' AND v_dispatch_state <> 'accepted')
      )
    )
    AND EXISTS (
      SELECT 1
      FROM public.companion_runtime_control current_gate
      WHERE current_gate.id = 'runtime-v2'
        AND current_gate.enabled
        AND current_gate.gate_epoch = p_gate_epoch
    )
  RETURNING l.expires_at INTO v_lease_expires_at;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT
    true, NULL::text, v_lease_expires_at,
    v_authorization_actor_id, v_decision_actor_id, v_client_surface,
    v_generation, v_box_id,
    v_box_state, v_pi_state, v_pi_invocation_id, v_disk_layout_version,
    v_applied_settings_revision, v_applied_skills_revision,
    CASE WHEN v_requires_resources THEN v_model_id ELSE NULL END,
    CASE WHEN v_requires_resources THEN v_persona ELSE NULL END,
    CASE WHEN v_requires_resources THEN v_can_write_skills ELSE NULL END,
    v_provider_refs, v_skill_refs, v_mcp_refs,
    v_desired_settings_revision, v_skills_revision,
    v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id, v_turn_status,
    v_attempt_status, v_dispatch_state, v_event_cursor,
    v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
    v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
    v_operation_kind, v_operation_started_at, v_operation_attempt_count,
    v_operation_provider_operation_id,
    v_operation_target_settings_revision, v_operation_target_skills_revision,
    v_decision_status, v_decision_delivery_state,
    v_decision_request_key, v_decision_response_text;
END
$$;
--> statement-breakpoint

-- Owner/Editor stop must settle cancelled even when dispatch is unacknowledged or a permission
-- answer is in flight. Interrupted would block the remaining queue until a second Cancel.
CREATE OR REPLACE FUNCTION public.companion_runtime_settle(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_terminal_status text,
  p_error_code text,
  p_error_message text,
  p_error_action public.companion_runtime_error_action
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_turn_id uuid;
  v_operation_kind public.companion_operation_kind;
  v_operation_actor_id text;
  v_operation_checkpoint text;
  v_target_settings_revision bigint;
  v_target_skills_revision integer;
  v_operation_box_id text;
  v_operation_box_state public.companion_box_observed_state;
  v_operation_pi_state public.companion_pi_observed_state;
  v_operation_pi_invocation_id text;
  v_operation_disk_layout_version integer;
  v_operation_applied_settings_revision bigint;
  v_operation_applied_skills_revision integer;
  v_operation_applied_client_surface public.companion_client_surface;
  v_client_surface public.companion_client_surface := 'web';
  v_cold_start_deadline timestamp with time zone;
  v_inactivity_deadline timestamp with time zone;
  v_absolute_deadline timestamp with time zone;
  v_live_desired_settings_revision bigint;
  v_live_skills_revision integer;
  v_settings_claim_revision bigint;
  v_settings_claim_skills_revision integer;
  v_settings_checkpoint text;
  v_dispatch_state public.companion_dispatch_state;
  v_attempt_checkpoint text;
  v_attempt_pi_invocation_id text;
  v_decision_delivery_state public.companion_decision_delivery_state;
  v_decision_attempt_id uuid;
  v_decision_command_id uuid;
  v_previous_runtime_protocol text;
  v_cancel_requested_at timestamp with time zone;
  v_success boolean := false;
BEGIN
  IF p_terminal_status NOT IN ('succeeded', 'failed', 'interrupted', 'cancelled')
     OR ((p_error_code IS NULL) <> (p_error_message IS NULL))
     OR ((p_error_code IS NULL) <> (p_error_action IS NULL))
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_]{0,63}$')
     OR (p_error_message IS NOT NULL AND (
       char_length(p_error_message) > 500 OR p_error_message ~ E'[\n\r]'
     ))
     OR (p_terminal_status IN ('failed', 'interrupted') AND p_error_code IS NULL)
     OR (p_terminal_status IN ('succeeded', 'cancelled') AND p_error_code IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid Runtime v2 settlement' USING ERRCODE = '22023';
  END IF;

  SELECT l.expires_at INTO v_lease_expires_at
  FROM public.companion_runtime_leases l
  JOIN public.companion_runtime_control c ON c.id = 'runtime-v2'
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
  FOR UPDATE OF l;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM 1
  FROM public.companion_runtime_instances i
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_now := clock_timestamp();
  IF v_lease_expires_at <= v_now THEN RETURN false; END IF;

  IF p_work_kind = 'operation' THEN
    SELECT o.kind, o.actor_id, o.checkpoint, o.target_settings_revision, o.target_skills_revision,
           o.source_turn_id, o.client_surface,
           i.box_id, i.box_state, i.pi_state, i.pi_invocation_id,
           i.disk_layout_version, i.applied_settings_revision, i.applied_skills_revision,
           i.applied_client_surface
    INTO v_operation_kind, v_operation_actor_id, v_operation_checkpoint,
         v_target_settings_revision, v_target_skills_revision,
         v_turn_id, v_client_surface,
         v_operation_box_id, v_operation_box_state, v_operation_pi_state,
         v_operation_pi_invocation_id, v_operation_disk_layout_version,
         v_operation_applied_settings_revision, v_operation_applied_skills_revision,
         v_operation_applied_client_surface
    FROM public.companion_operations o
    JOIN public.companion_runtime_instances i
      ON i.org_id = o.org_id AND i.companion_id = o.companion_id
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch
    FOR UPDATE OF o;
    IF NOT FOUND THEN RETURN false; END IF;

    IF v_turn_id IS NOT NULL THEN
      SELECT t.cold_start_deadline_at
      INTO v_cold_start_deadline
      FROM public.companion_turns t
      WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id AND t.id = v_turn_id
      FOR UPDATE;
      IF NOT FOUND THEN RETURN false; END IF;
    END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND v_operation_kind IN ('start', 'apply_settings')
         AND v_cold_start_deadline IS NOT NULL
         AND v_now >= v_cold_start_deadline
       ) THEN
      RETURN false;
    END IF;

    IF p_terminal_status = 'succeeded' AND NOT (
      (v_operation_kind IN ('start', 'restart_pi', 'restart_box') AND v_operation_checkpoint = 'pi_ready')
      OR (v_operation_kind = 'stop' AND v_operation_checkpoint = 'box_archived')
      OR (v_operation_kind = 'apply_settings' AND v_operation_checkpoint = 'settings_applied')
      OR (v_operation_kind = 'delete' AND v_operation_checkpoint IN ('provider_deleted', 'box_absent'))
    ) THEN
      RAISE EXCEPTION 'operation lacks terminal checkpoint proof' USING ERRCODE = '22023';
    END IF;

    IF p_terminal_status = 'succeeded'
       AND v_operation_kind IN ('start', 'restart_pi', 'restart_box')
       AND (
         v_operation_box_id IS NULL
         OR v_operation_box_state NOT IN ('ready', 'idle', 'running')
         OR v_operation_pi_state <> 'idle'
         OR v_operation_pi_invocation_id IS NULL
         OR v_operation_disk_layout_version IS DISTINCT FROM 14
         OR (
           v_operation_kind IN ('start', 'restart_box')
           AND (
             v_target_settings_revision IS NULL
             OR v_target_skills_revision IS NULL
             OR v_operation_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
             OR CASE
               WHEN v_operation_kind IN ('start', 'restart_box')
                    AND v_client_surface = 'native_mobile' THEN
                 v_operation_applied_client_surface IS DISTINCT FROM 'native_mobile'
               ELSE
                 v_operation_applied_skills_revision IS DISTINCT FROM v_target_skills_revision
                 OR v_operation_applied_client_surface IS NULL
                 OR v_operation_applied_client_surface = 'native_mobile'
             END
           )
         )
       ) THEN
      RAISE EXCEPTION 'operation lacks terminal Box/Pi/layout observation proof'
        USING ERRCODE = '22023';
    END IF;

    IF p_terminal_status = 'succeeded'
       AND v_operation_kind = 'stop'
       AND v_operation_box_state <> 'archived' THEN
      RAISE EXCEPTION 'stop lacks archived Box observation proof' USING ERRCODE = '22023';
    END IF;

    IF p_terminal_status = 'succeeded'
       AND v_operation_kind = 'delete'
       AND v_operation_box_state <> 'absent' THEN
      RAISE EXCEPTION 'delete lacks absent Box observation proof' USING ERRCODE = '22023';
    END IF;

    IF v_operation_kind = 'apply_settings' AND p_terminal_status = 'succeeded' THEN
      IF v_target_settings_revision IS NULL OR v_target_skills_revision IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.companion_runtime_instances i
        JOIN public.companions c
          ON c.org_id = i.org_id AND c.id = i.companion_id
        WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
          AND v_target_settings_revision <= i.desired_settings_revision
          AND v_target_skills_revision <= c.skills_revision
          AND i.applied_settings_revision >= v_target_settings_revision
          AND CASE WHEN v_client_surface = 'native_mobile'
            THEN i.applied_client_surface = 'native_mobile'
            ELSE i.applied_skills_revision >= v_target_skills_revision
              AND i.applied_client_surface IS NOT NULL
              AND i.applied_client_surface <> 'native_mobile'
          END
      ) THEN
        RAISE EXCEPTION 'settings operation target revisions are invalid' USING ERRCODE = '22023';
      END IF;
      UPDATE public.companion_runtime_instances i
      SET applied_settings_revision = GREATEST(i.applied_settings_revision, v_target_settings_revision),
          applied_skills_revision = CASE WHEN v_client_surface = 'native_mobile'
            THEN i.applied_skills_revision
            ELSE GREATEST(i.applied_skills_revision, v_target_skills_revision)
          END,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
    END IF;

    UPDATE public.companion_operations o
    SET status = p_terminal_status::public.companion_operation_status,
        checkpoint_sequence = o.checkpoint_sequence + 1,
        settled_at = v_now,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch;
    v_success := FOUND;

    IF v_success
       AND v_operation_kind IN ('start', 'apply_settings')
       AND v_turn_id IS NOT NULL
       AND p_terminal_status <> 'succeeded' THEN
      UPDATE public.companion_turns t
      SET status = CASE
            WHEN p_error_code = 'cold_start_deadline_exceeded'
              THEN 'interrupted'::public.companion_turn_status
            ELSE p_terminal_status::public.companion_turn_status
          END,
          inactivity_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE t.inactivity_deadline_at
          END,
          absolute_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE COALESCE(t.absolute_deadline_at, v_now)
          END,
          state_changed_at = v_now,
          settled_at = v_now,
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
        AND t.id = v_turn_id
        AND t.status IN ('queued', 'starting', 'dispatching', 'running', 'needs_input');
    END IF;

    IF v_success AND v_operation_kind = 'delete' AND p_terminal_status = 'succeeded' THEN
      -- Provider proof is the irreversible cutover point. Preserve a minimal, sanitized audit row,
      -- then delete the aggregate root so legacy thread/transcript state and every Runtime v2 row
      -- disappear atomically. Provider connections, member MCP accounts, Skills, and their secrets
      -- are workspace resources and intentionally do not cascade from the Companion.
      INSERT INTO public.audit_log (
        org_id, actor_id, action, target_type, target_id, metadata
      ) VALUES (
        p_org_id,
        CASE WHEN EXISTS (
          SELECT 1 FROM public."user" u WHERE u.id = v_operation_actor_id
        ) THEN v_operation_actor_id ELSE NULL END,
        'companion.deleted',
        'companion',
        p_companion_id::text,
        jsonb_build_object(
          'operation_id', p_work_id::text,
          'provider_checkpoint', v_operation_checkpoint
        )
      );

      -- The legacy mutation fence is diagnostic rather than an authorization boundary. Pin it only
      -- around this SECURITY DEFINER-owned aggregate delete, avoiding CREATE FUNCTION SET clauses
      -- that require deployment-specific custom-parameter privileges from the migration owner.
      UPDATE public.companion_runtime_instances i
      SET settings_claim_turn_id = NULL,
          settings_claim_cold_start_deadline_at = NULL,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
      UPDATE public.companion_operations o
      SET source_turn_id = NULL, updated_at = v_now
      WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
        AND o.source_turn_id IS NOT NULL;

      v_previous_runtime_protocol := pg_catalog.current_setting(
        'app.companion_runtime_protocol', true
      );
      PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
      DELETE FROM public.companions c
      WHERE c.org_id = p_org_id AND c.id = p_companion_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'delete settlement lost Companion aggregate root' USING ERRCODE = '40001';
      END IF;
      PERFORM pg_catalog.set_config(
        'app.companion_runtime_protocol', COALESCE(v_previous_runtime_protocol, ''), true
      );
      RETURN true;
    END IF;

  ELSIF p_work_kind = 'attempt' THEN
    SELECT a.turn_id, a.dispatch_state, a.checkpoint, a.pi_invocation_id,
           t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at,
           t.cancel_requested_at
    INTO v_turn_id, v_dispatch_state, v_attempt_checkpoint, v_attempt_pi_invocation_id,
         v_cold_start_deadline, v_inactivity_deadline, v_absolute_deadline,
         v_cancel_requested_at
    FROM public.companion_turn_attempts a
    JOIN public.companion_turns t
      ON t.org_id = a.org_id AND t.companion_id = a.companion_id AND t.id = a.turn_id
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.claim_epoch = p_claim_epoch
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
    FOR UPDATE OF a, t;
    IF NOT FOUND THEN RETURN false; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND (
           (v_absolute_deadline IS NOT NULL AND v_now >= v_absolute_deadline)
           OR (v_inactivity_deadline IS NOT NULL AND v_now >= v_inactivity_deadline)
         )
       ) THEN
      RETURN false;
    END IF;
    IF v_dispatch_state = 'ambiguous' AND p_terminal_status <> 'interrupted'
       AND NOT (p_terminal_status = 'cancelled' AND v_cancel_requested_at IS NOT NULL) THEN
      RAISE EXCEPTION 'an ambiguous attempt may only settle interrupted' USING ERRCODE = '22023';
    END IF;
    IF v_dispatch_state = 'write_intent' AND p_terminal_status <> 'interrupted'
       AND NOT (p_terminal_status = 'cancelled' AND v_cancel_requested_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a dispatch write intent without ACK may only settle interrupted'
        USING ERRCODE = '22023';
    END IF;
    IF v_dispatch_state = 'rejected' AND p_terminal_status NOT IN ('failed', 'interrupted') THEN
      RAISE EXCEPTION 'a rejected dispatch must settle failed or interrupted' USING ERRCODE = '22023';
    END IF;
    IF p_terminal_status = 'succeeded'
       AND (
         v_dispatch_state <> 'accepted'
         OR v_attempt_checkpoint <> 'agent_settled'
         OR v_attempt_pi_invocation_id IS NULL
       ) THEN
      RAISE EXCEPTION 'attempt lacks accepted dispatch, Pi invocation, and agent settlement proof'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.companion_turn_attempts a
    SET status = p_terminal_status::public.companion_attempt_status,
        checkpoint_sequence = a.checkpoint_sequence + 1,
        settled_at = v_now,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.claim_epoch = p_claim_epoch
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
    IF NOT FOUND THEN RETURN false; END IF;

    PERFORM public.companion_runtime_close_attempt_decisions(
      p_org_id, p_companion_id, p_work_id,
      p_error_code, p_error_message, p_error_action, NULL
    );

    UPDATE public.companion_turns t
    SET status = p_terminal_status::public.companion_turn_status,
        state_changed_at = v_now,
        settled_at = v_now,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
      AND t.id = v_turn_id AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');
    v_success := FOUND;

  ELSIF p_work_kind = 'decision' THEN
    SELECT d.turn_id, d.attempt_id, d.delivery_state, d.command_id,
           t.inactivity_deadline_at, t.absolute_deadline_at, t.cancel_requested_at
    INTO v_turn_id, v_decision_attempt_id, v_decision_delivery_state, v_decision_command_id,
         v_inactivity_deadline, v_absolute_deadline, v_cancel_requested_at
    FROM public.companion_decision_deliveries d
    JOIN public.companion_turns t
      ON t.org_id = d.org_id AND t.companion_id = d.companion_id AND t.id = d.turn_id
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
      AND d.decision_status <> 'pending'
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
    FOR UPDATE OF d, t;
    IF NOT FOUND THEN RETURN false; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND (
           (v_absolute_deadline IS NOT NULL AND v_now >= v_absolute_deadline)
           OR (v_inactivity_deadline IS NOT NULL AND v_now >= v_inactivity_deadline)
         )
       ) THEN
      RETURN false;
    END IF;

    IF p_terminal_status = 'succeeded' THEN
      IF v_decision_delivery_state <> 'write_intent' OR v_decision_command_id IS NULL THEN
        RAISE EXCEPTION 'decision success requires an unambiguous durable write intent'
          USING ERRCODE = '22023';
      END IF;
      UPDATE public.companion_decision_deliveries d
      SET delivery_state = 'delivered',
          delivery_checkpoint = 'delivered',
          delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
          delivered_at = v_now,
          last_error_code = NULL,
          last_error_message = NULL,
          last_error_action = NULL,
          updated_at = v_now
      WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
        AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
        AND d.decision_status <> 'pending'
        AND d.delivery_state = 'write_intent'
        AND d.command_id IS NOT NULL;
      v_success := FOUND;
    ELSE
      IF p_terminal_status = 'cancelled' THEN
        -- Owner/Editor stop is a real cancel, not a delivery protocol error. It must release the
        -- queue rather than leave the parent interrupted.
        IF v_cancel_requested_at IS NULL THEN
          RAISE EXCEPTION 'decision delivery cancellation must be explicit failure or interruption'
            USING ERRCODE = '22023';
        END IF;
        UPDATE public.companion_decision_deliveries d
        SET delivery_state = 'cancelled',
            delivery_checkpoint = 'cancelled',
            delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
            last_error_code = NULL,
            last_error_message = NULL,
            last_error_action = NULL,
            updated_at = v_now
        WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
          AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
          AND d.decision_status <> 'pending'
          AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous');
        v_success := FOUND;
        IF NOT v_success THEN RETURN false; END IF;
        PERFORM public.companion_runtime_close_attempt_decisions(
          p_org_id, p_companion_id, v_decision_attempt_id,
          NULL, NULL, NULL, p_work_id
        );
        UPDATE public.companion_turn_attempts a
        SET status = 'cancelled', settled_at = v_now,
            last_error_code = NULL,
            last_error_message = NULL,
            last_error_action = NULL,
            updated_at = v_now
        WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
          AND a.id = v_decision_attempt_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
        UPDATE public.companion_turns t
        SET status = 'cancelled', settled_at = v_now, state_changed_at = v_now,
            last_error_code = NULL,
            last_error_message = NULL,
            last_error_action = NULL,
            updated_at = v_now
        WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
          AND t.id = v_turn_id
          AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');
      ELSE
      UPDATE public.companion_decision_deliveries d
      SET delivery_state = CASE
            WHEN d.command_id IS NULL AND p_terminal_status = 'interrupted'
              THEN 'cancelled'::public.companion_decision_delivery_state
            WHEN d.command_id IS NULL THEN 'pending'::public.companion_decision_delivery_state
            ELSE 'ambiguous'::public.companion_decision_delivery_state
          END,
          delivery_checkpoint = CASE
            WHEN d.command_id IS NULL AND p_terminal_status = 'interrupted' THEN 'cancelled'
            WHEN d.command_id IS NULL THEN 'pending'
            ELSE 'ambiguous'
          END,
          delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
        AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
        AND d.decision_status <> 'pending'
        AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous');
      v_success := FOUND;

      -- Do not mutate the parent after a failed delivery CAS. FOUND would otherwise be replaced by
      -- the later UPDATEs and settlement could report success after changing only the parent.
      IF NOT v_success THEN RETURN false; END IF;

      -- A pre-write failure remains retryable, but an explicit interruption is terminal even when
      -- authorization vanished before the write. Once a command id exists, the response may have
      -- reached Pi. Both paths close the parent visibly instead of reclaiming this decision forever.
      IF v_decision_command_id IS NOT NULL OR p_terminal_status = 'interrupted' THEN
        PERFORM public.companion_runtime_close_attempt_decisions(
          p_org_id, p_companion_id, v_decision_attempt_id,
          p_error_code, p_error_message, p_error_action, p_work_id
        );
        UPDATE public.companion_turn_attempts a
        SET status = 'interrupted', settled_at = v_now,
            last_error_code = p_error_code,
            last_error_message = p_error_message,
            last_error_action = p_error_action,
            updated_at = v_now
        WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
          AND a.id = v_decision_attempt_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
        UPDATE public.companion_turns t
        SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
            last_error_code = p_error_code,
            last_error_message = p_error_message,
            last_error_action = p_error_action,
            updated_at = v_now
        WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
          AND t.id = v_turn_id
          AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');
      END IF;
      END IF;
    END IF;
  ELSIF p_work_kind = 'settings' THEN
    SELECT i.settings_claim_revision, i.settings_claim_skills_revision,
           i.settings_claim_client_surface, i.settings_checkpoint,
           i.settings_claim_turn_id, i.settings_claim_cold_start_deadline_at,
           i.desired_settings_revision, c.skills_revision
    INTO v_settings_claim_revision, v_settings_claim_skills_revision,
         v_client_surface, v_settings_checkpoint,
         v_turn_id, v_cold_start_deadline,
         v_live_desired_settings_revision, v_live_skills_revision
    FROM public.companion_runtime_instances i
    JOIN public.companions c
      ON c.org_id = i.org_id AND c.id = i.companion_id
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id AND i.settings_claim_epoch = p_claim_epoch
    FOR UPDATE OF i, c;
    IF NOT FOUND THEN RETURN false; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND v_cold_start_deadline IS NOT NULL
         AND v_now >= v_cold_start_deadline
       ) THEN
      RETURN false;
    END IF;

    IF p_terminal_status = 'succeeded' THEN
      IF v_settings_checkpoint <> 'applied'
         OR v_settings_claim_revision IS DISTINCT FROM v_live_desired_settings_revision
         OR (
           v_client_surface <> 'native_mobile'
           AND v_settings_claim_skills_revision IS DISTINCT FROM v_live_skills_revision
         ) THEN
        RETURN false;
      END IF;
      UPDATE public.companion_runtime_instances i
      SET applied_settings_revision = GREATEST(i.applied_settings_revision, v_settings_claim_revision),
          applied_skills_revision = GREATEST(i.applied_skills_revision, v_settings_claim_skills_revision),
          applied_client_surface = v_client_surface,
          settings_checkpoint = 'applied',
          settings_checkpoint_sequence = i.settings_checkpoint_sequence + 1,
          settings_claim_epoch = NULL,
          settings_claim_actor_id = NULL,
          settings_claim_client_surface = NULL,
          settings_claim_turn_id = NULL,
          settings_claim_cold_start_deadline_at = NULL,
          settings_claim_revision = NULL,
          settings_claim_skills_revision = NULL,
          settings_claim_model_id = NULL,
          settings_claim_persona = NULL,
          settings_claim_can_write_skills = NULL,
          settings_claim_provider_ids = NULL,
          settings_claim_selected_skill_ids = NULL,
          settings_claim_skill_refs = NULL,
          settings_claim_selected_mcp_account_ids = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          last_error_action = NULL,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
    ELSE
      UPDATE public.companion_runtime_instances i
      SET settings_checkpoint = 'pending',
          settings_checkpoint_sequence = i.settings_checkpoint_sequence + 1,
          settings_claim_epoch = NULL,
          settings_claim_actor_id = NULL,
          settings_claim_client_surface = NULL,
          settings_claim_turn_id = NULL,
          settings_claim_cold_start_deadline_at = NULL,
          settings_claim_revision = NULL,
          settings_claim_skills_revision = NULL,
          settings_claim_model_id = NULL,
          settings_claim_persona = NULL,
          settings_claim_can_write_skills = NULL,
          settings_claim_provider_ids = NULL,
          settings_claim_selected_skill_ids = NULL,
          settings_claim_skill_refs = NULL,
          settings_claim_selected_mcp_account_ids = NULL,
          settings_available_at = v_now + interval '30 seconds',
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
    END IF;
    v_success := FOUND;

    IF v_success AND v_turn_id IS NOT NULL AND p_terminal_status <> 'succeeded' THEN
      UPDATE public.companion_turns t
      SET status = CASE
            WHEN p_error_code = 'cold_start_deadline_exceeded'
              THEN 'interrupted'::public.companion_turn_status
            ELSE p_terminal_status::public.companion_turn_status
          END,
          inactivity_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE t.inactivity_deadline_at
          END,
          absolute_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE COALESCE(t.absolute_deadline_at, v_now)
          END,
          state_changed_at = v_now,
          settled_at = v_now,
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
        AND t.id = v_turn_id AND t.status = 'queued';
    END IF;

  ELSIF p_work_kind = 'health' THEN
    UPDATE public.companion_runtime_instances i
    SET health_checkpoint = CASE WHEN p_terminal_status = 'succeeded' THEN 'observed' ELSE 'pending' END,
        health_checkpoint_sequence = i.health_checkpoint_sequence + 1,
        health_claim_epoch = NULL,
        health_due_at = v_now + CASE
          WHEN p_terminal_status = 'succeeded' THEN interval '30 seconds'
          ELSE interval '15 seconds'
        END,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id
      AND i.health_claim_epoch = p_claim_epoch
      AND (p_terminal_status <> 'succeeded' OR i.health_checkpoint = 'observed');
    v_success := FOUND;
  END IF;

  IF NOT v_success THEN RETURN false; END IF;

  UPDATE public.companion_runtime_instances i
  SET last_write_epoch = GREATEST(i.last_write_epoch, p_claim_epoch), updated_at = v_now
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;

  UPDATE public.companion_runtime_leases l
  SET claim_token = NULL,
      gate_epoch = NULL,
      executor_id = NULL,
      work_kind = NULL,
      work_id = NULL,
      claimed_at = NULL,
      renewed_at = NULL,
      expires_at = NULL,
      updated_at = v_now
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id;
  RETURN FOUND;
END
$$;
