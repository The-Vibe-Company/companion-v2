-- Durable routine-run history foundation. A routine fire remains one ordinary Companion turn and
-- its turn id is the stable run id. This migration only adds nullable associations and read models;
-- isolated Pi execution and terminal-surface writes arrive in a later runtime migration.

CREATE TYPE public.companion_routine_surface_mode AS ENUM ('relay', 'notify');
--> statement-breakpoint

ALTER TABLE public.companion_turns
  ADD COLUMN routine_snapshot_id uuid;
--> statement-breakpoint

-- Fires created before this migration retain the routine id while the routine exists. Copy it to a
-- plain snapshot column before a later routine deletion can SET NULL on the existing FK column.
UPDATE public.companion_turns
SET routine_snapshot_id = routine_id
WHERE routine_name IS NOT NULL AND routine_snapshot_id IS NULL AND routine_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.companion_turns
  ADD CONSTRAINT companion_turns_routine_snapshot_check
  CHECK (routine_snapshot_id IS NULL OR routine_name IS NOT NULL);
--> statement-breakpoint

CREATE INDEX companion_turns_routine_snapshot_idx
  ON public.companion_turns (org_id, companion_id, routine_snapshot_id, queue_sequence, id)
  WHERE routine_snapshot_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.companion_transcript_entries
  ADD COLUMN turn_id uuid;
--> statement-breakpoint

ALTER TABLE public.companion_transcript_entries
  ADD CONSTRAINT companion_transcript_entries_turn_fk
  FOREIGN KEY (org_id, companion_id, turn_id)
  REFERENCES public.companion_turns(org_id, companion_id, id)
  ON DELETE CASCADE;
--> statement-breakpoint

CREATE INDEX companion_transcript_entries_turn_idx
  ON public.companion_transcript_entries (org_id, companion_id, turn_id)
  WHERE turn_id IS NOT NULL;
--> statement-breakpoint

-- Current enqueue writes the user projection before the turn row. The pair of compatibility
-- triggers associates both that user row and later v2 attempt projections without changing their
-- existing JSON shape. New routine/internal projections can also provide turn_id explicitly.
CREATE FUNCTION public.companion_assign_transcript_turn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
BEGIN
  IF NEW.turn_id IS NULL THEN
    SELECT turn_row.id INTO NEW.turn_id
    FROM public.companion_turns turn_row
    WHERE turn_row.org_id = NEW.org_id
      AND turn_row.companion_id = NEW.companion_id
      AND turn_row.message_event_id = NEW.event_id
    LIMIT 1;
  END IF;
  IF NEW.turn_id IS NULL THEN
    SELECT attempt.turn_id INTO NEW.turn_id
    FROM public.companion_turn_attempts attempt
    WHERE attempt.org_id = NEW.org_id
      AND attempt.companion_id = NEW.companion_id
      AND NEW.event_id LIKE ('v2:' || attempt.id::text || ':%')
    ORDER BY attempt.attempt_number DESC, attempt.id DESC
    LIMIT 1;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER companion_transcript_entries_assign_turn
BEFORE INSERT ON public.companion_transcript_entries
FOR EACH ROW
EXECUTE FUNCTION public.companion_assign_transcript_turn();
--> statement-breakpoint

CREATE FUNCTION public.companion_associate_turn_transcript()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
BEGIN
  UPDATE public.companion_transcript_entries entry
  SET turn_id = NEW.id
  WHERE entry.org_id = NEW.org_id
    AND entry.companion_id = NEW.companion_id
    AND entry.event_id = NEW.message_event_id
    AND entry.turn_id IS NULL;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER companion_turns_associate_transcript
AFTER INSERT ON public.companion_turns
FOR EACH ROW
EXECUTE FUNCTION public.companion_associate_turn_transcript();
--> statement-breakpoint

CREATE FUNCTION public.companion_capture_routine_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.routine_name IS NOT NULL AND NEW.routine_snapshot_id IS NULL THEN
    NEW.routine_snapshot_id := NEW.routine_id;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER companion_turns_capture_routine_snapshot
BEFORE INSERT ON public.companion_turns
FOR EACH ROW
EXECUTE FUNCTION public.companion_capture_routine_snapshot();
--> statement-breakpoint

CREATE TABLE public.companion_routine_run_entries (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  run_id uuid NOT NULL,
  event_id text NOT NULL,
  ordinal integer NOT NULL,
  role public.companion_transcript_role NOT NULL,
  content text NOT NULL,
  reasoning text,
  tool jsonb,
  decision jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_routine_run_entries_pk
    PRIMARY KEY (org_id, companion_id, run_id, event_id),
  CONSTRAINT companion_routine_run_entries_run_fk
    FOREIGN KEY (org_id, companion_id, run_id)
    REFERENCES public.companion_turns(org_id, companion_id, id)
    ON DELETE CASCADE,
  CONSTRAINT companion_routine_run_entries_ordinal_uq
    UNIQUE (companion_id, run_id, ordinal),
  CONSTRAINT companion_routine_run_entries_event_check
    CHECK (char_length(event_id) BETWEEN 1 AND 200 AND event_id !~ E'[\n\r]'),
  CONSTRAINT companion_routine_run_entries_ordinal_check
    CHECK (ordinal >= 0),
  CONSTRAINT companion_routine_run_entries_content_check
    CHECK (octet_length(content) <= 1048576),
  CONSTRAINT companion_routine_run_entries_reasoning_check
    CHECK (reasoning IS NULL OR octet_length(reasoning) <= 48000),
  CONSTRAINT companion_routine_run_entries_reasoning_role_check
    CHECK (reasoning IS NULL OR role = 'assistant'),
  CONSTRAINT companion_routine_run_entries_tool_role_check
    CHECK ((role = 'tool') = (tool IS NOT NULL)),
  CONSTRAINT companion_routine_run_entries_tool_size_check
    CHECK (tool IS NULL OR octet_length(tool::text) <= 262144),
  CONSTRAINT companion_routine_run_entries_decision_role_check
    CHECK ((role = 'decision') = (decision IS NOT NULL))
);
--> statement-breakpoint

CREATE INDEX companion_routine_run_entries_run_idx
  ON public.companion_routine_run_entries (org_id, companion_id, run_id, ordinal);
--> statement-breakpoint

CREATE TABLE public.companion_routine_returns (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  run_id uuid NOT NULL,
  mode public.companion_routine_surface_mode NOT NULL,
  main_entry_event_id text NOT NULL,
  relay_turn_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_routine_returns_pk
    PRIMARY KEY (org_id, companion_id, run_id),
  CONSTRAINT companion_routine_returns_run_fk
    FOREIGN KEY (org_id, companion_id, run_id)
    REFERENCES public.companion_turns(org_id, companion_id, id)
    ON DELETE CASCADE,
  CONSTRAINT companion_routine_returns_main_entry_fk
    FOREIGN KEY (companion_id, main_entry_event_id)
    REFERENCES public.companion_transcript_entries(companion_id, event_id)
    ON DELETE CASCADE,
  CONSTRAINT companion_routine_returns_relay_turn_fk
    FOREIGN KEY (org_id, companion_id, relay_turn_id)
    REFERENCES public.companion_turns(org_id, companion_id, id)
    ON DELETE CASCADE,
  CONSTRAINT companion_routine_returns_main_entry_uq
    UNIQUE (companion_id, main_entry_event_id),
  CONSTRAINT companion_routine_returns_relay_turn_uq
    UNIQUE (companion_id, relay_turn_id),
  CONSTRAINT companion_routine_returns_mode_relation_check
    CHECK ((mode = 'relay') = (relay_turn_id IS NOT NULL)),
  CONSTRAINT companion_routine_returns_main_entry_check
    CHECK (char_length(main_entry_event_id) BETWEEN 1 AND 200 AND main_entry_event_id !~ E'[\n\r]')
);
--> statement-breakpoint

ALTER TABLE public.companion_routine_run_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_routine_run_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_routine_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_routine_returns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "companion_routine_run_entries_runtime_function_owner_rls"
  ON public.companion_routine_run_entries FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint

CREATE POLICY "companion_routine_returns_runtime_function_owner_rls"
  ON public.companion_routine_returns FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint

-- Keep all routine-history wire shaping behind the API capability boundary. In particular, this
-- function returns the main entry reference but never copies its content into internal_entries.
CREATE FUNCTION public.companion_api_routine_run_json(
  p_org_id uuid,
  p_companion_id uuid,
  p_run_id uuid,
  p_viewer boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT jsonb_build_object(
    'run_id', turn_row.id,
    'companion_id', turn_row.companion_id,
    'routine', jsonb_build_object(
      'id', COALESCE(turn_row.routine_snapshot_id, turn_row.routine_id),
      'name', turn_row.routine_name
    ),
    'status', turn_row.status,
    'outcome', CASE
      WHEN routine_return.run_id IS NOT NULL THEN 'surfaced'
      WHEN turn_row.status IN ('failed', 'interrupted', 'cancelled') THEN 'error'
      -- During the additive rollout, ordinary main-session routine turns continue to run until
      -- the isolated executor lands. Treat their final assistant entry as the already-visible
      -- equivalent of a notify return instead of falsely calling the run `no_output`.
      WHEN turn_row.status = 'succeeded' AND legacy_surface.event_id IS NOT NULL THEN 'surfaced'
      WHEN turn_row.status = 'succeeded' THEN 'no_output'
      ELSE 'pending'
    END,
    'surface_mode', CASE
      WHEN routine_return.run_id IS NOT NULL THEN routine_return.mode
      WHEN turn_row.status = 'succeeded' AND legacy_surface.event_id IS NOT NULL
        THEN 'notify'::public.companion_routine_surface_mode
      ELSE NULL
    END,
    'main_entry_event_id', CASE
      WHEN routine_return.run_id IS NOT NULL THEN routine_return.main_entry_event_id
      WHEN turn_row.status = 'succeeded' THEN legacy_surface.event_id
      ELSE NULL
    END,
    'relay_turn_id', routine_return.relay_turn_id,
    'created_at', turn_row.created_at,
    'started_at', latest_attempt.started_at,
    'settled_at', turn_row.settled_at,
    'error', CASE
      WHEN p_viewer AND turn_row.last_error_code IS NOT NULL
        THEN public.companion_api_safe_error(
          'runtime_unavailable',
          'Companion runtime needs attention.',
          'none'::public.companion_runtime_error_action
        )
      ELSE public.companion_api_safe_error(
        turn_row.last_error_code, turn_row.last_error_message, turn_row.last_error_action
      )
    END,
    'internal_entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'event_id', entry.event_id,
        'ordinal', entry.ordinal,
        'role', entry.role,
        'content', entry.content,
        'reasoning', entry.reasoning,
        'tool', entry.tool,
        'decision', entry.decision,
        'created_at', entry.created_at
      ) ORDER BY entry.ordinal)
      FROM (
        SELECT
          private_entry.event_id,
          private_entry.ordinal,
          private_entry.role,
          private_entry.content,
          private_entry.reasoning,
          private_entry.tool,
          private_entry.decision,
          private_entry.created_at
        FROM public.companion_routine_run_entries private_entry
        WHERE private_entry.org_id = turn_row.org_id
          AND private_entry.companion_id = turn_row.companion_id
          AND private_entry.run_id = turn_row.id

        UNION ALL

        -- Compatibility projection for routine fires accepted before isolated execution is cut
        -- over. Their main-session entries are exposed as history, except for the final assistant
        -- payload which is referenced exactly once as the virtual notify entry above.
        SELECT
          main_entry.event_id,
          main_entry.ordinal,
          main_entry.role,
          main_entry.content,
          main_entry.reasoning,
          main_entry.tool,
          main_entry.decision,
          main_entry.created_at
        FROM public.companion_transcript_entries main_entry
        WHERE main_entry.org_id = turn_row.org_id
          AND main_entry.companion_id = turn_row.companion_id
          AND main_entry.turn_id = turn_row.id
          AND routine_return.run_id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.companion_routine_run_entries private_entry
            WHERE private_entry.org_id = turn_row.org_id
              AND private_entry.companion_id = turn_row.companion_id
              AND private_entry.run_id = turn_row.id
          )
          AND main_entry.event_id IS DISTINCT FROM legacy_surface.event_id
      ) entry
    ), '[]'::jsonb)
  )
  FROM public.companion_turns turn_row
  LEFT JOIN public.companion_routine_returns routine_return
    ON routine_return.org_id = turn_row.org_id
   AND routine_return.companion_id = turn_row.companion_id
   AND routine_return.run_id = turn_row.id
  LEFT JOIN LATERAL (
    SELECT entry.event_id
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = turn_row.org_id
      AND entry.companion_id = turn_row.companion_id
      AND entry.turn_id = turn_row.id
      AND entry.role = 'assistant'
      AND routine_return.run_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.companion_routine_run_entries private_entry
        WHERE private_entry.org_id = turn_row.org_id
          AND private_entry.companion_id = turn_row.companion_id
          AND private_entry.run_id = turn_row.id
      )
    ORDER BY entry.ordinal DESC, entry.event_id DESC
    LIMIT 1
  ) legacy_surface ON true
  LEFT JOIN LATERAL (
    SELECT attempt.started_at
    FROM public.companion_turn_attempts attempt
    WHERE attempt.org_id = turn_row.org_id
      AND attempt.companion_id = turn_row.companion_id
      AND attempt.turn_id = turn_row.id
    ORDER BY attempt.attempt_number DESC, attempt.id DESC
    LIMIT 1
  ) latest_attempt ON true
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_run_id
    AND turn_row.routine_name IS NOT NULL
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_routine_run_summary_json(
  p_org_id uuid,
  p_companion_id uuid,
  p_run_id uuid,
  p_viewer boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT public.companion_api_routine_run_json(
    p_org_id, p_companion_id, p_run_id, p_viewer
  )
    - 'internal_entries'
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_list_routine_runs(
  p_org_id uuid,
  p_companion_id uuid,
  p_routine_id uuid,
  p_cursor uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (run jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_access text;
BEGIN
  v_access := public.companion_api_require_access(p_org_id, p_companion_id, 'read');
  RETURN QUERY
  SELECT public.companion_api_routine_run_summary_json(
    turn_row.org_id, turn_row.companion_id, turn_row.id, v_access = 'viewer'
  )
  FROM public.companion_turns turn_row
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.routine_name IS NOT NULL
    AND COALESCE(turn_row.routine_snapshot_id, turn_row.routine_id) = p_routine_id
    AND (
      p_cursor IS NULL OR turn_row.queue_sequence < (
        SELECT cursor_turn.queue_sequence
        FROM public.companion_turns cursor_turn
        WHERE cursor_turn.org_id = p_org_id
          AND cursor_turn.companion_id = p_companion_id
          AND cursor_turn.id = p_cursor
          AND cursor_turn.routine_name IS NOT NULL
          AND COALESCE(cursor_turn.routine_snapshot_id, cursor_turn.routine_id) = p_routine_id
      )
    )
  ORDER BY turn_row.queue_sequence DESC, turn_row.id DESC
  LIMIT greatest(1, least(COALESCE(p_limit, 50), 101));
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_get_routine_run(
  p_org_id uuid,
  p_companion_id uuid,
  p_run_id uuid
)
RETURNS TABLE (run jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_access text;
BEGIN
  v_access := public.companion_api_require_access(p_org_id, p_companion_id, 'read');
  RETURN QUERY
  SELECT public.companion_api_routine_run_json(
    p_org_id, p_companion_id, p_run_id, v_access = 'viewer'
  )
  WHERE public.companion_api_routine_run_json(
    p_org_id, p_companion_id, p_run_id, v_access = 'viewer'
  ) IS NOT NULL;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_assign_transcript_turn() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_associate_turn_transcript() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_capture_routine_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_routine_run_json(uuid,uuid,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_routine_run_summary_json(uuid,uuid,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_list_routine_runs(uuid,uuid,uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_get_routine_run(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

-- Post-cutover installs may run this migration after the grants hook. Copy the API capability from
-- the existing read-thread function so a newly-created read surface is never left executable by
-- PUBLIC while the next grants pass is pending.
DO $companion_routine_history_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure('public.companion_api_read_thread(uuid,uuid)');
  v_grantee oid;
  v_role name;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Companion API thread surface is missing' USING ERRCODE = '55000';
  END IF;
  FOR v_grantee IN
    SELECT DISTINCT acl.grantee
    FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
    ) acl
    WHERE source_proc.oid = v_source
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> source_proc.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid = v_grantee;
    IF v_role IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.companion_api_list_routine_runs(uuid,uuid,uuid,uuid,integer) TO %I',
        v_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.companion_api_get_routine_run(uuid,uuid,uuid) TO %I',
        v_role
      );
    END IF;
  END LOOP;
END
$companion_routine_history_acl$;
