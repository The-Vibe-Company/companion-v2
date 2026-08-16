-- Serialize delivery across sends, open-thread syncs, and the reconciler. The lease uses the
-- existing per-Companion reconciler row so a worker and a browser cannot both hand the same durable
-- tail to Pi, and so a stale timeout snapshot cannot recycle a recovery turn another request just
-- started. A crashed API request releases itself by expiry; no Box lifecycle is part of the lease.

-- Unlike the legacy delivery watermark, this marker advances only after protocol 2 sees Pi's
-- correlated prompt response. It lets the client distinguish a genuinely generating recovered
-- turn from a pre-upgrade FIFO write that was watermarked but never consumed.
ALTER TABLE "companion_threads" ADD COLUMN "accepted_delivery_ordinal" integer;
--> statement-breakpoint
ALTER TABLE "companion_threads"
  ADD CONSTRAINT "companion_threads_accepted_delivery_ordinal_check"
  CHECK ("accepted_delivery_ordinal" IS NULL OR "accepted_delivery_ordinal" >= 0);
--> statement-breakpoint

-- Compatibility state is independent of the active reconciler/delivery claim. The migration can
-- therefore fence a snapshot that predates it even when a worker currently owns the ordinary
-- lease; settling that worker cannot erase the compatibility deadline.
ALTER TABLE "companion_reconcile_leases"
  ADD COLUMN "delivery_compat_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "companion_reconcile_leases"
  ADD COLUMN "delivery_compat_next_ordinal" integer;
--> statement-breakpoint
ALTER TABLE "companion_reconcile_leases"
  ADD COLUMN "delivery_compat_seeded" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "companion_reconcile_leases"
  ADD CONSTRAINT "companion_reconcile_leases_delivery_compat_next_ordinal_check"
  CHECK ("delivery_compat_next_ordinal" IS NULL OR "delivery_compat_next_ordinal" >= 0);
--> statement-breakpoint

-- Size a legacy drain from work the old API can actually perform, never from total history. A
-- running tool is treated like a future timeout so a fence cached before settlement still covers
-- the same post-tool tail after settlement re-queues it.
CREATE FUNCTION public.companion_delivery_compat_deadline(
  p_org_id uuid,
  p_companion_id uuid,
  p_now timestamp with time zone
)
RETURNS timestamp with time zone
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_delivered integer;
  v_timeout_delivery integer;
  v_latest_abandoned_tool integer := -1;
  v_latest_started_turn integer := -1;
  v_latest_assistant integer := -1;
  v_protected_tail_start integer := -1;
  v_recovery_tail boolean := false;
  v_work_items bigint := 0;
  v_completed_batch_deadline timestamp with time zone;
  v_settled_decision_deadline timestamp with time zone;
  v_deadline timestamp with time zone;
BEGIN
  SELECT t.delivered_ordinal, t.timeout_delivery_ordinal
  INTO v_delivered, v_timeout_delivery
  FROM public.companion_threads t
  WHERE t.org_id = p_org_id
    AND t.companion_id = p_companion_id;

  SELECT
    COALESCE(MAX(e.ordinal) FILTER (
      WHERE e.role::text = 'tool' AND e.tool->>'status' IN ('running', 'timeout')
    ), -1),
    COALESCE(MAX(e.ordinal) FILTER (
      WHERE e.role::text IN ('assistant', 'decision')
         OR (
           e.role::text = 'tool'
           AND e.tool->>'status' NOT IN ('running', 'timeout')
         )
    ), -1),
    COALESCE(MAX(e.ordinal) FILTER (WHERE e.role::text = 'assistant'), -1)
  INTO v_latest_abandoned_tool, v_latest_started_turn, v_latest_assistant
  FROM public.companion_transcript_entries e
  WHERE e.org_id = p_org_id
    AND e.companion_id = p_companion_id;

  WITH assistant_boundaries AS (
    SELECT
      e.ordinal,
      e.created_at,
      LAG(e.ordinal, 1, -1) OVER (ORDER BY e.ordinal) AS previous_assistant
    FROM public.companion_transcript_entries e
    WHERE e.org_id = p_org_id
      AND e.companion_id = p_companion_id
      AND e.role::text = 'assistant'
  ), completed_batches AS (
    SELECT
      a.ordinal,
      a.created_at + interval '600 seconds' + COUNT(u.ordinal) * interval '60 seconds'
        AS drain_deadline
    FROM assistant_boundaries a
    LEFT JOIN public.companion_transcript_entries u
      ON u.org_id = p_org_id
     AND u.companion_id = p_companion_id
     AND u.role::text = 'user'
     AND u.ordinal > a.previous_assistant
     AND u.ordinal < a.ordinal
    GROUP BY a.ordinal, a.created_at
    HAVING COUNT(u.ordinal) > 0
  )
  SELECT MAX(b.drain_deadline)
  INTO v_completed_batch_deadline
  FROM completed_batches b;

  -- A legacy decision route commits the durable settlement before it checks Box status and writes
  -- the matching FIFO response. If migration lands in that gap, `pending` is already gone but the
  -- old request can still be unblocking Pi. Retain recent settled cards for the same ten-minute
  -- bounded transport window used by the legacy prompt drain; malformed historical JSON is ignored.
  SELECT MAX(
    (e.decision->>'decided_at')::timestamp with time zone + interval '600 seconds'
  )
  INTO v_settled_decision_deadline
  FROM public.companion_transcript_entries e
  WHERE e.org_id = p_org_id
    AND e.companion_id = p_companion_id
    AND e.role::text = 'decision'
    AND e.decision->>'status' IN ('allowed', 'denied', 'answered', 'expired')
    AND pg_input_is_valid(e.decision->>'decided_at', 'timestamp with time zone');

  v_protected_tail_start := GREATEST(
    v_latest_abandoned_tool,
    COALESCE(v_timeout_delivery, -1)
  );
  v_recovery_tail := v_latest_abandoned_tool > v_latest_started_turn AND EXISTS (
    SELECT 1
    FROM public.companion_transcript_entries e
    WHERE e.org_id = p_org_id
      AND e.companion_id = p_companion_id
      AND e.role::text = 'user'
      AND e.ordinal > v_protected_tail_start
  );

  SELECT COUNT(*)
  INTO v_work_items
  FROM public.companion_transcript_entries e
  WHERE e.org_id = p_org_id
    AND e.companion_id = p_companion_id
    AND (
      (
        e.role::text = 'user'
        AND (
          v_delivered IS NULL
          OR e.ordinal > v_delivered
          OR (v_recovery_tail AND e.ordinal > v_protected_tail_start)
          -- Migration backfill can run after a faster protocol-1 request advanced the watermark
          -- but while a slower request still owns the same pre-policy snapshot. Until an assistant
          -- closes that tail, retain its user messages in the worst-case work bound.
          OR e.ordinal > v_latest_assistant
        )
      )
      OR (e.role::text = 'decision' AND e.decision->>'status' = 'pending')
    );

  -- Protocol 1 has a three-minute runtime-start budget and a 30-second transport deadline for
  -- each prompt/decision FIFO command. Sixty seconds per finite work item plus a ten-minute base
  -- covers its snapshot without turning a long, fully delivered transcript into rollout downtime.
  v_deadline := CASE
    WHEN v_work_items = 0 THEN p_now
    ELSE p_now + interval '600 seconds' + v_work_items * interval '60 seconds'
  END;
  -- A faster old request can append assistants and watermark batches while a slower request still
  -- holds the same pre-policy snapshot. Retain each completed batch only until its own size-derived
  -- worst-case window elapses; historical batches whose windows elapsed add no rollout delay.
  IF v_completed_batch_deadline IS NOT NULL THEN
    v_deadline := GREATEST(v_deadline, v_completed_batch_deadline);
  END IF;
  IF v_settled_decision_deadline IS NOT NULL THEN
    v_deadline := GREATEST(v_deadline, v_settled_decision_deadline);
  END IF;
  RETURN GREATEST(p_now, v_deadline);
END
$$;
--> statement-breakpoint

-- FORCE RLS applies to the migration owner. Admit only the owner of the constrained deadline
-- helper to the two read models it aggregates; runtime roles cannot execute the helper directly.
CREATE POLICY "companion_threads_delivery_compat_maintenance_rls"
  ON "companion_threads"
  FOR SELECT
  USING (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_delivery_compat_deadline(uuid,uuid,timestamp with time zone)'::regprocedure
    ))
  );
--> statement-breakpoint
CREATE POLICY "companion_transcript_entries_delivery_compat_maintenance_rls"
  ON "companion_transcript_entries"
  FOR SELECT
  USING (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_delivery_compat_deadline(uuid,uuid,timestamp with time zone)'::regprocedure
    ))
  );
--> statement-breakpoint

-- Migration-first deploys briefly run the previous API beside the new one. Old replicas do not
-- know how to claim a delivery lease, so transcript reads from those replicas establish this
-- compatibility lease through a restrictive RLS policy. New transactions identify protocol 2;
-- they either wait behind the old reader or make that reader fail before it can obtain a prompt
-- snapshot. The migration backfill covers an old request that read immediately before the policy
-- existed. Every later legacy read renews a fence sized from the thread's monotonic entry count;
-- only expiry after that snapshot's worst-case drain can admit protocol 2, because one old
-- watermark cannot prove every other old request has finished its Box work.
CREATE FUNCTION public.companion_delivery_read_fence(
  p_org_id uuid,
  p_companion_id uuid,
  p_caller text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := statement_timestamp();
  v_drain_deadline timestamp with time zone;
  v_next_ordinal integer := 0;
  v_existing_compat_deadline timestamp with time zone;
  v_existing_compat_ordinal integer;
  v_existing_compat_seeded boolean := false;
  v_existing_claimed_by text;
  v_existing_lease_expires_at timestamp with time zone;
  v_claimed boolean := false;
  v_owner text;
  v_timeout_owner text;
  v_reconciler_owner text;
BEGIN
  -- Definer maintenance functions already serialize through the reconciler lease and must retain
  -- their cross-tenant reads. Protocol-2 API transactions participate in the exact lease below.
  -- Return before catalog owner discovery on the permanent protocol-2 hot path: this restrictive
  -- policy runs once per transcript row, so even constant catalog work would scale with history.
  IF current_setting('app.companion_delivery_protocol', true) = '2' THEN
    RETURN true;
  END IF;
  SELECT
    pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_delivery_read_fence(uuid,uuid,text)'::regprocedure
    )),
    pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)'::regprocedure
    )),
    pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_claim_reconcile_candidates(text,integer,integer,integer,integer)'::regprocedure
    ))
  INTO v_owner, v_timeout_owner, v_reconciler_owner;
  IF p_caller = v_owner OR p_caller = v_timeout_owner OR p_caller = v_reconciler_owner THEN
    RETURN true;
  END IF;
  IF p_org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid
    OR NULLIF(current_setting('app.user_id', true), '') IS NULL
  THEN
    RETURN false;
  END IF;

  SELECT t.next_ordinal,
         l.delivery_compat_expires_at,
         l.delivery_compat_next_ordinal,
         l.delivery_compat_seeded,
         l.claimed_by,
         l.lease_expires_at
  INTO v_next_ordinal,
       v_existing_compat_deadline,
       v_existing_compat_ordinal,
       v_existing_compat_seeded,
       v_existing_claimed_by,
       v_existing_lease_expires_at
  FROM public.companion_threads t
  LEFT JOIN public.companion_reconcile_leases l
    ON l.org_id = t.org_id
   AND l.companion_id = t.companion_id
  WHERE t.org_id = p_org_id
    AND t.companion_id = p_companion_id;

  -- An exact API/worker claim wins if it started before this legacy snapshot. Fail the transcript
  -- read before protocol 1 can obtain work; a later read retries after that bounded owner settles.
  IF v_existing_claimed_by IS NOT NULL
    AND v_existing_lease_expires_at IS NOT NULL
    AND v_existing_lease_expires_at >= v_now
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Companion delivery protocol is upgrading; retry the request';
  END IF;

  -- One SELECT evaluates the policy once per returned entry. Reuse the first row's calculation
  -- while the monotonic snapshot bound is unchanged; tool/decision transitions can only reduce
  -- work except running -> timeout, which the deadline helper already counts conservatively.
  IF NOT v_existing_compat_seeded
    AND v_existing_compat_deadline >= v_now
    AND COALESCE(v_existing_compat_ordinal, -1) >= COALESCE(v_next_ordinal, 0)
  THEN
    RETURN true;
  END IF;

  v_next_ordinal := COALESCE(v_next_ordinal, 0);
  v_drain_deadline := public.companion_delivery_compat_deadline(
    p_org_id, p_companion_id, v_now
  );

  INSERT INTO public.companion_reconcile_leases AS l (
    org_id, companion_id, reason, delivery_compat_expires_at,
    delivery_compat_next_ordinal, delivery_compat_seeded, updated_at
  )
  VALUES (
    p_org_id,
    p_companion_id,
    'delivery_compat',
    v_drain_deadline,
    v_next_ordinal,
    false,
    v_now
  )
  ON CONFLICT ON CONSTRAINT companion_reconcile_leases_pkey DO UPDATE
    SET delivery_compat_expires_at = CASE
          WHEN l.delivery_compat_seeded THEN excluded.delivery_compat_expires_at
          ELSE GREATEST(l.delivery_compat_expires_at, excluded.delivery_compat_expires_at)
        END,
        delivery_compat_next_ordinal = CASE
          WHEN l.delivery_compat_seeded THEN excluded.delivery_compat_next_ordinal
          ELSE GREATEST(
            COALESCE(l.delivery_compat_next_ordinal, -1),
            excluded.delivery_compat_next_ordinal
          )
        END,
        delivery_compat_seeded = false,
        updated_at = excluded.updated_at
    WHERE l.claimed_by IS NULL
       OR l.lease_expires_at IS NULL
       OR l.lease_expires_at < v_now
  RETURNING true INTO v_claimed;

  IF NOT COALESCE(v_claimed, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Companion delivery protocol is upgrading; retry the request';
  END IF;
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE POLICY "companion_transcript_entries_delivery_fence_rls"
  ON "companion_transcript_entries"
  AS RESTRICTIVE
  FOR SELECT
  USING (
    public.companion_delivery_read_fence(org_id, companion_id, current_user::text)
  );
--> statement-breakpoint

-- The migration transaction must not scan every Companion's history while its preceding ALTERs
-- hold table locks. Install a conservative ten-minute fence with a cheap table join here; after
-- commit, the API migration runner refines only a bounded batch of untouched seeds at a time. The
-- seeded bit is durable progress if that runner stops, and the function comment records whether a
-- later runner still has refinement work to resume.
CREATE FUNCTION public.companion_refresh_delivery_compat_backfill(p_batch_size integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_processed integer := 0;
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'Companion delivery compatibility batch size must be between 1 and 1000';
  END IF;

  WITH batch AS MATERIALIZED (
    SELECT l.org_id, l.companion_id
    FROM public.companion_reconcile_leases l
    WHERE l.delivery_compat_seeded
    ORDER BY l.org_id, l.companion_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  ), refined AS (
    UPDATE public.companion_reconcile_leases AS l
    SET delivery_compat_expires_at = public.companion_delivery_compat_deadline(
          l.org_id, l.companion_id, statement_timestamp()
        ),
        delivery_compat_next_ordinal = COALESCE(t.next_ordinal, 0),
        delivery_compat_seeded = false,
        updated_at = statement_timestamp()
    FROM batch b
    LEFT JOIN public.companion_threads t
      ON t.org_id = b.org_id
     AND t.companion_id = b.companion_id
    WHERE l.org_id = b.org_id
      AND l.companion_id = b.companion_id
      -- A legacy read that won before this batch replaces the seed with a real monotonic fence.
      AND l.delivery_compat_seeded
    RETURNING 1
  )
  SELECT COUNT(*)::integer INTO v_processed FROM refined;

  RETURN v_processed;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.companion_refresh_delivery_compat_backfill(integer) IS
  'companion-delivery-compat-backfill:pending';
--> statement-breakpoint

INSERT INTO public.companion_reconcile_leases AS l (
  org_id, companion_id, reason, delivery_compat_expires_at,
  delivery_compat_next_ordinal, delivery_compat_seeded, updated_at
)
SELECT c.org_id, c.id, 'delivery_compat',
       statement_timestamp() + interval '600 seconds',
       COALESCE(t.next_ordinal, 0), true, statement_timestamp()
FROM public.companions c
LEFT JOIN public.companion_threads t
  ON t.org_id = c.org_id
 AND t.companion_id = c.id
ON CONFLICT ON CONSTRAINT companion_reconcile_leases_pkey DO UPDATE
  SET delivery_compat_expires_at = excluded.delivery_compat_expires_at,
      delivery_compat_next_ordinal = excluded.delivery_compat_next_ordinal,
      delivery_compat_seeded = true,
      updated_at = excluded.updated_at
;
--> statement-breakpoint

-- Existing protocol-1 workers do not know the compatibility column. Block their ordinary claim at
-- the table boundary while the fence is live; the trigger also covers a worker whose candidate
-- query raced the migration. Compatibility-only inserts/updates carry no claimed_by and pass.
CREATE FUNCTION public.companion_block_delivery_compat_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_compat_deadline timestamp with time zone;
BEGIN
  IF NEW.claimed_by IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    v_compat_deadline := OLD.delivery_compat_expires_at;
  ELSE
    SELECT l.delivery_compat_expires_at
    INTO v_compat_deadline
    FROM public.companion_reconcile_leases l
    WHERE l.org_id = NEW.org_id
      AND l.companion_id = NEW.companion_id;
  END IF;
  IF v_compat_deadline >= statement_timestamp() THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "companion_reconcile_leases_delivery_compat_claim_guard"
  BEFORE INSERT OR UPDATE OF claimed_by
  ON "companion_reconcile_leases"
  FOR EACH ROW
  EXECUTE FUNCTION public.companion_block_delivery_compat_claim();
--> statement-breakpoint

CREATE FUNCTION public.companion_claim_delivery_lease(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_id uuid,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := statement_timestamp();
  v_lease integer := LEAST(GREATEST(COALESCE(p_lease_seconds, 180), 30), 600);
  v_claimed boolean := false;
  v_actor text := NULLIF(current_setting('app.user_id', true), '');
BEGIN
  IF p_org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid
    OR v_actor IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.companions c
      WHERE c.org_id = p_org_id
        AND c.id = p_companion_id
        AND (
          c.owner_id = v_actor
          OR EXISTS (
            SELECT 1
            FROM public.companion_workspace_access a
            JOIN public.memberships m
              ON m.org_id = a.org_id
             AND m.user_id = v_actor
            WHERE a.org_id = c.org_id
              AND a.companion_id = c.id
              AND a.owner_id = c.owner_id
              AND a.role = 'editor'
          )
        )
    )
  THEN
    RETURN false;
  END IF;

  INSERT INTO public.companion_reconcile_leases AS l (
    org_id, companion_id, claimed_by, lease_expires_at, reason, updated_at
  )
  VALUES (
    p_org_id,
    p_companion_id,
    'delivery:' || p_claim_id::text,
    v_now + make_interval(secs => v_lease),
    'delivery',
    v_now
  )
  ON CONFLICT ON CONSTRAINT companion_reconcile_leases_pkey DO UPDATE
    SET claimed_by = excluded.claimed_by,
        lease_expires_at = excluded.lease_expires_at,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    WHERE (l.lease_expires_at IS NULL OR l.lease_expires_at < v_now)
      AND (l.delivery_compat_expires_at IS NULL OR l.delivery_compat_expires_at < v_now)
  RETURNING true INTO v_claimed;

  RETURN COALESCE(v_claimed, false);
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_release_delivery_lease(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_released boolean := false;
BEGIN
  IF p_org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid
    OR NULLIF(current_setting('app.user_id', true), '') IS NULL
  THEN
    RETURN false;
  END IF;

  UPDATE public.companion_reconcile_leases l
  SET claimed_by = NULL,
      lease_expires_at = NULL,
      updated_at = statement_timestamp()
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claimed_by = 'delivery:' || p_claim_id::text
  RETURNING true INTO v_released;

  RETURN COALESCE(v_released, false);
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_renew_delivery_lease(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_id uuid,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_renewed boolean := false;
  v_lease integer := LEAST(GREATEST(COALESCE(p_lease_seconds, 600), 30), 600);
BEGIN
  IF p_org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid
    OR NULLIF(current_setting('app.user_id', true), '') IS NULL
  THEN
    RETURN false;
  END IF;

  UPDATE public.companion_reconcile_leases l
  SET lease_expires_at = statement_timestamp() + make_interval(secs => v_lease),
      updated_at = statement_timestamp()
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claimed_by = 'delivery:' || p_claim_id::text
    AND l.lease_expires_at >= statement_timestamp()
  RETURNING true INTO v_renewed;

  RETURN COALESCE(v_renewed, false);
END
$$;
--> statement-breakpoint

-- Commit a correlated Pi acknowledgement only while the caller still owns the exact live lease.
-- Locking the lease row fences this write against an expiry takeover: a replacement claim waits
-- for this transaction, then observes the accepted watermark instead of replaying the same turn.
CREATE FUNCTION public.companion_accept_delivery_lease(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_id uuid,
  p_delivered_ordinal integer,
  p_timeout_delivery_ordinal integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_owned boolean := false;
BEGIN
  IF p_org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid
    OR NULLIF(current_setting('app.user_id', true), '') IS NULL
    OR p_delivered_ordinal < 0
    OR (p_timeout_delivery_ordinal IS NOT NULL AND p_timeout_delivery_ordinal < 0)
  THEN
    RETURN false;
  END IF;

  SELECT true
  INTO v_owned
  FROM public.companion_reconcile_leases l
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claimed_by = 'delivery:' || p_claim_id::text
    AND l.lease_expires_at >= statement_timestamp()
  FOR UPDATE;

  IF NOT COALESCE(v_owned, false) THEN
    RETURN false;
  END IF;

  UPDATE public.companion_threads t
  SET delivered_ordinal = GREATEST(COALESCE(t.delivered_ordinal, -1), p_delivered_ordinal),
      accepted_delivery_ordinal = GREATEST(
        COALESCE(t.accepted_delivery_ordinal, -1), p_delivered_ordinal
      ),
      timeout_delivery_ordinal = CASE
        WHEN p_timeout_delivery_ordinal IS NULL THEN t.timeout_delivery_ordinal
        ELSE GREATEST(
          COALESCE(t.timeout_delivery_ordinal, -1), p_timeout_delivery_ordinal
        )
      END,
      updated_at = statement_timestamp()
  WHERE t.org_id = p_org_id
    AND t.companion_id = p_companion_id;

  RETURN FOUND;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_claim_delivery_lease(uuid, uuid, uuid, integer)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_block_delivery_compat_claim()
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_delivery_compat_deadline(
  uuid, uuid, timestamp with time zone
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_refresh_delivery_compat_backfill(integer)
  FROM PUBLIC;
--> statement-breakpoint
-- Keep the RLS fence callable through the migration-first handoff. The function validates tenant
-- context internally; runtime-role-grants atomically grants the API role and revokes PUBLIC after
-- the new policy has committed, so an old API replica never sees the policy without EXECUTE.
REVOKE ALL ON FUNCTION public.companion_release_delivery_lease(uuid, uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_renew_delivery_lease(uuid, uuid, uuid, integer)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_accept_delivery_lease(
  uuid, uuid, uuid, integer, integer
) FROM PUBLIC;
