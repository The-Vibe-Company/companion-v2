-- Every message send unconditionally enqueued a fresh companion_operations(kind='start') row, even
-- when the Companion's Box and Pi were already observed ready/idle. While that operation was in
-- flight, packages/core's projectedRuntimeState() reported "provisioning" for an already-running
-- Companion (the chat badge flashed "Starting" and the panel said the Box was not running), and
-- packages/companion-runtime's startAndObservePi() restarted the already-idle Pi daemon on every
-- single turn -- a fresh systemd invocation each time -- instead of leaving it alone. A start
-- operation is now enqueued only when the instance is not already observed ready/idle with Pi idle;
-- an already-warm send instead falls straight through to the ordinary turn-claim path
-- (companion_runtime_claim_work), which dispatches directly to the idle Pi without touching its
-- process, so its conversation is never interrupted.

CREATE OR REPLACE FUNCTION public.companion_api_enqueue_turn(
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
  v_message_found boolean := false;
  v_message_ordinal integer;
  v_now timestamp with time zone := clock_timestamp();
  v_replayed boolean := false;
  v_needs_start boolean;
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

  -- A Send is the only normal wake, but a Companion already observed ready with Pi idle needs no wake
  -- at all: the ordinary turn-claim path dispatches straight to the already-idle Pi, which itself
  -- verifies Pi is live and idle through a real broker call before ever writing a prompt. The
  -- unconditional 'start' operation this replaces used to double as a live Box/Pi liveness check on
  -- every single send; skipping it here must not silently trust an observation the periodic health
  -- check (every 30s while healthy) made stale, so recency is required in addition to the cached
  -- state itself.
  v_needs_start := NOT (
    v_instance.box_state IN ('ready', 'idle', 'running') AND v_instance.pi_state = 'idle'
    AND v_instance.last_observed_at >= v_now - interval '2 minutes'
  );

  SELECT queued_turn.id, queued_turn.actor_id, queued_turn.client_surface
  INTO v_turn_id, v_existing_actor_id, v_existing_surface
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
      AND entry.event_id = 'msg:' || p_client_message_id::text
      AND entry.role = 'user';
    v_message_found := FOUND;
    SELECT start_operation.id INTO v_operation_id
    FROM public.companion_operations start_operation
    WHERE start_operation.org_id = p_org_id
      AND start_operation.companion_id = p_companion_id
      AND start_operation.source_turn_id = v_turn_id
      AND start_operation.kind = 'start'
    ORDER BY start_operation.queue_sequence, start_operation.id
    LIMIT 1;
    -- An already-warm send legitimately creates no start operation at all, so its absence no longer
    -- proves an incomplete insert; only the transcript entry does.
    IF NOT v_message_found THEN
      RAISE EXCEPTION 'idempotent Companion turn is incomplete' USING ERRCODE = '55000';
    END IF;
    IF v_existing_actor_id IS DISTINCT FROM v_actor_id
       OR v_existing_author_id IS DISTINCT FROM v_actor_id
       OR v_existing_surface IS DISTINCT FROM p_client_surface
       OR v_existing_content IS DISTINCT FROM btrim(p_content) THEN
      RAISE EXCEPTION 'client_message_id was reused with different message intent'
        USING ERRCODE = '23505', CONSTRAINT = 'companion_turns_client_message_uq';
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

    IF v_needs_start THEN
      INSERT INTO public.companion_operations(
        org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
        queue_sequence, turn_queue_cutoff, runtime_generation, status, created_at, updated_at
      ) VALUES (
        p_org_id, p_companion_id, p_client_message_id, 'start', 'turn', v_actor_id,
        v_turn_id, 0, 0, v_instance.generation, 'pending', v_now, v_now
      ) RETURNING companion_operations.id INTO v_operation_id;
    END IF;

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
$function$

--> statement-breakpoint
