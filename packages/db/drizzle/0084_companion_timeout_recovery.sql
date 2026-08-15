-- Timeout recovery is deliberately one-shot. Existing #305 timeout rows need their unanswered
-- user tail re-delivered after migration 0084, while a tail Pi accepts later must not be reset on
-- every thread read or live sync.

ALTER TABLE "companion_threads" ADD COLUMN "timeout_recovery_ordinal" integer;--> statement-breakpoint

ALTER TABLE "companion_threads"
  ADD CONSTRAINT "companion_threads_timeout_recovery_ordinal_check"
  CHECK ("timeout_recovery_ordinal" is null or "timeout_recovery_ordinal" >= 0);--> statement-breakpoint

-- A Viewer may cause deadline settlement by reading a thread, but remains unable to update either
-- table directly under FORCE RLS. This definer is the narrow control-plane capability: it validates
-- the current tenant/user ACL, performs only running->timeout CAS updates, and assesses each timeout
-- exactly once for delivery-watermark recovery. The requested clock is clamped to the database clock
-- so a caller cannot expire a live run early.
CREATE FUNCTION public.companion_expire_tool_runs(
  p_org_id uuid,
  p_companion_id uuid,
  p_now timestamp with time zone
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
      to_jsonb('Timed out after 90 seconds without a tool result.'::text)
    )
    WHERE e.org_id = p_org_id
      AND e.companion_id = p_companion_id
      AND e.role::text = 'tool'
      AND e.tool->>'status' = 'running'
      AND e.created_at <= effective_now - interval '90 seconds'
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
          THEN (
            SELECT max(prior.ordinal)
            FROM public.companion_transcript_entries prior
            WHERE prior.org_id = p_org_id
              AND prior.companion_id = p_companion_id
              AND prior.role::text = 'user'
              AND prior.ordinal < timeout_row.ordinal
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
      WHERE p.oid = 'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone)'::regprocedure
    ))
  )
  WITH CHECK (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone)'::regprocedure
    ))
  );--> statement-breakpoint

CREATE POLICY "companion_threads_timeout_maintenance_rls"
  ON "companion_threads"
  FOR UPDATE
  USING (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone)'::regprocedure
    ))
  )
  WITH CHECK (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone)'::regprocedure
    ))
  );--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_expire_tool_runs(
  uuid, uuid, timestamp with time zone
) FROM PUBLIC;
