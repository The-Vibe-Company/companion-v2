-- Companion reconciler bookkeeping. Every recovery mechanism so far runs inside one API request or
-- one open browser tab; a Companion nobody is looking at stays broken exactly as it is. The worker
-- gains a reconciliation loop, and this migration gives it the two things the loop needs: a lease
-- row per Companion (so concurrent workers cannot double-treat one) and a pair of SECURITY DEFINER
-- functions — candidate claim and lease settlement — that are its only path to that table.
--
-- Leases deliberately live beside `companions`, not on it: `companions.updated_at` is the CAS token
-- every lifecycle finalizer compares against, and reconciler bookkeeping must never move it.

CREATE TABLE "companion_reconcile_leases" (
  "org_id" uuid NOT NULL,
  "companion_id" uuid PRIMARY KEY NOT NULL,
  "claimed_by" text,
  "lease_expires_at" timestamp with time zone,
  "reason" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attention_at" timestamp with time zone,
  "last_outcome" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_reconcile_leases_attempts_check" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "companion_reconcile_leases"
  ADD CONSTRAINT "companion_reconcile_leases_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_reconcile_leases"
  ADD CONSTRAINT "companion_reconcile_leases_companion_id_companions_id_fk"
  FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_reconcile_leases"
  ADD CONSTRAINT "companion_reconcile_leases_companion_fk"
  FOREIGN KEY ("org_id", "companion_id")
  REFERENCES "public"."companions"("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_reconcile_leases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_reconcile_leases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

/*
 * Claim up to p_limit Companions that need reconciler attention, most urgent first. Cross-tenant by
 * design — the definer bypasses RLS the way the other worker claim functions do — and returned rows
 * carry the owner's identity so the worker can run every subsequent org-scoped service under that
 * owner's tenant context.
 *
 * Reasons, in priority order, each with a grace window so an active client or a live request wins:
 *   stale_start     — a `provisioning` claim whose owner went quiet past the takeover window
 *   archive_resume  — the durable `stopping`/`starting` marker with no open tab continuing it
 *   deletion_stuck  — the Owner-deletion lock (`stopping`/`unknown`) that a failed Box stop stranded
 *   redelivery      — a recent, undelivered user tail on a Companion no client is actively syncing
 *   liveness        — a `running` projection nothing has observed lately (bounded to recent starts)
 *   expiry_sweep    — overdue tool chips or expired permission cards on an unread thread
 *
 * A row is claimable only when its lease is free and its backoff gate (`next_attention_at`) has
 * passed; the conditional upsert is what makes two workers ticking together claim disjoint sets.
 */
CREATE FUNCTION public.companion_claim_reconcile_candidates(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
)
RETURNS TABLE (
  org_id uuid,
  companion_id uuid,
  owner_id text,
  owner_email text,
  owner_name text,
  reason text,
  box_id text,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_worker text := NULLIF(trim(p_worker_id), '');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 5), 1), 50);
  v_lease integer := LEAST(GREATEST(COALESCE(p_lease_seconds, 300), 60), 3600);
  v_now timestamp with time zone := statement_timestamp();
  v_claimed integer := 0;
  v_attempts integer;
  candidate record;
BEGIN
  IF v_worker IS NULL OR length(v_worker) > 200 THEN
    RETURN;
  END IF;

  FOR candidate IN
    WITH candidates AS (
      SELECT c.org_id AS cand_org, c.id AS cand_companion, 1 AS priority, 'stale_start' AS cand_reason
      FROM public.companions c
      WHERE c.runtime_state = 'provisioning'
        -- Past COMPANION_RUNTIME_CLAIM_STALE_MS (210 s) plus margin, so a live wake always wins.
        AND c.updated_at < v_now - interval '240 seconds'
      UNION ALL
      SELECT c.org_id, c.id, 2, 'archive_resume'
      FROM public.companions c
      WHERE c.runtime_state = 'stopping'
        AND c.daemon_state = 'starting'
        AND c.updated_at < v_now - interval '30 seconds'
      UNION ALL
      SELECT c.org_id, c.id, 3, 'deletion_stuck'
      FROM public.companions c
      WHERE c.runtime_state = 'stopping'
        AND c.daemon_state = 'unknown'
        AND c.updated_at < v_now - interval '10 minutes'
      UNION ALL
      SELECT c.org_id, c.id, 4, 'redelivery'
      FROM public.companions c
      JOIN public.companion_threads t
        ON t.org_id = c.org_id AND t.companion_id = c.id
      WHERE c.runtime_state IN ('stopped', 'error', 'running')
        -- A thread updated within the last half minute has a client on it; that client delivers.
        AND t.updated_at < v_now - interval '30 seconds'
        AND EXISTS (
          SELECT 1
          FROM public.companion_transcript_entries e
          WHERE e.org_id = c.org_id
            AND e.companion_id = c.id
            AND e.role::text = 'user'
            AND e.ordinal > COALESCE(t.delivered_ordinal, -1)
            -- Only a recently asked question justifies waking a Box on the asker's behalf.
            AND e.created_at > v_now - interval '30 minutes'
            -- An explicit Stop after the send is the human answering "not now"; respect it.
            AND (c.last_stopped_at IS NULL OR c.last_stopped_at < e.created_at)
        )
      UNION ALL
      SELECT c.org_id, c.id, 5, 'liveness'
      FROM public.companions c
      WHERE c.runtime_state = 'running'
        AND (c.last_observed_at IS NULL OR c.last_observed_at < v_now - interval '120 seconds')
        -- Probe cost is bounded to Companions someone actually started recently.
        AND c.last_started_at > v_now - interval '24 hours'
      UNION ALL
      SELECT DISTINCT e.org_id, e.companion_id, 6, 'expiry_sweep'
      FROM public.companion_transcript_entries e
      JOIN public.companion_threads t
        ON t.org_id = e.org_id AND t.companion_id = e.companion_id
      WHERE t.updated_at < v_now - interval '60 seconds'
        AND (
          (
            e.role::text = 'tool'
            AND e.tool->>'status' = 'running'
            AND e.created_at <= v_now - make_interval(
              secs => CASE WHEN e.tool->>'kind' = 'shell' THEN 600 ELSE 90 END
            )
          )
          OR (
            e.role::text = 'decision'
            AND e.decision->>'status' = 'pending'
            AND (e.decision->>'expires_at')::timestamptz <= v_now
          )
        )
    )
    SELECT ranked.cand_org, ranked.cand_companion, ranked.priority, ranked.cand_reason
    FROM (
      SELECT DISTINCT ON (cand.cand_companion)
        cand.cand_org, cand.cand_companion, cand.priority, cand.cand_reason
      FROM candidates cand
      LEFT JOIN public.companion_reconcile_leases l
        ON l.org_id = cand.cand_org AND l.companion_id = cand.cand_companion
      WHERE l.companion_id IS NULL
        OR (
          (l.lease_expires_at IS NULL OR l.lease_expires_at < v_now)
          AND (l.next_attention_at IS NULL OR l.next_attention_at <= v_now)
        )
      ORDER BY cand.cand_companion, cand.priority
    ) ranked
    ORDER BY ranked.priority, ranked.cand_companion
    LIMIT LEAST(v_limit * 4, 200)
  LOOP
    -- The conditional upsert is the mutual exclusion: a lease another worker took since the
    -- candidate query ran fails the WHERE and claims nothing.
    INSERT INTO public.companion_reconcile_leases AS l (
      org_id, companion_id, claimed_by, lease_expires_at, reason, updated_at
    )
    VALUES (
      candidate.cand_org,
      candidate.cand_companion,
      v_worker,
      v_now + make_interval(secs => v_lease),
      candidate.cand_reason,
      v_now
    )
    -- By constraint name: a bare column target is ambiguous against the OUT parameter of the
    -- same name inside plpgsql.
    ON CONFLICT ON CONSTRAINT companion_reconcile_leases_pkey DO UPDATE
      SET claimed_by = excluded.claimed_by,
          lease_expires_at = excluded.lease_expires_at,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      WHERE (l.lease_expires_at IS NULL OR l.lease_expires_at < v_now)
        AND (l.next_attention_at IS NULL OR l.next_attention_at <= v_now)
    RETURNING l.attempts INTO v_attempts;

    IF v_attempts IS NOT NULL THEN
      RETURN QUERY
        SELECT comp.org_id, comp.id, u.id, u.email, u.name,
               candidate.cand_reason, comp.box_id, v_attempts
        FROM public.companions comp
        JOIN public."user" u ON u.id = comp.owner_id
        WHERE comp.org_id = candidate.cand_org AND comp.id = candidate.cand_companion;
      v_claimed := v_claimed + 1;
      EXIT WHEN v_claimed >= v_limit;
    END IF;
    v_attempts := NULL;
  END LOOP;
END
$$;
--> statement-breakpoint

/*
 * Release one claimed lease. A positive backoff records a failed attempt: the attempt counter
 * advances and the row sleeps until `next_attention_at`. Zero backoff records success and clears
 * the counter. Only the worker holding the lease may settle it.
 */
CREATE FUNCTION public.companion_settle_reconcile_lease(
  p_org_id uuid,
  p_companion_id uuid,
  p_worker_id text,
  p_outcome text,
  p_backoff_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_worker text := NULLIF(trim(p_worker_id), '');
  v_backoff integer := LEAST(GREATEST(COALESCE(p_backoff_seconds, 0), 0), 86400);
  v_settled boolean := false;
BEGIN
  IF v_worker IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.companion_reconcile_leases l
  SET claimed_by = NULL,
      lease_expires_at = NULL,
      last_outcome = left(COALESCE(p_outcome, ''), 300),
      attempts = CASE WHEN v_backoff > 0 THEN l.attempts + 1 ELSE 0 END,
      next_attention_at = CASE
        WHEN v_backoff > 0 THEN statement_timestamp() + make_interval(secs => v_backoff)
        ELSE NULL
      END,
      updated_at = statement_timestamp()
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claimed_by = v_worker
  RETURNING true INTO v_settled;

  RETURN COALESCE(v_settled, false);
END
$$;
--> statement-breakpoint

-- FORCE RLS applies to the NOSUPERUSER migration owner too; this single policy admits exactly the
-- owner of the constrained claim function, so runtime roles reach the table only through the two
-- definer functions above.
CREATE POLICY "companion_reconcile_leases_maintenance_rls"
  ON "companion_reconcile_leases"
  FOR ALL
  USING (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_claim_reconcile_candidates(text,integer,integer)'::regprocedure
    ))
  )
  WITH CHECK (
    current_user = pg_get_userbyid((
      SELECT p.proowner
      FROM pg_proc p
      WHERE p.oid = 'public.companion_claim_reconcile_candidates(text,integer,integer)'::regprocedure
    ))
  );
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_claim_reconcile_candidates(
  text, integer, integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_settle_reconcile_lease(
  uuid, uuid, text, text, integer
) FROM PUBLIC;
