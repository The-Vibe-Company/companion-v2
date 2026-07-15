ALTER TABLE "skill_runs" ADD COLUMN "reactivatable_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "activation_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_activation_revision_check" CHECK ("skill_runs"."activation_revision" >= 0);--> statement-breakpoint

UPDATE "skill_runs"
SET "reactivatable_until" = COALESCE("frozen_at", "updated_at") + interval '7 days'
WHERE "status" IN ('frozen', 'canceled')
  AND "sandbox_cleaned_at" IS NULL
  AND "reactivatable_until" IS NULL;--> statement-breakpoint

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
