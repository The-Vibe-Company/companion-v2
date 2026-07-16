ALTER TABLE "skill_run_prompts"
  ADD COLUMN "dispatch_protocol" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "skill_run_prompts"
  ADD COLUMN "send_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_run_prompts"
  ADD COLUMN "attachments_retained" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "skill_run_prompts"
  ADD CONSTRAINT "skill_run_prompts_dispatch_protocol_check"
  CHECK ("dispatch_protocol" BETWEEN 0 AND 2);--> statement-breakpoint
ALTER TABLE "skill_run_prompts"
  ADD CONSTRAINT "skill_run_prompts_send_marker_protocol_check"
  CHECK ("send_attempted_at" IS NULL OR "dispatch_protocol" >= 2);--> statement-breakpoint
ALTER TABLE "skill_run_prompts"
  ADD CONSTRAINT "skill_run_prompts_attachment_disposition_check"
  CHECK (
    "attachments_retained"
    OR (
      "status" = 'canceled'
      AND "kind" = 'follow_up'
      AND "send_attempted_at" IS NULL
      AND ("attempt" = 0 OR "dispatch_protocol" >= 2)
    )
  );--> statement-breakpoint

-- Rows claimed before this protocol existed are ambiguous by construction. Backfill them as
-- attempted so cancellation can only pass through the worker's abort + durable-idle barrier.
UPDATE "skill_run_prompts"
SET "dispatch_protocol" = 2,
    "send_attempted_at" = COALESCE("heartbeat_at", "updated_at", "created_at", clock_timestamp())
WHERE "attempt" > 0 AND "status" IN ('queued', 'processing');--> statement-breakpoint

ALTER TABLE "skill_run_worker_heartbeats"
  DROP CONSTRAINT "skill_run_worker_heartbeats_turn_stop_protocol_check";--> statement-breakpoint
ALTER TABLE "skill_run_worker_heartbeats"
  ADD CONSTRAINT "skill_run_worker_heartbeats_turn_stop_protocol_check"
  CHECK ("turn_stop_protocol" BETWEEN 0 AND 2);--> statement-breakpoint

-- Fence already-leased protocol-1 work without consuming another job attempt. Its owner loses the
-- exact lease before the dispatch trigger can reject a queued prompt; a v2 worker then reclaims the
-- same job attempt and inspects any deterministic message id conservatively.
UPDATE "skill_run_jobs" j
SET "lease_expires_at" = clock_timestamp(),
    "updated_at" = clock_timestamp()
WHERE j."status" = 'leased'
  AND EXISTS (
    SELECT 1 FROM "skill_run_prompts" p
    WHERE p."org_id" = j."org_id"
      AND p."run_id" = j."run_id"
      AND p."status" IN ('queued', 'processing')
  )
  AND NOT EXISTS (
    SELECT 1 FROM "skill_run_worker_heartbeats" h
    WHERE h."worker_id" = j."lease_owner"
      AND h."expires_at" > clock_timestamp()
      AND h."turn_stop_protocol" >= 2
  );--> statement-breakpoint

-- Enforce the attachment-disposition invariant below every terminalization path, including the
-- SECURITY DEFINER membership-revocation function. Only a queued follow-up proven never sent may
-- become sweepable. Initial prompts remain retained because a canceled run may replay them.
CREATE FUNCTION companion_prepare_canceled_skill_run_prompt_attachments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."status" = 'queued'
    AND NEW."status" = 'canceled'
    AND OLD."kind" = 'follow_up'
    AND OLD."send_attempted_at" IS NULL
    AND (OLD."attempt" = 0 OR OLD."dispatch_protocol" >= 2) THEN
    INSERT INTO public."skill_run_attachment_uploads" (
      "storage_key", "org_id", "creator_id", "touched_at"
    )
    SELECT a."storage_key", a."org_id", r."creator_id", clock_timestamp()
    FROM public."skill_run_attachments" a
    JOIN public."skill_runs" r
      ON r."org_id" = a."org_id" AND r."id" = a."run_id"
    WHERE a."org_id" = OLD."org_id"
      AND a."run_id" = OLD."run_id"
      AND a."prompt_id" = OLD."id"
    ON CONFLICT ("storage_key") DO UPDATE
    SET "touched_at" = EXCLUDED."touched_at";
    NEW."attachments_retained" := false;
  ELSE
    IF OLD."status" = 'queued'
      AND NEW."status" = 'canceled'
      AND (
        OLD."send_attempted_at" IS NOT NULL
        OR (OLD."attempt" > 0 AND OLD."dispatch_protocol" < 2)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public."skill_runs" r
        WHERE r."org_id" = OLD."org_id"
          AND r."id" = OLD."run_id"
          AND (r."cancel_requested_at" IS NOT NULL OR r."status" = 'canceled')
      ) THEN
      RAISE EXCEPTION 'ambiguous queued prompt requires worker stop recovery' USING ERRCODE = '55000';
    END IF;
    NEW."attachments_retained" := true;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER skill_run_prompts_prepare_canceled_attachments
BEFORE UPDATE OF "status" ON "skill_run_prompts"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status" AND NEW."status" = 'canceled')
EXECUTE FUNCTION companion_prepare_canceled_skill_run_prompt_attachments();--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_prepare_canceled_skill_run_prompt_attachments() FROM PUBLIC;--> statement-breakpoint

-- No writer may manufacture a sweepable prompt at INSERT time or flip disposition after the
-- terminal transition. The preparation trigger above is the only path that can make it false.
CREATE FUNCTION companion_guard_skill_run_prompt_attachment_disposition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW."attachments_retained" THEN
      RAISE EXCEPTION 'new run prompt attachments must be retained' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."attachments_retained"
    AND NOT NEW."attachments_retained"
    AND NOT (
      OLD."status" = 'queued'
      AND NEW."status" = 'canceled'
      AND OLD."kind" = 'follow_up'
      AND OLD."send_attempted_at" IS NULL
      AND (OLD."attempt" = 0 OR OLD."dispatch_protocol" >= 2)
    ) THEN
    RAISE EXCEPTION 'run prompt attachment disposition requires proven queued cancellation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER skill_run_prompts_guard_attachment_disposition_insert
BEFORE INSERT ON "skill_run_prompts"
FOR EACH ROW
EXECUTE FUNCTION companion_guard_skill_run_prompt_attachment_disposition();--> statement-breakpoint
CREATE TRIGGER skill_run_prompts_guard_attachment_disposition_update
BEFORE UPDATE OF "attachments_retained", "status" ON "skill_run_prompts"
FOR EACH ROW
EXECUTE FUNCTION companion_guard_skill_run_prompt_attachment_disposition();--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_guard_skill_run_prompt_attachment_disposition() FROM PUBLIC;--> statement-breakpoint

-- A protocol-1 worker cannot safely create a protocol-2 processing claim: it would be able to
-- contact OpenCode without first persisting send_attempted_at. Cancellation-only recovery is
-- exempt because it cannot dispatch a message.
CREATE FUNCTION companion_guard_skill_run_prompt_dispatch_protocol()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."status" = 'queued'
    AND NEW."status" = 'processing'
    AND NEW."cancel_requested_at" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public."skill_run_jobs" j
      JOIN public."skill_run_worker_heartbeats" h ON h."worker_id" = j."lease_owner"
      WHERE j."org_id" = NEW."org_id"
        AND j."run_id" = NEW."run_id"
        AND j."status" = 'leased'
        AND j."lease_owner" = NEW."lease_owner"
        AND j."lease_expires_at" > clock_timestamp()
        AND h."expires_at" > clock_timestamp()
        AND h."turn_stop_protocol" >= 2
    ) THEN
    RAISE EXCEPTION 'run prompt dispatch protocol 2 worker is required' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER skill_run_prompts_guard_dispatch_protocol
BEFORE UPDATE OF "status" ON "skill_run_prompts"
FOR EACH ROW
WHEN (OLD."status" = 'queued' AND NEW."status" = 'processing')
EXECUTE FUNCTION companion_guard_skill_run_prompt_dispatch_protocol();--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_guard_skill_run_prompt_dispatch_protocol() FROM PUBLIC;--> statement-breakpoint

-- The send marker is an irreversible external-side-effect barrier. Dispatch protocol may only
-- advance, and a marker can only be introduced by protocol 2 or a migration performed beforehand.
CREATE FUNCTION companion_guard_skill_run_prompt_dispatch_marker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."dispatch_protocol" < OLD."dispatch_protocol" THEN
    RAISE EXCEPTION 'run prompt dispatch protocol cannot regress' USING ERRCODE = '55000';
  END IF;
  IF OLD."send_attempted_at" IS NOT NULL
    AND NEW."send_attempted_at" IS DISTINCT FROM OLD."send_attempted_at" THEN
    RAISE EXCEPTION 'run prompt send marker is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."send_attempted_at" IS NULL
    AND NEW."send_attempted_at" IS NOT NULL
    AND NEW."dispatch_protocol" < 2 THEN
    RAISE EXCEPTION 'run prompt send marker requires dispatch protocol 2' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER skill_run_prompts_guard_dispatch_marker
BEFORE UPDATE OF "dispatch_protocol", "send_attempted_at" ON "skill_run_prompts"
FOR EACH ROW
EXECUTE FUNCTION companion_guard_skill_run_prompt_dispatch_marker();--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_guard_skill_run_prompt_dispatch_marker() FROM PUBLIC;--> statement-breakpoint

-- Attachment visibility and cleanup use the explicit disposition, never an execution-attempt
-- counter. The reservation row remains locked across object deletion and metadata removal.
CREATE OR REPLACE FUNCTION companion_lock_skill_run_attachment_orphan(
  p_storage_key text,
  p_before timestamp with time zone
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE candidate text;
BEGIN
  SELECT u."storage_key" INTO candidate
  FROM public."skill_run_attachment_uploads" u
  WHERE u."storage_key" = p_storage_key AND u."touched_at" < p_before
  FOR UPDATE;
  IF candidate IS NULL THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1
    FROM public."skill_run_attachments" a
    LEFT JOIN public."skill_run_prompts" p
      ON p."org_id" = a."org_id" AND p."run_id" = a."run_id" AND p."id" = a."prompt_id"
    WHERE a."storage_key" = p_storage_key
      AND (p."id" IS NULL OR p."status" <> 'canceled' OR p."attachments_retained")
  ) THEN
    DELETE FROM public."skill_run_attachment_uploads" WHERE "storage_key" = p_storage_key;
    RETURN false;
  END IF;
  RETURN true;
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION companion_complete_skill_run_attachment_orphan(p_storage_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public."skill_run_attachments" a
  USING public."skill_run_prompts" p
  WHERE a."storage_key" = p_storage_key
    AND p."org_id" = a."org_id"
    AND p."run_id" = a."run_id"
    AND p."id" = a."prompt_id"
    AND p."status" = 'canceled'
    AND NOT p."attachments_retained";
  DELETE FROM public."skill_run_attachment_uploads" WHERE "storage_key" = p_storage_key;
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION companion_defer_skill_run_attachment_orphan(
  p_storage_key text,
  p_before timestamp with time zone
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH deferred AS (
    UPDATE public."skill_run_attachment_uploads" u
    SET "touched_at" = clock_timestamp()
    WHERE u."storage_key" = p_storage_key
      AND u."touched_at" < p_before
      AND NOT EXISTS (
        SELECT 1
        FROM public."skill_run_attachments" a
        LEFT JOIN public."skill_run_prompts" p
          ON p."org_id" = a."org_id" AND p."run_id" = a."run_id" AND p."id" = a."prompt_id"
        WHERE a."storage_key" = p_storage_key
          AND (p."id" IS NULL OR p."status" <> 'canceled' OR p."attachments_retained")
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM deferred)
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION companion_heartbeat_skill_run_worker(
  p_worker_id text,
  p_ttl_seconds integer,
  p_attachment_prompt_protocol integer,
  p_turn_stop_protocol integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) < 1 OR length(p_worker_id) > 512 THEN
    RAISE EXCEPTION 'valid worker id is required' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds < 5 OR p_ttl_seconds > 300 THEN
    RAISE EXCEPTION 'invalid worker heartbeat ttl' USING ERRCODE = '22023';
  END IF;
  IF p_attachment_prompt_protocol <> 1 THEN
    RAISE EXCEPTION 'invalid attachment prompt protocol' USING ERRCODE = '22023';
  END IF;
  IF p_turn_stop_protocol NOT IN (1, 2) THEN
    RAISE EXCEPTION 'invalid turn stop protocol' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public."skill_run_worker_heartbeats" (
    "worker_id", "expires_at", "updated_at", "attachment_prompt_protocol", "turn_stop_protocol"
  ) VALUES (
    p_worker_id,
    clock_timestamp() + make_interval(secs => p_ttl_seconds),
    clock_timestamp(),
    p_attachment_prompt_protocol,
    p_turn_stop_protocol
  )
  ON CONFLICT ("worker_id") DO UPDATE
  SET "expires_at" = EXCLUDED."expires_at",
      "updated_at" = EXCLUDED."updated_at",
      "attachment_prompt_protocol" = EXCLUDED."attachment_prompt_protocol",
      "turn_stop_protocol" = EXCLUDED."turn_stop_protocol";
  DELETE FROM public."skill_run_worker_heartbeats"
  WHERE "expires_at" <= clock_timestamp() - interval '1 hour';
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION companion_skill_run_turn_stop_worker_ready(
  p_org_id uuid,
  p_run_id uuid,
  p_creator_id text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."skill_run_jobs" j
    JOIN public."skill_run_worker_heartbeats" h ON h."worker_id" = j."lease_owner"
    WHERE j."org_id" = p_org_id
      AND j."run_id" = p_run_id
      AND j."creator_id" = p_creator_id
      AND j."status" = 'leased'
      AND j."lease_expires_at" > clock_timestamp()
      AND h."expires_at" > clock_timestamp()
      AND h."turn_stop_protocol" >= 2
  )
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION companion_skill_run_turn_stop_worker_ready()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."skill_run_worker_heartbeats" h
    WHERE h."expires_at" > clock_timestamp()
      AND h."turn_stop_protocol" >= 2
  )
$$;--> statement-breakpoint

-- New runs also contain an initial prompt, so generic launch readiness must not admit work that
-- only a rolling protocol-1 worker can see but can no longer claim safely.
CREATE OR REPLACE FUNCTION companion_skill_run_worker_ready()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."skill_run_worker_heartbeats" h
    WHERE h."expires_at" > clock_timestamp()
      AND h."turn_stop_protocol" >= 2
  )
$$;--> statement-breakpoint

-- Job admission requires protocol 2 whenever any prompt dispatch or stop recovery is pending.
-- This keeps an old replica from repeatedly leasing work that the dispatch trigger will reject.
CREATE OR REPLACE FUNCTION companion_claim_skill_run_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 30
)
RETURNS SETOF "skill_run_jobs"
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
    RAISE EXCEPTION 'invalid claim limits' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  PERFORM set_config('app.run_worker', 'claim', true);
  RETURN QUERY
  WITH candidates AS (
    SELECT j."id"
    FROM public."skill_run_jobs" j
    WHERE j."available_at" <= clock_timestamp()
      AND (
        (j."status" = 'queued' AND j."attempt" < j."max_attempts")
        OR (j."status" = 'leased' AND j."lease_expires_at" <= clock_timestamp())
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM public."skill_run_prompts" p
          JOIN public."skill_run_attachments" a
            ON a."org_id" = p."org_id" AND a."run_id" = p."run_id" AND a."prompt_id" = p."id"
          WHERE p."org_id" = j."org_id" AND p."run_id" = j."run_id"
            AND p."kind" = 'follow_up'
            AND p."status" IN ('queued', 'processing')
        )
        OR EXISTS (
          SELECT 1 FROM public."skill_run_worker_heartbeats" h
          WHERE h."worker_id" = p_worker_id
            AND h."expires_at" > clock_timestamp()
            AND h."attachment_prompt_protocol" >= 1
        )
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM public."skill_run_prompts" p
          WHERE p."org_id" = j."org_id" AND p."run_id" = j."run_id"
            AND p."status" IN ('queued', 'processing')
        )
        OR EXISTS (
          SELECT 1 FROM public."skill_run_worker_heartbeats" h
          WHERE h."worker_id" = p_worker_id
            AND h."expires_at" > clock_timestamp()
            AND h."turn_stop_protocol" >= 2
        )
      )
    ORDER BY j."available_at", j."created_at", j."id"
    FOR UPDATE OF j SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public."skill_run_jobs" j
  SET "status" = 'leased',
      "attempt" = CASE WHEN j."status" = 'queued' THEN j."attempt" + 1 ELSE j."attempt" END,
      "lease_reclaim_count" = CASE WHEN j."status" = 'leased' THEN j."lease_reclaim_count" + 1 ELSE j."lease_reclaim_count" END,
      "lease_owner" = p_worker_id,
      "lease_expires_at" = clock_timestamp() + make_interval(secs => p_lease_seconds),
      "heartbeat_at" = clock_timestamp(),
      "updated_at" = clock_timestamp()
  FROM candidates c
  WHERE j."id" = c."id"
  RETURNING j.*;
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_skill_run_jobs(text, integer, integer) FROM PUBLIC;
