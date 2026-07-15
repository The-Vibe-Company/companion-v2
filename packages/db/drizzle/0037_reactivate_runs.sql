ALTER TABLE "skill_runs" ADD COLUMN "reactivatable_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "activation_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_activation_revision_check" CHECK ("skill_runs"."activation_revision" >= 0);--> statement-breakpoint

UPDATE "skill_runs"
SET "reactivatable_until" = COALESCE("frozen_at", "updated_at") + interval '7 days'
WHERE "status" IN ('frozen', 'canceled')
  AND "sandbox_cleaned_at" IS NULL
  AND "reactivatable_until" IS NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION companion_terminalize_revoked_skill_run(
  p_org_id uuid,
  p_run_id uuid,
  p_creator_id text,
  p_worker_id text,
  p_cleanup_confirmed boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text;
  previous_worker_id text;
  previous_worker_org_id text;
  previous_worker_run_id text;
  previous_worker_creator_id text;
  previous_org_id text;
  cancellation boolean;
  failure_phase "skill_run_phase";
  folded_sequence integer;
  next_sequence integer;
BEGIN
  IF p_org_id IS NULL OR p_run_id IS NULL OR p_creator_id IS NULL OR btrim(p_creator_id) = ''
    OR p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'complete worker lease identity is required' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  previous_worker_id := current_setting('app.run_worker_id', true);
  previous_worker_org_id := current_setting('app.run_worker_org_id', true);
  previous_worker_run_id := current_setting('app.run_worker_run_id', true);
  previous_worker_creator_id := current_setting('app.run_worker_creator_id', true);
  previous_org_id := current_setting('app.org_id', true);
  PERFORM set_config('app.run_worker', 'exact_lease', true);
  PERFORM set_config('app.run_worker_id', p_worker_id, true);
  PERFORM set_config('app.run_worker_org_id', p_org_id::text, true);
  PERFORM set_config('app.run_worker_run_id', p_run_id::text, true);
  PERFORM set_config('app.run_worker_creator_id', p_creator_id, true);
  PERFORM set_config('app.org_id', p_org_id::text, true);

  SELECT r."cancel_requested_at" IS NOT NULL OR r."status" = 'canceled',
         r."phase", r."transcript_event_sequence"
  INTO cancellation, failure_phase, folded_sequence
  FROM public."skill_runs" r
  JOIN public."skill_run_jobs" j
    ON j."org_id" = r."org_id" AND j."run_id" = r."id" AND j."creator_id" = r."creator_id"
  WHERE r."org_id" = p_org_id AND r."id" = p_run_id AND r."creator_id" = p_creator_id
    AND j."status" = 'leased' AND j."lease_owner" = p_worker_id
    AND j."lease_expires_at" > clock_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM public."memberships" m
      WHERE m."org_id" = r."org_id" AND m."user_id" = r."creator_id"
    )
  FOR UPDATE OF r, j;
  IF cancellation IS NULL THEN
    PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
    PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
    PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
    PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
    PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
    PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
    RETURN false;
  END IF;

  UPDATE public."skill_runs" r
  SET "status" = CASE WHEN cancellation THEN 'canceled'::"skill_run_status" ELSE 'error'::"skill_run_status" END,
      "phase" = CASE WHEN cancellation THEN 'complete'::"skill_run_phase" ELSE failure_phase END,
      "error_code" = CASE WHEN cancellation THEN NULL ELSE 'membership_revoked' END,
      "user_message" = CASE WHEN cancellation THEN NULL ELSE 'Run stopped because its owner is no longer an organization member' END,
      "frozen_at" = clock_timestamp(),
      "sandbox_cleaned_at" = CASE
        WHEN p_cleanup_confirmed THEN COALESCE(r."sandbox_cleaned_at", clock_timestamp())
        ELSE r."sandbox_cleaned_at"
      END,
      "updated_at" = clock_timestamp()
  WHERE r."org_id" = p_org_id AND r."id" = p_run_id AND r."creator_id" = p_creator_id;

  IF NOT cancellation THEN
    SELECT GREATEST(COALESCE(MAX(e."sequence"), 0), folded_sequence) + 1 INTO next_sequence
    FROM public."skill_run_events" e
    WHERE e."org_id" = p_org_id AND e."run_id" = p_run_id;
    INSERT INTO public."skill_run_events" ("org_id", "run_id", "sequence", "type", "payload")
    VALUES (
      p_org_id,
      p_run_id,
      next_sequence,
      'run.error',
      jsonb_build_object(
        'code', 'membership_revoked',
        'message', 'Run stopped because its owner is no longer an organization member',
        'phase', failure_phase::text
      )
    );
  END IF;

  UPDATE public."skill_run_prompts" p
  SET "status" = 'canceled', "lease_owner" = NULL, "lease_expires_at" = NULL,
      "heartbeat_at" = clock_timestamp(), "updated_at" = clock_timestamp()
  WHERE p."org_id" = p_org_id AND p."run_id" = p_run_id
    AND p."status" IN ('queued', 'processing');

  UPDATE public."skill_run_jobs" j
  SET "status" = CASE WHEN cancellation THEN 'canceled'::"skill_run_job_status" ELSE 'failed'::"skill_run_job_status" END,
      "phase" = CASE WHEN cancellation THEN 'complete'::"skill_run_phase" ELSE failure_phase END,
      "lease_owner" = NULL, "lease_expires_at" = NULL,
      "heartbeat_at" = clock_timestamp(), "last_error_code" = CASE WHEN cancellation THEN NULL ELSE 'membership_revoked' END,
      "updated_at" = clock_timestamp()
  WHERE j."org_id" = p_org_id AND j."run_id" = p_run_id AND j."creator_id" = p_creator_id
    AND j."status" = 'leased' AND j."lease_owner" = p_worker_id;

  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
  PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
  PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
  PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
  PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
  PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
  PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
  PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
  PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
  RAISE;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_terminalize_revoked_skill_run(uuid, uuid, text, text, boolean) FROM PUBLIC;--> statement-breakpoint

DROP INDEX "skill_run_prompts_pending_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "skill_run_prompts_pending_uq" ON "skill_run_prompts" ("org_id", "run_id") WHERE "status" = 'processing';--> statement-breakpoint

CREATE OR REPLACE FUNCTION companion_claim_skill_run_cleanups(p_worker_id text, p_limit integer DEFAULT 1, p_lease_seconds integer DEFAULT 30)
RETURNS TABLE (
  "org_id" uuid,
  "run_id" uuid,
  "creator_id" text,
  "sandbox_id" text,
  "sandbox_name" text,
  "cleanup_attempt" integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker id is required' USING ERRCODE = '22023';
  END IF;
  IF p_limit < 1 OR p_limit > 32 OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'invalid cleanup claim limits' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  PERFORM set_config('app.run_worker', 'cleanup', true);
  RETURN QUERY
  WITH candidates AS (
    SELECT r."org_id", r."id"
    FROM public."skill_runs" r
    WHERE r."status" IN ('frozen', 'error', 'canceled')
      AND r."sandbox_cleaned_at" IS NULL
      AND (r."cleanup_lease_expires_at" IS NULL OR r."cleanup_lease_expires_at" <= clock_timestamp())
      AND (
        r."status" = 'error'
        OR (
          r."status" IN ('frozen', 'canceled')
          AND (r."reactivatable_until" IS NULL OR r."reactivatable_until" <= clock_timestamp())
        )
      )
    ORDER BY r."updated_at", r."id"
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public."skill_runs" r
    SET "cleanup_lease_owner" = p_worker_id,
        "cleanup_lease_expires_at" = clock_timestamp() + make_interval(secs => p_lease_seconds),
        "cleanup_attempt" = r."cleanup_attempt" + 1
    FROM candidates c
    WHERE r."org_id" = c."org_id" AND r."id" = c."id"
    RETURNING r."org_id", r."id", r."creator_id", r."sandbox_id", r."sandbox_name", r."cleanup_attempt"
  )
  SELECT c."org_id", c."id", c."creator_id", c."sandbox_id", c."sandbox_name", c."cleanup_attempt"
  FROM claimed c;
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  RAISE;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_skill_run_cleanups(text, integer, integer) FROM PUBLIC;
