ALTER TYPE "skill_run_status" ADD VALUE IF NOT EXISTS 'interrupted' BEFORE 'error';--> statement-breakpoint
CREATE TYPE "skill_run_runtime_state" AS ENUM ('healthy', 'degraded');--> statement-breakpoint
CREATE TYPE "sandbox_usage_runtime_policy" AS ENUM ('safety_capped', 'budgeted');--> statement-breakpoint
CREATE TYPE "sandbox_provider_state" AS ENUM ('running', 'stopped', 'missing', 'unknown');--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "runtime_state" "skill_run_runtime_state" DEFAULT 'healthy' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "runtime_degraded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "runtime_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "runtime_reconcile_lease_owner" text;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "runtime_reconcile_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "runtime_reconcile_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_usage_sessions" ADD COLUMN "runtime_policy" "sandbox_usage_runtime_policy" DEFAULT 'safety_capped' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_usage_sessions" ADD COLUMN "runtime_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_usage_sessions" ADD COLUMN "provider_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_usage_sessions" ADD COLUMN "last_provider_state" "sandbox_provider_state" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_usage_sessions" ADD COLUMN "last_provider_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "skill_runs_runtime_reconcile_idx"
ON "skill_runs" ("runtime_state", "runtime_degraded_at", "updated_at")
WHERE "status" IN ('starting', 'running') AND "sandbox_cleaned_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sandbox_usage_runtime_reconcile_idx"
ON "sandbox_usage_sessions" ("runtime_deadline_at", "last_provider_checked_at")
WHERE "ended_at" IS NULL;--> statement-breakpoint

CREATE FUNCTION companion_claim_skill_run_runtime_reconciliations(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 30,
  p_org_ids text DEFAULT NULL
)
RETURNS TABLE (
  "org_id" uuid,
  "run_id" uuid,
  "creator_id" text,
  "sandbox_id" text,
  "sandbox_name" text,
  "timeout_ms" integer,
  "activation_revision" integer,
  "reconcile_generation" integer,
  "runtime_deadline_at" timestamp with time zone
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
    RAISE EXCEPTION 'invalid runtime reconciliation claim limits' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  PERFORM set_config('app.run_worker', 'runtime-reconcile', true);
  RETURN QUERY
  WITH candidates AS (
    SELECT r."org_id", r."id"
    FROM public."skill_runs" r
    LEFT JOIN public."sandbox_usage_sessions" u
      ON u."org_id" = r."org_id"
      AND u."kind" = 'run'
      AND u."source_id" = r."id"
      AND u."activation_revision" = r."activation_revision"
      AND u."ended_at" IS NULL
    WHERE r."status" IN ('starting', 'running')
      AND (p_org_ids IS NULL OR p_org_ids = '' OR r."org_id"::text = ANY(string_to_array(p_org_ids, ',')))
      AND r."sandbox_name" IS NOT NULL
      AND r."sandbox_cleaned_at" IS NULL
      AND (r."runtime_reconcile_lease_expires_at" IS NULL OR r."runtime_reconcile_lease_expires_at" <= clock_timestamp())
      AND (
        NOT EXISTS (
          SELECT 1 FROM public."skill_run_jobs" j
          WHERE j."org_id" = r."org_id" AND j."run_id" = r."id"
            AND j."status" = 'leased' AND j."lease_expires_at" > clock_timestamp()
        )
        OR (
          r."runtime_state" = 'degraded'
          AND r."runtime_degraded_at" <= clock_timestamp() - interval '60 seconds'
        )
      )
      AND (
        (r."runtime_state" = 'degraded' AND r."runtime_degraded_at" <= clock_timestamp() - interval '60 seconds')
        OR u."runtime_deadline_at" <= clock_timestamp() + interval '60 seconds'
        OR u."last_provider_checked_at" IS NULL
        OR u."last_provider_checked_at" <= clock_timestamp() - interval '60 seconds'
      )
    ORDER BY COALESCE(r."runtime_degraded_at", r."updated_at"), r."id"
    FOR UPDATE OF r SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public."skill_runs" r
    SET "runtime_reconcile_lease_owner" = p_worker_id,
        "runtime_reconcile_lease_expires_at" = clock_timestamp() + make_interval(secs => p_lease_seconds),
        "runtime_reconcile_generation" = r."runtime_reconcile_generation" + 1,
        "updated_at" = clock_timestamp()
    FROM candidates c
    WHERE r."org_id" = c."org_id" AND r."id" = c."id"
    RETURNING r.*
  )
  SELECT c."org_id", c."id", c."creator_id", c."sandbox_id", c."sandbox_name",
         c."timeout_ms", c."activation_revision", c."runtime_reconcile_generation",
         COALESCE(u."runtime_deadline_at", c."runtime_deadline_at")
  FROM claimed c
  LEFT JOIN public."sandbox_usage_sessions" u
    ON u."org_id" = c."org_id"
    AND u."kind" = 'run'
    AND u."source_id" = c."id"
    AND u."activation_revision" = c."activation_revision"
    AND u."ended_at" IS NULL;
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  RAISE;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_skill_run_runtime_reconciliations(text, integer, integer, text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_complete_skill_run_runtime_reconciliation(
  p_org_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_activation_revision integer,
  p_reconcile_generation integer,
  p_provider_state sandbox_provider_state,
  p_provider_expires_at timestamp with time zone
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text;
  active_prompt boolean;
  v_deadline_at timestamp with time zone;
  v_started_at timestamp with time zone;
  v_phase skill_run_phase;
BEGIN
  previous_worker_context := current_setting('app.run_worker', true);
  PERFORM set_config('app.run_worker', 'runtime-reconcile', true);
  IF NOT EXISTS (
    SELECT 1 FROM public."skill_runs" r
    WHERE r."org_id" = p_org_id AND r."id" = p_run_id
      AND r."activation_revision" = p_activation_revision
      AND r."runtime_reconcile_lease_owner" = p_worker_id
      AND r."runtime_reconcile_generation" = p_reconcile_generation
      AND r."runtime_reconcile_lease_expires_at" > clock_timestamp()
      AND (
        NOT EXISTS (
          SELECT 1 FROM public."skill_run_jobs" j
          WHERE j."org_id" = r."org_id" AND j."run_id" = r."id"
            AND j."status" = 'leased' AND j."lease_expires_at" > clock_timestamp()
        )
        OR (
          r."runtime_state" = 'degraded'
          AND r."runtime_degraded_at" <= clock_timestamp() - interval '60 seconds'
        )
      )
    FOR UPDATE
  ) THEN
    PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
    RETURN false;
  END IF;

  SELECT r."runtime_deadline_at", r."phase" INTO v_deadline_at, v_phase
  FROM public."skill_runs" r
  WHERE r."org_id" = p_org_id AND r."id" = p_run_id
    AND r."activation_revision" = p_activation_revision;

  UPDATE public."sandbox_usage_sessions"
  SET "last_provider_state" = p_provider_state,
      "provider_expires_at" = p_provider_expires_at,
      "last_provider_checked_at" = clock_timestamp(),
      "updated_at" = clock_timestamp()
  WHERE "org_id" = p_org_id AND "kind" = 'run' AND "source_id" = p_run_id
    AND "activation_revision" = p_activation_revision AND "ended_at" IS NULL
  RETURNING
    COALESCE(public."sandbox_usage_sessions"."runtime_deadline_at", v_deadline_at),
    public."sandbox_usage_sessions"."started_at"
  INTO v_deadline_at, v_started_at;

  IF p_provider_state <> 'running' THEN
    SELECT EXISTS (
      SELECT 1 FROM public."skill_run_prompts"
      WHERE "org_id" = p_org_id AND "run_id" = p_run_id AND "status" = 'processing'
    ) INTO active_prompt;
    UPDATE public."skill_run_prompts"
    SET "status" = CASE WHEN "status" = 'processing' THEN 'error'::skill_run_prompt_status ELSE 'canceled'::skill_run_prompt_status END,
        "error_code" = CASE WHEN "status" = 'processing' THEN 'sandbox_expired_during_turn' ELSE "error_code" END,
        "user_message" = CASE WHEN "status" = 'processing' THEN 'The sandbox expired while this turn was running.' ELSE "user_message" END,
        "lease_owner" = NULL, "lease_expires_at" = NULL, "completed_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
    WHERE "org_id" = p_org_id AND "run_id" = p_run_id AND "status" IN ('queued', 'processing');
    IF active_prompt THEN
      INSERT INTO public."skill_run_events" ("org_id", "run_id", "sequence", "type", "payload")
      SELECT
        r."org_id",
        r."id",
        GREATEST(COALESCE(MAX(e."sequence"), 0), r."transcript_event_sequence") + 1,
        'run.error',
        jsonb_build_object(
          'code', 'sandbox_expired_during_turn',
          'message', 'The sandbox expired while this turn was running.',
          'phase', v_phase::text
        )
      FROM public."skill_runs" r
      LEFT JOIN public."skill_run_events" e
        ON e."org_id" = r."org_id" AND e."run_id" = r."id"
      WHERE r."org_id" = p_org_id AND r."id" = p_run_id
      GROUP BY r."org_id", r."id", r."transcript_event_sequence";
    END IF;
    UPDATE public."skill_runs"
    SET "status" = CASE WHEN active_prompt THEN 'interrupted'::skill_run_status ELSE 'frozen'::skill_run_status END,
        "phase" = 'complete',
        "error_code" = CASE WHEN active_prompt THEN 'sandbox_expired_during_turn' ELSE NULL END,
        "user_message" = CASE WHEN active_prompt THEN 'The sandbox expired while this turn was running.' ELSE NULL END,
        "frozen_at" = clock_timestamp(),
        "reactivatable_until" = CASE WHEN p_provider_state = 'stopped' THEN clock_timestamp() + interval '7 days' ELSE NULL END,
        "sandbox_cleaned_at" = CASE WHEN p_provider_state = 'missing' THEN clock_timestamp() ELSE "sandbox_cleaned_at" END,
        "runtime_state" = 'healthy',
        "runtime_degraded_at" = NULL,
        "runtime_reconcile_lease_owner" = NULL,
        "runtime_reconcile_lease_expires_at" = NULL,
        "updated_at" = clock_timestamp()
    WHERE "org_id" = p_org_id AND "id" = p_run_id AND "activation_revision" = p_activation_revision;
    UPDATE public."skill_run_jobs"
    SET "status" = CASE WHEN active_prompt THEN 'failed'::skill_run_job_status ELSE 'completed'::skill_run_job_status END,
        "phase" = 'complete', "lease_owner" = NULL, "lease_expires_at" = NULL,
        "last_error_code" = CASE WHEN active_prompt THEN 'sandbox_expired_during_turn' ELSE "last_error_code" END,
        "updated_at" = clock_timestamp()
    WHERE "org_id" = p_org_id AND "run_id" = p_run_id;
    UPDATE public."sandbox_usage_sessions"
    SET "ended_at" = clock_timestamp(),
        "settled_ms" = CASE
          WHEN v_started_at IS NULL THEN 0
          ELSE LEAST(
            CEIL(GREATEST(1, EXTRACT(EPOCH FROM (LEAST(clock_timestamp(), COALESCE(v_deadline_at, clock_timestamp())) - v_started_at)) * 1000) / 60000) * 60000,
            GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(v_deadline_at, clock_timestamp()) - v_started_at)) * 1000)
          )::integer
        END,
        "updated_at" = clock_timestamp()
    WHERE "org_id" = p_org_id AND "kind" = 'run' AND "source_id" = p_run_id
      AND "activation_revision" = p_activation_revision AND "ended_at" IS NULL;
  ELSE
    UPDATE public."skill_runs"
    SET "runtime_reconcile_lease_owner" = NULL,
        "runtime_reconcile_lease_expires_at" = NULL,
        "updated_at" = clock_timestamp()
    WHERE "org_id" = p_org_id AND "id" = p_run_id AND "activation_revision" = p_activation_revision;
  END IF;
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  RAISE;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_complete_skill_run_runtime_reconciliation(uuid, uuid, text, integer, integer, sandbox_provider_state, timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
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
    WHERE r."status" IN ('frozen', 'interrupted', 'error', 'canceled')
      AND r."sandbox_cleaned_at" IS NULL
      AND (r."cleanup_lease_expires_at" IS NULL OR r."cleanup_lease_expires_at" <= clock_timestamp())
      AND (
        r."status" = 'error'
        OR (
          r."status" IN ('frozen', 'interrupted', 'canceled')
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
