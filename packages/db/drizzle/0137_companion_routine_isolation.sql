-- Final routine-isolation cutover. The deploy gate lives in apps/runtime; these capabilities are
-- additive so old replicas continue to execute routine turns through the ordinary main Pi path.

ALTER TABLE public.companion_turns
  ADD COLUMN routine_isolated boolean NOT NULL DEFAULT false,
  ADD COLUMN routine_context_substrate_id uuid,
  ADD COLUMN routine_relay_source_event_id text;
--> statement-breakpoint

ALTER TABLE public.companion_turns
  ADD CONSTRAINT companion_turns_routine_isolation_check
    CHECK (NOT routine_isolated OR (
      routine_snapshot_id IS NOT NULL AND routine_context_substrate_id IS NOT NULL
    )),
  ADD CONSTRAINT companion_turns_routine_relay_source_check
    CHECK (routine_relay_source_event_id IS NULL OR (
      char_length(routine_relay_source_event_id) BETWEEN 1 AND 200
      AND routine_relay_source_event_id !~ E'[\n\r]'
      AND routine_name IS NULL
    ));
--> statement-breakpoint

ALTER TABLE public.companion_runtime_event_projections
  DROP CONSTRAINT companion_runtime_event_projections_kind_check,
  ADD CONSTRAINT companion_runtime_event_projections_kind_check CHECK (
    projection_kind IN (
      'assistant','tool','decision','activity','settled','process_exit','compaction','routine_return'
    )
  );
--> statement-breakpoint

CREATE TABLE public.companion_main_pi_compactions (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  pi_invocation_id text NOT NULL,
  generation bigint NOT NULL,
  event_cursor bigint NOT NULL,
  summary text NOT NULL,
  first_kept_entry_id text NOT NULL,
  tokens_before integer NOT NULL,
  estimated_tokens_after integer NOT NULL,
  cache_read integer,
  cache_write integer,
  sha256 text NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  CONSTRAINT companion_main_pi_compactions_pk
    PRIMARY KEY (org_id, companion_id, pi_invocation_id, generation),
  CONSTRAINT companion_main_pi_compactions_companion_fk
    FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_main_pi_compactions_bounds_check CHECK (
    generation >= 1 AND event_cursor >= 1
    AND char_length(pi_invocation_id) BETWEEN 1 AND 200
    AND pi_invocation_id !~ E'[\n\r]'
    AND octet_length(summary) BETWEEN 1 AND 32768
    AND char_length(first_kept_entry_id) BETWEEN 1 AND 200
    AND first_kept_entry_id !~ E'[\n\r]'
    AND tokens_before >= 0 AND estimated_tokens_after >= 0
    AND (cache_read IS NULL OR cache_read >= 0)
    AND (cache_write IS NULL OR cache_write >= 0)
    AND sha256 ~ '^[0-9a-f]{64}$'
  )
);
--> statement-breakpoint

CREATE INDEX companion_main_pi_compactions_latest_idx
  ON public.companion_main_pi_compactions(org_id, companion_id, observed_at DESC);
--> statement-breakpoint

CREATE TABLE public.companion_routine_context_substrates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  summary_sha256 text,
  built_through_ordinal integer NOT NULL,
  content text NOT NULL,
  sha256 text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_routine_context_substrates_companion_fk
    FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_routine_context_substrates_digest_uq UNIQUE (companion_id, sha256),
  CONSTRAINT companion_routine_context_substrates_bounds_check CHECK (
    (summary_sha256 IS NULL OR summary_sha256 ~ '^[0-9a-f]{64}$')
    AND built_through_ordinal >= -1
    AND octet_length(content) BETWEEN 1 AND 32768
    AND sha256 ~ '^[0-9a-f]{64}$'
  )
);
--> statement-breakpoint

CREATE INDEX companion_routine_context_substrates_companion_idx
  ON public.companion_routine_context_substrates(org_id, companion_id, created_at DESC);
--> statement-breakpoint

ALTER TABLE public.companion_turns
  ADD CONSTRAINT companion_turns_routine_context_substrate_fk
  FOREIGN KEY (routine_context_substrate_id)
  REFERENCES public.companion_routine_context_substrates(id)
  ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE public.companion_main_pi_compactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_main_pi_compactions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_routine_context_substrates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_routine_context_substrates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "companion_main_pi_compactions_runtime_owner_rls"
  ON public.companion_main_pi_compactions FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint

CREATE POLICY "companion_routine_context_substrates_runtime_owner_rls"
  ON public.companion_routine_context_substrates FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_get_routine_material(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid
)
RETURNS TABLE (
  routine_snapshot_id uuid,
  routine_name text,
  routine_isolated boolean,
  routine_context_id uuid,
  routine_context_sha256 text,
  routine_context_content text,
  relay_source_content text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_turn_id uuid;
BEGIN
  SELECT lease.turn_id INTO v_turn_id
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
    AND lease.expires_at > clock_timestamp()
    AND control.enabled
    AND control.gate_epoch = p_gate_epoch;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT turn_row.routine_snapshot_id, turn_row.routine_name, turn_row.routine_isolated,
    substrate.id, substrate.sha256, substrate.content, surfaced.content
  FROM public.companion_turns turn_row
  LEFT JOIN public.companion_routine_context_substrates substrate
    ON substrate.id = turn_row.routine_context_substrate_id
   AND substrate.org_id = turn_row.org_id
   AND substrate.companion_id = turn_row.companion_id
  LEFT JOIN public.companion_transcript_entries surfaced
    ON surfaced.org_id = turn_row.org_id
   AND surfaced.companion_id = turn_row.companion_id
   AND surfaced.event_id = turn_row.routine_relay_source_event_id
   AND surfaced.role = 'assistant'
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.id = v_turn_id;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_prepare_routine_run(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_enable_new_isolation boolean
)
RETURNS TABLE (isolated boolean, context_id uuid, context_sha256 text, context_content text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_attempt public.companion_turn_attempts%ROWTYPE;
  v_turn public.companion_turns%ROWTYPE;
  v_summary public.companion_main_pi_compactions%ROWTYPE;
  v_tail text := '';
  v_built_through integer := -1;
  v_snapshot_version text;
  v_content text;
  v_digest text;
  v_context_id uuid;
BEGIN
  IF p_work_kind <> 'attempt' THEN RETURN; END IF;
  PERFORM 1
  FROM public.companion_runtime_leases lease
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch AND lease.executor_id = p_executor_id
    AND lease.work_kind = p_work_kind AND lease.work_id = p_work_id
    AND lease.expires_at > clock_timestamp()
    AND control.enabled AND control.gate_epoch = p_gate_epoch
  FOR UPDATE OF lease;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT attempt.* INTO v_attempt
  FROM public.companion_turn_attempts attempt
  WHERE attempt.org_id = p_org_id AND attempt.companion_id = p_companion_id
    AND attempt.id = p_work_id AND attempt.claim_epoch = p_claim_epoch
    AND attempt.status IN ('starting','dispatching','running','needs_input')
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT turn_row.* INTO v_turn
  FROM public.companion_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = v_attempt.turn_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_turn.routine_snapshot_id IS NULL OR v_turn.routine_name IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_turn.routine_isolated THEN
    RETURN QUERY
    SELECT true, substrate.id, substrate.sha256, substrate.content
    FROM public.companion_routine_context_substrates substrate
    WHERE substrate.id = v_turn.routine_context_substrate_id
      AND substrate.org_id = p_org_id AND substrate.companion_id = p_companion_id;
    RETURN;
  END IF;
  IF NOT p_enable_new_isolation THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_turn.routine_context_substrate_id IS NOT NULL THEN
    RAISE EXCEPTION 'routine context was pinned without isolated execution' USING ERRCODE = '55000';
  END IF;

  SELECT compaction.* INTO v_summary
  FROM public.companion_main_pi_compactions compaction
  WHERE compaction.org_id = p_org_id AND compaction.companion_id = p_companion_id
  ORDER BY compaction.observed_at DESC, compaction.generation DESC
  LIMIT 1;

  SELECT COALESCE(max(entry.ordinal), -1) INTO v_built_through
  FROM public.companion_transcript_entries entry
  WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
    AND entry.created_at <= v_turn.created_at;

  SELECT COALESCE(string_agg(rendered.line, E'\n' ORDER BY rendered.ordinal), '')
  INTO v_tail
  FROM (
    SELECT selected.ordinal,
      '[' || to_char(selected.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '] '
      || CASE selected.role
        WHEN 'user' THEN COALESCE(author.name, 'Member') || ': '
        WHEN 'assistant' THEN 'Companion: '
        WHEN 'decision' THEN 'Decision: '
        WHEN 'tool' THEN 'Tool: '
        ELSE 'Context: '
      END
      || left(regexp_replace(selected.content, E'[\n\r]+', ' ', 'g'), 500) AS line
    FROM (
      SELECT entry.*
      FROM public.companion_transcript_entries entry
      WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
        AND entry.ordinal <= v_built_through
        AND entry.role IN ('user','assistant','decision','tool')
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns origin
          WHERE origin.org_id = entry.org_id AND origin.companion_id = entry.companion_id
            AND origin.message_event_id = entry.event_id
            AND (origin.routine_snapshot_id IS NOT NULL OR origin.routine_relay_source_event_id IS NOT NULL)
        )
      ORDER BY entry.ordinal DESC
      LIMIT 12
    ) selected
    LEFT JOIN public.profiles author ON author.id = selected.author_id
  ) rendered;
  v_tail := left(v_tail, 5000);
  v_snapshot_version := 'v1:' || COALESCE(v_summary.sha256, 'none') || ':' || v_built_through::text;
  v_content := '--- Main conversation context (background, not the routine task) ---' || E'\n'
    || 'Snapshot: ' || v_snapshot_version || E'\n'
    || 'Built through main-thread ordinal: ' || v_built_through::text || E'\n'
    || 'Summary observed at: ' || CASE WHEN v_summary.observed_at IS NULL THEN 'none yet'
      ELSE to_char(v_summary.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END || E'\n\n'
    || '## Stable summary' || E'\n'
    || COALESCE(left(v_summary.summary, 10000), '[No accepted main-Pi compaction summary yet.]') || E'\n\n'
    || '## Recent main-thread tail' || E'\n'
    || CASE WHEN v_tail = '' THEN '[No eligible recent main-thread entries.]' ELSE v_tail END || E'\n'
    || '--- End main conversation context ---' || E'\n';
  IF octet_length(v_content) > 32768 THEN
    RAISE EXCEPTION 'routine context renderer exceeded its hard limit' USING ERRCODE = '22023';
  END IF;
  v_digest := encode(sha256(convert_to(v_content, 'UTF8')), 'hex');

  INSERT INTO public.companion_routine_context_substrates(
    org_id, companion_id, summary_sha256, built_through_ordinal, content, sha256
  ) VALUES (
    p_org_id, p_companion_id, v_summary.sha256, v_built_through, v_content, v_digest
  )
  ON CONFLICT (companion_id, sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
  RETURNING id INTO v_context_id;

  UPDATE public.companion_turns turn_row
  SET routine_context_substrate_id = v_context_id,
      routine_isolated = true,
      updated_at = clock_timestamp()
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = v_turn.id AND NOT turn_row.routine_isolated;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'routine isolation pin raced another executor' USING ERRCODE = '40001';
  END IF;
  RETURN QUERY SELECT true, v_context_id, v_digest, v_content;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_surface_routine_return(
  p_org_id uuid,
  p_companion_id uuid,
  p_run_id uuid,
  p_mode public.companion_routine_surface_mode,
  p_message text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_turn public.companion_turns%ROWTYPE;
  v_owner_id text;
  v_name text;
  v_main_event_id text := 'routine-return:' || p_run_id::text;
  v_relay_client_message_id uuid;
  v_relay_turn jsonb;
  v_relay_turn_id uuid;
  v_ordinal integer;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_mode IS NULL OR p_message IS NULL
     OR char_length(btrim(p_message)) NOT BETWEEN 1 AND 16384
     OR octet_length(p_message) > 65536 THEN
    RAISE EXCEPTION 'invalid routine surface return' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  SELECT turn_row.* INTO v_turn
  FROM public.companion_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_run_id AND turn_row.routine_isolated
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM public.companion_routine_returns existing
    WHERE existing.org_id = p_org_id AND existing.companion_id = p_companion_id
      AND existing.run_id = p_run_id
  ) THEN
    RETURN false;
  END IF;
  SELECT companion.owner_id, companion.name INTO STRICT v_owner_id, v_name
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;

  -- Relay uses an ordinary durable turn. Its stored user message is a non-secret instruction; the
  -- material reader appends the surfaced entry by reference, so the payload itself exists once.
  IF p_mode = 'relay' THEN
    v_relay_client_message_id := gen_random_uuid();
    PERFORM pg_catalog.set_config('app.org_id', p_org_id::text, true);
    PERFORM pg_catalog.set_config('app.user_id', v_owner_id, true);
    SELECT queued.turn INTO v_relay_turn
    FROM public.companion_api_enqueue_turn(
      p_org_id, p_companion_id, v_relay_client_message_id,
      'A scheduled routine surfaced the next Companion entry. Read it and respond to that entry.',
      'web'::public.companion_client_surface, '[]'::jsonb, NULL::uuid, NULL::text
    ) queued;
    v_relay_turn_id := (v_relay_turn ->> 'id')::uuid;
    IF v_relay_turn_id IS NULL THEN
      RAISE EXCEPTION 'routine relay turn was not created' USING ERRCODE = '55000';
    END IF;
  END IF;

  INSERT INTO public.companion_threads(org_id, companion_id, next_ordinal)
  VALUES (p_org_id, p_companion_id, 0)
  ON CONFLICT (companion_id) DO NOTHING;
  UPDATE public.companion_threads thread
  SET next_ordinal = thread.next_ordinal + 1,
      last_message_at = v_now,
      updated_at = v_now
  WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
  RETURNING thread.next_ordinal - 1 INTO v_ordinal;
  INSERT INTO public.companion_transcript_entries(
    org_id, companion_id, event_id, ordinal, role, content, created_at
  ) VALUES (
    p_org_id, p_companion_id, v_main_event_id, v_ordinal,
    'assistant', btrim(p_message), v_now
  );
  IF v_relay_turn_id IS NOT NULL THEN
    UPDATE public.companion_turns relay_turn
    SET routine_relay_source_event_id = v_main_event_id, updated_at = v_now
    WHERE relay_turn.org_id = p_org_id AND relay_turn.companion_id = p_companion_id
      AND relay_turn.id = v_relay_turn_id;
  END IF;
  INSERT INTO public.companion_routine_returns(
    org_id, companion_id, run_id, mode, main_entry_event_id, relay_turn_id, created_at
  ) VALUES (
    p_org_id, p_companion_id, p_run_id, p_mode, v_main_event_id, v_relay_turn_id, v_now
  );
  IF p_mode = 'notify' THEN
    PERFORM public.companion_notification_enqueue(
      p_org_id, p_companion_id, v_owner_id,
      'routine-return:' || p_run_id::text, 'reply', v_name || ' shared an update', p_message
    );
  END IF;
  RETURN true;
END
$$;
--> statement-breakpoint

-- Isolated routine settlement never produces the generic terminal-turn push. `notify` enqueues its
-- own return alert atomically above; `relay` relies on the ordinary main-Pi turn's later outcome.
DROP TRIGGER companion_notification_terminal_turn_trigger ON public.companion_turns;
CREATE TRIGGER companion_notification_terminal_turn_trigger
AFTER UPDATE OF status ON public.companion_turns
FOR EACH ROW
WHEN (NOT NEW.routine_isolated)
EXECUTE FUNCTION public.companion_notification_terminal_turn();
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_project_event_batch_v2(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_expected_sequence bigint,
  p_pi_invocation_id text,
  p_events jsonb,
  p_through_cursor bigint,
  p_activity_at timestamp with time zone,
  p_unknown_event_count integer,
  p_malformed_event_count integer,
  p_oversized_event_count integer
)
RETURNS TABLE (
  checkpoint_sequence bigint,
  event_cursor bigint,
  has_visible_output boolean,
  routine_returned boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_attempt public.companion_turn_attempts%ROWTYPE;
  v_turn public.companion_turns%ROWTYPE;
  v_event jsonb;
  v_main_events jsonb;
  v_sequence bigint;
  v_previous_sequence bigint := 0;
  v_type text;
  v_hash text;
  v_existing_hash text;
  v_event_id text;
  v_ordinal integer;
  v_existing_event_id text;
  v_existing_tool jsonb;
  v_tool jsonb;
  v_has_settled boolean := false;
  v_has_process_exit boolean := false;
  v_returned boolean := false;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_work_kind <> 'attempt'
     OR p_expected_sequence IS NULL OR p_expected_sequence < 0
     OR p_pi_invocation_id IS NULL
     OR char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200
     OR p_pi_invocation_id ~ E'[\n\r]'
     OR p_events IS NULL OR jsonb_typeof(p_events) <> 'array'
     OR jsonb_array_length(p_events) > 256 OR octet_length(p_events::text) > 4194304
     OR p_through_cursor IS NULL OR p_through_cursor < 1
     OR p_unknown_event_count IS NULL OR p_unknown_event_count < 0
     OR p_malformed_event_count IS NULL OR p_malformed_event_count < 0
     OR p_oversized_event_count IS NULL OR p_oversized_event_count < 0 THEN
    RAISE EXCEPTION 'invalid routine event batch' USING ERRCODE = '22023';
  END IF;
  SELECT attempt.* INTO v_attempt
  FROM public.companion_turn_attempts attempt
  JOIN public.companion_runtime_leases lease
    ON lease.org_id = attempt.org_id AND lease.companion_id = attempt.companion_id
   AND lease.work_kind = 'attempt' AND lease.work_id = attempt.id
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  WHERE attempt.org_id = p_org_id AND attempt.companion_id = p_companion_id
    AND attempt.id = p_work_id AND attempt.claim_epoch = p_claim_epoch
    AND attempt.status IN ('starting','dispatching','running','needs_input')
    AND attempt.dispatch_state = 'accepted' AND attempt.pi_invocation_id = p_pi_invocation_id
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch AND lease.executor_id = p_executor_id
    AND lease.expires_at > clock_timestamp()
    AND control.enabled AND control.gate_epoch = p_gate_epoch
  FOR UPDATE OF attempt, lease;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT turn_row.* INTO STRICT v_turn
  FROM public.companion_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = v_attempt.turn_id
  FOR UPDATE;
  IF (v_turn.absolute_deadline_at IS NOT NULL AND v_now >= v_turn.absolute_deadline_at)
     OR (v_turn.inactivity_deadline_at IS NOT NULL AND v_now >= v_turn.inactivity_deadline_at) THEN
    RETURN;
  END IF;
  IF p_unknown_event_count < v_attempt.unknown_event_count
     OR p_malformed_event_count < v_attempt.malformed_event_count
     OR p_oversized_event_count < v_attempt.oversized_event_count THEN
    RAISE EXCEPTION 'routine event parser counters cannot rewind' USING ERRCODE = '22023';
  END IF;

  -- Ordinary and pre-cutover routine rows retain the established projector. Successful main-Pi
  -- compactions are converted to the old activity shape for that projector, then recorded in this
  -- same transaction as the cursor advance.
  IF NOT v_turn.routine_isolated THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_events) e WHERE e ->> 'type' = 'routine_return') THEN
      RAISE EXCEPTION 'routine return appeared on the main Pi session' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(jsonb_agg(
      CASE WHEN e ->> 'type' = 'compaction'
        THEN jsonb_build_object('sequence', e ->> 'sequence', 'type', 'activity', 'event_type', 'compaction_end')
        ELSE e END ORDER BY (e ->> 'sequence')::bigint
    ), '[]'::jsonb) INTO v_main_events
    FROM jsonb_array_elements(p_events) e;
    SELECT projected.checkpoint_sequence, projected.event_cursor, projected.has_visible_output
    INTO checkpoint_sequence, event_cursor, has_visible_output
    FROM public.companion_runtime_project_event_batch(
      p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
      p_executor_id, p_work_kind, p_work_id, p_expected_sequence, p_pi_invocation_id,
      v_main_events, p_through_cursor, p_activity_at,
      p_unknown_event_count, p_malformed_event_count, p_oversized_event_count
    ) projected;
    IF checkpoint_sequence IS NULL THEN RETURN; END IF;
    IF v_turn.routine_snapshot_id IS NULL THEN
      FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
      LOOP
        IF v_event ->> 'type' = 'compaction' THEN
          INSERT INTO public.companion_main_pi_compactions(
            org_id, companion_id, pi_invocation_id, generation, event_cursor,
            summary, first_kept_entry_id, tokens_before, estimated_tokens_after,
            cache_read, cache_write, sha256, observed_at
          ) VALUES (
            p_org_id, p_companion_id, p_pi_invocation_id,
            (v_event ->> 'sequence')::bigint, (v_event ->> 'sequence')::bigint,
            v_event ->> 'summary', v_event ->> 'first_kept_entry_id',
            (v_event ->> 'tokens_before')::integer,
            (v_event ->> 'estimated_tokens_after')::integer,
            CASE WHEN jsonb_typeof(v_event -> 'cache_read') = 'number' THEN (v_event ->> 'cache_read')::integer END,
            CASE WHEN jsonb_typeof(v_event -> 'cache_write') = 'number' THEN (v_event ->> 'cache_write')::integer END,
            encode(sha256(convert_to(v_event ->> 'summary', 'UTF8')), 'hex'), v_now
          ) ON CONFLICT DO NOTHING;
        END IF;
      END LOOP;
    END IF;
    routine_returned := false;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_attempt.event_cursor >= p_through_cursor THEN
    FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
    LOOP
      v_sequence := (v_event ->> 'sequence')::bigint;
      v_hash := encode(sha256(convert_to(v_event::text, 'UTF8')), 'hex');
      SELECT projection.projection_sha256 INTO v_existing_hash
      FROM public.companion_runtime_event_projections projection
      WHERE projection.attempt_id = p_work_id AND projection.broker_sequence = v_sequence;
      IF NOT FOUND OR v_existing_hash <> v_hash THEN
        RAISE EXCEPTION 'routine event replay mismatch' USING ERRCODE = '40001';
      END IF;
    END LOOP;
    checkpoint_sequence := v_attempt.checkpoint_sequence;
    event_cursor := v_attempt.event_cursor;
    has_visible_output := false;
    routine_returned := EXISTS (
      SELECT 1 FROM public.companion_routine_returns returned
      WHERE returned.org_id = p_org_id AND returned.companion_id = p_companion_id
        AND returned.run_id = v_turn.id
    );
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_attempt.checkpoint_sequence <> p_expected_sequence THEN
    RAISE EXCEPTION 'routine event checkpoint sequence is stale' USING ERRCODE = '40001';
  END IF;

  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
  LOOP
    IF jsonb_typeof(v_event) <> 'object' OR (v_event ->> 'sequence') !~ '^[1-9][0-9]{0,17}$' THEN
      RAISE EXCEPTION 'invalid normalized routine event' USING ERRCODE = '22023';
    END IF;
    v_sequence := (v_event ->> 'sequence')::bigint;
    v_type := v_event ->> 'type';
    IF v_sequence <= v_previous_sequence OR v_sequence > p_through_cursor
       OR v_type NOT IN ('assistant','tool','decision','activity','compaction','routine_return','settled','process_exit') THEN
      RAISE EXCEPTION 'invalid normalized routine event ordering or type' USING ERRCODE = '22023';
    END IF;
    v_previous_sequence := v_sequence;
    IF v_type = 'routine_return' AND (
      v_event - ARRAY['sequence','type','call_id','mode','message']::text[] <> '{}'::jsonb
      OR v_event ->> 'mode' NOT IN ('relay','notify')
      OR char_length(v_event ->> 'call_id') NOT BETWEEN 1 AND 200
      OR char_length(btrim(v_event ->> 'message')) NOT BETWEEN 1 AND 16384
    ) THEN
      RAISE EXCEPTION 'invalid normalized routine return' USING ERRCODE = '22023';
    END IF;

    v_hash := encode(sha256(convert_to(v_event::text, 'UTF8')), 'hex');
    INSERT INTO public.companion_runtime_event_projections(
      org_id, companion_id, attempt_id, broker_sequence,
      pi_invocation_id, projection_kind, projection_sha256
    ) VALUES (
      p_org_id, p_companion_id, p_work_id, v_sequence,
      p_pi_invocation_id, v_type, v_hash
    );
    v_event_id := 'v2:' || p_work_id::text || ':' || v_sequence::text;

    IF v_returned THEN CONTINUE; END IF;
    IF v_type = 'routine_return' THEN
      PERFORM public.companion_runtime_surface_routine_return(
        p_org_id, p_companion_id, v_turn.id,
        (v_event ->> 'mode')::public.companion_routine_surface_mode,
        v_event ->> 'message'
      );
      v_returned := true;
    ELSIF v_type IN ('assistant','decision') THEN
      SELECT COALESCE(max(entry.ordinal), -1) + 1 INTO v_ordinal
      FROM public.companion_routine_run_entries entry
      WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
        AND entry.run_id = v_turn.id;
      INSERT INTO public.companion_routine_run_entries(
        org_id, companion_id, run_id, event_id, ordinal, role, content,
        reasoning, decision, created_at
      ) VALUES (
        p_org_id, p_companion_id, v_turn.id, v_event_id, v_ordinal,
        CASE WHEN v_type = 'assistant' THEN 'assistant' ELSE 'decision' END::public.companion_transcript_role,
        COALESCE(v_event ->> 'content', ''), v_event ->> 'reasoning',
        CASE WHEN v_type = 'decision' THEN v_event -> 'decision' END, v_now
      );
    ELSIF v_type = 'tool' THEN
      v_tool := v_event -> 'tool';
      v_existing_event_id := NULL;
      IF v_tool ->> 'call_id' IS NOT NULL THEN
        SELECT entry.event_id, entry.tool INTO v_existing_event_id, v_existing_tool
        FROM public.companion_routine_run_entries entry
        WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
          AND entry.run_id = v_turn.id AND entry.role = 'tool'
          AND entry.tool ->> 'call_id' = v_tool ->> 'call_id'
        ORDER BY entry.ordinal DESC LIMIT 1 FOR UPDATE;
      END IF;
      IF v_existing_event_id IS NULL THEN
        SELECT COALESCE(max(entry.ordinal), -1) + 1 INTO v_ordinal
        FROM public.companion_routine_run_entries entry
        WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
          AND entry.run_id = v_turn.id;
        INSERT INTO public.companion_routine_run_entries(
          org_id, companion_id, run_id, event_id, ordinal, role, content, tool, created_at
        ) VALUES (
          p_org_id, p_companion_id, v_turn.id, v_event_id, v_ordinal,
          'tool', COALESCE(NULLIF(v_event ->> 'content',''), v_tool ->> 'name'), v_tool, v_now
        );
      ELSE
        UPDATE public.companion_routine_run_entries entry
        SET content = COALESCE(NULLIF(v_event ->> 'content',''), entry.content),
            tool = entry.tool || v_tool
        WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
          AND entry.run_id = v_turn.id AND entry.event_id = v_existing_event_id;
      END IF;
    ELSIF v_type = 'settled' THEN
      v_has_settled := true;
    ELSIF v_type = 'process_exit' THEN
      v_has_process_exit := true;
    END IF;
  END LOOP;

  UPDATE public.companion_turn_attempts attempt
  SET status = 'running',
      checkpoint = CASE
        WHEN v_returned OR v_has_settled THEN 'agent_settled'
        WHEN v_has_process_exit THEN 'process_exited'
        ELSE 'event_projected'
      END,
      checkpoint_sequence = attempt.checkpoint_sequence + 1,
      event_cursor = p_through_cursor,
      last_activity_at = CASE WHEN p_activity_at IS NULL THEN attempt.last_activity_at
        ELSE LEAST(p_activity_at, v_now) END,
      unknown_event_count = p_unknown_event_count,
      malformed_event_count = p_malformed_event_count,
      oversized_event_count = p_oversized_event_count,
      updated_at = v_now
  WHERE attempt.org_id = p_org_id AND attempt.companion_id = p_companion_id
    AND attempt.id = p_work_id AND attempt.claim_epoch = p_claim_epoch
    AND attempt.checkpoint_sequence = p_expected_sequence
  RETURNING attempt.checkpoint_sequence, attempt.event_cursor
  INTO checkpoint_sequence, event_cursor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'routine event checkpoint changed' USING ERRCODE = '40001';
  END IF;
  UPDATE public.companion_runtime_instances instance
  SET last_write_epoch = GREATEST(instance.last_write_epoch, p_claim_epoch), updated_at = v_now
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
  has_visible_output := false;
  routine_returned := v_returned;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_routine_hidden_relay_turns(
  p_org_id uuid,
  p_companion_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT CASE WHEN public.companion_api_require_access(p_org_id, p_companion_id, 'read') IS NULL
    THEN '[]'::jsonb
    ELSE COALESCE(jsonb_agg(returned.relay_turn_id), '[]'::jsonb)
  END
  FROM public.companion_routine_returns returned
  WHERE returned.org_id = p_org_id AND returned.companion_id = p_companion_id
    AND returned.relay_turn_id IS NOT NULL
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_get_routine_material(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_prepare_routine_run(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_surface_routine_return(
  uuid,uuid,uuid,public.companion_routine_surface_mode,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_project_event_batch_v2(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,
  bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_routine_hidden_relay_turns(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

DO $routine_isolation_acl$
DECLARE
  v_runtime_source oid := pg_catalog.to_regprocedure(
    'public.companion_runtime_project_event_batch(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,'
    || 'timestamp with time zone,integer,integer,integer)'
  );
  v_api_source oid := pg_catalog.to_regprocedure('public.companion_api_read_thread(uuid,uuid)');
  v_role name;
BEGIN
  FOR v_role IN
    SELECT role.rolname
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.aclexplode((SELECT proacl FROM pg_proc WHERE oid = v_runtime_source)) acl
      ON acl.grantee = role.oid
    WHERE acl.privilege_type = 'EXECUTE'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_get_routine_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_prepare_routine_run(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,boolean) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_project_event_batch_v2(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer) TO %I', v_role);
  END LOOP;
  FOR v_role IN
    SELECT role.rolname
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.aclexplode((SELECT proacl FROM pg_proc WHERE oid = v_api_source)) acl
      ON acl.grantee = role.oid
    WHERE acl.privilege_type = 'EXECUTE'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_routine_hidden_relay_turns(uuid,uuid) TO %I', v_role);
  END LOOP;
END
$routine_isolation_acl$;
--> statement-breakpoint
