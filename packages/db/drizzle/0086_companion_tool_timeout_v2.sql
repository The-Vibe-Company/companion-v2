-- Tool-run deadlines, second revision. One 90-second ceiling proved wrong for shell runs: a
-- legitimate build or test sweep is killed mid-flight while the chip closes as `timeout`. Shell
-- runs now get their own longer deadline, passed by the caller so the detail text and the cutoff
-- can never disagree. The rewind target also becomes total: a timed-out tool with no earlier user
-- message re-pends only the tail after itself instead of resetting the watermark to NULL, which
-- re-delivered every message in the thread.

DROP POLICY "companion_transcript_entries_timeout_maintenance_rls" ON "companion_transcript_entries";--> statement-breakpoint

DROP POLICY "companion_threads_timeout_maintenance_rls" ON "companion_threads";--> statement-breakpoint

DROP FUNCTION public.companion_expire_tool_runs(uuid, uuid, timestamp with time zone);--> statement-breakpoint

-- A Viewer may cause deadline settlement by reading a thread, but remains unable to update either
-- table directly under FORCE RLS. This definer is the narrow control-plane capability: it validates
-- the current tenant/user ACL, performs only running->timeout CAS updates, and assesses each timeout
-- exactly once for delivery-watermark recovery. The requested clock is clamped to the database clock
-- so a caller cannot expire a live run early, and both timeouts are clamped to sane bounds so a
-- compromised API session cannot expire everything instantly or postpone settlement forever.
CREATE FUNCTION public.companion_expire_tool_runs(
  p_org_id uuid,
  p_companion_id uuid,
  p_now timestamp with time zone,
  p_timeout_seconds integer,
  p_exec_timeout_seconds integer
)
RETURNS TABLE (event_id text, kind text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller_id text := NULLIF(current_setting('app.user_id', true), '');
  effective_now timestamp with time zone := LEAST(
    COALESCE(p_now, statement_timestamp()),
    statement_timestamp()
  );
  base_seconds integer := LEAST(GREATEST(COALESCE(p_timeout_seconds, 90), 30), 3600);
  exec_seconds integer := LEAST(GREATEST(COALESCE(p_exec_timeout_seconds, 600), 30), 3600);
  timeout_row record;
BEGIN
  IF caller_id IS NULL
    OR p_org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid
    OR NOT EXISTS (
      SELECT 1
      FROM public.memberships m
      JOIN public.companions c ON c.org_id = m.org_id
      WHERE m.org_id = p_org_id
        AND m.user_id = caller_id
        AND c.id = p_companion_id
        AND (
          c.owner_id = caller_id
          OR EXISTS (
            SELECT 1
            FROM public.companion_workspace_access a
            WHERE a.org_id = c.org_id AND a.companion_id = c.id
          )
        )
    ) THEN
    RETURN;
  END IF;

  RETURN QUERY
    UPDATE public.companion_transcript_entries e
    SET tool = jsonb_set(
      jsonb_set(e.tool, '{status}', to_jsonb('timeout'::text)),
      '{detail}',
      to_jsonb(
        'Timed out after '
        || CASE WHEN e.tool->>'kind' = 'shell' THEN exec_seconds ELSE base_seconds END
        || ' seconds without a tool result.'
      )
    )
    WHERE e.org_id = p_org_id
      AND e.companion_id = p_companion_id
      AND e.role::text = 'tool'
      AND e.tool->>'status' = 'running'
      AND e.created_at <= effective_now - make_interval(
        secs => CASE WHEN e.tool->>'kind' = 'shell' THEN exec_seconds ELSE base_seconds END
      )
    RETURNING e.event_id, e.tool->>'kind';

  FOR timeout_row IN
    SELECT e.ordinal
    FROM public.companion_transcript_entries e
    WHERE e.org_id = p_org_id
      AND e.companion_id = p_companion_id
      AND e.role::text = 'tool'
      AND e.tool->>'status' = 'timeout'
    ORDER BY e.ordinal
  LOOP
    UPDATE public.companion_threads t
    SET delivered_ordinal = CASE
          WHEN t.delivered_ordinal > timeout_row.ordinal
            AND NOT EXISTS (
              SELECT 1
              FROM public.companion_transcript_entries later
              WHERE later.org_id = p_org_id
                AND later.companion_id = p_companion_id
                AND later.role::text = 'assistant'
                AND later.ordinal > timeout_row.ordinal
            )
          -- A thread whose very first turn timed out has no earlier user ordinal to rewind to.
          -- Falling back to the tool's own ordinal re-pends exactly the unanswered tail; NULL
          -- would mark every message in the thread undelivered and prompt Pi with all of them.
          THEN COALESCE(
            (
              SELECT max(prior.ordinal)
              FROM public.companion_transcript_entries prior
              WHERE prior.org_id = p_org_id
                AND prior.companion_id = p_companion_id
                AND prior.role::text = 'user'
                AND prior.ordinal < timeout_row.ordinal
            ),
            timeout_row.ordinal
          )
          ELSE t.delivered_ordinal
        END,
        timeout_recovery_ordinal = greatest(
          coalesce(t.timeout_recovery_ordinal, -1), timeout_row.ordinal
        ),
        updated_at = statement_timestamp()
    WHERE t.org_id = p_org_id
      AND t.companion_id = p_companion_id
      AND coalesce(t.timeout_recovery_ordinal, -1) < timeout_row.ordinal;
  END LOOP;
END
$$;--> statement-breakpoint

-- FORCE RLS also applies to the production NOSUPERUSER/NOBYPASSRLS migration owner. These policies
-- admit only the current owner of the exact constrained function above; API sessions remain subject
-- to the Owner/Editor write policies and cannot use these table capabilities directly.
CREATE POLICY "companion_transcript_entries_timeout_maintenance_rls"
  ON "companion_transcript_entries"
  FOR UPDATE
  USING (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)'::regprocedure
    ))
  )
  WITH CHECK (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)'::regprocedure
    ))
  );--> statement-breakpoint

CREATE POLICY "companion_threads_timeout_maintenance_rls"
  ON "companion_threads"
  FOR UPDATE
  USING (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)'::regprocedure
    ))
  )
  WITH CHECK (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)'::regprocedure
    ))
  );--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_expire_tool_runs(
  uuid, uuid, timestamp with time zone, integer, integer
) FROM PUBLIC;
