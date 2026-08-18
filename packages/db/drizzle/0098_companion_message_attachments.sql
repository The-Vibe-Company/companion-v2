-- Chat attachments, part one: what a member sends.
--
-- A Companion turn could only ever carry text. This migration gives one transcript entry a bounded
-- list of files, stored in object storage and referenced here by key, so the runtime can stage them
-- read-only on the Box before it dispatches the prompt and every reader — including a Viewer — can
-- fetch them back through the control plane without the Box ever being contacted.
--
-- The table is deliberately one table for both directions. `kind` separates a file a member vouched
-- for from an image Pi produced (migration 0099 writes those), because a reader must never be able
-- to mistake one for the other, and keeping them in one place means one RLS boundary, one purge
-- path, and one projection instead of two of each.

CREATE TYPE "public"."companion_attachment_kind" AS ENUM('user_upload', 'pi_output');
--> statement-breakpoint

CREATE TABLE "companion_message_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "companion_id" uuid NOT NULL,
  "entry_event_id" text NOT NULL,
  "kind" "public"."companion_attachment_kind" NOT NULL,
  "storage_key" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "sha256" text NOT NULL,
  "filename" text NOT NULL,
  "position" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- One entry never holds two files in the same slot, so a projection ordered by position is stable
  -- across reads and a replayed enqueue compares like for like.
  CONSTRAINT "companion_message_attachments_position_uq"
    UNIQUE ("companion_id", "entry_event_id", "position"),
  -- Keys are content-addressed under the owning message or attempt, so two rows sharing one key
  -- would mean two rows owning the same bytes -- and a purge of either would strand the other.
  CONSTRAINT "companion_message_attachments_storage_key_uq" UNIQUE ("storage_key"),
  CONSTRAINT "companion_message_attachments_storage_key_check" CHECK (
    "storage_key" ~ '^[A-Za-z0-9][A-Za-z0-9/._-]*$'
    AND char_length("storage_key") BETWEEN 1 AND 512
  ),
  -- The stored type is resolved from the bytes at upload, never from what a client declared, and
  -- the list here is the same allowlist the contract enforces.
  CONSTRAINT "companion_message_attachments_content_type_check" CHECK (
    "content_type" IN (
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'application/pdf', 'text/csv', 'text/plain', 'text/markdown', 'application/json'
    )
  ),
  -- Pi hands back images only. A document appearing as a Pi output would mean the harvest read
  -- something it was never allowed to read.
  CONSTRAINT "companion_message_attachments_output_image_check" CHECK (
    "kind" <> 'pi_output'
    OR "content_type" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  ),
  CONSTRAINT "companion_message_attachments_byte_size_check" CHECK (
    "byte_size" BETWEEN 1 AND 10485760
  ),
  CONSTRAINT "companion_message_attachments_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  -- The filename is interpolated into a Box path and into the prompt suffix naming that path, so
  -- the charset is narrow enough that there is nothing left to quote, escape, or traverse.
  CONSTRAINT "companion_message_attachments_filename_check" CHECK (
    "filename" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  ),
  CONSTRAINT "companion_message_attachments_position_check" CHECK ("position" BETWEEN 0 AND 9),
  CONSTRAINT "companion_message_attachments_entry_event_check" CHECK (
    char_length("entry_event_id") BETWEEN 1 AND 200 AND "entry_event_id" !~ E'[\\n\\r]'
  )
);
--> statement-breakpoint

ALTER TABLE "companion_message_attachments"
  ADD CONSTRAINT "companion_message_attachments_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_message_attachments"
  ADD CONSTRAINT "companion_message_attachments_companion_fk"
  FOREIGN KEY ("org_id", "companion_id")
  REFERENCES "public"."companions"("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
-- An attachment exists only as part of an entry someone can read. Deleting the transcript entry
-- removes its files, which is what makes the purge below complete rather than best-effort.
ALTER TABLE "companion_message_attachments"
  ADD CONSTRAINT "companion_message_attachments_entry_fk"
  FOREIGN KEY ("companion_id", "entry_event_id")
  REFERENCES "public"."companion_transcript_entries"("companion_id", "event_id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "companion_message_attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_message_attachments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Like every Runtime v2 table, no login role reads this directly. The API and the runtime reach it
-- only through the SECURITY DEFINER surface below, which re-authorizes on each call.
CREATE POLICY "companion_message_attachments_function_owner_rls"
  ON "companion_message_attachments" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint

-- Fail-closed purge of the stored bytes.
--
-- Whatever removes an attachment row -- a Companion delete settling, a transcript entry cascading, a
-- tenant being removed -- the object it points at must stop existing too. Journaling that from the
-- delete branch of one settlement function would only cover the path that function owns, so it is a
-- row trigger instead: it runs inside the same transaction as the delete, so the object is either
-- scheduled for removal or the delete did not happen, and it covers every cascade for free.
--
-- The queue is the existing durable object-deletion outbox the worker already drains; it is keyed by
-- storage key and carries no skill-database semantics, so a Companion attachment key is exactly the
-- kind of work it was built to retry until the object is gone.
CREATE FUNCTION public.companion_enqueue_attachment_object_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.skill_database_object_deletions(storage_key, org_id)
  VALUES (OLD.storage_key, OLD.org_id)
  ON CONFLICT (storage_key) DO NOTHING;
  RETURN OLD;
END
$$;
--> statement-breakpoint

CREATE TRIGGER "companion_message_attachments_purge_objects"
  AFTER DELETE ON "companion_message_attachments"
  FOR EACH ROW EXECUTE FUNCTION public.companion_enqueue_attachment_object_deletion();
--> statement-breakpoint

-- Validate one send's attachment list before anything durable is written. Every bound the contract
-- states is restated here, because the API is not the only caller a definer function must survive.
CREATE FUNCTION public.companion_api_assert_message_attachments(
  p_org_id uuid,
  p_companion_id uuid,
  p_attachments jsonb
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_total bigint;
  v_prefix text := 'companion-attachments/' || p_org_id::text || '/' || p_companion_id::text || '/';
BEGIN
  IF p_attachments IS NULL OR jsonb_typeof(p_attachments) <> 'array' THEN
    RAISE EXCEPTION 'Companion message attachments must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_attachments) > 5 THEN
    RAISE EXCEPTION 'a Companion message carries at most 5 attachments' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_attachments) WITH ORDINALITY AS part(value, ordinality)
    WHERE jsonb_typeof(part.value) <> 'object'
      OR COALESCE(part.value ->> 'position', '') <> (part.ordinality - 1)::text
      OR COALESCE(part.value ->> 'storage_key', '') !~ '^[A-Za-z0-9][A-Za-z0-9/._-]*$'
      OR char_length(COALESCE(part.value ->> 'storage_key', '')) NOT BETWEEN 1 AND 512
      -- The key must live under this tenant's own prefix. Today the only caller builds it, but a
      -- future one that forwards a client-supplied key would otherwise turn the read route into a
      -- cross-tenant object reader and hand another tenant's key to the deletion outbox.
      OR left(COALESCE(part.value ->> 'storage_key', ''), char_length(v_prefix)) <> v_prefix
      OR COALESCE(part.value ->> 'content_type', '') NOT IN (
        'image/png', 'image/jpeg', 'image/webp', 'image/gif',
        'application/pdf', 'text/csv', 'text/plain', 'text/markdown', 'application/json'
      )
      OR COALESCE(part.value ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
      OR COALESCE(part.value ->> 'filename', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
      OR COALESCE(part.value ->> 'byte_size', '') !~ '^[1-9][0-9]{0,7}$'
      OR (part.value ->> 'byte_size')::bigint > 10485760
  ) THEN
    RAISE EXCEPTION 'invalid Companion message attachment' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(sum((part.value ->> 'byte_size')::bigint), 0) INTO v_total
  FROM jsonb_array_elements(p_attachments) part;
  IF v_total > 52428800 THEN
    RAISE EXCEPTION 'Companion message attachments exceed the per-send byte budget'
      USING ERRCODE = '22023';
  END IF;
END
$$;
--> statement-breakpoint

-- The comparable content of one send's attachments: what a replay must match exactly. Storage keys
-- and row ids are deliberately absent, so re-uploading identical bytes under a fresh row id is the
-- same intent while a different file at the same position is not.
CREATE FUNCTION public.companion_api_message_attachment_intent(p_attachments jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'position', (part.ordinality - 1)::integer,
      'content_type', part.value ->> 'content_type',
      'byte_size', (part.value ->> 'byte_size')::integer,
      'filename', part.value ->> 'filename',
      'sha256', part.value ->> 'sha256'
    ) ORDER BY part.ordinality)
    FROM jsonb_array_elements(p_attachments) WITH ORDINALITY AS part(value, ordinality)
  ), '[]'::jsonb)
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_stored_attachment_intent(
  p_org_id uuid,
  p_companion_id uuid,
  p_entry_event_id text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'position', attachment.position,
      'content_type', attachment.content_type,
      'byte_size', attachment.byte_size,
      'filename', attachment.filename,
      'sha256', attachment.sha256
    ) ORDER BY attachment.position)
    FROM public.companion_message_attachments attachment
    WHERE attachment.org_id = p_org_id
      AND attachment.companion_id = p_companion_id
      AND attachment.entry_event_id = p_entry_event_id
      AND attachment.kind = 'user_upload'
  ), '[]'::jsonb)
$$;
--> statement-breakpoint

-- The parameter list changes, so this is a DROP + CREATE rather than a replace: leaving the old
-- signature in place would keep a second, attachment-blind overload callable, and the grants hook
-- names exact signatures.
DROP FUNCTION public.companion_api_enqueue_turn(
  uuid, uuid, uuid, text, public.companion_client_surface
);
--> statement-breakpoint

CREATE FUNCTION public.companion_api_enqueue_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_client_message_id uuid,
  p_content text,
  p_client_surface public.companion_client_surface,
  -- Defaulted so the previous release's positional five-argument call still resolves. The release
  -- order runs migrations before the matching application processes start, so without this every
  -- send from a still-running old replica would raise 42883 for the whole rollout window, and a
  -- code-only rollback would leave sends broken until the schema was rolled back too.
  p_attachments jsonb DEFAULT '[]'::jsonb
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
      AND entry.event_id = v_message_event_id
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
       OR v_existing_content IS DISTINCT FROM btrim(p_content)
       -- A retried send re-uploads identical bytes to identical content-addressed keys, so the
       -- comparison is over what the files are, not which rows or objects happen to hold them.
       OR public.companion_api_stored_attachment_intent(
            p_org_id, p_companion_id, v_message_event_id
          ) IS DISTINCT FROM public.companion_api_message_attachment_intent(v_attachments) THEN
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
      p_org_id, p_companion_id, v_message_event_id,
      v_message_ordinal, 'user', btrim(p_content), v_actor_id, v_now
    );

    -- The message and its files land in one transaction. A turn can therefore never become
    -- claimable while the runtime would find only some of the attachments it must stage.
    INSERT INTO public.companion_message_attachments(
      org_id, companion_id, entry_event_id, kind, storage_key,
      content_type, byte_size, sha256, filename, position, created_at
    )
    SELECT p_org_id, p_companion_id, v_message_event_id, 'user_upload',
      part.value ->> 'storage_key',
      part.value ->> 'content_type',
      (part.value ->> 'byte_size')::integer,
      part.value ->> 'sha256',
      part.value ->> 'filename',
      (part.ordinality - 1)::integer,
      v_now
    FROM jsonb_array_elements(v_attachments) WITH ORDINALITY AS part(value, ordinality);

    INSERT INTO public.companion_turns(
      org_id, companion_id, client_message_id, message_event_id, queue_sequence,
      actor_id, client_surface, status, created_at, updated_at
    ) VALUES (
      p_org_id, p_companion_id, p_client_message_id,
      v_message_event_id, 0, v_actor_id, p_client_surface,
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
$function$;
--> statement-breakpoint

-- Serve one attachment's bytes to anyone who may read the thread it belongs to. Access is resolved
-- on this call and no other: a URL that worked a minute ago stops working the moment the reader's
-- access does, which is why nothing signed or cacheable is ever handed out instead.
CREATE FUNCTION public.companion_api_read_attachment(
  p_org_id uuid,
  p_companion_id uuid,
  p_attachment_id uuid
)
RETURNS TABLE (
  storage_key text,
  content_type text,
  byte_size integer,
  filename text,
  kind public.companion_attachment_kind
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'read');
  RETURN QUERY
  SELECT attachment.storage_key, attachment.content_type, attachment.byte_size,
         attachment.filename, attachment.kind
  FROM public.companion_message_attachments attachment
  WHERE attachment.org_id = p_org_id
    AND attachment.companion_id = p_companion_id
    AND attachment.id = p_attachment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion attachment not found' USING ERRCODE = 'P0002';
  END IF;
END
$$;
--> statement-breakpoint

-- The projection gains one field per entry. Storage keys never appear: a reader is handed metadata
-- and an id, and fetches bytes through the re-authorizing route above.
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

-- The executor's material gains the staging list. The return type changes, so this is a DROP +
-- CREATE and the grants hook re-resolves the new signature.
DROP FUNCTION public.companion_runtime_get_material(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
);
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_get_material(
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
  turn_id uuid,
  attempt_id uuid,
  message_event_id text,
  prompt_text text,
  decision_request_kind public.companion_decision_request_kind,
  decision_response_payload jsonb,
  provider_material jsonb,
  skill_material jsonb,
  mcp_material jsonb,
  model_input jsonb,
  has_visible_output boolean,
  attachments jsonb,
  credential_snapshot_matches boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_authorization record;
  v_turn_id uuid;
  v_message_event_id text;
  v_prompt_text text;
  v_request_kind public.companion_decision_request_kind;
  v_response_payload jsonb;
  v_provider_material jsonb := '[]'::jsonb;
  v_skill_material jsonb := '[]'::jsonb;
  v_mcp_material jsonb := '[]'::jsonb;
  v_attachments jsonb := '[]'::jsonb;
  v_attachment_bytes bigint := 0;
  v_visible_attempt_id uuid;
  v_has_visible_output boolean := false;
  v_pinned_provider_refs jsonb;
  v_pinned_mcp_refs jsonb;
  v_credential_snapshot_matches boolean := true;
  v_expected integer;
BEGIN
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN
    RETURN;
  END IF;

  v_turn_id := v_authorization.turn_id;
  IF p_work_kind = 'attempt' THEN
    v_visible_attempt_id := p_work_id;
    SELECT attempt.provider_credential_refs, attempt.mcp_credential_refs,
      turn_row.message_event_id, entry.content
    INTO v_pinned_provider_refs, v_pinned_mcp_refs, v_message_event_id, v_prompt_text
    FROM public.companion_turn_attempts attempt
    JOIN public.companion_turns turn_row
      ON turn_row.org_id = attempt.org_id
     AND turn_row.companion_id = attempt.companion_id
     AND turn_row.id = attempt.turn_id
    JOIN public.companion_transcript_entries entry
      ON entry.org_id = turn_row.org_id
     AND entry.companion_id = turn_row.companion_id
     AND entry.event_id = turn_row.message_event_id
    WHERE attempt.org_id = p_org_id
      AND attempt.companion_id = p_companion_id
      AND attempt.id = p_work_id
      AND attempt.turn_id = v_turn_id
      AND attempt.claim_epoch = p_claim_epoch
      AND entry.role = 'user'
      AND entry.author_id = turn_row.actor_id
    FOR UPDATE OF attempt;
    IF NOT FOUND OR v_prompt_text IS NULL OR octet_length(v_prompt_text) > 1048576 THEN
      RAISE EXCEPTION 'claimed turn prompt is unavailable' USING ERRCODE = '22023';
    END IF;

    -- Files the runtime must stage read-only on the Box before it dispatches this prompt. The
    -- storage key travels because only the runtime holds object-storage credentials; the digest
    -- travels so the bytes it downloads can be proven to be the bytes that were accepted.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', attachment.id,
        'storage_key', attachment.storage_key,
        'content_type', attachment.content_type,
        'byte_size', attachment.byte_size,
        'sha256', attachment.sha256,
        'filename', attachment.filename,
        'position', attachment.position
      ) ORDER BY attachment.position), '[]'::jsonb),
      COALESCE(sum(attachment.byte_size), 0)
    INTO v_attachments, v_attachment_bytes
    FROM public.companion_message_attachments attachment
    WHERE attachment.org_id = p_org_id
      AND attachment.companion_id = p_companion_id
      AND attachment.entry_event_id = v_message_event_id
      AND attachment.kind = 'user_upload';
    IF jsonb_array_length(v_attachments) > 5 OR v_attachment_bytes > 52428800 THEN
      RAISE EXCEPTION 'claimed turn attachments exceed the bounded executor contract'
        USING ERRCODE = '22023';
    END IF;

    IF v_pinned_provider_refs IS NULL AND v_pinned_mcp_refs IS NULL THEN
      UPDATE public.companion_turn_attempts attempt
      SET provider_credential_refs = v_authorization.provider_refs,
          mcp_credential_refs = v_authorization.mcp_refs,
          updated_at = clock_timestamp()
      WHERE attempt.org_id = p_org_id
        AND attempt.companion_id = p_companion_id
        AND attempt.id = p_work_id
        AND attempt.claim_epoch = p_claim_epoch;
      v_pinned_provider_refs := v_authorization.provider_refs;
      v_pinned_mcp_refs := v_authorization.mcp_refs;
    ELSIF v_pinned_provider_refs IS NULL
       OR v_pinned_mcp_refs IS NULL
       OR v_pinned_provider_refs IS DISTINCT FROM v_authorization.provider_refs
       OR v_pinned_mcp_refs IS DISTINCT FROM v_authorization.mcp_refs THEN
      v_credential_snapshot_matches := false;
    END IF;
  END IF;

  IF p_work_kind = 'decision' THEN
    SELECT delivery.attempt_id, delivery.request_kind,
      CASE
        WHEN delivery.request_kind = 'question' AND delivery.decision_status = 'answered' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key,
            'value', delivery.response_text
          )
        WHEN delivery.request_kind = 'confirmation' AND delivery.decision_status = 'allowed' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'confirmed', true
          )
        WHEN delivery.request_kind = 'confirmation' AND delivery.decision_status = 'denied' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'confirmed', false
          )
        WHEN delivery.decision_status IN ('denied', 'expired', 'cancelled') THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'cancelled', true
          )
        ELSE NULL
      END
    INTO v_visible_attempt_id, v_request_kind, v_response_payload
    FROM public.companion_decision_deliveries delivery
    WHERE delivery.org_id = p_org_id
      AND delivery.companion_id = p_companion_id
      AND delivery.id = p_work_id
      AND delivery.claim_epoch = p_claim_epoch;
    IF NOT FOUND OR v_response_payload IS NULL OR octet_length(v_response_payload::text) > 32768 THEN
      RAISE EXCEPTION 'claimed decision response is unavailable' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'provider_id', connection.provider_id,
      'auth_method', connection.auth_method,
      'credential_generation', connection.credential_generation,
      'credential_version', connection.credential_version,
      'ciphertext', connection.ciphertext,
      'iv', connection.iv,
      'auth_tag', connection.auth_tag,
      'wrapped_dek', connection.wrapped_dek,
      'wrap_iv', connection.wrap_iv,
      'wrap_auth_tag', connection.wrap_auth_tag,
      'key_id', connection.key_id
    ) ORDER BY connection.provider_id), '[]'::jsonb)
  INTO v_provider_material
  FROM public.companion_provider_connections connection
  WHERE connection.org_id = p_org_id
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_authorization.provider_refs) ref
      WHERE ref ->> 'provider_id' = connection.provider_id
        AND ref ->> 'credential_generation' = connection.credential_generation::text
        AND (ref ->> 'credential_version')::integer = connection.credential_version
    );
  v_expected := jsonb_array_length(v_authorization.provider_refs);
  IF jsonb_array_length(v_provider_material) <> v_expected THEN
    RAISE EXCEPTION 'provider material changed after authorization' USING ERRCODE = '40001';
  END IF;

  IF v_authorization.client_surface IS DISTINCT FROM 'native_mobile' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_authorization.skill_refs) ref
      WHERE jsonb_typeof(ref) <> 'object'
        OR COALESCE(jsonb_typeof(ref -> 'skill_id'), 'missing') <> 'string'
        OR COALESCE(jsonb_typeof(ref -> 'current_version_id'), 'missing') <> 'string'
    ) THEN
      RAISE EXCEPTION 'Skill material is not pinned to an immutable version' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'skill_id', skill.id,
        'slug', skill.slug,
        'version_id', version.id,
        'version', version.version,
        'checksum', version.checksum,
        'size_bytes', version.size_bytes,
        'storage_path', version.storage_path
      ) ORDER BY skill.id), '[]'::jsonb)
    INTO v_skill_material
    FROM public.skills skill
    JOIN public.skill_versions version
      ON version.org_id = skill.org_id AND version.skill_id = skill.id
    WHERE skill.org_id = p_org_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_authorization.skill_refs) ref
        WHERE ref ->> 'skill_id' = skill.id::text
          AND ref ->> 'current_version_id' = version.id::text
      );
    IF jsonb_array_length(v_skill_material) <> jsonb_array_length(v_authorization.skill_refs) THEN
      RAISE EXCEPTION 'Skill material changed after authorization' USING ERRCODE = '40001';
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'account_id', account.id,
        'owner_id', account.owner_id,
        'provider', account.provider,
        'label', account.label,
        'transport', account.transport,
        'account_config', account.account_config,
        'credential_generation', account.credential_generation,
        'ciphertext', account.ciphertext,
        'iv', account.iv,
        'auth_tag', account.auth_tag,
        'wrapped_dek', account.wrapped_dek,
        'wrap_iv', account.wrap_iv,
        'wrap_auth_tag', account.wrap_auth_tag,
        'key_id', account.key_id
      ) ORDER BY account.id), '[]'::jsonb)
    INTO v_mcp_material
    FROM public.companion_mcp_accounts account
    WHERE account.org_id = p_org_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_authorization.mcp_refs) ref
        WHERE ref ->> 'account_id' = account.id::text
          AND ref ->> 'credential_generation' = account.credential_generation::text
      );
    IF jsonb_array_length(v_mcp_material) <> jsonb_array_length(v_authorization.mcp_refs) THEN
      RAISE EXCEPTION 'MCP material changed after authorization' USING ERRCODE = '40001';
    END IF;
  END IF;

  IF octet_length(v_provider_material::text) > 2097152
     OR octet_length(v_skill_material::text) > 2097152
     OR octet_length(v_mcp_material::text) > 4194304 THEN
    RAISE EXCEPTION 'authorized material exceeds the bounded executor contract' USING ERRCODE = '22023';
  END IF;

  IF v_visible_attempt_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.companion_transcript_entries entry
      WHERE entry.org_id = p_org_id
        AND entry.companion_id = p_companion_id
        AND entry.event_id LIKE ('v2:' || v_visible_attempt_id::text || ':%')
        AND entry.role IN ('assistant', 'decision')
    ) INTO v_has_visible_output;
  END IF;

  RETURN QUERY SELECT
    v_turn_id, v_visible_attempt_id, v_message_event_id, v_prompt_text,
    v_request_kind, v_response_payload,
    v_provider_material, v_skill_material, v_mcp_material, NULL::jsonb,
    v_has_visible_output, v_attachments, v_credential_snapshot_matches;
END
$function$;
--> statement-breakpoint
