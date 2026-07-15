CREATE TYPE "skill_run_prewarm_status" AS ENUM ('queued', 'warming', 'ready', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "skill_run_prewarm_phase" AS ENUM ('queued', 'fork', 'push_skills', 'ready', 'cleanup', 'complete');--> statement-breakpoint

CREATE TABLE "skill_run_prewarms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "skill_id" uuid NOT NULL,
  "creator_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "skill_version_id" uuid NOT NULL,
  "status" "skill_run_prewarm_status" DEFAULT 'queued' NOT NULL,
  "phase" "skill_run_prewarm_phase" DEFAULT 'queued' NOT NULL,
  "sandbox_name" text NOT NULL,
  "sandbox_id" text,
  "sandbox_domain" text,
  "golden_snapshot_id" text NOT NULL,
  "timeout_ms" integer DEFAULT 300000 NOT NULL,
  "client_lease_expires_at" timestamp with time zone NOT NULL,
  "absolute_expires_at" timestamp with time zone NOT NULL,
  "adopted_run_id" uuid,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "error_code" text,
  "sandbox_cleaned_at" timestamp with time zone,
  "cleanup_lease_owner" text,
  "cleanup_lease_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_prewarms_org_id_id_uq" UNIQUE("org_id", "id"),
  CONSTRAINT "skill_run_prewarms_skill_org_fk" FOREIGN KEY("org_id", "skill_id") REFERENCES "skills"("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "skill_run_prewarms_version_org_fk" FOREIGN KEY("org_id", "skill_id", "skill_version_id") REFERENCES "skill_versions"("org_id", "skill_id", "id") ON DELETE CASCADE,
  CONSTRAINT "skill_run_prewarms_timeout_check" CHECK ("timeout_ms" BETWEEN 10000 AND 3600000),
  CONSTRAINT "skill_run_prewarms_attempt_check" CHECK ("attempt" >= 0 AND "max_attempts" BETWEEN 1 AND 10),
  CONSTRAINT "skill_run_prewarms_lease_check" CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "skill_run_prewarms_cleanup_lease_check" CHECK (("cleanup_lease_owner" IS NULL) = ("cleanup_lease_expires_at" IS NULL))
);--> statement-breakpoint

CREATE TABLE "skill_run_prewarm_skills" (
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "prewarm_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "skill_version_id" uuid NOT NULL,
  "is_root" boolean DEFAULT false NOT NULL,
  "mount_order" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_prewarm_skills_pk" PRIMARY KEY("org_id", "prewarm_id", "skill_id"),
  CONSTRAINT "skill_run_prewarm_skills_mount_order_uq" UNIQUE("org_id", "prewarm_id", "mount_order"),
  CONSTRAINT "skill_run_prewarm_skills_prewarm_org_fk" FOREIGN KEY("org_id", "prewarm_id") REFERENCES "skill_run_prewarms"("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "skill_run_prewarm_skills_version_org_fk" FOREIGN KEY("org_id", "skill_id", "skill_version_id") REFERENCES "skill_versions"("org_id", "skill_id", "id") ON DELETE CASCADE,
  CONSTRAINT "skill_run_prewarm_skills_mount_order_check" CHECK ("mount_order" >= 0)
);--> statement-breakpoint

ALTER TABLE "skill_runs" ADD COLUMN "prewarm_id" uuid REFERENCES "skill_run_prewarms"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_runs_prewarm_uq" ON "skill_runs"("prewarm_id") WHERE "prewarm_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "skill_run_prewarms_claim_idx" ON "skill_run_prewarms"("status", "available_at", "lease_expires_at");--> statement-breakpoint
CREATE INDEX "skill_run_prewarms_cleanup_idx" ON "skill_run_prewarms"("status", "client_lease_expires_at", "absolute_expires_at");--> statement-breakpoint
CREATE INDEX "skill_run_prewarms_quota_idx" ON "skill_run_prewarms"("org_id", "creator_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_run_prewarms_adopted_run_uq" ON "skill_run_prewarms"("adopted_run_id") WHERE "adopted_run_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "skill_run_prewarms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_prewarm_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_prewarms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_prewarm_skills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_run_prewarms_creator" ON "skill_run_prewarms" USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "skill_run_prewarms"."org_id" AND m."user_id" = "skill_run_prewarms"."creator_id")
) WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "skill_run_prewarms"."org_id" AND m."user_id" = "skill_run_prewarms"."creator_id")
);--> statement-breakpoint
CREATE POLICY "skill_run_prewarm_skills_creator" ON "skill_run_prewarm_skills" USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "skill_run_prewarms" p WHERE p."org_id" = "skill_run_prewarm_skills"."org_id" AND p."id" = "skill_run_prewarm_skills"."prewarm_id" AND p."creator_id" = NULLIF(current_setting('app.user_id', true), ''))
) WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "skill_run_prewarms" p WHERE p."org_id" = "skill_run_prewarm_skills"."org_id" AND p."id" = "skill_run_prewarm_skills"."prewarm_id" AND p."creator_id" = NULLIF(current_setting('app.user_id', true), ''))
);--> statement-breakpoint

-- The worker GUC is only a selector, never an authority: companion_run_policy_definer() also
-- requires the SECURITY DEFINER identity to be the migration/table owner. The skill_runs policy is
-- deliberately read-only and exposes only terminal rows whose run cleanup already reported success;
-- it lets prewarm cleanup reconcile a sandbox that appeared after an early run teardown returned 404.
CREATE POLICY "skill_run_prewarms_worker_internal" ON "skill_run_prewarms" USING (
  companion_run_policy_definer() AND current_setting('app.run_prewarm_worker', true) = 'internal'
) WITH CHECK (
  companion_run_policy_definer() AND current_setting('app.run_prewarm_worker', true) = 'internal'
);--> statement-breakpoint
CREATE POLICY "skill_runs_prewarm_cleanup_reconciliation" ON "skill_runs" FOR SELECT USING (
  companion_run_policy_definer()
  AND current_setting('app.run_prewarm_worker', true) = 'internal'
  AND "status" IN ('error', 'canceled')
  AND "sandbox_cleaned_at" IS NOT NULL
);--> statement-breakpoint

CREATE FUNCTION companion_claim_skill_run_prewarms(p_worker_id text, p_limit integer DEFAULT 1, p_lease_seconds integer DEFAULT 30)
RETURNS SETOF "skill_run_prewarms"
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE previous_worker_context text;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR p_limit < 1 OR p_limit > 32 OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'invalid prewarm claim input' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_prewarm_worker', true);
  PERFORM set_config('app.run_prewarm_worker', 'internal', true);
  RETURN QUERY
  WITH candidates AS (
    SELECT p."id"
    FROM public."skill_run_prewarms" p
    WHERE p."adopted_run_id" IS NULL
      AND p."sandbox_cleaned_at" IS NULL
      AND p."client_lease_expires_at" > clock_timestamp()
      AND p."absolute_expires_at" > clock_timestamp()
      AND p."available_at" <= clock_timestamp()
      AND ((p."status" = 'queued' AND p."attempt" < p."max_attempts") OR (p."status" = 'warming' AND p."lease_expires_at" <= clock_timestamp()))
    ORDER BY p."available_at", p."created_at", p."id"
    FOR UPDATE SKIP LOCKED LIMIT p_limit
  )
  UPDATE public."skill_run_prewarms" p
  SET "status" = 'warming',
      "attempt" = CASE WHEN p."status" = 'queued' THEN p."attempt" + 1 ELSE p."attempt" END,
      "lease_owner" = p_worker_id,
      "lease_expires_at" = clock_timestamp() + make_interval(secs => p_lease_seconds),
      "heartbeat_at" = clock_timestamp(),
      "updated_at" = clock_timestamp()
  FROM candidates c WHERE p."id" = c."id" RETURNING p.*;
  PERFORM set_config('app.run_prewarm_worker', COALESCE(previous_worker_context, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_prewarm_worker', COALESCE(previous_worker_context, ''), true);
  RAISE;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_skill_run_prewarms(text, integer, integer) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_claim_skill_run_prewarm_cleanups(p_worker_id text, p_limit integer DEFAULT 1, p_lease_seconds integer DEFAULT 30)
RETURNS TABLE ("org_id" uuid, "id" uuid, "creator_id" text, "sandbox_id" text, "sandbox_name" text, "timeout_ms" integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE previous_worker_context text;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR p_limit < 1 OR p_limit > 32 OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'invalid prewarm cleanup input' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_prewarm_worker', true);
  PERFORM set_config('app.run_prewarm_worker', 'internal', true);
  RETURN QUERY
  WITH candidates AS (
    SELECT p."id"
    FROM public."skill_run_prewarms" p
    WHERE p."sandbox_cleaned_at" IS NULL
      AND (
        (
          p."adopted_run_id" IS NULL
          AND (p."status" IN ('failed', 'canceled') OR p."client_lease_expires_at" <= clock_timestamp() OR p."absolute_expires_at" <= clock_timestamp())
        )
        OR (
          p."adopted_run_id" IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public."skill_runs" r
            WHERE r."org_id" = p."org_id" AND r."id" = p."adopted_run_id"
              AND r."status" IN ('error', 'canceled') AND r."sandbox_cleaned_at" IS NOT NULL
          )
        )
      )
      AND (p."lease_expires_at" IS NULL OR p."lease_expires_at" <= clock_timestamp())
      AND (p."cleanup_lease_expires_at" IS NULL OR p."cleanup_lease_expires_at" <= clock_timestamp())
    ORDER BY p."updated_at", p."id" FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE public."skill_run_prewarms" p
    SET "status" = 'canceled', "phase" = 'cleanup', "cleanup_lease_owner" = p_worker_id,
        "cleanup_lease_expires_at" = clock_timestamp() + make_interval(secs => p_lease_seconds), "updated_at" = clock_timestamp()
    FROM candidates c WHERE p."id" = c."id"
    RETURNING p."org_id", p."id", p."creator_id", p."sandbox_id", p."sandbox_name", p."timeout_ms"
  ) SELECT * FROM claimed;
  PERFORM set_config('app.run_prewarm_worker', COALESCE(previous_worker_context, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_prewarm_worker', COALESCE(previous_worker_context, ''), true);
  RAISE;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_skill_run_prewarm_cleanups(text, integer, integer) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_complete_skill_run_prewarm_cleanup(p_org_id uuid, p_id uuid, p_worker_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  updated_count integer;
  previous_worker_context text;
BEGIN
  previous_worker_context := current_setting('app.run_prewarm_worker', true);
  PERFORM set_config('app.run_prewarm_worker', 'internal', true);
  UPDATE public."skill_run_prewarms" p
  SET "phase" = 'complete', "sandbox_cleaned_at" = clock_timestamp(), "cleanup_lease_owner" = NULL,
      "cleanup_lease_expires_at" = NULL, "lease_owner" = NULL, "lease_expires_at" = NULL, "updated_at" = clock_timestamp()
  WHERE p."org_id" = p_org_id AND p."id" = p_id
    AND (
      p."adopted_run_id" IS NULL
      OR EXISTS (
        SELECT 1 FROM public."skill_runs" r
        WHERE r."org_id" = p."org_id" AND r."id" = p."adopted_run_id"
          AND r."status" IN ('error', 'canceled') AND r."sandbox_cleaned_at" IS NOT NULL
      )
    )
    AND p."cleanup_lease_owner" = p_worker_id;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  PERFORM set_config('app.run_prewarm_worker', COALESCE(previous_worker_context, ''), true);
  RETURN updated_count = 1;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_prewarm_worker', COALESCE(previous_worker_context, ''), true);
  RAISE;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_complete_skill_run_prewarm_cleanup(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_purge_skill_run_prewarms(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  deleted_count integer;
  previous_worker_context text;
BEGIN
  IF p_limit < 1 OR p_limit > 5000 THEN RAISE EXCEPTION 'invalid purge limit' USING ERRCODE = '22023'; END IF;
  previous_worker_context := current_setting('app.run_prewarm_worker', true);
  PERFORM set_config('app.run_prewarm_worker', 'internal', true);
  WITH candidates AS (
    SELECT p."id" FROM public."skill_run_prewarms" p
    WHERE (p."sandbox_cleaned_at" IS NOT NULL OR p."adopted_run_id" IS NOT NULL)
      AND p."updated_at" < clock_timestamp() - interval '24 hours'
    ORDER BY p."updated_at" LIMIT p_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM public."skill_run_prewarms" p USING candidates c WHERE p."id" = c."id";
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  PERFORM set_config('app.run_prewarm_worker', COALESCE(previous_worker_context, ''), true);
  RETURN deleted_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_prewarm_worker', COALESCE(previous_worker_context, ''), true);
  RAISE;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_purge_skill_run_prewarms(integer) FROM PUBLIC;
