-- Chat attachments, part two: what Pi hands back.
--
-- A turn could produce text, tool runs, and permission cards, and nothing else. Pi now has an outbox
-- at ~/outbox: it drops an image there, and after Pi settles the turn the runtime moves what it finds
-- into the transcript. That is external work happening between Pi's terminal record and the turn
-- settling, so it needs a durable fact of its own -- otherwise a takeover in the middle would either
-- repeat the harvest or lose it.
--
-- The outbox lives within disk layout 14 rather than a new layout version: the runtime creates and
-- empties the directory before every dispatch, so no forced restage is required and the attempt
-- state machine's layout gate is untouched.
--
-- `outputs_harvested_at` is that fact. It is deliberately a column rather than a new checkpoint: the
-- attempt state machine's transition matrix, its `succeeded` terminal proof, and the engine's
-- takeover equality check all stay exactly as they are, while the harvest still commits atomically
-- with the entry and rows it produced. A takeover reads the column through the same terminal
-- projection it already reads and skips a harvest that already happened.

ALTER TABLE public.companion_turn_attempts
  ADD COLUMN outputs_harvested_at timestamp with time zone;
--> statement-breakpoint

-- Only an accepted dispatch can have produced outputs, and only after Pi settled it.
ALTER TABLE public.companion_turn_attempts
  ADD CONSTRAINT companion_turn_attempts_outputs_check CHECK (
    outputs_harvested_at IS NULL
    OR (dispatch_state = 'accepted' AND pi_invocation_id IS NOT NULL)
  );
--> statement-breakpoint

-- The takeover read gains the harvest fact, so a runtime that died between harvesting and settling
-- does not repeat work that already committed. Adding a column to the returned row changes the
-- function's return type, which cannot be replaced in place; the two-phase migration runner
-- re-applies the grants hook after this phase, so the executor keeps its EXECUTE.
DROP FUNCTION public.companion_runtime_get_attempt_terminal_projection(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid
);
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_get_attempt_terminal_projection(
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
  checkpoint text,
  event_cursor bigint,
  has_visible_output boolean,
  outputs_harvested boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_checkpoint text;
  v_event_cursor bigint;
  v_outputs_harvested boolean;
  v_has_visible_output boolean;
BEGIN
  IF p_work_kind <> 'attempt' THEN
    RAISE EXCEPTION 'terminal projection is attempt-only' USING ERRCODE = '22023';
  END IF;

  SELECT attempt.checkpoint, attempt.event_cursor, attempt.outputs_harvested_at IS NOT NULL
  INTO v_checkpoint, v_event_cursor, v_outputs_harvested
  FROM public.companion_runtime_leases lease
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  JOIN public.companion_turn_attempts attempt
    ON attempt.org_id = lease.org_id
   AND attempt.companion_id = lease.companion_id
   AND attempt.id = lease.work_id
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
    AND attempt.claim_epoch = p_claim_epoch
    AND attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
    AND attempt.dispatch_state = 'accepted'
    AND attempt.checkpoint IN ('agent_settled', 'process_exited')
    AND attempt.event_cursor > 0
  FOR UPDATE OF lease, attempt;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id
      AND entry.companion_id = p_companion_id
      AND entry.event_id LIKE ('v2:' || p_work_id::text || ':%')
      AND entry.role IN ('assistant', 'decision')
  ) INTO v_has_visible_output;

  RETURN QUERY SELECT v_checkpoint, v_event_cursor, v_has_visible_output, v_outputs_harvested;
END
$function$;
--> statement-breakpoint

-- Record one attempt's harvested outputs and mark the harvest done, atomically.
--
-- The entry is `v2:<attempt-id>:outputs` with empty content. That id shape is what every
-- visible-output test in this schema already matches on, so a turn whose only product was an image
-- counts as a visible output rather than settling `empty_response`. The content stays empty because
-- the image is the message: an entry that invented a caption would be the control plane speaking
-- for Pi.
--
-- Everything here is idempotent against a call that committed and lost its response: the entry
-- insert and the attachment rows both do nothing on conflict, and marking an already-marked attempt
-- changes nothing. Calling it twice with the same rows leaves the same state.
CREATE FUNCTION public.companion_runtime_record_attempt_outputs(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_attachments jsonb,
  p_activity_at timestamp with time zone
)
RETURNS TABLE (
  recorded integer,
  has_visible_output boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_attempt public.companion_turn_attempts%ROWTYPE;
  v_event_id text;
  v_ordinal integer;
  v_now timestamp with time zone := clock_timestamp();
  v_activity_at timestamp with time zone;
  v_total bigint;
  v_inserted integer;
BEGIN
  -- Like the event projector, this writes into the legacy thread aggregate, so it pins the
  -- diagnostic mutation protocol at execution time. A CREATE FUNCTION proconfig for a custom GUC
  -- would require an administrator-only parameter grant during a fresh migration.
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_work_kind <> 'attempt' THEN
    RAISE EXCEPTION 'attempt outputs are attempt-only' USING ERRCODE = '22023';
  END IF;
  IF p_attachments IS NULL OR jsonb_typeof(p_attachments) <> 'array' THEN
    RAISE EXCEPTION 'attempt outputs must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_attachments) > 10 THEN
    RAISE EXCEPTION 'an attempt hands back at most 10 files' USING ERRCODE = '22023';
  END IF;
  -- Pi hands back images only, under the same per-file ceiling an upload uses, and positions are
  -- dense so the projection order is the harvest order.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_attachments) WITH ORDINALITY AS part(value, ordinality)
    WHERE jsonb_typeof(part.value) <> 'object'
      OR COALESCE(part.value ->> 'position', '') <> (part.ordinality - 1)::text
      OR COALESCE(part.value ->> 'storage_key', '') !~ '^[A-Za-z0-9][A-Za-z0-9/._-]*$'
      OR char_length(COALESCE(part.value ->> 'storage_key', '')) NOT BETWEEN 1 AND 512
      OR COALESCE(part.value ->> 'content_type', '')
         NOT IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
      OR COALESCE(part.value ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
      OR COALESCE(part.value ->> 'filename', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
      OR COALESCE(part.value ->> 'byte_size', '') !~ '^[1-9][0-9]{0,7}$'
      OR (part.value ->> 'byte_size')::bigint > 10485760
  ) THEN
    RAISE EXCEPTION 'invalid attempt output attachment' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(sum((part.value ->> 'byte_size')::bigint), 0) INTO v_total
  FROM jsonb_array_elements(p_attachments) part;
  IF v_total > 104857600 THEN
    RAISE EXCEPTION 'attempt outputs exceed the per-turn byte budget' USING ERRCODE = '22023';
  END IF;

  SELECT attempt.* INTO v_attempt
  FROM public.companion_runtime_leases lease
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  JOIN public.companion_turn_attempts attempt
    ON attempt.org_id = lease.org_id
   AND attempt.companion_id = lease.companion_id
   AND attempt.id = lease.work_id
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
    AND attempt.claim_epoch = p_claim_epoch
    AND attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
    AND attempt.dispatch_state = 'accepted'
    AND attempt.checkpoint = 'agent_settled'
  FOR UPDATE OF lease, attempt;
  -- A stale fence returns no row rather than a diagnostic, exactly like every other executor entry
  -- point: the caller abandons and lets a later claim read the durable state.
  IF NOT FOUND THEN RETURN; END IF;

  v_event_id := 'v2:' || p_work_id::text || ':outputs';
  IF jsonb_array_length(p_attachments) > 0 THEN
    UPDATE public.companion_threads thread
    SET next_ordinal = thread.next_ordinal + 1,
        last_message_at = v_now,
        updated_at = v_now
    WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
    RETURNING thread.next_ordinal - 1 INTO v_ordinal;
    IF v_ordinal IS NULL THEN
      RAISE EXCEPTION 'Companion thread allocation failed' USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.companion_transcript_entries(
      org_id, companion_id, event_id, ordinal, role, content, created_at
    ) VALUES (
      p_org_id, p_companion_id, v_event_id, v_ordinal, 'assistant', '', v_now
    )
    ON CONFLICT ON CONSTRAINT companion_transcript_entries_companion_id_event_id_pk DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
      -- The entry already exists, so an earlier call committed and only lost its answer. Give the
      -- ordinal back rather than leaving a hole in the transcript.
      UPDATE public.companion_threads thread
      SET next_ordinal = thread.next_ordinal - 1, updated_at = v_now
      WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
        AND thread.next_ordinal = v_ordinal + 1;
    END IF;

    INSERT INTO public.companion_message_attachments(
      org_id, companion_id, entry_event_id, kind, storage_key,
      content_type, byte_size, sha256, filename, position, created_at
    )
    SELECT p_org_id, p_companion_id, v_event_id, 'pi_output',
      part.value ->> 'storage_key',
      part.value ->> 'content_type',
      (part.value ->> 'byte_size')::integer,
      part.value ->> 'sha256',
      part.value ->> 'filename',
      (part.ordinality - 1)::integer,
      v_now
    FROM jsonb_array_elements(p_attachments) WITH ORDINALITY AS part(value, ordinality)
    ON CONFLICT DO NOTHING;
  END IF;

  -- Harvesting is real activity. Without this stamp a large but legitimate transfer could cross the
  -- ten-minute inactivity deadline and be settled out from under itself.
  v_activity_at := GREATEST(
    COALESCE(v_attempt.last_activity_at, '-infinity'::timestamp with time zone),
    LEAST(COALESCE(p_activity_at, v_now), v_now)
  );

  UPDATE public.companion_turn_attempts attempt
  SET outputs_harvested_at = COALESCE(attempt.outputs_harvested_at, v_now),
      last_activity_at = v_activity_at,
      updated_at = v_now
  WHERE attempt.org_id = p_org_id
    AND attempt.companion_id = p_companion_id
    AND attempt.id = p_work_id
    AND attempt.claim_epoch = p_claim_epoch;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.companion_turns turn_row
  SET inactivity_deadline_at = LEAST(
        turn_row.absolute_deadline_at,
        v_activity_at + interval '10 minutes'
      ),
      updated_at = v_now
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.id = v_attempt.turn_id;
  UPDATE public.companion_runtime_instances instance
  SET last_write_epoch = GREATEST(instance.last_write_epoch, p_claim_epoch), updated_at = v_now
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;

  recorded := jsonb_array_length(p_attachments);
  SELECT EXISTS (
    SELECT 1 FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id
      AND entry.companion_id = p_companion_id
      AND entry.event_id LIKE ('v2:' || p_work_id::text || ':%')
      AND entry.role IN ('assistant', 'decision')
  ) INTO has_visible_output;
  RETURN NEXT;
END
$function$;
--> statement-breakpoint
