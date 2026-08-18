-- Durable, global ledger for the one-shot Runtime v2 legacy Companion purge. It deliberately has
-- no foreign key to `companions`: the evidence and provider deletion operation ids must survive the
-- transaction that removes the legacy ownership rows, both for resumability and for the PR4 guard.
CREATE TABLE "companion_legacy_purge_runs" (
  "id" text PRIMARY KEY DEFAULT 'legacy-companion-purge' NOT NULL,
  "phase" text DEFAULT 'deleting_external' NOT NULL,
  "inventory_hash" text NOT NULL,
  "inventory" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "companion_legacy_purge_runs_singleton_check"
    CHECK ("id" = 'legacy-companion-purge'),
  CONSTRAINT "companion_legacy_purge_runs_phase_check"
    CHECK ("phase" IN ('deleting_external', 'external_complete', 'database_complete')),
  CONSTRAINT "companion_legacy_purge_runs_inventory_hash_check"
    CHECK ("inventory_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "companion_legacy_purge_runs_inventory_check"
    CHECK (jsonb_typeof("inventory") = 'object'),
  CONSTRAINT "companion_legacy_purge_runs_completed_check"
    CHECK (("phase" = 'database_complete') = ("completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "companion_legacy_purge_targets" (
  "box_id" text PRIMARY KEY NOT NULL,
  "observed_name" text,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "state" text DEFAULT 'discovered' NOT NULL,
  "operation_id" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "requested_at" timestamp with time zone,
  "last_polled_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_legacy_purge_targets_box_id_check"
    CHECK ("box_id" ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'),
  CONSTRAINT "companion_legacy_purge_targets_evidence_check"
    CHECK (jsonb_typeof("evidence") = 'array'),
  CONSTRAINT "companion_legacy_purge_targets_state_check"
    CHECK ("state" IN (
      'discovered', 'requesting', 'pending', 'processing', 'blocked', 'completed', 'absent'
    )),
  CONSTRAINT "companion_legacy_purge_targets_operation_id_check"
    CHECK (
      "operation_id" IS NULL
      OR "operation_id" ~ '^bdop_[0-9a-f]{32}$'
    ),
  CONSTRAINT "companion_legacy_purge_targets_operation_state_check"
    CHECK (
      ("state" IN ('pending', 'processing', 'blocked', 'completed') AND "operation_id" IS NOT NULL)
      OR ("state" IN ('discovered', 'requesting', 'absent') AND "operation_id" IS NULL)
    ),
  CONSTRAINT "companion_legacy_purge_targets_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "companion_legacy_purge_targets_last_error_check"
    CHECK ("last_error" IS NULL OR (char_length("last_error") <= 500 AND "last_error" !~ E'[\\n\\r]')),
  CONSTRAINT "companion_legacy_purge_targets_completed_check"
    CHECK (("state" IN ('completed', 'absent')) = ("completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_legacy_purge_targets_operation_id_uq"
  ON "companion_legacy_purge_targets" ("operation_id")
  WHERE "operation_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "companion_legacy_purge_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_legacy_purge_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_legacy_purge_targets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_legacy_purge_targets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The only destructive database step. Provider work is intentionally absent from this function:
-- the command persists and polls every provider operation outside a database transaction, then this
-- short transaction rechecks the durable proof before removing a single legacy ownership row.
CREATE FUNCTION public.companion_finalize_legacy_purge()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_phase text;
  v_companions bigint := 0;
  v_pools bigint := 0;
  v_workspace_access bigint := 0;
  v_member_state bigint := 0;
  v_threads bigint := 0;
  v_transcript_entries bigint := 0;
  v_reconcile_leases bigint := 0;
  v_companion_tokens bigint := 0;
BEGIN
  -- Share the migrator/cutover namespace even when this narrow function is invoked manually.
  PERFORM pg_advisory_xact_lock(72401, 20260608);

  LOCK TABLE
    public.companion_legacy_purge_runs,
    public.companion_legacy_purge_targets,
    public.companion_transcript_entries,
    public.companion_threads,
    public.companion_workspace_access,
    public.companion_member_state,
    public.companion_reconcile_leases,
    public.companions,
    public.companion_runtime_pools,
    public.api_tokens
  IN ACCESS EXCLUSIVE MODE;

  SELECT r.phase INTO v_phase
  FROM public.companion_legacy_purge_runs r
  WHERE r.id = 'legacy-companion-purge'
  FOR UPDATE;

  IF v_phase IS NULL THEN
    RAISE EXCEPTION 'legacy Companion purge has no durable run ledger' USING ERRCODE = '55000';
  END IF;
  IF v_phase = 'database_complete' THEN
    RETURN jsonb_build_object(
      'already_complete', true,
      'companions', 0,
      'runtime_pools', 0,
      'workspace_access', 0,
      'member_state', 0,
      'threads', 0,
      'transcript_entries', 0,
      'reconcile_leases', 0,
      'companion_tokens', 0
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.companion_legacy_purge_targets t
    WHERE t.state NOT IN ('completed', 'absent')
  ) THEN
    RAISE EXCEPTION 'legacy Companion provider deletions are not all confirmed'
      USING ERRCODE = '55000';
  END IF;

  -- A DB-owned id absent from the successful ledger would become irrecoverable after this commit.
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT c.box_id FROM public.companions c WHERE c.box_id IS NOT NULL
      UNION
      SELECT p.box_id FROM public.companion_runtime_pools p WHERE p.box_id IS NOT NULL
    ) owned
    LEFT JOIN public.companion_legacy_purge_targets t ON t.box_id = owned.box_id
    WHERE t.box_id IS NULL OR t.state NOT IN ('completed', 'absent')
  ) THEN
    RAISE EXCEPTION 'a legacy Companion database Box id lacks confirmed provider deletion'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.companion_legacy_purge_runs
  SET phase = 'external_complete', updated_at = statement_timestamp()
  WHERE id = 'legacy-companion-purge';

  WITH deleted AS (
    DELETE FROM public.companion_transcript_entries RETURNING 1
  ) SELECT count(*) INTO v_transcript_entries FROM deleted;
  WITH deleted AS (
    DELETE FROM public.companion_threads RETURNING 1
  ) SELECT count(*) INTO v_threads FROM deleted;
  WITH deleted AS (
    DELETE FROM public.companion_workspace_access RETURNING 1
  ) SELECT count(*) INTO v_workspace_access FROM deleted;
  WITH deleted AS (
    DELETE FROM public.companion_member_state RETURNING 1
  ) SELECT count(*) INTO v_member_state FROM deleted;
  WITH deleted AS (
    DELETE FROM public.companion_reconcile_leases RETURNING 1
  ) SELECT count(*) INTO v_reconcile_leases FROM deleted;
  WITH deleted AS (
    DELETE FROM public.companions RETURNING 1
  ) SELECT count(*) INTO v_companions FROM deleted;
  WITH deleted AS (
    DELETE FROM public.companion_runtime_pools RETURNING 1
  ) SELECT count(*) INTO v_pools FROM deleted;
  WITH deleted AS (
    DELETE FROM public.api_tokens WHERE source_type = 'companion' RETURNING 1
  ) SELECT count(*) INTO v_companion_tokens FROM deleted;

  IF EXISTS (SELECT 1 FROM public.companions)
     OR EXISTS (SELECT 1 FROM public.companion_runtime_pools)
     OR EXISTS (SELECT 1 FROM public.companion_workspace_access)
     OR EXISTS (SELECT 1 FROM public.companion_member_state)
     OR EXISTS (SELECT 1 FROM public.companion_threads)
     OR EXISTS (SELECT 1 FROM public.companion_transcript_entries)
     OR EXISTS (SELECT 1 FROM public.companion_reconcile_leases)
     OR EXISTS (SELECT 1 FROM public.api_tokens WHERE source_type = 'companion') THEN
    RAISE EXCEPTION 'legacy Companion database purge did not drain every owned row'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.companion_legacy_purge_runs
  SET phase = 'database_complete', updated_at = statement_timestamp(), completed_at = statement_timestamp()
  WHERE id = 'legacy-companion-purge';

  RETURN jsonb_build_object(
    'already_complete', false,
    'companions', v_companions,
    'runtime_pools', v_pools,
    'workspace_access', v_workspace_access,
    'member_state', v_member_state,
    'threads', v_threads,
    'transcript_entries', v_transcript_entries,
    'reconcile_leases', v_reconcile_leases,
    'companion_tokens', v_companion_tokens
  );
END
$$;
--> statement-breakpoint

-- FORCE RLS also applies to the NOSUPERUSER migration owner. These policies admit only the owner
-- of the constrained finalizer; API/worker roles receive neither table privileges nor function
-- execution and therefore cannot turn this one-shot maintenance path into a product endpoint.
CREATE POLICY "companion_legacy_purge_runs_maintenance_rls"
  ON "companion_legacy_purge_runs" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_legacy_purge_targets_maintenance_rls"
  ON "companion_legacy_purge_targets" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companions_legacy_purge_maintenance_rls"
  ON "companions" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_runtime_pools_legacy_purge_maintenance_rls"
  ON "companion_runtime_pools" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_workspace_access_legacy_purge_maintenance_rls"
  ON "companion_workspace_access" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_member_state_legacy_purge_maintenance_rls"
  ON "companion_member_state" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_threads_legacy_purge_maintenance_rls"
  ON "companion_threads" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_transcript_entries_legacy_purge_maintenance_rls"
  ON "companion_transcript_entries" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_reconcile_leases_legacy_purge_maintenance_rls"
  ON "companion_reconcile_leases" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "api_tokens_legacy_companion_purge_maintenance_rls"
  ON "api_tokens" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
  )));
--> statement-breakpoint

REVOKE ALL ON TABLE public.companion_legacy_purge_runs FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_legacy_purge_targets FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_finalize_legacy_purge() FROM PUBLIC;
