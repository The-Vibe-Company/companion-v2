-- Subagent tool runs in the transcript.
--
-- Two changes, both confined to the tool branch of the event projection:
--
--   1. `subagent` joins the accepted tool-run kinds, so a delegated child agent is a card a reader
--      can see rather than an unclassified generic tool.
--   2. The tool branch merges instead of replacing. An empty title or content, and a null detail,
--      mean "keep what the row holds", which is what lets a progress update carry only progress and
--      a settlement carry only its status. Every kind that existed before this migration sends the
--      same generic title on start and end and never sends a detail, so their projections are
--      byte-identical to what the previous body produced.
--
-- The whole function is restated because PostgreSQL replaces a function body wholesale; this is the
-- same pattern 0100 used over 0091.

CREATE OR REPLACE FUNCTION public.companion_runtime_project_event_batch(
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
RETURNS TABLE (checkpoint_sequence bigint, event_cursor bigint, has_visible_output boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_attempt public.companion_turn_attempts%ROWTYPE;
  v_turn public.companion_turns%ROWTYPE;
  v_event jsonb;
  v_event_count integer;
  v_sequence bigint;
  v_previous_sequence bigint := 0;
  v_event_type text;
  v_event_hash text;
  v_existing_hash text;
  v_event_id text;
  v_existing_event_id text;
  v_existing_content text;
  v_existing_tool jsonb;
  v_ordinal integer;
  v_content text;
  v_reasoning text;
  v_tool jsonb;
  v_decision jsonb;
  v_proposal jsonb;
  v_request_key text;
  v_request_kind public.companion_decision_request_kind;
  v_expires_at timestamp with time zone;
  v_inserted integer;
  v_has_decision boolean := false;
  v_has_activity boolean := false;
  v_has_settled boolean := false;
  v_has_process_exit boolean := false;
  v_now timestamp with time zone := clock_timestamp();
  v_effective_activity_at timestamp with time zone;
  v_next_status public.companion_attempt_status;
BEGIN
  -- This is the only executor capability that still projects into the legacy thread aggregate.
  -- Pin the diagnostic mutation protocol at execution time: CREATE FUNCTION proconfig for a custom
  -- GUC would require an administrator-only parameter grant during a fresh migration.
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_work_kind <> 'attempt'
     OR p_expected_sequence IS NULL OR p_expected_sequence < 0
     OR p_pi_invocation_id IS NULL
     OR char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200
     OR p_pi_invocation_id ~ E'[\n\r]'
     OR p_events IS NULL OR jsonb_typeof(p_events) <> 'array'
     OR octet_length(p_events::text) > 4194304
     OR p_through_cursor IS NULL OR p_through_cursor < 1
     OR p_unknown_event_count IS NULL OR p_unknown_event_count < 0
     OR p_malformed_event_count IS NULL OR p_malformed_event_count < 0
     OR p_oversized_event_count IS NULL OR p_oversized_event_count < 0 THEN
    RAISE EXCEPTION 'invalid Runtime v2 event batch' USING ERRCODE = '22023';
  END IF;
  v_event_count := jsonb_array_length(p_events);
  IF v_event_count > 256 THEN
    RAISE EXCEPTION 'Runtime v2 event batch is too large' USING ERRCODE = '22023';
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
    AND lease.expires_at > clock_timestamp()
    AND control.enabled
    AND control.gate_epoch = p_gate_epoch
  FOR UPDATE OF lease;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT attempt.* INTO v_attempt
  FROM public.companion_turn_attempts attempt
  WHERE attempt.org_id = p_org_id
    AND attempt.companion_id = p_companion_id
    AND attempt.id = p_work_id
    AND attempt.claim_epoch = p_claim_epoch
    AND attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
    AND attempt.dispatch_state = 'accepted'
    AND attempt.pi_invocation_id = p_pi_invocation_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT turn_row.* INTO v_turn
  FROM public.companion_turns turn_row
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.id = v_attempt.turn_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_now := clock_timestamp();
  IF (v_turn.absolute_deadline_at IS NOT NULL AND v_now >= v_turn.absolute_deadline_at)
     OR (v_turn.inactivity_deadline_at IS NOT NULL AND v_now >= v_turn.inactivity_deadline_at) THEN
    RETURN;
  END IF;
  IF p_unknown_event_count < v_attempt.unknown_event_count
     OR p_malformed_event_count < v_attempt.malformed_event_count
     OR p_oversized_event_count < v_attempt.oversized_event_count THEN
    RAISE EXCEPTION 'Runtime v2 parser counters cannot rewind' USING ERRCODE = '22023';
  END IF;

  -- Validate the full typed batch before any insert. Sequence gaps are legal because rejected or
  -- unsupported broker records advance the acknowledged cursor but are represented only by counts.
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
  LOOP
    IF jsonb_typeof(v_event) <> 'object'
       OR COALESCE(jsonb_typeof(v_event -> 'sequence'), 'missing') <> 'string'
       OR (v_event ->> 'sequence') !~ '^[1-9][0-9]{0,17}$'
       OR COALESCE(jsonb_typeof(v_event -> 'type'), 'missing') <> 'string' THEN
      RAISE EXCEPTION 'invalid normalized Runtime v2 event' USING ERRCODE = '22023';
    END IF;
    v_sequence := (v_event ->> 'sequence')::bigint;
    v_event_type := v_event ->> 'type';
    IF v_sequence <= v_previous_sequence OR v_sequence > p_through_cursor THEN
      RAISE EXCEPTION 'Runtime v2 event sequences are not strictly ordered' USING ERRCODE = '22023';
    END IF;
    v_previous_sequence := v_sequence;

    IF v_event_type = 'assistant' THEN
      IF v_event - ARRAY['sequence','type','entry_key','content','reasoning']::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'entry_key'), 'missing') <> 'string'
         OR char_length(v_event ->> 'entry_key') NOT BETWEEN 1 AND 240
         OR (v_event ->> 'entry_key') ~ E'[\n\r]'
         OR COALESCE(jsonb_typeof(v_event -> 'content'), 'missing') <> 'string'
         OR char_length(v_event ->> 'content') > 100000
         OR octet_length(v_event ->> 'content') > 1048576
         OR COALESCE(jsonb_typeof(v_event -> 'reasoning'), 'null') NOT IN ('string', 'null')
         OR char_length(COALESCE(v_event ->> 'reasoning', '')) > 16000
         OR octet_length(COALESCE(v_event ->> 'reasoning', '')) > 48000 THEN
        RAISE EXCEPTION 'invalid assistant projection' USING ERRCODE = '22023';
      END IF;
      v_has_activity := true;
    ELSIF v_event_type = 'tool' THEN
      v_tool := v_event -> 'tool';
      IF v_event - ARRAY['sequence','type','entry_key','content','tool']::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'entry_key'), 'missing') <> 'string'
         OR char_length(v_event ->> 'entry_key') NOT BETWEEN 1 AND 240
         OR (v_event ->> 'entry_key') ~ E'[\n\r]'
         OR COALESCE(jsonb_typeof(v_event -> 'content'), 'missing') <> 'string'
         OR char_length(v_event ->> 'content') > 300
         OR COALESCE(jsonb_typeof(v_tool), 'missing') <> 'object'
         OR v_tool - ARRAY['call_id','kind','name','title','status','detail','screenshot']::text[] <> '{}'::jsonb
         OR NOT (v_tool ?& ARRAY['call_id','kind','name','title','status','detail','screenshot'])
         OR COALESCE(jsonb_typeof(v_tool -> 'call_id'), 'null') NOT IN ('string', 'null')
         OR char_length(COALESCE(v_tool ->> 'call_id', '')) > 200
         OR COALESCE(jsonb_typeof(v_tool -> 'kind'), 'missing') <> 'string'
         OR (v_tool ->> 'kind') NOT IN ('shell', 'file', 'browse', 'computer', 'subagent', 'tool')
         OR COALESCE(jsonb_typeof(v_tool -> 'name'), 'missing') <> 'string'
         OR char_length(v_tool ->> 'name') NOT BETWEEN 1 AND 120
         OR COALESCE(jsonb_typeof(v_tool -> 'title'), 'missing') <> 'string'
         OR char_length(v_tool ->> 'title') > 300
         OR COALESCE(jsonb_typeof(v_tool -> 'status'), 'missing') <> 'string'
         OR (v_tool ->> 'status') NOT IN ('running', 'ok', 'error', 'timeout')
         OR COALESCE(jsonb_typeof(v_tool -> 'detail'), 'null') NOT IN ('string', 'null')
         OR char_length(COALESCE(v_tool ->> 'detail', '')) > 16000
         OR jsonb_typeof(v_tool -> 'screenshot') IS DISTINCT FROM 'null'
         OR octet_length(v_tool::text) > 262144 THEN
        RAISE EXCEPTION 'invalid tool projection' USING ERRCODE = '22023';
      END IF;
      v_has_activity := true;
    ELSIF v_event_type = 'decision' THEN
      v_decision := v_event -> 'decision';
      IF v_event - ARRAY[
          'sequence','type','entry_key','request_key','request_kind','content','decision',
          'expires_at','proposal'
        ]::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'entry_key'), 'missing') <> 'string'
         OR char_length(v_event ->> 'entry_key') NOT BETWEEN 1 AND 240
         OR (v_event ->> 'entry_key') ~ E'[\n\r]'
         OR COALESCE(jsonb_typeof(v_event -> 'request_key'), 'missing') <> 'string'
         OR char_length(v_event ->> 'request_key') NOT BETWEEN 1 AND 200
         OR (v_event ->> 'request_key') ~ E'[\n\r]'
         OR COALESCE(jsonb_typeof(v_event -> 'request_kind'), 'missing') <> 'string'
         OR (v_event ->> 'request_kind') NOT IN ('question', 'confirmation', 'config_proposal')
         OR COALESCE(jsonb_typeof(v_event -> 'content'), 'missing') <> 'string'
         OR char_length(v_event ->> 'content') > 300
         OR COALESCE(jsonb_typeof(v_event -> 'expires_at'), 'missing') <> 'string'
         OR COALESCE(jsonb_typeof(v_decision), 'missing') <> 'object'
         OR v_decision - ARRAY[
           'request_id','kind','name','title','detail','status','answer',
           'decided_by_id','decided_by_name','decided_at','expires_at','proposal'
         ]::text[] <> '{}'::jsonb
         OR NOT (v_decision ?& ARRAY[
           'request_id','kind','name','title','detail','status','answer',
           'decided_by_id','decided_by_name','decided_at','expires_at'
         ])
         OR v_decision ->> 'request_id' IS DISTINCT FROM v_event ->> 'request_key'
         OR (v_decision ->> 'kind') NOT IN ('shell', 'file', 'question', 'config')
         OR ((v_event ->> 'request_kind' = 'question') IS DISTINCT FROM
             (v_decision ->> 'kind' = 'question'))
         -- A config proposal is exactly the config kind and carries the same bounded payload on the
         -- event and on the projected card. Every other kind carries no proposal at all: an absent
         -- key and an explicit JSON null both count as none, because the card shape always has the
         -- field.
         OR ((v_event ->> 'request_kind' = 'config_proposal') IS DISTINCT FROM
             (v_decision ->> 'kind' = 'config'))
         OR (CASE WHEN v_event ->> 'request_kind' = 'config_proposal'
               THEN jsonb_typeof(v_event -> 'proposal') IS DISTINCT FROM 'object'
                 OR (v_decision -> 'proposal') IS DISTINCT FROM (v_event -> 'proposal')
               ELSE COALESCE(jsonb_typeof(v_event -> 'proposal'), 'null') <> 'null'
                 OR COALESCE(jsonb_typeof(v_decision -> 'proposal'), 'null') <> 'null'
             END)
         OR COALESCE(jsonb_typeof(v_decision -> 'name'), 'missing') <> 'string'
         OR char_length(v_decision ->> 'name') NOT BETWEEN 1 AND 120
         OR COALESCE(jsonb_typeof(v_decision -> 'title'), 'missing') <> 'string'
         OR char_length(v_decision ->> 'title') > 300
         OR v_decision ->> 'title' IS DISTINCT FROM v_event ->> 'content'
         OR COALESCE(jsonb_typeof(v_decision -> 'detail'), 'null') NOT IN ('string', 'null')
         OR char_length(COALESCE(v_decision ->> 'detail', '')) > 16000
         OR v_decision ->> 'status' IS DISTINCT FROM 'pending'
         OR jsonb_typeof(v_decision -> 'answer') IS DISTINCT FROM 'null'
         OR jsonb_typeof(v_decision -> 'decided_by_id') IS DISTINCT FROM 'null'
         OR jsonb_typeof(v_decision -> 'decided_by_name') IS DISTINCT FROM 'null'
         OR jsonb_typeof(v_decision -> 'decided_at') IS DISTINCT FROM 'null'
         OR v_decision ->> 'expires_at' IS DISTINCT FROM v_event ->> 'expires_at'
         OR octet_length(v_decision::text) > 262144 THEN
        RAISE EXCEPTION 'invalid decision projection' USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_expires_at := (v_event ->> 'expires_at')::timestamp with time zone;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'invalid decision expiry' USING ERRCODE = '22023';
      END;
      IF v_expires_at <= v_now OR v_expires_at > v_now + interval '24 hours' THEN
        RAISE EXCEPTION 'invalid decision expiry' USING ERRCODE = '22023';
      END IF;
      v_has_decision := true;
      v_has_activity := true;
    ELSIF v_event_type = 'activity' THEN
      IF v_event - ARRAY['sequence','type','event_type']::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'event_type'), 'missing') <> 'string'
         OR (v_event ->> 'event_type') NOT IN (
           'agent_start', 'agent_end', 'turn_start', 'turn_end',
           'message_start', 'message_update', 'message_end',
           'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
           'extension_ui_request', 'extension_error', 'auto_retry_start', 'auto_retry_end',
           'queue_update', 'compaction_start', 'compaction_update', 'compaction_end'
         ) THEN
        RAISE EXCEPTION 'invalid activity projection' USING ERRCODE = '22023';
      END IF;
      v_has_activity := true;
    ELSIF v_event_type = 'settled' THEN
      IF v_event - ARRAY['sequence','type']::text[] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'invalid settlement projection' USING ERRCODE = '22023';
      END IF;
      v_has_settled := true;
    ELSIF v_event_type = 'process_exit' THEN
      IF v_event - ARRAY['sequence','type','code','signal']::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'code'), 'null') NOT IN ('number', 'null')
         OR (jsonb_typeof(v_event -> 'code') = 'number' AND (
           (v_event ->> 'code') !~ '^-?[0-9]{1,10}$'
           OR (v_event ->> 'code')::numeric NOT BETWEEN -2147483648 AND 2147483647
         ))
         OR COALESCE(jsonb_typeof(v_event -> 'signal'), 'null') NOT IN ('string', 'null')
         OR char_length(COALESCE(v_event ->> 'signal', '')) > 40
         OR COALESCE(v_event ->> 'signal', '') ~ E'[\n\r]' THEN
        RAISE EXCEPTION 'invalid process exit projection' USING ERRCODE = '22023';
      END IF;
      v_has_process_exit := true;
    ELSE
      RAISE EXCEPTION 'unsupported normalized Runtime v2 event' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF v_attempt.event_cursor >= p_through_cursor THEN
    -- A response-lost retry may replay an already committed page. Verify every supplied digest and
    -- return the current cursor/sequence; partial or altered replay is a serialization conflict.
    FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
    LOOP
      v_sequence := (v_event ->> 'sequence')::bigint;
      v_event_hash := encode(sha256(convert_to(v_event::text, 'UTF8')), 'hex');
      SELECT projection.projection_sha256 INTO v_existing_hash
      FROM public.companion_runtime_event_projections projection
      WHERE projection.attempt_id = p_work_id AND projection.broker_sequence = v_sequence;
      IF NOT FOUND OR v_existing_hash <> v_event_hash THEN
        RAISE EXCEPTION 'Runtime v2 event replay does not match committed projection'
          USING ERRCODE = '40001';
      END IF;
    END LOOP;
    IF p_unknown_event_count > v_attempt.unknown_event_count
       OR p_malformed_event_count > v_attempt.malformed_event_count
       OR p_oversized_event_count > v_attempt.oversized_event_count THEN
      RAISE EXCEPTION 'Runtime v2 replay counters exceed committed counters' USING ERRCODE = '40001';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.companion_transcript_entries entry
      WHERE entry.org_id = p_org_id
        AND entry.companion_id = p_companion_id
        AND entry.event_id LIKE ('v2:' || p_work_id::text || ':%')
        AND entry.role IN ('assistant', 'decision')
    ) INTO has_visible_output;
    RETURN QUERY SELECT v_attempt.checkpoint_sequence, v_attempt.event_cursor, has_visible_output;
    RETURN;
  END IF;
  IF v_attempt.checkpoint_sequence <> p_expected_sequence THEN
    RAISE EXCEPTION 'Runtime v2 event checkpoint sequence is stale' USING ERRCODE = '40001';
  END IF;
  IF p_through_cursor <= v_attempt.event_cursor
     OR p_through_cursor > v_attempt.event_cursor + 10000
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_events) supplied(value)
       WHERE (supplied.value ->> 'sequence')::bigint <= v_attempt.event_cursor
     ) THEN
    RAISE EXCEPTION 'Runtime v2 event cursor did not advance consistently' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.companion_threads(org_id, companion_id, next_ordinal)
  VALUES (p_org_id, p_companion_id, 0)
  ON CONFLICT (companion_id) DO NOTHING;

  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
  LOOP
    v_sequence := (v_event ->> 'sequence')::bigint;
    v_event_type := v_event ->> 'type';
    v_event_hash := encode(sha256(convert_to(v_event::text, 'UTF8')), 'hex');
    INSERT INTO public.companion_runtime_event_projections(
      org_id, companion_id, attempt_id, broker_sequence,
      pi_invocation_id, projection_kind, projection_sha256
    ) VALUES (
      p_org_id, p_companion_id, p_work_id, v_sequence,
      p_pi_invocation_id, v_event_type, v_event_hash
    );

    v_event_id := 'v2:' || p_work_id::text || ':' || v_sequence::text;
    IF v_event_type = 'assistant' THEN
      v_content := v_event ->> 'content';
      v_reasoning := v_event ->> 'reasoning';
      UPDATE public.companion_threads thread
      SET next_ordinal = thread.next_ordinal + 1,
          last_message_at = v_now,
          updated_at = v_now
      WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
      RETURNING thread.next_ordinal - 1 INTO v_ordinal;
      INSERT INTO public.companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, reasoning, created_at
      ) VALUES (
        p_org_id, p_companion_id, v_event_id, v_ordinal, 'assistant',
        v_content, v_reasoning, v_now
      );
    ELSIF v_event_type = 'tool' THEN
      v_content := v_event ->> 'content';
      v_tool := v_event -> 'tool';
      v_existing_event_id := NULL;
      v_existing_content := NULL;
      v_existing_tool := NULL;
      IF v_tool ->> 'call_id' IS NOT NULL THEN
        SELECT entry.event_id, entry.content, entry.tool
        INTO v_existing_event_id, v_existing_content, v_existing_tool
        FROM public.companion_transcript_entries entry
        WHERE entry.org_id = p_org_id
          AND entry.companion_id = p_companion_id
          AND entry.role = 'tool'
          AND entry.event_id LIKE ('v2:' || p_work_id::text || ':%')
          AND entry.tool ->> 'call_id' = v_tool ->> 'call_id'
        ORDER BY entry.ordinal DESC
        LIMIT 1
        FOR UPDATE;
      END IF;
      IF v_existing_event_id IS NULL THEN
        -- A progress or result line whose start never landed -- an oversized start is dropped by the
        -- broker, counted, and not projected -- still becomes a card. It names the tool rather than
        -- inheriting a headline no row holds.
        v_content := COALESCE(NULLIF(v_content, ''), v_tool ->> 'name');
        v_tool := v_tool || jsonb_build_object(
          'title', COALESCE(NULLIF(v_tool ->> 'title', ''), v_tool ->> 'name')
        );
        UPDATE public.companion_threads thread
        SET next_ordinal = thread.next_ordinal + 1,
            last_message_at = v_now,
            updated_at = v_now
        WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
        RETURNING thread.next_ordinal - 1 INTO v_ordinal;
        INSERT INTO public.companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content, tool, created_at
        ) VALUES (
          p_org_id, p_companion_id, v_event_id, v_ordinal, 'tool', v_content, v_tool, v_now
        );
      ELSE
        -- Merge, do not replace. An empty title or content and a null detail are the projection's
        -- inherit sentinels: a progress update carries progress only, and the settlement that
        -- follows it carries a status only, so neither erases what the card already says.
        v_content := COALESCE(NULLIF(v_content, ''), v_existing_content);
        v_tool := v_tool || jsonb_build_object(
          'title', COALESCE(
            NULLIF(v_tool ->> 'title', ''),
            v_existing_tool ->> 'title',
            v_tool ->> 'name'
          ),
          'detail', COALESCE(
            to_jsonb(v_tool ->> 'detail'),
            v_existing_tool -> 'detail',
            'null'::jsonb
          )
        );
        UPDATE public.companion_transcript_entries entry
        SET content = v_content, tool = v_tool
        WHERE entry.org_id = p_org_id
          AND entry.companion_id = p_companion_id
          AND entry.event_id = v_existing_event_id;
        UPDATE public.companion_threads thread
        SET last_message_at = v_now, updated_at = v_now
        WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id;
      END IF;
    ELSIF v_event_type = 'decision' THEN
      v_content := v_event ->> 'content';
      v_request_key := v_event ->> 'request_key';
      v_request_kind := (v_event ->> 'request_kind')::public.companion_decision_request_kind;
      v_proposal := v_event -> 'proposal';
      IF v_proposal = 'null'::jsonb THEN
        v_proposal := NULL;
      END IF;
      IF v_request_kind::text = 'config_proposal' THEN
        IF v_proposal IS NULL
           OR jsonb_typeof(v_proposal) <> 'object'
           OR octet_length(v_proposal::text) > 16384 THEN
          RAISE EXCEPTION 'invalid Companion config proposal' USING ERRCODE = '22023';
        END IF;
      ELSIF v_proposal IS NOT NULL THEN
        RAISE EXCEPTION 'invalid Companion config proposal' USING ERRCODE = '22023';
      END IF;
      v_expires_at := LEAST(
        (v_event ->> 'expires_at')::timestamp with time zone,
        COALESCE(v_turn.absolute_deadline_at, 'infinity'::timestamp with time zone)
      );
      v_decision := jsonb_build_object(
        'request_id', v_request_key,
        'kind', v_event -> 'decision' ->> 'kind',
        'name', v_event -> 'decision' ->> 'name',
        'title', v_event -> 'decision' ->> 'title',
        'detail', v_event -> 'decision' -> 'detail',
        'status', 'pending',
        'answer', NULL,
        'decided_by_id', NULL,
        'decided_by_name', NULL,
        'decided_at', NULL,
        'expires_at', to_char(
          v_expires_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'proposal', v_proposal
      );
      INSERT INTO public.companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id, request_key, request_kind, expires_at, proposal
      ) VALUES (
        p_org_id, p_companion_id, v_attempt.turn_id, p_work_id,
        v_request_key, v_request_kind, v_expires_at, v_proposal
      )
      ON CONFLICT ON CONSTRAINT companion_decision_deliveries_request_uq DO NOTHING;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      IF v_inserted = 1 THEN
        UPDATE public.companion_threads thread
        SET next_ordinal = thread.next_ordinal + 1,
            last_message_at = v_now,
            updated_at = v_now
        WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
        RETURNING thread.next_ordinal - 1 INTO v_ordinal;
        INSERT INTO public.companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content, decision, created_at
        ) VALUES (
          p_org_id, p_companion_id, v_event_id, v_ordinal, 'decision',
          v_content, v_decision, v_now
        );
      ELSE
        PERFORM 1
        FROM public.companion_decision_deliveries delivery
        WHERE delivery.org_id = p_org_id
          AND delivery.companion_id = p_companion_id
          AND delivery.attempt_id = p_work_id
          AND delivery.request_key = v_request_key
          AND delivery.request_kind = v_request_kind
          AND delivery.proposal IS NOT DISTINCT FROM v_proposal;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'decision request key was reused inconsistently' USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
  END LOOP;

  v_next_status := CASE WHEN v_has_decision AND NOT v_has_settled AND NOT v_has_process_exit
                        THEN 'needs_input'
                        ELSE 'running' END::public.companion_attempt_status;
  v_effective_activity_at := CASE
    WHEN v_has_activity THEN GREATEST(
      COALESCE(v_attempt.last_activity_at, '-infinity'::timestamp with time zone),
      LEAST(COALESCE(p_activity_at, v_now), v_now)
    )
    ELSE v_attempt.last_activity_at
  END;

  UPDATE public.companion_turn_attempts attempt
  SET status = v_next_status,
      -- The terminal proof and cursor advance are one durable mutation. If the SQL response or the
      -- subsequent broker ACK is lost, a lease takeover can ACK this cursor and settle immediately
      -- instead of polling forever beyond the already-projected terminal record.
      checkpoint = CASE
        WHEN v_has_process_exit THEN 'process_exited'
        WHEN v_has_settled THEN 'agent_settled'
        ELSE 'event_projected'
      END,
      checkpoint_sequence = attempt.checkpoint_sequence + 1,
      event_cursor = p_through_cursor,
      last_activity_at = v_effective_activity_at,
      unknown_event_count = p_unknown_event_count,
      malformed_event_count = p_malformed_event_count,
      oversized_event_count = p_oversized_event_count,
      updated_at = v_now
  WHERE attempt.org_id = p_org_id
    AND attempt.companion_id = p_companion_id
    AND attempt.id = p_work_id
    AND attempt.claim_epoch = p_claim_epoch
    AND attempt.checkpoint_sequence = p_expected_sequence
  RETURNING attempt.checkpoint_sequence, attempt.event_cursor
  INTO checkpoint_sequence, event_cursor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Runtime v2 event checkpoint sequence changed' USING ERRCODE = '40001';
  END IF;

  UPDATE public.companion_turns turn_row
  SET status = v_next_status::text::public.companion_turn_status,
      inactivity_deadline_at = CASE
        WHEN v_effective_activity_at IS NULL THEN turn_row.inactivity_deadline_at
        ELSE LEAST(turn_row.absolute_deadline_at, v_effective_activity_at + interval '10 minutes')
      END,
      state_changed_at = CASE
        WHEN turn_row.status::text = v_next_status::text THEN turn_row.state_changed_at ELSE v_now
      END,
      updated_at = v_now
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.id = v_attempt.turn_id;
  UPDATE public.companion_runtime_instances instance
  SET last_write_epoch = GREATEST(instance.last_write_epoch, p_claim_epoch), updated_at = v_now
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;

  SELECT EXISTS (
    SELECT 1 FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id
      AND entry.companion_id = p_companion_id
      AND entry.event_id LIKE ('v2:' || p_work_id::text || ':%')
      AND entry.role IN ('assistant', 'decision')
  ) INTO has_visible_output;

  RETURN NEXT;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_project_event_batch(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  bigint, text, jsonb, bigint, timestamp with time zone, integer, integer, integer
) FROM PUBLIC;
