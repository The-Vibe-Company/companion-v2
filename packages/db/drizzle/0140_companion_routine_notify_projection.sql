-- Thread readers need routine-return mode and stable routine identity in one bounded database call.
-- Keep this behind the existing API access capability; clients still receive only the grouped
-- projection assembled by packages/core, never private routine-run transcript entries.
DO $companion_thread_routine_snapshot_identity$
DECLARE
  v_signature text := 'public.companion_api_read_thread(uuid,uuid)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$'id', origin.routine_id,$r$;
  v_new text := $r$'id', COALESCE(origin.routine_snapshot_id, origin.routine_id),$r$;
  v_count integer;
BEGIN
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'thread routine identity rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_thread_routine_snapshot_identity$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_routine_notify_returns(
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
  WITH authorized AS (
    SELECT public.companion_api_require_access(p_org_id, p_companion_id, 'read') AS access_role
  ), notify_returns AS (
    SELECT
      returned.run_id,
      COALESCE(run_turn.routine_snapshot_id, run_turn.routine_id) AS routine_id,
      run_turn.routine_name,
      returned.main_entry_event_id,
      main_entry.ordinal
    FROM authorized
    JOIN public.companion_routine_returns returned
      ON returned.org_id = p_org_id
     AND returned.companion_id = p_companion_id
     AND returned.mode = 'notify'
    JOIN public.companion_turns run_turn
      ON run_turn.org_id = returned.org_id
     AND run_turn.companion_id = returned.companion_id
     AND run_turn.id = returned.run_id
    JOIN public.companion_transcript_entries main_entry
      ON main_entry.org_id = returned.org_id
     AND main_entry.companion_id = returned.companion_id
     AND main_entry.event_id = returned.main_entry_event_id
    WHERE COALESCE(run_turn.routine_snapshot_id, run_turn.routine_id) IS NOT NULL
      AND run_turn.routine_name IS NOT NULL

    UNION ALL

    -- Compatibility for routine turns accepted before isolated routine returns were introduced.
    SELECT
      run_turn.id,
      COALESCE(run_turn.routine_snapshot_id, run_turn.routine_id),
      run_turn.routine_name,
      legacy_surface.event_id,
      legacy_surface.ordinal
    FROM authorized
    JOIN public.companion_turns run_turn
      ON run_turn.org_id = p_org_id
     AND run_turn.companion_id = p_companion_id
    JOIN LATERAL (
      SELECT entry.event_id, entry.ordinal
      FROM public.companion_transcript_entries entry
      WHERE entry.org_id = run_turn.org_id
        AND entry.companion_id = run_turn.companion_id
        AND entry.turn_id = run_turn.id
        AND entry.role = 'assistant'
      ORDER BY entry.ordinal DESC, entry.event_id DESC
      LIMIT 1
    ) legacy_surface ON true
    WHERE run_turn.status = 'succeeded'
      AND COALESCE(run_turn.routine_snapshot_id, run_turn.routine_id) IS NOT NULL
      AND run_turn.routine_name IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.companion_routine_returns returned
        WHERE returned.org_id = run_turn.org_id
          AND returned.companion_id = run_turn.companion_id
          AND returned.run_id = run_turn.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.companion_routine_run_entries private_entry
        WHERE private_entry.org_id = run_turn.org_id
          AND private_entry.companion_id = run_turn.companion_id
          AND private_entry.run_id = run_turn.id
      )
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'run_id', notify_returns.run_id,
    'routine_id', notify_returns.routine_id,
    'routine_name', notify_returns.routine_name,
    'main_entry_event_id', notify_returns.main_entry_event_id
  ) ORDER BY notify_returns.ordinal, notify_returns.run_id), '[]'::jsonb)
  FROM notify_returns
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_routine_notify_returns(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

DO $companion_routine_notify_projection_acl$
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
        'GRANT EXECUTE ON FUNCTION public.companion_api_routine_notify_returns(uuid,uuid) TO %I',
        v_role
      );
    END IF;
  END LOOP;
END
$companion_routine_notify_projection_acl$;
