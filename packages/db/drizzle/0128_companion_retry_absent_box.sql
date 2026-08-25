-- An explicit Retry used to enqueue restart_pi even when the interrupted cold start had never
-- produced a Box. That operation could only fail with box_unavailable, leaving the turn stuck.
-- Retry remains an explicit human authorization: when no usable Box is projected, enqueue start so
-- runtime first reconciles the deterministic generation name and then creates at most one new Box.

CREATE OR REPLACE FUNCTION public.companion_runtime_assign_operation_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_applied_revision integer;
  v_applied_ids jsonb;
  v_applied_refs jsonb;
  v_applied_digest text;
  v_required_revision integer;
  v_available_revision integer;
BEGIN
  UPDATE public.companion_runtime_instances i
  SET next_operation_sequence = i.next_operation_sequence + 1,
      updated_at = statement_timestamp()
  WHERE i.org_id = NEW.org_id AND i.companion_id = NEW.companion_id
  RETURNING i.next_operation_sequence - 1, i.next_turn_sequence - 1,
    i.applied_skills_revision, i.applied_selected_skill_ids,
    i.applied_skill_refs, i.applied_skills_digest
  INTO NEW.queue_sequence, NEW.turn_queue_cutoff, v_applied_revision,
    v_applied_ids, v_applied_refs, v_applied_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation runtime instance does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW.kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings', 'stop') THEN
    IF NEW.kind <> 'stop' THEN
      SELECT COALESCE(t.client_surface, NEW.client_surface, 'web'::public.companion_client_surface)
      INTO NEW.client_surface
      FROM (SELECT 1) singleton
      LEFT JOIN public.companion_turns t
        ON t.org_id = NEW.org_id AND t.companion_id = NEW.companion_id
       AND t.id = NEW.source_turn_id;
    ELSE
      NEW.client_surface := NULL;
    END IF;

    SELECT i.desired_settings_revision, c.skills_revision, c.skills_available_revision,
           c.model_id, c.persona, c.can_write_skills,
           c.provider_ids, c.selected_skill_ids, c.selected_mcp_account_ids
    INTO NEW.target_settings_revision, v_required_revision, v_available_revision,
         NEW.model_id, NEW.persona, NEW.can_write_skills,
         NEW.provider_ids, NEW.selected_skill_ids, NEW.selected_mcp_account_ids
    FROM public.companion_runtime_instances i
    JOIN public.companions c ON c.org_id = i.org_id AND c.id = i.companion_id
    WHERE i.org_id = NEW.org_id AND i.companion_id = NEW.companion_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'operation Companion does not exist' USING ERRCODE = '23503';
    END IF;

    IF NEW.kind = 'start' AND v_applied_digest IS NOT NULL
       AND v_applied_revision >= v_required_revision THEN
      NEW.target_skills_revision := v_applied_revision;
      NEW.selected_skill_ids := v_applied_ids;
      NEW.skill_refs := v_applied_refs;
    ELSE
      NEW.target_skills_revision := CASE
        WHEN NEW.client_surface = 'native_mobile' THEN v_required_revision
        ELSE v_available_revision
      END;
    END IF;

    IF NEW.client_surface = 'native_mobile' THEN
      NEW.can_write_skills := false;
      NEW.selected_skill_ids := '[]'::jsonb;
      NEW.selected_mcp_account_ids := '[]'::jsonb;
    END IF;

    IF NEW.skill_refs IS NULL THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'skill_id', s.id,
               'current_version_id', s.current_version_id
             ) ORDER BY s.id), '[]'::jsonb)
      INTO NEW.skill_refs
      FROM public.skills s
      WHERE s.org_id = NEW.org_id
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(NEW.selected_skill_ids) selected(skill_id)
          WHERE selected.skill_id = s.id::text
        );
    END IF;

    IF NEW.kind IN ('stop', 'restart_pi', 'restart_box', 'apply_settings') THEN
      NEW.skill_update_selected_skill_ids := NEW.selected_skill_ids;
      NEW.skill_update_refs := NEW.skill_refs;
      IF NEW.kind = 'stop' THEN
        NEW.selected_skill_ids := NULL;
        NEW.skill_refs := NULL;
      ELSIF v_applied_digest IS NOT NULL AND v_applied_revision >= v_required_revision THEN
        -- Resource-bearing lifecycle work only needs provider/MCP authority when it can preserve
        -- the proven installed tree. The separate update snapshot is authorized independently.
        NEW.selected_skill_ids := '[]'::jsonb;
        NEW.skill_refs := '[]'::jsonb;
      END IF;
    ELSE
      NEW.skill_update_selected_skill_ids := NULL;
      NEW.skill_update_refs := NULL;
    END IF;

    IF NEW.kind = 'stop' THEN
      NEW.target_settings_revision := NULL;
      NEW.model_id := NULL;
      NEW.persona := NULL;
      NEW.can_write_skills := NULL;
      NEW.provider_ids := NULL;
      NEW.selected_mcp_account_ids := NULL;
    END IF;
  ELSE
    NEW.client_surface := NULL;
    NEW.target_settings_revision := NULL;
    NEW.target_skills_revision := NULL;
    NEW.model_id := NULL;
    NEW.persona := NULL;
    NEW.can_write_skills := NULL;
    NEW.provider_ids := NULL;
    NEW.selected_skill_ids := NULL;
    NEW.skill_refs := NULL;
    NEW.skill_update_selected_skill_ids := NULL;
    NEW.skill_update_refs := NULL;
    NEW.selected_mcp_account_ids := NULL;
  END IF;

  IF NEW.kind = 'start' AND NEW.source_turn_id IS NOT NULL THEN
    UPDATE public.companion_turns t
    SET cold_start_deadline_at = CASE
          WHEN t.status = 'interrupted' THEN statement_timestamp() + interval '3 minutes'
          ELSE COALESCE(t.cold_start_deadline_at, t.created_at + interval '3 minutes')
        END,
        updated_at = statement_timestamp()
    WHERE t.org_id = NEW.org_id AND t.companion_id = NEW.companion_id
      AND t.id = NEW.source_turn_id
      AND (
        t.status = 'queued'
        OR (
          t.status = 'interrupted'
          AND NEW.trigger = 'user'
          AND NEW.request_id IS NOT NULL
        )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cold-start source turn must be queued or explicitly retried'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_retry_turn(
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
  v_operation_trigger public.companion_operation_trigger;
  v_retry_kind public.companion_operation_kind;
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

  SELECT existing.id, existing.source_turn_id, existing.kind, existing.trigger
  INTO v_operation_id, v_operation_turn_id, v_operation_kind, v_operation_trigger
  FROM public.companion_operations existing
  WHERE existing.org_id = p_org_id AND existing.companion_id = p_companion_id
    AND existing.request_id = p_retry_id;
  IF FOUND THEN
    IF v_operation_turn_id IS DISTINCT FROM p_turn_id
       OR v_operation_kind NOT IN ('start', 'restart_pi')
       OR v_operation_trigger <> 'user' THEN
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
      AND retry_operation.kind IN ('start', 'restart_pi')
      AND retry_operation.trigger = 'user'
      AND retry_operation.status IN ('pending', 'running')
  ) THEN
    RAISE EXCEPTION 'a retry is already pending for this Companion turn' USING ERRCODE = '55000';
  END IF;

  v_retry_kind := CASE
    WHEN v_instance.box_id IS NOT NULL
      AND v_instance.box_state IN ('ready', 'idle', 'running')
      THEN 'restart_pi'::public.companion_operation_kind
    ELSE 'start'::public.companion_operation_kind
  END;

  INSERT INTO public.companion_operations(
    org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
    queue_sequence, turn_queue_cutoff, runtime_generation, client_surface,
    status, created_at, updated_at
  ) VALUES (
    p_org_id, p_companion_id, p_retry_id, v_retry_kind, 'user', v_actor_id,
    p_turn_id, 0, 0, v_instance.generation, p_client_surface, 'pending', v_now, v_now
  ) RETURNING companion_operations.id INTO v_operation_id;

  RETURN QUERY SELECT
    public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), false;
END
$$;
--> statement-breakpoint

-- Retry handoff is identical whether recovery starts an absent Box or recycles Pi on a live Box.
CREATE OR REPLACE FUNCTION public.companion_api_retry_operation_handoff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF NEW.kind NOT IN ('start', 'restart_pi') OR NEW.trigger <> 'user'
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

CREATE OR REPLACE FUNCTION public.companion_api_assign_attempt_retry_id()
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
      AND retry_operation.kind IN ('start', 'restart_pi')
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
      AND retry_operation.kind IN ('start', 'restart_pi')
      AND retry_operation.trigger = 'user'
      AND retry_operation.status = 'running'
  ) THEN
    RAISE EXCEPTION 'Companion turn retry is already running' USING ERRCODE = '55000';
  END IF;
  UPDATE public.companion_operations retry_operation
  SET status = 'cancelled', settled_at = v_now, updated_at = v_now
  WHERE retry_operation.org_id = p_org_id
    AND retry_operation.companion_id = p_companion_id
    AND retry_operation.source_turn_id = p_turn_id
    AND retry_operation.kind IN ('start', 'restart_pi')
    AND retry_operation.trigger = 'user'
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
